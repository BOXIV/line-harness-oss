// BOXIV-only: LINE Login 共有コールバック（フロー非依存の司令塔）。
//
// 複数フロー（出品フォーム / アプリ出品 / 劣化診断 …）の LINE 連携を、
// コールバック URL 1本（/link/callback）＋署名 state の `flow` で分岐して受ける
// （MTG 2026-07-16）。このファイルは flow に依存しない前半だけを持つ:
//   前半（共通）: state 検証 → OAuth code 交換 → profile 取得 → 実フォロー判定 → friend 登録
//   以降（フロー所有）: LINK_FLOWS[flow].complete(...) に丸ごと委譲。
//     データ書き込み＋イベント発火＋終端（描画/redirect）まで各フローが行い Response を返す。
//     終端はフロー依存（web は HTML ページ、アプリは自スキームへ redirect）のため共通化しない。
//
// フロー固有の実装（complete）は各フローのファイルにあり、ここは LINK_FLOWS に登録するだけ。
// フロー追加時はこの登録簿に1エントリ足す（callback 本体は変更しない）。

import { Hono } from 'hono';
import type { Context } from 'hono';
import { upsertFriend, getFriendByLineUserId } from '@line-crm/db';
import type { Friend } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { checkFollowing } from '../services/friendship.boxiv.js';
import {
  LINK_STATE_TTL_MS,
  unpackSignedState,
  exchangeLineCode,
  fetchLineProfile,
  escapeHtml,
} from '../services/line-login.boxiv.js';
import type { FlowId, LinkFlow, LinkStateBase } from '../services/line-login.boxiv.js';
import { listingFormFlow } from './listing-form-line.js';
import { appListingFlow } from './app-listing.boxiv.js';
import type { Env } from '../index.js';

const linkCallback = new Hono<Env>();

/**
 * 連携フローのレジストリ。callback は ctx.flow でここを引くだけ（本体は flow 非依存）。
 * フロー追加時はハンドラを実装してここに1エントリ足す（callback 本体は変更しない）。
 * app_listing はステージ③で追加予定。
 */
const LINK_FLOWS: Partial<Record<FlowId, LinkFlow>> = {
  listing_form: listingFormFlow,
  app_listing: appListingFlow,
};

/**
 * GET /link/callback — LINE Login 共有コールバック（フロー非依存の正 URL）。
 * GET /listing-form/callback — 旧 URL の互換エイリアス（本番切替後に console 登録・コードとも削除予定）。
 *
 * LINE Login redirects here after user grants permission.
 * Exchanges code for access_token, fetches profile, registers the friend, then hands off
 * to the flow's complete(...) which owns data writes + event + the terminal Response.
 */
const handleLinkCallback = async (c: Context<Env>) => {
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
    console.error('link callback: LINE_LOGIN_CHANNEL_ID / LINE_LOGIN_CHANNEL_SECRET not configured');
    return c.json({ success: false, error: 'LINE login not configured' }, 500);
  }

  // 共通フィールドだけで検証する（フロー固有フィールドは各 complete が解釈）。
  const ctx = await unpackSignedState<LinkStateBase>(stateParam, c.env.SESSION_SECRET);
  if (!ctx || ctx.v !== 1) {
    return c.html(renderErrorPage('リンクが無効です', 'お手数ですが、完了ページから連携をやり直してください。'), 400);
  }
  if (Date.now() - ctx.ts > LINK_STATE_TTL_MS) {
    return c.html(renderErrorPage('時間切れです', '連携の有効期限（30分）が切れました。完了ページから再度お試しください。'), 400);
  }

  // フロー分岐（MTG 2026-07-16: callback URL は1本、署名 state の flow で分岐）。
  // 旧 state（flow 無し）は listing_form 扱い（後方互換）。未登録の flow は明示エラー。
  const flow = ctx.flow ?? 'listing_form';
  const flowHandler = LINK_FLOWS[flow];
  if (!flowHandler) {
    console.error(`link callback: unknown flow (flow=${flow})`);
    return c.html(renderErrorPage('未対応の連携フローです', 'お手数ですが、最初から連携をやり直してください。'), 400);
  }

  const reqUrl = new URL(c.req.url);
  const workerBase = (c.env.WORKER_URL || reqUrl.origin).replace(/\/+$/, '');

  // Exchange code → tokens (redirect_uri must match the one sent in /start)。
  // 実際に受けたパスから導出する: 新旧どちらの URL で受けても authorize 時の redirect_uri と一致する。
  const callbackUrl = `${workerBase}${reqUrl.pathname}`;
  const exchanged = await exchangeLineCode(c.env, code, callbackUrl);
  if (!exchanged.ok) {
    // redact upstream body; keep status + flow for correlation
    console.error(`link callback: token exchange failed (status=${exchanged.status}, flow=${flow})`);
    return c.html(renderErrorPage('連携に失敗しました', 'お手数ですが、しばらくしてから完了ページより再度お試しください。'), 502);
  }
  const { tokens } = exchanged;

  // Fetch profile
  const profileRes = await fetchLineProfile(tokens.access_token);
  if (!profileRes.ok) {
    console.error(`link callback: profile fetch failed (status=${profileRes.status}, flow=${flow})`);
    return c.html(renderErrorPage('連携に失敗しました', 'プロフィールの取得に失敗しました。お手数ですが再度お試しください。'), 502);
  }
  const { profile } = profileRes;

  // 実フォロー状態を Messaging API で判定する。bot_prompt=aggressive でも友だち追加は任意で、
  // ユーザーがスキップすれば「連携済みだが未フォロー（=配信不達）」になる。LINE Login の
  // profile は友だち状態と無関係なので、Messaging API の /v2/bot/profile で実態を確認する。
  const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
  const followStatus = await checkFollowing(lineClient, profile.userId); // true=友だち / false=未追加 / null=判定不能

  // 友だちを D1 に upsert（全フロー共通の identity 登録）: 既に友だちで follow webhook が発火しない
  // ケースでも friend を確実に登録する。これで突合ボットの friend↔Notion 連携が lineUserId で friend を
  // 見つけられる。実フォロー判定値を渡し、未追加で連携しただけのユーザーを is_following=1 と誤検知させない
  // （null=判定不能のときは既存値を維持）。ここで1回だけ作り、その friend を各フローに渡す（二重 upsert 廃止）。
  let friend: Friend | null = null;
  try {
    friend = await upsertFriend(c.env.DB, {
      lineUserId: profile.userId,
      displayName: profile.displayName,
      pictureUrl: profile.pictureUrl ?? null,
      isFollowing: followStatus === null ? undefined : followStatus,
    });
  } catch (err) {
    // 競合（follow webhook と同時 INSERT）等 → 既存を取り直す。両方失敗なら null のまま各フローが判断。
    console.error(`link callback: upsertFriend failed (flow=${flow})`, err);
    friend = await getFriendByLineUserId(c.env.DB, profile.userId).catch(() => null);
  }

  // ここから先（フロー固有のデータ書き込み＋イベント発火＋終端の描画/redirect）はフローが所有する。
  // 終端はフロー依存（web は HTML ページ、アプリは自スキームへ redirect）なので Response をそのまま返す。
  return flowHandler.complete(c, ctx, profile, followStatus, friend);
};

linkCallback.get('/link/callback', handleLinkCallback);
linkCallback.get('/listing-form/callback', handleLinkCallback);

// ─── 終端ページ・共通ヘルパー（全フロー共通） ─────────────────

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

export { linkCallback };
