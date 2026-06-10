// BOXIV-only: LINE Login integration for STUDIO listing form on lightning.boxiv.co.jp.
//
// Flow:
//   1. User submits STUDIO form on lightning.boxiv.co.jp
//   2. STUDIO posts form fields to Slack #pj-lightning-sell (existing — handled by STUDIO)
//   3. Page shows "LINEで連携" button that redirects to:
//        GET /listing-form/start?form_id=XXX&return_to=YYY[&display_name=ZZZ]
//   4. We redirect to LINE Login OAuth with bot_prompt=normal (asks user to add the OA as friend)
//   5. LINE redirects back to /listing-form/callback?code=&state=
//   6. We exchange code → access_token → profile (LINE userId, displayName)
//   7. We post a notification to Slack #pj-lightning-sell (configurable channel)
//   8. A separate reconciliation bot (existing) batches Slack #pj-lightning-sell to match form
//      submissions with LINE link events, then writes to Notion.
//   9. We redirect user to return_to (with ?linked=1) or show success page.
//
// Required env (Worker secrets):
//   LINE_LOGIN_CHANNEL_ID, LINE_LOGIN_CHANNEL_SECRET   — existing
//   SESSION_SECRET                                      — existing (used for state HMAC)
//   SELLENTRY_SLACK_BOT_TOKEN                           — claude-sellentry bot (xoxb-..., groups:history+chat:write・チャンネル member)
//   SLACK_LISTING_LINK_CHANNEL_ID                       — #pj-lightning-sell (e.g. C08PSA6A7PW)
//
// Set new secrets via wrangler:
//   cd line/line-harness-oss/apps/worker
//   pnpm exec wrangler secret put SELLENTRY_SLACK_BOT_TOKEN --config wrangler.boxiv.toml
//   pnpm exec wrangler secret put SLACK_LISTING_LINK_CHANNEL_ID --config wrangler.boxiv.toml

import { Hono } from 'hono';
import { upsertFriend, getFriendByLineUserId } from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { upsertOnSubmit, markLinked, insertOrphanLink, setNotionPageId } from '../services/listing-entry.boxiv.js';
import { createOrUpdateSellerRow, linkSellerRow } from '../services/listing-notion.boxiv.js';
import { lookupPostalCode } from '../services/jp-postal.boxiv.js';
import type { Env } from '../index.js';

const listingFormLine = new Hono<Env>();

// Allowed return_to hosts (open-redirect protection).
// Dev hosts (localhost) are only honored when the Worker itself runs on a dev/test origin.
const RETURN_TO_ALLOWED_HOSTS = [
  'lightning.boxiv.co.jp',
  'line-connect.boxiv.workers.dev',
  'line-connect-test.boxiv.workers.dev',
];
const RETURN_TO_DEV_HOSTS = ['localhost', '127.0.0.1'];

function isDevOrigin(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host.endsWith('-test.boxiv.workers.dev');
}

const STATE_TTL_MS = 30 * 60 * 1000; // 30 min

// ─── HMAC state signing ─────────────────────────────────────

async function hmacSign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlEncode(s: string): string {
  // UTF-8 safe: btoa() only accepts Latin1 and throws on non-Latin1 (e.g. 日本語 の display_name).
  // Encode to bytes first so a Japanese name in the signed state doesn't 500 /listing-form/start.
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): string {
  const pad = s + '==='.slice((s.length + 3) % 4);
  const bin = atob(pad.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function packState(payloadObj: object, secret: string): Promise<string> {
  const payload = JSON.stringify(payloadObj);
  const payloadB64 = b64urlEncode(payload);
  const sig = await hmacSign(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

async function unpackState<T = unknown>(token: string, secret: string): Promise<T | null> {
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;
  const expected = await hmacSign(payloadB64, secret);
  // Constant-time compare via length + char-by-char XOR
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    return JSON.parse(b64urlDecode(payloadB64)) as T;
  } catch {
    return null;
  }
}

// reqHost = hostname the Worker is currently serving on (gates localhost return_to to dev/test).
function isAllowedReturnTo(url: string, reqHost: string): boolean {
  try {
    const u = new URL(url);
    const isDevHost = RETURN_TO_DEV_HOSTS.includes(u.hostname);
    // Scheme must be https (blocks javascript:/data:/protocol-relative); http only for dev hosts.
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isDevHost)) return false;
    if (RETURN_TO_ALLOWED_HOSTS.includes(u.hostname)) return true;
    if (isDevHost) return isDevOrigin(reqHost); // localhost honored only on a dev/test Worker origin
    return false;
  } catch {
    return false;
  }
}

// ─── Routes ──────────────────────────────────────────────────

interface ListingStateV1 {
  v: 1;
  form_id: string;
  return_to: string;
  display_name: string;
  ts: number;
}

/**
 * GET /listing-form/start
 *
 * Entry point from lightning.boxiv.co.jp's "LINEで連携" button.
 * Redirects user to LINE Login OAuth with bot_prompt=normal so the user is
 * asked to add the BOXIV official LINE account as friend during login.
 *
 * Query params:
 *   form_id     (required) — STUDIO form submission identifier
 *   return_to   (optional) — URL to redirect after successful link
 *                            (must match RETURN_TO_ALLOWED_HOSTS)
 *   display_name(optional) — pre-filled name from the form (for success page)
 */
listingFormLine.get('/listing-form/start', async (c) => {
  const formId = c.req.query('form_id') ?? '';
  const returnTo = c.req.query('return_to') ?? '';
  const displayName = c.req.query('display_name') ?? '';

  const reqUrl = new URL(c.req.url);
  // Canonical Worker base (per-env) so redirect_uri always matches a registered LINE Callback URL.
  const workerBase = (c.env.WORKER_URL || reqUrl.origin).replace(/\/+$/, '');

  if (!formId) {
    return c.json({ success: false, error: 'form_id is required' }, 400);
  }
  // form_id (= match_key) is a client-generated UUID / short token. Constrain its shape so a crafted
  // value cannot smuggle newlines/backticks/control chars into the signed state or the Slack
  // reconciliation post (which the matching bot parses line-by-line).
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(formId)) {
    return c.json({ success: false, error: 'invalid form_id' }, 400);
  }
  if (returnTo && !isAllowedReturnTo(returnTo, reqUrl.hostname)) {
    return c.json({ success: false, error: 'return_to host not allowed' }, 400);
  }
  if (!c.env.SESSION_SECRET) {
    return c.json({ success: false, error: 'SESSION_SECRET not configured' }, 500);
  }
  if (!c.env.LINE_LOGIN_CHANNEL_ID) {
    return c.json({ success: false, error: 'LINE_LOGIN_CHANNEL_ID not configured' }, 500);
  }

  const state = await packState(
    { v: 1, form_id: formId, return_to: returnTo, display_name: displayName, ts: Date.now() } satisfies ListingStateV1,
    c.env.SESSION_SECRET,
  );

  const callbackUrl = `${workerBase}/listing-form/callback`;
  const loginUrl = new URL('https://access.line.me/oauth2/v2.1/authorize');
  loginUrl.searchParams.set('response_type', 'code');
  loginUrl.searchParams.set('client_id', c.env.LINE_LOGIN_CHANNEL_ID);
  loginUrl.searchParams.set('redirect_uri', callbackUrl);
  loginUrl.searchParams.set('scope', 'profile'); // profile のみ（id_token 未使用なので openid は付けない）
  // aggressive: ログインのたびに「友だち追加」画面を必ず表示。未追加/ブロック中の人にも再追加（=ブロック解除）を促す。
  // ※ LINE 仕様上、自動追加・自動ブロック解除は不可。ユーザーが「追加」をタップして初めて成立する。
  loginUrl.searchParams.set('bot_prompt', 'aggressive');
  loginUrl.searchParams.set('state', state);

  return c.redirect(loginUrl.toString());
});

// ─── CORS（公開フォームページからの直接 POST 用） ────────────────
function applyCors(c: any): void {
  const origin = c.req.header('origin') || '';
  let allow = 'https://lightning.boxiv.co.jp';
  try {
    const h = origin ? new URL(origin).hostname : '';
    if (h && (h === 'lightning.boxiv.co.jp' || h.endsWith('.boxiv.co.jp') || h === 'localhost' || h === '127.0.0.1')) {
      allow = origin;
    }
  } catch { /* keep default */ }
  c.header('Access-Control-Allow-Origin', allow);
  c.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, X-Listing-Token');
  c.header('Access-Control-Max-Age', '86400');
  c.header('Vary', 'Origin');
}

listingFormLine.options('/listing-form/submit', (c) => {
  applyCors(c);
  return c.body(null, 204);
});

/**
 * POST /listing-form/submit
 *
 * STUDIO フォームページが submit 時に直接叩く。フォーム送信“時点”で
 *   1) D1 台帳 listing_entries に upsert（正本・status=form_only）
 *   2) Notion 出品者DB へ即ミラー起票（未連携。match_key キー）
 * を行う（LINE 連携前から Notion に行ができる）。LINE userId は後続の callback で追記。
 *
 * body: { match_key, fields:{label:value}, name?, phone?, email?, return_to? }
 */
listingFormLine.post('/listing-form/submit', async (c) => {
  applyCors(c);

  // 任意の共有トークン（設定時のみ必須）。公開エンドポイントの簡易ガード（堅牢化は Turnstile を検討）。
  if (c.env.LISTING_FORM_SUBMIT_TOKEN && c.req.header('x-listing-token') !== c.env.LISTING_FORM_SUBMIT_TOKEN) {
    return c.json({ success: false, error: 'forbidden' }, 403);
  }

  let body: Record<string, any>;
  try { body = await c.req.json(); } catch { return c.json({ success: false, error: 'invalid json' }, 400); }

  const matchKey = String(body.match_key ?? body.matchKey ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(matchKey)) {
    return c.json({ success: false, error: 'invalid match_key' }, 400);
  }
  const fields: Record<string, unknown> = (body.fields && typeof body.fields === 'object') ? body.fields : {};
  if (JSON.stringify(fields).length > 20000) {
    return c.json({ success: false, error: 'payload too large' }, 413);
  }
  const pick = (k: string): string | undefined => {
    const v = fields[k];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  const name = (body.name ? String(body.name) : pick('お名前')) || null;
  const emailRaw = (body.email ? String(body.email) : pick('メールアドレス')) || '';
  const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailRaw) ? emailRaw : null;
  const phoneRaw = (body.phone ? String(body.phone) : pick('電話番号')) || '';
  const phone = phoneRaw.replace(/[^\d+-]/g, '') || null;
  const reqHost = new URL(c.req.url).hostname;
  const returnTo = body.return_to && isAllowedReturnTo(String(body.return_to), reqHost) ? String(body.return_to) : null;

  // 1) D1 台帳に upsert（正本）— 非致命
  await upsertOnSubmit(c.env.DB, { matchKey, formData: fields, name, phone, email, returnTo })
    .catch((e) => console.error('listing-form submit: D1 upsert failed', e));

  // 2) 郵便番号（住所→API、ベストエフォート）
  let zip: string | null = null;
  const addr = pick('ご住所');
  if (addr) zip = await lookupPostalCode(c.env, addr).catch(() => null);

  // 3) Notion へ即ミラー起票（未連携）— 非致命
  try {
    const pageId = await createOrUpdateSellerRow(c.env, { matchKey, formData: fields, name, phone, email, zip });
    if (pageId) await setNotionPageId(c.env.DB, matchKey, pageId);
  } catch (e) {
    console.error('listing-form submit: Notion 起票 failed', e);
  }

  return c.json({ success: true }, 200);
});

/**
 * GET /listing-form/callback
 *
 * LINE Login redirects here after user grants permission.
 * Exchanges code for access_token, fetches profile, posts notification to Slack,
 * then redirects to return_to (or shows success page).
 */
listingFormLine.get('/listing-form/callback', async (c) => {
  const code = c.req.query('code');
  const stateParam = c.req.query('state');
  const errorParam = c.req.query('error');
  const errorDesc = c.req.query('error_description') ?? '';

  if (errorParam) {
    return c.html(renderErrorPage(`LINE 連携がキャンセルされました（${errorParam}）`, errorDesc), 400);
  }
  if (!code || !stateParam) {
    return c.html(renderErrorPage('リクエストが不正です', 'パラメータが不足しています。完了ページから連携をやり直してください。'), 400);
  }
  if (!c.env.SESSION_SECRET) {
    return c.json({ success: false, error: 'SESSION_SECRET not configured' }, 500);
  }
  if (!c.env.LINE_LOGIN_CHANNEL_ID || !c.env.LINE_LOGIN_CHANNEL_SECRET) {
    console.error('listing-form callback: LINE_LOGIN_CHANNEL_ID / LINE_LOGIN_CHANNEL_SECRET not configured');
    return c.json({ success: false, error: 'LINE login not configured' }, 500);
  }

  const ctx = await unpackState<ListingStateV1>(stateParam, c.env.SESSION_SECRET);
  if (!ctx || ctx.v !== 1) {
    return c.html(renderErrorPage('リンクが無効です', 'お手数ですが、完了ページから連携をやり直してください。'), 400);
  }
  if (Date.now() - ctx.ts > STATE_TTL_MS) {
    return c.html(renderErrorPage('時間切れです', '連携の有効期限（30分）が切れました。完了ページから再度お試しください。'), 400);
  }

  const reqUrl = new URL(c.req.url);
  const workerBase = (c.env.WORKER_URL || reqUrl.origin).replace(/\/+$/, '');

  // Exchange code → tokens (redirect_uri must match the one sent in /start)
  const callbackUrl = `${workerBase}/listing-form/callback`;
  const tokenRes = await fetch('https://api.line.me/oauth2/v2.1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrl,
      client_id: c.env.LINE_LOGIN_CHANNEL_ID,
      client_secret: c.env.LINE_LOGIN_CHANNEL_SECRET,
    }),
  });
  if (!tokenRes.ok) {
    // redact upstream body; keep status + form_id for correlation
    console.error(`listing-form callback: token exchange failed (status=${tokenRes.status}, form_id=${ctx.form_id})`);
    return c.html(renderErrorPage('連携に失敗しました', 'お手数ですが、しばらくしてから完了ページより再度お試しください。'), 502);
  }
  const tokens = (await tokenRes.json()) as { access_token: string };

  // Fetch profile
  const profileRes = await fetch('https://api.line.me/v2/profile', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!profileRes.ok) {
    console.error(`listing-form callback: profile fetch failed (status=${profileRes.status}, form_id=${ctx.form_id})`);
    return c.html(renderErrorPage('連携に失敗しました', 'プロフィールの取得に失敗しました。お手数ですが再度お試しください。'), 502);
  }
  const profile = (await profileRes.json()) as {
    userId: string;
    displayName: string;
    pictureUrl?: string;
  };

  // 友だちを D1 に upsert: 既に友だちで follow webhook が発火しないケースでも friend を確実に登録する。
  // これで突合ボットの friend↔Notion 連携が lineUserId で friend を見つけられる。非致命。
  await upsertFriend(c.env.DB, {
    lineUserId: profile.userId,
    displayName: profile.displayName,
    pictureUrl: profile.pictureUrl ?? null,
  }).catch((err) => {
    console.error(`listing-form callback: upsertFriend failed (form_id=${ctx.form_id})`, err);
  });

  // BOXIV: D1 台帳 + Notion を match_key で「連携済み」に更新（旧 reconcile-daemon の Notion 起票を Worker に集約）。
  // フォーム送信時に submit で起票済みの行へ lineUserId を追記。form_submit が無い直リンクは orphan 行を作る。非致命。
  let notionPageId: string | null = null;
  try {
    const entry = await markLinked(c.env.DB, ctx.form_id, profile.userId, profile.displayName);
    if (!entry) {
      await insertOrphanLink(c.env.DB, ctx.form_id, profile.userId, profile.displayName);
    } else {
      notionPageId = entry.notion_page_id;
    }
  } catch (err) {
    console.error(`listing-form callback: D1 markLinked failed (form_id=${ctx.form_id})`, err);
  }
  try {
    await linkSellerRow(c.env, {
      matchKey: ctx.form_id,
      lineUserId: profile.userId,
      displayName: profile.displayName,
      knownPageId: notionPageId,
    });
  } catch (err) {
    console.error(`listing-form callback: Notion linkSellerRow failed (form_id=${ctx.form_id})`, err);
  }

  // BOXIV: 自動連携完了を `listing_link_completed` イベントとして発火（S-03 はデータ駆動）。
  // 何を送るかは管理UIの automation 側で決める。非致命 — 失敗してもリダイレクトは完了。
  await fireListingLinkCompleted(c.env, profile, ctx).catch((err) => {
    console.error('listing-form callback: listing_link_completed fire threw', err);
  });

  // Post to Slack — non-fatal: 突合ボット用（#pj-lightning-sell）。失敗してもフロー継続。
  await postSlackLinkNotification(c.env, ctx, profile).catch((err) => {
    console.error(`listing-form callback: slack post threw (form_id=${ctx.form_id})`, err);
  });

  // Redirect to return_to (with ?linked=1) or render success page.
  // Re-validate against the allowlist at the redirect site (defense-in-depth).
  if (ctx.return_to && isAllowedReturnTo(ctx.return_to, reqUrl.hostname)) {
    try {
      const url = new URL(ctx.return_to);
      url.searchParams.set('linked', '1');
      return c.redirect(url.toString());
    } catch {
      // fall through to default success page if return_to was somehow malformed
    }
  }
  return c.html(renderSuccessPage(profile.displayName));
});

// ─── helpers ─────────────────────────────────────────────────

/**
 * 自動連携 完了時に `listing_link_completed` イベントを発火する。
 *
 * event-bus の send_message アクションは friends 行（line_user_id）を要求するため、
 * 先に friend を upsert して存在を保証する。follow webhook（bot_prompt=normal で
 * 友だち追加されると非同期で届く）より callback が先行することがあるため、
 * ここで作っておく。同時実行の競合に備え、INSERT 失敗時は再取得でフォールバックする。
 *
 * 何を送るかは管理UIの automation（eventType=listing_link_completed）が決める。
 * lineAccountId は単一OA前提で undefined（automation 側の account 絞り込みは全件マッチ）。
 */
async function fireListingLinkCompleted(
  env: Env['Bindings'],
  profile: { userId: string; displayName: string; pictureUrl?: string },
  ctx: ListingStateV1,
) {
  let friend;
  try {
    friend = await upsertFriend(env.DB, {
      lineUserId: profile.userId,
      displayName: profile.displayName ?? null,
      pictureUrl: profile.pictureUrl ?? null,
    });
  } catch {
    // 競合（follow webhook と同時 INSERT）等 → 既存を取り直す
    friend = await getFriendByLineUserId(env.DB, profile.userId);
  }
  if (!friend) {
    console.warn('listing-form callback: friend upsert/fetch failed — listing_link_completed をスキップ');
    return;
  }

  await fireEvent(
    env.DB,
    'listing_link_completed',
    {
      friendId: friend.id,
      eventData: {
        formId: ctx.form_id,
        displayName: profile.displayName,
        formInputName: ctx.display_name || null,
      },
    },
    env.LINE_CHANNEL_ACCESS_TOKEN,
  );
}

async function postSlackLinkNotification(
  env: Env['Bindings'],
  ctx: ListingStateV1,
  profile: { userId: string; displayName: string; pictureUrl?: string },
) {
  if (!env.SELLENTRY_SLACK_BOT_TOKEN || !env.SLACK_LISTING_LINK_CHANNEL_ID) {
    console.warn('listing-form callback: SELLENTRY_SLACK_BOT_TOKEN / SLACK_LISTING_LINK_CHANNEL_ID not configured — skipping');
    return;
  }
  // 注: ここは「LINEログイン完了」だけ（出品フォームとの突合は後段の突合ボットが実施）。
  const title = 'LINEログイン完了';
  // 各値はコードボックス（`…`）で囲って視認性を上げる。表示名も同様に囲う。
  const lines = [
    `:white_check_mark: *${title}*`,
    `Form ID: \`${codeField(ctx.form_id)}\``,
    `LINE userId: \`${codeField(profile.userId)}\``,
    `表示名: \`${codeField(profile.displayName)}\``,
  ];
  if (ctx.display_name) lines.push(`フォーム入力名: \`${codeField(ctx.display_name)}\``);

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${env.SELLENTRY_SLACK_BOT_TOKEN}`,
    },
    // 小さく見やすく: トップレベル text は付けない（「LINEログイン完了」の二重表示を防ぐ）。
    // 中身はカラーサイドバー付きアタッチメント1本。text/fallback を突合ボットが Form ID / LINE userId でパースする。
    body: JSON.stringify({
      channel: env.SLACK_LISTING_LINK_CHANNEL_ID,
      attachments: [
        {
          color: '#06C755',
          fallback: `${title} Form ID: \`${codeField(ctx.form_id)}\` LINE userId: \`${codeField(profile.userId)}\``,
          text: lines.join('\n'),
          mrkdwn_in: ['text'],
        },
      ],
    }),
  });
  const body = (await res.json()) as { ok: boolean; error?: string; ts?: string };
  if (!body.ok) {
    console.error('listing-form callback: slack chat.postMessage failed', body.error);
  }
}

function renderSuccessPage(displayName: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>連携完了</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hiragino Sans','Yu Gothic',system-ui,sans-serif;background:#0f172a;color:#fff;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{text-align:center;max-width:420px;width:90%;padding:48px 24px}
h1{font-size:26px;font-weight:800;margin-bottom:16px}
p{color:rgba(255,255,255,0.75);line-height:1.7;font-size:15px}
.note{font-size:12px;color:rgba(255,255,255,0.4);margin-top:32px}
</style>
</head>
<body>
<div class="card">
<h1>連携完了 🎉</h1>
<p>${escapeHtml(displayName)} さん、ありがとうございます。<br>追って LINE でご連絡いたします。</p>
<p class="note">このページは閉じていただいて構いません。</p>
</div>
</body>
</html>`;
}

function renderErrorPage(title: string, detail: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>エラー</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hiragino Sans','Yu Gothic',system-ui,sans-serif;background:#0f172a;color:#fff;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{text-align:center;max-width:420px;width:90%;padding:48px 24px}
h1{font-size:22px;font-weight:800;margin-bottom:16px;color:#fca5a5}
p{color:rgba(255,255,255,0.75);line-height:1.7;font-size:14px}
</style>
</head>
<body>
<div class="card">
<h1>${escapeHtml(title)}</h1>
${detail ? `<p>${escapeHtml(detail)}</p>` : ''}
</div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Neutralize Slack mrkdwn in user-supplied text: collapse newlines (blocks forged-line injection into
// the reconciliation post) and escape <,>,& (blocks <@mention> / <url|text>).
function slackEscape(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// For values rendered inside a `code span`: drop backticks and newlines so they cannot break out of
// the span or inject a forged field line that the reconciliation parser would read.
function codeField(s: string): string {
  return s.replace(/[`\r\n]+/g, ' ');
}

export { listingFormLine };
