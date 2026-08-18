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
import type { Context } from 'hono';
import { packSignedState, escapeHtml, buildLinkCallbackUrl } from '../services/line-login.boxiv.js';
import type { LinkFlow, LinkStateBase } from '../services/line-login.boxiv.js';
import { linkSellerRowByBoxivId } from '../services/listing-notion.boxiv.js';
import { ensureSourceTag } from '../services/source-tag.boxiv.js';
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

  // listing_form と同じ共有 callback。登録済みパスは env で切替可（buildLinkCallbackUrl 参照）。
  const callbackUrl = buildLinkCallbackUrl(c.env, workerBase);
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
 * GET /app-listing/done — 連携完了ページ（再取得できる終端）。
 *
 * callback のレスポンス（handoff）は `code` が単回使用なので二度と再現できない。旧実装は
 * replaceState でクエリだけ剥がしていたため、iOS がタブを退避→再活性化して再読込すると
 * 「パラメータ無しの GET /link/callback」＝400『リクエストが不正です』が描画されていた
 * （連携は成功しているのに失敗表示になる）。handoff の replaceState 先をこの URL にすることで、
 * 再読込されても同じ完了ページが出る。
 *
 * ここには連携処理を持たない（表示専用）。復帰スキームは署名 state を経由できないため
 * クエリで受け、許可リストで検証する（オープンリダイレクト防止は start と同じ扱い）。
 *
 * Query: s（復帰スキーム = app の bundle id）/ f（友だち追加済みか '1'|'0'）
 */
appListing.get('/app-listing/done', (c) => {
  const schemeParam = c.req.query('s') ?? '';
  const scheme = ALLOWED_APP_SCHEMES.includes(schemeParam) ? schemeParam : DEFAULT_APP_SCHEME;
  // クエリの生値は通さない。'1' 以外は未フォロー扱い（アプリ側のフォロー促しを出す安全側）。
  const followed = c.req.query('f') === '1' ? '1' : '0';

  setTerminalPageHeaders(c);
  return c.html(
    renderDonePage({
      scheme,
      followed,
      userAgent: c.req.header('user-agent') ?? '',
      // 再読込で来た＝ユーザーが意図してブラウザ側にいる可能性があるので自動遷移しない。
      autoRedirect: false,
    }),
  );
});

/**
 * アプリ出品フローの連携確定処理。共有 callback（link-callback.boxiv.ts）から呼ばれる。
 * friend は共通前半で登録済み。ここでは Notion 連携（boxivID キー）＋タグ「出品者」＋
 * アプリへのスキーム redirect。
 */
export const appListingFlow: LinkFlow<AppListingStateV1> = {
  async complete(c, ctx, profile, followStatus, friend) {
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

    // タグ「出品者」を付与。アプリ出品も出品者なのでフォーム出品と同じ分類にする
    // （/chats の出品者/購入者タブ・ステータス選択・リッチメニュー自動切替が見る）。非致命。
    if (friend) {
      await ensureSourceTag(c.env.DB, friend.id, 'seller').catch((err) =>
        console.error(`app-listing: ensureSourceTag failed (friend=${friend.id})`, err),
      );
    }

    // TODO(#68/Q4): アプリ用の連携完了イベント（app_listing_link_completed）を発火し、
    //   フォロー促し/SMS・メール催促を automation で駆動する（listing_form の listing_link_completed と別イベント）。
    // TODO(#66/#73): 必要になれば boxivID → Cloud SQL User の紐付けをここに足す。

    // 終端: アプリの自スキームへ戻す。scheme は署名 state 内（start で許可リスト検証済み）＝改竄不可。
    // dev/prod で別アプリに戻る。followed=0 のとき app 側でフォロー促し画面を出す（#67）。
    //
    // 302 でカスタムスキームへ直接飛ばすと、外部 Safari が URL を Web ページとして開こうとして
    // 一瞬「サーバーに接続できません」が出る。HTML(200)＋JS で遷移すれば、その画面を出さずに
    // スキームへ handoff できる（app_links の deep-link 捕捉はそのまま効く）。
    const scheme = ALLOWED_APP_SCHEMES.includes(ctx.return_scheme) ? ctx.return_scheme : DEFAULT_APP_SCHEME;
    const followed = followStatus === true ? '1' : '0';
    setTerminalPageHeaders(c);
    return c.html(
      renderDonePage({
        scheme,
        followed,
        userAgent: c.req.header('user-agent') ?? '',
        // callback のレスポンスなので自動遷移する。Safari はこれで即アプリへ戻る。
        autoRedirect: true,
      }),
    );
  },
};

/** 終端ページ共通のハードニング（キャッシュ・フレーム埋め込み・外部リソース・リファラを封じる）。 */
function setTerminalPageHeaders(c: Context<Env>): void {
  // Referrer-Policy=no-referrer で、次遷移に callback URL（code/state 付き）を漏らさない。
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');
  // style-src はインライン CSS（完了ページの見た目）に必要。外部リソースは引き続き全面禁止。
  c.header('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'");
}

/**
 * アプリ復帰 URL を作る。
 * Android の Chrome は素のカスタムスキームより intent:// を推奨しており、package 指定で
 * 候補アプリの曖昧さも消せる（本アプリは applicationId == scheme）。iOS はスキームのまま。
 */
function buildAppReturnUrl(scheme: string, followed: string, userAgent: string): string {
  const query = `linked=1&followed=${followed}`;
  if (/Android/i.test(userAgent)) {
    return `intent://${APP_RETURN_HOST_PATH}?${query}#Intent;scheme=${scheme};package=${scheme};end`;
  }
  return `${scheme}://${APP_RETURN_HOST_PATH}?${query}`;
}

interface DonePageOptions {
  /** 復帰先スキーム（= app の bundle id）。許可リスト検証済みの値のみ渡すこと。 */
  scheme: string;
  /** '1'=友だち追加済み / '0'=未追加。アプリ側のフォロー促し分岐（#67）に渡る。 */
  followed: string;
  /** intent:// 出し分けのため。 */
  userAgent: string;
  /**
   * true=自動遷移 + replaceState を仕込む（callback のレスポンス用）。
   * false=ボタンのみ（/app-listing/done 用）。done で自動遷移してはいけない:
   * ユーザーが意図してブラウザに戻った可能性があり、かつ Chrome は連続した
   * 外部アプリ起動に確認プロンプトを出すため。
   */
  autoRedirect: boolean;
}

/**
 * LINE 連携の完了ページ。callback の終端（自動遷移あり）と /app-listing/done（ボタンのみ）で
 * 同じ見た目を共有する。両者でユーザーの状況は同じ（ブラウザにいる・アプリに戻りたい・
 * 連携が無事か知りたい）ので、差分は JS の有無だけにしている。
 *
 * 可視のボタンが要るのは、iOS/Android の Chrome が「リンクのタップ起点でない」外部アプリ遷移を
 * 自動実行しないため（Chromium の app_launcher_tab_helper が link_transition で分岐する）。
 * 自動遷移だけに頼っていた旧実装は、Chrome だと真っ白な画面で詰んでいた。
 *
 * トンマナは lightning.boxiv.co.jp 準拠（白基調・Noto Sans JP・黒のピル型 CTA）。
 * Web フォントは読み込まない: CSP が外部取得を禁じている上、Safari では 100〜300ms しか
 * 表示されないページにネットワーク待ちを足す価値がないため、端末フォントへフォールバックする。
 */
function renderDonePage({ scheme, followed, userAgent, autoRedirect }: DonePageOptions): string {
  const appUrl = buildAppReturnUrl(scheme, followed, userAgent);
  const safeAppUrl = escapeHtml(appUrl);
  // 再読込しても再現できる URL。code/state を履歴から消しつつ、旧実装のように
  // 「パラメータ無しの /link/callback」（= 400 リクエストが不正です）を履歴に残さない。
  const doneUrl = `/app-listing/done?s=${encodeURIComponent(scheme)}&f=${followed}`;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LINE連携が完了しました</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"Noto Sans JP",-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;
  background:#fff;color:#1a1a1a;display:flex;justify-content:center;align-items:center;padding:24px 0;
  /* iOS の 100vh はツールバーを除いた「大きい方」の高さなので、下部ツールバーに隠れる分まで
     含めて中央揃えされ、見えている範囲の中心より下にずれる。dvh は現在の表示高さを指す。
     未対応ブラウザ向けに 100vh を先に置いてフォールバックさせる。 */
  min-height:100vh;min-height:100dvh}
.card{text-align:center;max-width:420px;width:88%}
.mark{width:48px;height:48px;border-radius:50%;background:#e8fbe5;display:flex;align-items:center;justify-content:center;margin:0 auto 18px;font-size:24px;line-height:1;color:#05a800;font-weight:700}
h1{font-size:22px;font-weight:700;margin-bottom:10px;letter-spacing:-.01em}
p{color:#666;line-height:1.8;font-size:15px}
.btn{display:block;margin-top:26px;padding:16px;border-radius:999px;font-size:16px;font-weight:700;
  text-decoration:none;background:#1a1a1a;color:#fff}
.hint{font-size:12.5px;color:#8a8a8a;margin-top:12px;line-height:1.6}
.fallback{display:none;font-size:13px;color:#666;margin-top:20px;padding-top:16px;border-top:1px solid #e8e8e8;line-height:1.75}
.fallback.on{display:block}
.fallback b{color:#1a1a1a}
</style>
</head>
<body>
<div class="card">
<div class="mark">✓</div>
<h1>LINE連携が完了しました</h1>
<p>Portalアプリに戻って、<br>続きを進めてください。</p>
<a href="${safeAppUrl}" class="btn" id="back">Portalアプリに戻る</a>
<p class="hint">確認が表示されたら「開く」を選んでください</p>
<div class="fallback" id="fb">
戻れないときは、ホーム画面から<b>Portalアプリ</b>を開いてください。<br>
LINE連携はすでに完了しているので、やり直す必要はありません。
</div>
</div>
<script>
// ボタンを押しても戻れなかった人（確認ダイアログでキャンセルした・アプリ未インストール）に、
// 「押したのに無反応＝壊れている」と読ませないための補助テキスト。
document.getElementById('back').addEventListener('click', function () {
  var fb = document.getElementById('fb');
  fb.classList.add('on');
  if (fb.scrollIntoView) fb.scrollIntoView({ block: 'nearest' });
});
${
  autoRedirect
    ? `// 履歴の code/state を消し、再読込しても同じ完了ページを出せる URL に置き換える。
try { history.replaceState(null, '', ${JSON.stringify(doneUrl)}); } catch (e) {}
// Safari はここで即アプリへ戻る。Chrome は自動実行しないため上のボタンが受け皿になる。
location.replace(${JSON.stringify(appUrl)});`
    : `// done ページは自動遷移しない（上の autoRedirect の説明を参照）。`
}
</script>
</body>
</html>`;
}

export { appListing };
