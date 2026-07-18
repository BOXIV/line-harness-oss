// BOXIV-only: LINE Login integration for STUDIO listing form on lightning.boxiv.co.jp.
//
// Flow:
//   1. User submits STUDIO form on lightning.boxiv.co.jp
//   2. STUDIO posts form fields to Slack #pj-lightning-sell (existing — handled by STUDIO)
//   3. Page shows "LINEで連携" button that redirects to:
//        GET /listing-form/start?form_id=XXX&return_to=YYY[&display_name=ZZZ]
//   4. We redirect to LINE Login OAuth with bot_prompt=aggressive (always shows the friend-add prompt; user must tap to add)
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
import type { Friend } from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { upsertOnSubmit, markLinked, insertOrphanLink, setNotionPageId, setSlackThreadTs, markListingPriceNotified } from '../services/listing-entry.boxiv.js';
import { createOrUpdateSellerRow, linkSellerRow } from '../services/listing-notion.boxiv.js';
import { lookupPostalCode } from '../services/jp-postal.boxiv.js';
import { slackPost, slackUpdate, buildSlackCard, escapeSlackText } from '../services/slack.boxiv.js';
import {
  packSignedState,
  isAllowedReturnTo,
  escapeHtml,
} from '../services/line-login.boxiv.js';
import type { LinkFlow, LinkStateBase } from '../services/line-login.boxiv.js';
import type { Env } from '../index.js';

const listingFormLine = new Hono<Env>();

// HMAC 署名 state / OAuth 交換 / return_to 許可判定は services/line-login.boxiv.ts に集約（複数フロー共有）。

// ─── Routes ──────────────────────────────────────────────────

// フロー Strategy の契約（FlowId / LinkFlow / LinkStateBase）は services/line-login.boxiv.ts に集約。
// ここは listing_form フロー固有の state と実装だけを持つ。

/** 出品フォーム連携の署名 state。共通 LinkStateBase にフォーム固有フィールドを足す。 */
interface ListingStateV1 extends LinkStateBase {
  form_id: string;
  display_name: string;
}

/**
 * GET /listing-form/start
 *
 * Entry point from lightning.boxiv.co.jp's "LINEで連携" button.
 * Redirects user to LINE Login OAuth with bot_prompt=aggressive so the user is
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

  const state = await packSignedState(
    { v: 1, flow: 'listing_form', form_id: formId, return_to: returnTo, display_name: displayName, ts: Date.now() } satisfies ListingStateV1,
    c.env.SESSION_SECRET,
  );

  // 共有 callback（フロー非依存の /link/callback）。LINE Login チャネルの Callback URL 登録が必要
  // （test/prod 各 Worker の URL）。旧 /listing-form/callback は互換エイリアス（本番切替後に削除予定）。
  const callbackUrl = `${workerBase}/link/callback`;
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

/**
 * GET /r/:key — SMS 等に載せる短縮リンク。
 * LIFF ラップ済みの /listing-form/start へ 302。SMS で長い encoded URL を避けるため。
 */
listingFormLine.get('/r/:key', (c) => {
  const key = c.req.param('key');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) return c.text('not found', 404);
  const base = (c.env.WORKER_URL || new URL(c.req.url).origin).replace(/\/+$/, '');
  const returnTo = 'https://lightning.boxiv.co.jp/car/sell/thanks';
  const start = `${base}/listing-form/start?form_id=${encodeURIComponent(key)}&return_to=${encodeURIComponent(returnTo)}`;
  const liffUrl = c.env.LIFF_URL || '';
  const target = /liff\.line\.me\/[0-9]+-[A-Za-z0-9]+/.test(liffUrl)
    ? `${liffUrl}?redirect=${encodeURIComponent(start)}`
    : start;
  return c.redirect(target, 302);
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

  // 4) Slack #pj-lightning-sell へフォーム通知を投稿し ts を保存（連携完了/72hエスカレのスレッド親）— 非致命
  try {
    const carModel = pick('メーカー/車種') || pick('車種') || null;
    const card = buildListingFormCard({ name, phone, email, carModel, matchKey, linked: false });
    const r = await slackPost(c.env, card.fallback as string, { attachments: [card] });
    if (r.ok && r.ts) await setSlackThreadTs(c.env.DB, matchKey, r.ts);
  } catch (e) {
    console.error('listing-form submit: Slack 通知 failed', e);
  }

  return c.json({ success: true }, 200);
});

// ─── フロー Strategy ─────────────────────────────────────────

/**
 * 出品フォーム（STUDIO / web）連携の確定処理（データ書き込み＋終端）。
 * D1 台帳 markLinked（無ければ orphan）→ Notion 出品者DB 起票 → listing_link_completed 発火 →
 * Slack 親メッセージ更新＋スレッド返信（すべて非致命）→ 終端 Response を返す。
 * 終端は web 向け: 未フォロー→友だち追加ページ / return_to→?linked=1 / それ以外→success ページ。
 */
export const listingFormFlow: LinkFlow<ListingStateV1> = {
  async complete(c, ctx, profile, followStatus, friend) {
    // BOXIV: D1 台帳 + Notion を match_key で「連携済み」に更新（旧 reconcile-daemon の Notion 起票を Worker に集約）。
    // フォーム送信時に submit で起票済みの行へ lineUserId を追記。form_submit が無い直リンクは orphan 行を作る。非致命。
    let notionPageId: string | null = null;
    let slackThreadTs: string | null = null;
    let linkedEntry: Awaited<ReturnType<typeof markLinked>> = null;
    // ⚠️ markLinked は follow webhook 側の「3秒ホールド再判定」(webhook.ts) が待つ書き込み。
    // この呼び出しより前に遅い外部処理（Notion/Slack 等）を挟むとホールドに間に合わず、
    // 連携ユーザへ挨拶を誤送するため、必ず complete 最初の書き込みのままにすること。
    try {
      const entry = await markLinked(c.env.DB, ctx.form_id, profile.userId, profile.displayName);
      if (!entry) {
        await insertOrphanLink(c.env.DB, ctx.form_id, profile.userId, profile.displayName);
      } else {
        linkedEntry = entry;
        notionPageId = entry.notion_page_id;
        slackThreadTs = entry.slack_thread_ts;
      }
    } catch (err) {
      console.error(`link callback: D1 markLinked failed (form_id=${ctx.form_id})`, err);
    }
    try {
      await linkSellerRow(c.env, {
        matchKey: ctx.form_id,
        lineUserId: profile.userId,
        displayName: profile.displayName,
        knownPageId: notionPageId,
      });
    } catch (err) {
      console.error(`link callback: Notion linkSellerRow failed (form_id=${ctx.form_id})`, err);
    }

    // BOXIV: 自動連携完了を `listing_link_completed` イベントとして発火（S-03 はデータ駆動）。
    // 何を送るかは管理UIの automation 側で決める。非致命 — 失敗してもリダイレクトは完了。
    // friend は共通前半で登録済みのものを受け取る（フロー内で再 upsert しない）。
    await fireListingLinkCompleted(c.env, profile, ctx, followStatus, friend).catch((err) => {
      console.error('link callback: listing_link_completed fire threw', err);
    });

    // Slack: トップのフォーム送信通知を「（LINE連携待ち）」→「（LINE連携済み）」に更新（親メッセージを書換）。非致命。
    if (slackThreadTs && linkedEntry) {
      try {
        const updated = buildListingFormCard({
          name: linkedEntry.name,
          phone: linkedEntry.phone,
          email: linkedEntry.email,
          carModel: pickCarModel(linkedEntry.form_data),
          matchKey: ctx.form_id,
          linked: true,
        });
        await slackUpdate(c.env, slackThreadTs, updated.fallback as string, { attachments: [updated] });
      } catch (err) {
        console.error(`link callback: slack update (連携済み) threw (form_id=${ctx.form_id})`, err);
      }
    }

    // Slack: フォーム通知スレッドに「連携完了」を返信（thread_ts があればスレッド、無ければ単発）。非致命。
    try {
      const notionUrl = notionPageId ? `https://www.notion.so/${notionPageId.replace(/-/g, '')}` : null;
      const card = buildSlackCard({
        title: '✅ LINE連携が完了しました',
        color: '#2eb67d', // 緑: 完了
        omitTitleBlock: true, // 本体 text と重複するため attachment 内のタイトルは出さない
        fields: [
          { label: '表示名', value: escapeSlackText(profile.displayName) || '—' },
          { label: 'LINE userId', value: `\`${profile.userId}\`` },
          { label: 'Notion', value: notionUrl ? `<${notionUrl}|出品者リストを開く>` : null },
          { label: 'match_key', value: `\`${ctx.form_id}\`` },
        ],
      });
      await slackPost(c.env, card.fallback as string, { threadTs: slackThreadTs, attachments: [card] });
    } catch (err) {
      console.error(`link callback: slack post threw (form_id=${ctx.form_id})`, err);
    }

    // ─── 終端（web 向け）─────────────────────────────
    // 未フォロー（友だち追加を断った/まだ追加していない）の場合は、サンクスページではなく
    // 友だち追加ページを表示する。連携（match_key↔lineUserId、Notion 起票）は完了しているが、
    // 友だち追加が無いとメッセージが届かないため。追加後は follow webhook が受信を有効化する。
    if (followStatus === false) {
      const basicId = await fetchBotBasicId(c.env.LINE_CHANNEL_ACCESS_TOKEN);
      return c.html(renderFriendAddPage(profile.displayName, basicId));
    }

    // return_to（with ?linked=1）へ redirect、無ければ success ページ。
    // allowlist を再検証（defense-in-depth）。
    if (ctx.return_to && isAllowedReturnTo(ctx.return_to, new URL(c.req.url).hostname)) {
      try {
        const url = new URL(ctx.return_to);
        url.searchParams.set('linked', '1');
        return c.redirect(url.toString());
      } catch {
        // fall through to default success page if return_to was somehow malformed
      }
    }
    return c.html(renderSuccessPage(profile.displayName));
  },
};

// ─── 終端ページ（web 向け・listing_form 固有）─────────────────

/** Messaging API の /v2/bot/info から OA の basicId（@xxxx）を取得。友だち追加URLの組み立てに使う。 */
async function fetchBotBasicId(channelAccessToken: string): Promise<string> {
  try {
    const res = await fetch('https://api.line.me/v2/bot/info', {
      headers: { Authorization: `Bearer ${channelAccessToken}` },
    });
    if (res.ok) {
      const bot = (await res.json()) as { basicId?: string };
      return bot.basicId || '';
    }
  } catch {
    // ignore — basicId 無しでもページは表示する
  }
  return '';
}

/**
 * 連携は完了したが OA を友だち追加していない出品者に、友だち追加を促すページ。
 * 追加しないと撮影日程調整などの連絡が届かないため、サンクスページではなくこの画面を出す。
 */
function renderFriendAddPage(displayName: string, basicId: string): string {
  const addUrl = basicId ? `https://line.me/R/ti/p/${escapeHtml(basicId)}` : '';
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>あと少しで完了</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hiragino Sans','Yu Gothic',system-ui,sans-serif;background:#0f172a;color:#fff;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{text-align:center;max-width:420px;width:90%;padding:48px 24px}
h1{font-size:24px;font-weight:800;margin-bottom:12px}
p{color:rgba(255,255,255,0.78);line-height:1.7;font-size:15px}
.btn{display:block;margin-top:28px;padding:16px;border-radius:10px;font-size:16px;font-weight:700;text-decoration:none;background:#06C755;color:#fff}
.note{font-size:12px;color:rgba(255,255,255,0.45);margin-top:20px;line-height:1.6}
</style>
</head>
<body>
<div class="card">
<h1>あと少しで完了です</h1>
<p>${escapeHtml(displayName)} さん、連携ありがとうございます。<br>担当者からのご連絡をお届けするには<br><b>友だち追加</b>が必要です。</p>
${addUrl ? `<a href="${addUrl}" class="btn">LINEで友だち追加する</a>` : `<p class="note">お手数ですが LINE 公式アカウントを検索して友だち追加してください。</p>`}
<p class="note">追加後、メッセージが届くようになります。<br>このページは閉じていただいて構いません。</p>
</div>
</body>
</html>`;
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

// ─── Slack カードヘルパー ─────────────────────────────────────

/** form_data(JSON) から車種を抽出（「メーカー/車種」優先、無ければ「車種」）。 */
function pickCarModel(formDataJson: string | null | undefined): string | null {
  if (!formDataJson) return null;
  try {
    const o = JSON.parse(formDataJson) as Record<string, unknown>;
    const v = o['メーカー/車種'] ?? o['車種'];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

/** 出品フォーム送信通知カード。連携前(待ち=黄)と連携完了後(済み=緑)でタイトル・色だけ切り替える。 */
function buildListingFormCard(opts: {
  name: string | null;
  phone: string | null;
  email: string | null;
  carModel: string | null;
  matchKey: string;
  linked: boolean;
}): Record<string, unknown> {
  return buildSlackCard({
    title: `🆕 出品フォーム送信（${opts.linked ? 'LINE連携済み' : 'LINE連携待ち'}）`,
    color: opts.linked ? '#2eb67d' : '#ECB22E', // 緑=連携済み / 黄=連携待ち
    omitTitleBlock: true, // 本体 text と重複するため attachment 内のタイトルは出さない
    fields: [
      { label: 'お名前', value: escapeSlackText(opts.name) || '—' },
      { label: '連絡先', value: [opts.phone, opts.email].filter(Boolean).map(escapeSlackText).join(' / ') || '—' },
      { label: '車種', value: opts.carModel ? escapeSlackText(opts.carModel) : null },
      { label: 'match_key', value: `\`${opts.matchKey}\`` },
    ],
  });
}

// ─── helpers ─────────────────────────────────────────────────

/**
 * 自動連携 完了時に `listing_link_completed` イベントを発火する。
 *
 * event-bus の send_message アクションは friends 行（line_user_id）を要求するため、
 * 先に friend を upsert して存在を保証する。follow webhook（bot_prompt=aggressive で
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
  followStatus: boolean | null,
  friend: Friend | null,
) {
  // friend は共通前半（link-callback）で登録済みのものを受け取る（ここでは upsert しない）。
  if (!friend) {
    console.warn('listing-form callback: friend が無い — listing_link_completed をスキップ');
    return;
  }

  // フォロー済みのときだけ価格お知らせ(listing_link_completed)を発火する。
  // 未フォロー（友だち追加を後回し/ブロック）の場合は送れないのでここでは発火せず、
  // 後で友だち追加が完了した際に follow webhook 側が連携済みを検知して発火する（救済フロー）。
  if (followStatus !== true) {
    console.log(`listing-form callback: 未フォローのため listing_link_completed を保留（follow 時に送信） form_id=${ctx.form_id}`);
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
  // 二重送信防止: 送信済みフラグを立てる（follow webhook 側はこれを見て再送しない）。
  await markListingPriceNotified(env.DB, friend.id).catch((err) =>
    console.error('listing-form callback: markListingPriceNotified failed', err),
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
