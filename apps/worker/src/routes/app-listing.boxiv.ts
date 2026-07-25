// BOXIV-only: アプリ出品フローの LINE 連携（Portal アプリ → Web OAuth → カスタムスキーム復帰）。
//
// Portal アプリが flutter_web_auth_2 で /app-listing/start を開き、LINE ログイン後は
// 共有 callback（/link/callback）が署名 state の flow=app_listing でこのフローに委譲する。
// Tesla ログイン(handleTeslaOAuthRedirect + tesla_account_link_page.dart)と同型:
//   app → FlutterWebAuth2.authenticate(start URL, callbackUrlScheme: <app bundle id>)
//       → LINE OAuth → /link/callback → appListingFlow.complete
//       → 302 <app bundle id>://auth/line?linked=1&followed=<0|1>
//       → app が Uri.parse で分岐（followed=0 ならフォロー促し画面 #67）
//
// ⚠️ 復帰スキームは「app の bundle id」＝環境ごとに別（dev: jp.co.boxiv.portal.dev /
//    prod: jp.co.boxiv.portal）。ハードコードすると dev/prod のアプリが同じスキームを
//    奪い合い、別環境のアプリに戻ってしまう（実測: dev から本番アプリに飛んだ）。
//    そのため app が自分の bundle id を ?scheme= で渡し、Worker は許可リストで検証して
//    その scheme へ戻す。
//
// フォームフロー(listing_form)との違い:
//   - 相関キーは match_key ではなく boxivID（BOXIV ユーザーID）。app が署名 state に積む。
//   - Notion 行は submit（起票）が boxivID 入りで作っている前提。連携時は boxivID で
//     引き当てて LINE User ID を update する。
//   - 終端は web の HTML ページでなく、未フォローでもアプリの自スキームへ redirect。

import { Hono } from 'hono';
import { packSignedState, escapeHtml } from '../services/line-login.boxiv.js';
import type { LinkFlow, LinkStateBase } from '../services/line-login.boxiv.js';
import { linkSellerRowByBoxivId } from '../services/listing-notion.boxiv.js';
import { slackPost, buildSlackCard } from '../services/slack.boxiv.js';
import type { Env } from '../index.js';

const appListing = new Hono<Env>();

// アプリ復帰スキームの許可リスト（＝Portal の bundle id）。dev/prod でアプリが別なので
// スキームも別。app が自分の bundle id を渡し、ここで検証してからその scheme へ redirect する
// （許可外＝オープンリダイレクトは弾く）。
const ALLOWED_APP_SCHEMES = ['jp.co.boxiv.portal', 'jp.co.boxiv.portal.dev'];
// scheme 未指定/不正時の既定（本番アプリ側に倒す＝fail-safe）。
const DEFAULT_APP_SCHEME = 'jp.co.boxiv.portal';
const APP_RETURN_HOST_PATH = 'auth/line';

interface AppListingStateV1 extends LinkStateBase {
  /** BOXIV ユーザーID（= Cloud SQL User.userPublicId・英大文字+数字8桁 generatePublicId(8)）。app が署名 state に積む。Notion 連携の引き当てキー。 */
  boxiv_id: string;
  /** アプリ復帰スキーム（= app の bundle id）。dev/prod でアプリが別なので env ごとに異なる。許可リスト検証済み。 */
  return_scheme: string;
  display_name: string;
}

/**
 * GET /app-listing/start
 *
 * Portal アプリの「LINEで連携」から flutter_web_auth_2 で開かれる入口。
 * flow=app_listing の署名 state（boxivID・復帰スキームを含む）を作り、LINE Login OAuth へ 302。
 * redirect_uri は共有 callback /link/callback（listing_form と同じ URL を共有）。
 *
 * Query: boxiv_id（必須）/ scheme（= app の bundle id・許可リスト検証）/ display_name（任意）
 */
appListing.get('/app-listing/start', async (c) => {
  const boxivId = c.req.query('boxiv_id') ?? '';
  const displayName = c.req.query('display_name') ?? '';
  const schemeParam = c.req.query('scheme') ?? '';

  const reqUrl = new URL(c.req.url);
  const workerBase = (c.env.WORKER_URL || reqUrl.origin).replace(/\/+$/, '');

  // 署名 state と Notion query に載るので形状を制約（改行/制御文字の混入防止）。
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(boxivId)) {
    return c.json({ success: false, error: 'invalid boxiv_id' }, 400);
  }
  // 復帰スキームは許可リストのみ（オープンリダイレクト防止）。未指定は本番へ倒す。
  const returnScheme = ALLOWED_APP_SCHEMES.includes(schemeParam) ? schemeParam : DEFAULT_APP_SCHEME;
  if (!c.env.SESSION_SECRET) {
    return c.json({ success: false, error: 'SESSION_SECRET not configured' }, 500);
  }
  if (!c.env.LINE_LOGIN_CHANNEL_ID) {
    return c.json({ success: false, error: 'LINE_LOGIN_CHANNEL_ID not configured' }, 500);
  }

  const state = await packSignedState(
    { v: 1, flow: 'app_listing', boxiv_id: boxivId, return_scheme: returnScheme, display_name: displayName, ts: Date.now() } satisfies AppListingStateV1,
    c.env.SESSION_SECRET,
  );

  const callbackUrl = `${workerBase}/link/callback`;
  const loginUrl = new URL('https://access.line.me/oauth2/v2.1/authorize');
  loginUrl.searchParams.set('response_type', 'code');
  loginUrl.searchParams.set('client_id', c.env.LINE_LOGIN_CHANNEL_ID);
  loginUrl.searchParams.set('redirect_uri', callbackUrl);
  loginUrl.searchParams.set('scope', 'profile'); // profile のみ（id_token 未使用）
  loginUrl.searchParams.set('bot_prompt', 'aggressive'); // 毎回「友だち追加」を表示
  // アプリ側は url_launcher で外部ブラウザ/LINEアプリを開き、戻りを app_links の deep-link で受ける。
  // LINE アプリ login のようにセッションを抜ける往復に耐えるため、auto-login は止めない（LINEアプリ login 可）。
  loginUrl.searchParams.set('state', state);

  return c.redirect(loginUrl.toString());
});

/**
 * アプリ出品フローの連携確定処理。共有 callback（link-callback.boxiv.ts）から呼ばれる。
 * friend は共通前半で登録済み。ここでは Notion 連携（boxivID キー）＋アプリへのスキーム redirect。
 */
export const appListingFlow: LinkFlow<AppListingStateV1> = {
  async complete(c, ctx, profile, followStatus, _friend) {
    // boxivID キーで Notion 出品者DB の LINE User ID を update（行は submit 起票済みが前提）。非致命。
    try {
      const pageId = await linkSellerRowByBoxivId(c.env, {
        boxivId: ctx.boxiv_id,
        lineUserId: profile.userId,
      });
      if (!pageId) {
        // boxivID に対応する出品者行が無い（起票前提だが未検出）→ Slack で警告。
        // 通知先は env の SLACK_LISTING_LINK_CHANNEL_ID＝dev/prod で別チャンネル。別 try で握る（非致命）。
        try {
          const card = buildSlackCard({
            title: 'アプリ出品者のLINE連携に失敗しました',
            color: '#e01e5a', // 赤: 失敗・手動対応要
            omitTitleBlock: true,
            fields: [
              { label: 'BOXIV ID', value: `\`${ctx.boxiv_id}\`` },
              { label: 'LINE USER ID', value: `\`${profile.userId}\`` },
            ],
          });
          const text =
            '🔴 アプリ出品者のLINE連携に失敗しました\n' +
            'NOTIONにBOXIV IDが見つかりませんでした。手動対応をお願いします。';
          const r = await slackPost(c.env, text, { attachments: [card] });
          console.log(
            `app-listing: 出品者行なし → Slack 通知 ${r.ok ? 'OK' : `NG(${r.error})`} (boxiv_id=${ctx.boxiv_id})`,
          );
        } catch (slackErr) {
          console.error(`app-listing: Slack 通知 threw (boxiv_id=${ctx.boxiv_id})`, slackErr);
        }
      }
    } catch (err) {
      console.error(`app-listing: Notion lineUserId update failed (boxiv_id=${ctx.boxiv_id})`, err);
    }

    // TODO(#68/Q4): アプリ用の連携完了イベント（app_listing_link_completed）を発火し、
    //   フォロー促し/SMS・メール催促を automation で駆動する（listing_form の listing_link_completed と別イベント）。
    // TODO(#66/#73): 必要になれば boxivID → Cloud SQL User の紐付けをここに足す。

    // 終端: アプリの自スキームへ戻す。scheme は署名 state 内（start で許可リスト検証済み）＝改竄不可。
    // dev/prod で別アプリに戻る。followed=0 のとき app 側でフォロー促し画面を出す（#67）。
    //
    // 302 でカスタムスキームへ直接飛ばすと、外部 Safari が URL を Web ページとして開こうとして
    // 一瞬「サーバーに接続できません」が出る。HTML(200)＋JS で遷移すれば、画面を出さない
    // 空ページのままスキームへ handoff できる（app_links の deep-link 捕捉はそのまま効く）。
    const scheme = ALLOWED_APP_SCHEMES.includes(ctx.return_scheme) ? ctx.return_scheme : DEFAULT_APP_SCHEME;
    const followed = followStatus === true ? '1' : '0';
    const appUrl = `${scheme}://${APP_RETURN_HOST_PATH}?linked=1&followed=${followed}`;
    // 中間ページのハードニング: キャッシュ・フレーム埋め込み・外部リソース・リファラを封じる。
    // Referrer-Policy=no-referrer で、次遷移に callback URL（code/state 付き）を漏らさない。
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'");
    return c.html(renderSchemeHandoff(appUrl));
  },
};

/**
 * アプリの自スキームへ JS で即 handoff する中間ページ。
 * 画面は出さない（空ページ）— 302 直飛びの「サーバーに接続できません」を避けつつ、
 * deep-link 捕捉だけを行うための最小 HTML。JS 無効時のみ noscript のリンクを出す。
 */
function renderSchemeHandoff(appUrl: string): string {
  const safe = escapeHtml(appUrl);
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>リダイレクト中</title>
</head>
<body>
<noscript><a href="${safe}">アプリに戻る</a></noscript>
<script>
// 履歴から callback URL の code/state を消してからスキームへ handoff（Safari 履歴に残さない）。
try { history.replaceState(null, '', location.pathname); } catch (e) {}
location.replace(${JSON.stringify(appUrl)});
</script>
</body>
</html>`;
}

export { appListing };
