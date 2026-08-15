// BOXIV-only: 購入エントリー（lightning.boxiv.co.jp /car/detail/{掲載ID}#entry）の LINE 連携。
// 出品者フォーム（listing-form-line.ts）の購入者版で、フローも2段構成で同一:
//
//   1. 購入エントリーを送信 → クライアントが match_key(UUID) を採番
//   2. POST /buyer-form/submit で D1 台帳(listing_entries, source='buyer') へ upsert
//      ＋ Notion 購入者DB へ即ミラー起票（未連携）＋ Slack #pj-lightning-buy へカード投稿
//   3. 着地ページ /car/buy/line-connect の「LINEで連携」ボタン → GET /buyer-form/start
//   4. LINE Login OAuth（bot_prompt=aggressive）→ 共有 callback（buildLinkCallbackUrl で解決）
//      （callback URL はフロー非依存の1本なので LINE Developers 側の追加登録は不要）
//   5. buyerFormFlow.complete が markLinked → Notion PATCH → タグ「購入者」付与
//      → buyer_link_completed 発火 → Slack 更新 → 終端ページ/return_to
//
// 必要 env（Worker secrets。出品者フローと共有するものは既存）:
//   LINE_LOGIN_CHANNEL_ID / LINE_LOGIN_CHANNEL_SECRET / SESSION_SECRET  — 既存（共有）
//   NOTION_API_KEY / NOTION_BUYER_DB_ID                                 — 既存（購入者DB）
//   SELLENTRY_SLACK_BOT_TOKEN                                           — 既存（共有 bot）
//   SLACK_BUYER_LINK_CHANNEL_ID                                         — 新規 #pj-lightning-buy

import { Hono } from 'hono';
import type { Friend } from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import {
  upsertOnSubmit,
  markLinked,
  insertOrphanLink,
  setNotionPageId,
  setSlackThreadTs,
  markLinkCompletedNotified,
} from '../services/listing-entry.boxiv.js';
import { createOrUpdateBuyerRow, linkBuyerRow } from '../services/buyer-notion.boxiv.js';
import { ensureBuyerTag } from '../services/buyer-tag.boxiv.js';
import { lookupPostalCode } from '../services/jp-postal.boxiv.js';
import { slackPost, slackUpdate, buildSlackCard, escapeSlackText, slackChannelFor, slackTokenFor } from '../services/slack.boxiv.js';
import { packSignedState, isAllowedReturnTo, escapeHtml, buildLinkCallbackUrl } from '../services/line-login.boxiv.js';
import type { LinkFlow, LinkStateBase } from '../services/line-login.boxiv.js';
import type { Env } from '../index.js';

const buyerFormLine = new Hono<Env>();

/** 購入エントリー連携の署名 state。共通 LinkStateBase にフォーム固有フィールドを足す。 */
interface BuyerStateV1 extends LinkStateBase {
  form_id: string;
  display_name: string;
  /** エントリー対象車両の掲載ID（Slack/Notion 表示用。無くても連携は成立する） */
  listing_id?: string;
}

/**
 * GET /buyer-form/start
 *
 * 着地ページ（/car/buy/line-connect）の「LINEで連携」ボタンからの入口。
 * bot_prompt=aggressive で友だち追加を促しつつ LINE Login OAuth へ飛ばす。
 *
 * Query params:
 *   form_id      (required) — 購入エントリーの match_key
 *   return_to    (optional) — 連携後の戻り先（RETURN_TO_ALLOWED_HOSTS のみ）
 *   display_name (optional) — フォーム入力の氏名（終端ページ表示用）
 *   listing_id   (optional) — 掲載ID
 */
buyerFormLine.get('/buyer-form/start', async (c) => {
  const formId = c.req.query('form_id') ?? '';
  const returnTo = c.req.query('return_to') ?? '';
  const displayName = c.req.query('display_name') ?? '';
  const listingId = c.req.query('listing_id') ?? '';

  const reqUrl = new URL(c.req.url);
  // Canonical Worker base (per-env) so redirect_uri always matches a registered LINE Callback URL.
  const workerBase = (c.env.WORKER_URL || reqUrl.origin).replace(/\/+$/, '');

  if (!formId) {
    return c.json({ success: false, error: 'form_id is required' }, 400);
  }
  // form_id (= match_key) はクライアント生成の UUID / 短トークン。署名 state や Slack 投稿へ
  // 改行・バッククォート・制御文字を混入させられないよう形を固定する。
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(formId)) {
    return c.json({ success: false, error: 'invalid form_id' }, 400);
  }
  if (listingId && !/^[A-Za-z0-9_-]{1,32}$/.test(listingId)) {
    return c.json({ success: false, error: 'invalid listing_id' }, 400);
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
    {
      v: 1,
      flow: 'buyer_form',
      form_id: formId,
      return_to: returnTo,
      display_name: displayName,
      listing_id: listingId,
      ts: Date.now(),
    } satisfies BuyerStateV1,
    c.env.SESSION_SECRET,
  );

  // 共有 callback（フロー非依存）。出品者フローと同じ URL を使うので追加登録は不要だが、
  // ⚠️ redirect_uri は LINE Login チャネルに**登録済みの文字列と完全一致**でないと authorize が
  // 400 になり連携が全滅する（出品者フローで実障害あり）。prod は /link/callback が未登録なので
  // env LINE_LOGIN_CALLBACK_PATH で登録済みパスへ退避している。必ず共通ヘルパー経由で組み立てる。
  const callbackUrl = buildLinkCallbackUrl(c.env, workerBase);
  const loginUrl = new URL('https://access.line.me/oauth2/v2.1/authorize');
  loginUrl.searchParams.set('response_type', 'code');
  loginUrl.searchParams.set('client_id', c.env.LINE_LOGIN_CHANNEL_ID);
  loginUrl.searchParams.set('redirect_uri', callbackUrl);
  loginUrl.searchParams.set('scope', 'profile'); // profile のみ（id_token 未使用なので openid は付けない）
  loginUrl.searchParams.set('bot_prompt', 'aggressive');
  loginUrl.searchParams.set('state', state);

  return c.redirect(loginUrl.toString());
});

/**
 * GET /rb/:key — 購入者向け催促 SMS に載せる短縮リンク。
 * LIFF ラップ済みの /buyer-form/start へ 302（SMS で長い encoded URL を避ける）。
 * 出品者側の /r/:key と対になる（同じ key 空間だと source を取り違えるのでパスを分ける）。
 */
buyerFormLine.get('/rb/:key', (c) => {
  const key = c.req.param('key');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) return c.text('not found', 404);
  const base = (c.env.WORKER_URL || new URL(c.req.url).origin).replace(/\/+$/, '');
  const returnTo = c.env.BUYER_REMINDER_RETURN_TO || 'https://lightning.boxiv.co.jp/car/buy/thanks';
  const start = `${base}/buyer-form/start?form_id=${encodeURIComponent(key)}&return_to=${encodeURIComponent(returnTo)}`;
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

buyerFormLine.options('/buyer-form/submit', (c) => {
  applyCors(c);
  return c.body(null, 204);
});

/**
 * POST /buyer-form/submit
 *
 * 購入エントリーの送信“時点”で
 *   1) D1 台帳 listing_entries に upsert（正本・status=form_only, source=buyer）
 *   2) Notion 購入者DB へ即ミラー起票（未連携。match_key キー）
 *   3) Slack #pj-lightning-buy へカード投稿（連携完了/72hエスカレのスレッド親）
 * を行う。LINE userId は後続の callback で追記する。
 *
 * body: { match_key, fields:{label:value}, name?, phone?, email?, listing_id?, vehicle?, return_to? }
 */
buyerFormLine.post('/buyer-form/submit', async (c) => {
  applyCors(c);

  // 任意の共有トークン（設定時のみ必須）。出品者フォームと同じトークンを流用する。
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
  // フォームの name 属性は 'お名前'（表示ラベルは「お名前 (漢字)」）。旧名もフォールバックで拾う。
  const name = (body.name ? String(body.name) : (pick('お名前') || pick('お名前 (漢字)'))) || null;
  const emailRaw = (body.email ? String(body.email) : pick('メールアドレス')) || '';
  const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailRaw) ? emailRaw : null;
  const phoneRaw = (body.phone ? String(body.phone) : pick('電話番号')) || '';
  const phone = phoneRaw.replace(/[^\d+-]/g, '') || null;
  // 掲載ID（購入エントリーは車両ごと。/car/detail/{掲載ID} 由来。フォーム自身も hidden で持つ）
  const listingIdRaw = String(body.listing_id ?? body.listingId ?? pick('掲載ID') ?? '').trim();
  const listingId = /^[A-Za-z0-9_-]{1,32}$/.test(listingIdRaw) ? listingIdRaw : null;
  const vehicleRaw = String(body.vehicle ?? pick('車両') ?? '').trim();
  const vehicle = vehicleRaw ? vehicleRaw.slice(0, 200) : null;
  const reqHost = new URL(c.req.url).hostname;
  const returnTo = body.return_to && isAllowedReturnTo(String(body.return_to), reqHost) ? String(body.return_to) : null;

  // 掲載ID/車両サマリは form_data にも残す（台帳だけ見て突合できるように）
  const formData: Record<string, unknown> = { ...fields };
  if (listingId) formData['掲載ID'] = listingId;
  if (vehicle) formData['車両'] = vehicle;

  // 1) D1 台帳に upsert（正本）— 非致命
  await upsertOnSubmit(c.env.DB, { matchKey, formData, name, phone, email, returnTo, source: 'buyer' })
    .catch((e) => console.error('buyer-form submit: D1 upsert failed', e));

  // 2) 郵便番号（住所→API、ベストエフォート）
  let zip: string | null = pick('郵便番号') ?? null;
  if (!zip) {
    const addr = pick('ご住所');
    if (addr) zip = await lookupPostalCode(c.env, addr).catch(() => null);
  }

  // 3) Notion へ即ミラー起票（未連携）— 非致命
  try {
    const pageId = await createOrUpdateBuyerRow(c.env, { matchKey, formData, name, phone, email, zip, listingId, vehicle });
    if (pageId) await setNotionPageId(c.env.DB, matchKey, pageId);
  } catch (e) {
    console.error('buyer-form submit: Notion 起票 failed', e);
  }

  // 4) Slack #pj-lightning-buy へエントリー通知を投稿し ts を保存（連携完了/72hエスカレのスレッド親）— 非致命
  try {
    const card = buildBuyerFormCard({ name, phone, email, listingId, vehicle, matchKey, linked: false });
    const r = await slackPost(c.env, card.fallback as string, {
      attachments: [card],
      channel: slackChannelFor(c.env, 'buyer'),
      token: slackTokenFor(c.env, 'buyer'),
    });
    if (r.ok && r.ts) await setSlackThreadTs(c.env.DB, matchKey, r.ts);
  } catch (e) {
    console.error('buyer-form submit: Slack 通知 failed', e);
  }

  return c.json({ success: true }, 200);
});

// ─── フロー Strategy ─────────────────────────────────────────

/**
 * 購入エントリー連携の確定処理（データ書き込み＋終端）。
 * D1 台帳 markLinked（無ければ orphan）→ Notion 購入者DB PATCH → タグ「購入者」付与 →
 * buyer_link_completed 発火 → Slack 親メッセージ更新＋スレッド返信（すべて非致命）→ 終端 Response。
 */
export const buyerFormFlow: LinkFlow<BuyerStateV1> = {
  async complete(c, ctx, profile, followStatus, friend) {
    let notionPageId: string | null = null;
    let slackThreadTs: string | null = null;
    let linkedEntry: Awaited<ReturnType<typeof markLinked>> = null;
    // ⚠️ markLinked は follow webhook 側の「3秒ホールド再判定」(webhook.ts) が待つ書き込み。
    // この呼び出しより前に遅い外部処理（Notion/Slack 等）を挟むとホールドに間に合わず、
    // 連携ユーザへ挨拶を誤送するため、必ず complete 最初の書き込みのままにすること。
    try {
      const entry = await markLinked(c.env.DB, ctx.form_id, profile.userId, profile.displayName);
      if (!entry) {
        await insertOrphanLink(c.env.DB, ctx.form_id, profile.userId, profile.displayName, 'buyer');
      } else {
        linkedEntry = entry;
        notionPageId = entry.notion_page_id;
        slackThreadTs = entry.slack_thread_ts;
      }
    } catch (err) {
      console.error(`buyer-form callback: D1 markLinked failed (form_id=${ctx.form_id})`, err);
    }
    try {
      notionPageId = await linkBuyerRow(c.env, {
        matchKey: ctx.form_id,
        lineUserId: profile.userId,
        displayName: profile.displayName,
        knownPageId: notionPageId,
      }) ?? notionPageId;
    } catch (err) {
      console.error(`buyer-form callback: Notion linkBuyerRow failed (form_id=${ctx.form_id})`, err);
    }

    // タグ「購入者」を付与。/chats のステータス選択（購入者DBの options）と
    // リッチメニュー自動切替がこのタグを見るので、automation 設定に依存せずコードで確定させる。
    if (friend) {
      await ensureBuyerTag(c.env.DB, friend.id).catch((err) =>
        console.error(`buyer-form callback: ensureBuyerTag failed (friend=${friend.id})`, err),
      );
    }

    // 連携完了を `buyer_link_completed` として発火（何を送るかは管理UIの automation が決める）。
    await fireBuyerLinkCompleted(c.env, profile, ctx, followStatus, friend).catch((err) => {
      console.error('buyer-form callback: buyer_link_completed fire threw', err);
    });

    const buyerChannel = slackChannelFor(c.env, 'buyer');
    const buyerToken = slackTokenFor(c.env, 'buyer');

    // Slack: エントリー通知を「（LINE連携待ち）」→「（LINE連携済み）」に更新。非致命。
    if (slackThreadTs && linkedEntry) {
      try {
        const updated = buildBuyerFormCard({
          name: linkedEntry.name,
          phone: linkedEntry.phone,
          email: linkedEntry.email,
          listingId: pickFormValue(linkedEntry.form_data, '掲載ID'),
          vehicle: pickFormValue(linkedEntry.form_data, '車両'),
          matchKey: ctx.form_id,
          linked: true,
        });
        await slackUpdate(c.env, slackThreadTs, updated.fallback as string, {
          attachments: [updated],
          channel: buyerChannel,
          token: buyerToken,
        });
      } catch (err) {
        console.error(`buyer-form callback: slack update (連携済み) threw (form_id=${ctx.form_id})`, err);
      }
    }

    // Slack: エントリー通知スレッドに「連携完了」を返信。非致命。
    try {
      const notionUrl = notionPageId ? `https://www.notion.so/${notionPageId.replace(/-/g, '')}` : null;
      const card = buildSlackCard({
        title: '✅ LINE連携が完了しました（購入者）',
        color: '#2eb67d', // 緑: 完了
        omitTitleBlock: true, // 本体 text と重複するため attachment 内のタイトルは出さない
        fields: [
          { label: '表示名', value: escapeSlackText(profile.displayName) || '—' },
          { label: 'LINE userId', value: `\`${profile.userId}\`` },
          { label: 'Notion', value: notionUrl ? `<${notionUrl}|購入者リストを開く>` : null },
          { label: 'match_key', value: `\`${ctx.form_id}\`` },
        ],
      });
      await slackPost(c.env, card.fallback as string, {
        threadTs: slackThreadTs,
        attachments: [card],
        channel: buyerChannel,
        token: buyerToken,
      });
    } catch (err) {
      console.error(`buyer-form callback: slack post threw (form_id=${ctx.form_id})`, err);
    }

    // ─── 終端（web 向け）─────────────────────────────
    // 未フォローだと担当者からの連絡が届かないため、サンクスではなく友だち追加ページを出す。
    if (followStatus === false) {
      const basicId = await fetchBotBasicId(c.env.LINE_CHANNEL_ACCESS_TOKEN);
      return c.html(renderFriendAddPage(profile.displayName, basicId));
    }

    // return_to（with ?linked=1）へ redirect、無ければ success ページ。allowlist を再検証。
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

// ─── 終端ページ（web 向け・buyer_form 固有）───────────────────

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

/** 連携は完了したが OA 未追加の購入者に、友だち追加を促すページ。 */
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
<p>${escapeHtml(displayName)} さん、購入エントリーありがとうございます。<br>ご納車までのご案内をお届けするには<br><b>友だち追加</b>が必要です。</p>
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
<p>${escapeHtml(displayName)} さん、購入エントリーありがとうございます。<br>担当者より LINE でご連絡いたします。</p>
<p class="note">このページは閉じていただいて構いません。</p>
</div>
</body>
</html>`;
}

// ─── Slack カードヘルパー ─────────────────────────────────────

/** form_data(JSON) から指定ラベルの値を取り出す。 */
function pickFormValue(formDataJson: string | null | undefined, label: string): string | null {
  if (!formDataJson) return null;
  try {
    const o = JSON.parse(formDataJson) as Record<string, unknown>;
    const v = o[label];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

/** 購入エントリー通知カード。連携前(待ち=黄)と連携完了後(済み=緑)でタイトル・色だけ切り替える。 */
function buildBuyerFormCard(opts: {
  name: string | null;
  phone: string | null;
  email: string | null;
  listingId: string | null;
  vehicle: string | null;
  matchKey: string;
  linked: boolean;
}): Record<string, unknown> {
  return buildSlackCard({
    title: `🛒 購入エントリー（${opts.linked ? 'LINE連携済み' : 'LINE連携待ち'}）`,
    color: opts.linked ? '#2eb67d' : '#ECB22E', // 緑=連携済み / 黄=連携待ち
    omitTitleBlock: true, // 本体 text と重複するため attachment 内のタイトルは出さない
    fields: [
      { label: 'お名前', value: escapeSlackText(opts.name) || '—' },
      { label: '連絡先', value: [opts.phone, opts.email].filter(Boolean).map(escapeSlackText).join(' / ') || '—' },
      { label: '掲載ID', value: opts.listingId ? `\`${opts.listingId}\`` : null },
      { label: '車両', value: opts.vehicle ? escapeSlackText(opts.vehicle) : null },
      { label: 'match_key', value: `\`${opts.matchKey}\`` },
    ],
  });
}

// ─── helpers ─────────────────────────────────────────────────

/**
 * 連携完了時に `buyer_link_completed` イベントを発火する。
 *
 * 送る中身は管理UIの automation（eventType=buyer_link_completed）が決める。
 * 未フォロー時は送れないのでここでは発火せず、後で友だち追加された際に
 * follow webhook 側が連携済みを検知して発火する（救済フロー）。
 */
async function fireBuyerLinkCompleted(
  env: Env['Bindings'],
  profile: { userId: string; displayName: string; pictureUrl?: string },
  ctx: BuyerStateV1,
  followStatus: boolean | null,
  friend: Friend | null,
) {
  if (!friend) {
    console.warn('buyer-form callback: friend が無い — buyer_link_completed をスキップ');
    return;
  }
  if (followStatus !== true) {
    console.log(`buyer-form callback: 未フォローのため buyer_link_completed を保留（follow 時に送信） form_id=${ctx.form_id}`);
    return;
  }

  await fireEvent(
    env.DB,
    'buyer_link_completed',
    {
      friendId: friend.id,
      eventData: {
        formId: ctx.form_id,
        listingId: ctx.listing_id || null,
        displayName: profile.displayName,
        formInputName: ctx.display_name || null,
      },
    },
    env.LINE_CHANNEL_ACCESS_TOKEN,
  );
  // 二重送信防止: 送信済みフラグを立てる（follow webhook 側はこれを見て再送しない）。
  await markLinkCompletedNotified(env.DB, friend.id, 'buyer').catch((err) =>
    console.error('buyer-form callback: markLinkCompletedNotified failed', err),
  );
}

export { buyerFormLine };
