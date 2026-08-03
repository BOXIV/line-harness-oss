import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { LineClient } from '@line-crm/line-sdk';
import { processStepDeliveries } from './services/step-delivery.js';
import { processScheduledBroadcasts } from './services/broadcast.js';
import { processReminderDeliveries } from './services/reminder-delivery.js';
import { processScheduledMessages } from './services/scheduled-message-delivery.boxiv.js';
import { processListingFormReminders } from './services/listing-reminder.boxiv.js';
import { processSlackBurstNotify } from './services/slack-burst-notify.boxiv.js';
import { checkAccountHealth } from './services/ban-monitor.js';
import { refreshLineAccessTokens } from './services/token-refresh.js';
import { authMiddleware } from './middleware/auth.js';
import { rateLimitMiddleware } from './middleware/rate-limit.js';
import { webhook } from './routes/webhook.js';
import { friends } from './routes/friends.js';
import { tags } from './routes/tags.js';
import { scenarios } from './routes/scenarios.js';
import { broadcasts } from './routes/broadcasts.js';
import { users } from './routes/users.js';
import { lineAccounts } from './routes/line-accounts.js';
import { conversions } from './routes/conversions.js';
import { affiliates } from './routes/affiliates.js';
import { openapi } from './routes/openapi.js';
import { liffRoutes } from './routes/liff.js';
// Round 3 ルート
import { webhooks } from './routes/webhooks.js';
import { calendar } from './routes/calendar.js';
import { reminders } from './routes/reminders.js';
import { scoring } from './routes/scoring.js';
import { templates } from './routes/templates.js';
import { chats } from './routes/chats.js';
import { notifications } from './routes/notifications.js';
import { stripe } from './routes/stripe.js';
import { health } from './routes/health.js';
import { automations } from './routes/automations.js';
import { richMenus } from './routes/rich-menus.js';
import { trackedLinks } from './routes/tracked-links.js';
import { forms } from './routes/forms.js';
import { adPlatforms } from './routes/ad-platforms.js';
import { staff } from './routes/staff.js';
import { images } from './routes/images.js';
// 撮影予約システム
import { booking } from './routes/booking.js';
import { bookingInvites } from './routes/booking-invites.js';
import { bookingRequests } from './routes/booking-requests.js';
import { staffAvailability } from './routes/staff-availability.js';
// 出品フォーム LINE 連携 (BOXIV)
import { listingFormLine } from './routes/listing-form-line.js';
// アプリ出品 LINE 連携（Portal アプリ・BOXIV）
import { appListing } from './routes/app-listing.boxiv.js';
// LINE Login 共有コールバック（フロー非依存の司令塔・BOXIV）
import { linkCallback } from './routes/link-callback.boxiv.js';
// バッテリー劣化診断 LIFF フォーム (BOXIV)
import { diagnosisForm } from './routes/diagnosis-form.boxiv.js';
// 最安EVピックアップ日次更新 (BOXIV)
import { refreshCheapestListings } from './services/cheapest-listings.boxiv.js';
import { backfillDiagnosisSpecs } from './services/diagnosis-spec-backfill.boxiv.js';
// 顧客ステータス (Notion 同期, BOXIV)
import { friendStatus } from './routes/friend-status.boxiv.js';
// 個別チャット送信予約 (BOXIV)
import { scheduledMessages } from './routes/scheduled-messages.boxiv.js';
// チャット用メディア (画像 / 動画 / PDF, BOXIV)
import { media } from './routes/media.boxiv.js';
// 友だち↔Notion 連携 (BOXIV)
import { friendNotion } from './routes/friend-notion.boxiv.js';
// リッチメニュー × 顧客ステータス マッピング (BOXIV)
import { richMenuStatus } from './routes/rich-menu-status.boxiv.js';
// 既存フォロワーの一括インポート (BOXIV, Lステップ移行)
import { friendImport } from './routes/friend-import.boxiv.js';
// prod スキーマ整合 (BOXIV, bootstrap 取りこぼし列の補填)
import { schemaReconcile } from './routes/schema-reconcile.boxiv.js';
import { notionWebhook } from './routes/notion-webhook.boxiv.js';
import { reconcileNotionStatuses } from './services/notion-status-sync.boxiv.js';
// 監査ログ（管理操作の変更証跡, BOXIV）
import { auditLogMiddleware } from './middleware/audit-log.boxiv.js';
import { auditLogs } from './routes/audit-logs.boxiv.js';

export type Env = {
  Bindings: {
    DB: D1Database;
    IMAGES: R2Bucket;
    LINE_CHANNEL_SECRET: string;
    LINE_CHANNEL_ACCESS_TOKEN: string;
    API_KEY: string;
    LIFF_URL: string;
    LINE_CHANNEL_ID: string;
    LINE_LOGIN_CHANNEL_ID: string;
    LINE_LOGIN_CHANNEL_SECRET: string;
    WORKER_URL: string;
    CHAT_ALERT_SLACK_BOT_TOKEN?: string;   // BOXIV: 受信メッセージを Slack 通知する Bot トークン（未設定なら無効）
    CHAT_ALERT_SLACK_CHANNEL_ID?: string;  // BOXIV: 同上 通知先チャンネル ID
    X_HARNESS_URL?: string;  // Optional: X Harness API URL for account linking
    SESSION_SECRET?: string;  // 撮影予約セッションCookie署名用
    BOOKING_BASE_URL?: string;  // 撮影予約リンクのベースURL（未設定時はWORKER_URL or origin）
    // Notion連携（撮影予約 招待生成時にお客様情報を取得）
    NOTION_API_KEY?: string;
    NOTION_DATABASE_ID?: string;
    NOTION_PROP_LINE_USER_ID?: string;
    NOTION_PROP_NAME?: string;
    NOTION_PROP_PREFECTURE?: string;
    NOTION_PROP_VEHICLE?: string;
    NOTION_PROP_PHONE?: string;
    NOTION_PROP_ADDRESS?: string;
    // 出品フォーム LINE 連携 (BOXIV) — Slack 通知用 (claude-sellentry bot)
    SELLENTRY_SLACK_BOT_TOKEN?: string;
    SLACK_LISTING_LINK_CHANNEL_ID?: string;
    SLACK_REMINDER_WEBHOOK_URL?: string;   // BOXIV: 催促メール/SMS の送信状況を流す監視用 Slack Incoming Webhook（未設定なら無効）
    // 顧客ステータス (BOXIV) — Notion 出品者DB / 購入者DB の Status 同期用
    NOTION_SELLER_DB_ID?: string;
    NOTION_BUYER_DB_ID?: string;
    NOTION_SELLER_STATUS_PROP?: string;  // default: ステータス
    NOTION_BUYER_STATUS_PROP?: string;
    NOTION_SELLER_LISTING_ID_PROP?: string;  // default: 掲載ID
    NOTION_SELLER_LISTING_TYPE_PROP?: string; // default: 出品タイプ（連携先候補の表示用）
    NOTION_AUTOMATION_SECRET?: string;       // PR6: Notion DBオートメーション Send webhook の共有シークレット（未設定なら受信口は無効）
    // バッテリー劣化診断 LIFF フォーム (BOXIV) — 全て任意（未設定なら該当処理をスキップ）
    // spec_API は listing パイプラインと同じ VEHICLE_SPECS_* を正とする。旧 SPEC_* は後方互換で許容。
    VEHICLE_SPECS_API_KEY?: string;            // getVehicleSpecs の x-api-key（正）
    VEHICLE_SPECS_API_URL?: string;            // 既定: asia-northeast1 boxiv-share getVehicleSpecs
    SPEC_API_KEY?: string;                     // 後方互換（旧名）
    SPEC_API_URL?: string;                     // 後方互換（旧名）
    DIAGNOSIS_SLACK_CHANNEL_ID?: string;       // #診断依頼 チャンネル ID
    DIAGNOSIS_SLACK_BOT_TOKEN?: string;        // 未設定なら SELLENTRY_SLACK_BOT_TOKEN を流用
    DIAGNOSIS_LIFF_ID?: string;                // 診断フォーム用 LIFF ID（未設定なら LIFF_URL から導出）
    DIAGNOSIS_NOTION_DB_ID?: string;           // Notion「出品者リードリスト」DB ID
    // 出品フォーム台帳→Notion 即起票 + 催促 (BOXIV)
    LISTING_FORM_SUBMIT_TOKEN?: string;        // /listing-form/submit の簡易共有トークン（任意）
    NOTION_SELLER_MATCH_KEY_PROP?: string;     // default: match_key
    NOTION_SELLER_LINE_USER_ID_PROP?: string;  // default: LINE User ID
    NOTION_SELLER_TITLE_PROP?: string;         // default: 名前
    NOTION_SELLER_PHONE_PROP?: string;         // default: [Form]電話番号
    NOTION_SELLER_EMAIL_PROP?: string;         // default: [Form]メールアドレス
    NOTION_SELLER_MEMO_PROP?: string;          // default: その他詳細備考
    NOTION_SELLER_ZIP_PROP?: string;           // default: 郵便番号
    NOTION_SELLER_STATUS_VALUE?: string;       // default: 0_LINE登録（連携時付与）
    NOTION_SELLER_LINK_STATUS_PROP?: string;   // default: 連携ステータス
    NOTION_SELLER_LINK_STATUS_UNLINKED?: string; // default: 1_フォーム入力
    NOTION_SELLER_LINK_STATUS_LINKED?: string;   // default: 3_連携済
    NOTION_LISTING_ID_MIN?: string;            // default: 10000
    NOTION_LISTING_ID_MAX?: string;            // default: 19999
    GOOGLE_GEOCODING_API_KEY?: string;         // 住所→郵便番号（任意）
    SENDGRID_API_KEY?: string;                 // 催促メール
    SENDGRID_FROM_EMAIL?: string;
    SENDGRID_FROM_NAME?: string;
    LISTING_REMINDER_AFTER_MINUTES?: string;       // default: 1440 (24h)
    LISTING_REMINDER_MIN_INTERVAL_MINUTES?: string; // default: 1440
    LISTING_REMINDER_MAX?: string;                 // default: 3
    LISTING_REMINDER_MAX_PER_TICK?: string;        // default: 20
    LISTING_REMINDER_QUIET_START_HOUR_JST?: string; // default: 21
    LISTING_REMINDER_QUIET_END_HOUR_JST?: string;   // default: 9
    LISTING_REMINDER_RETURN_TO?: string;           // default: https://lightning.boxiv.co.jp/thanks
    // 催促スケジュール（提出起点・分）
    LISTING_REMINDER_STEPS_MINUTES?: string;        // default: 10,1440,2880（10分/24h/48h）
    LISTING_ESCALATE_MINUTES?: string;              // default: 4320（72h→Slackエスカレ）
    // SMS 催促 (Twilio)
    TWILIO_ACCOUNT_SID?: string;
    TWILIO_AUTH_TOKEN?: string;
    TWILIO_FROM?: string;                           // Twilio番号(+81…) or Messaging Service SID(MG…)
  };
  Variables: {
    staff: { id: string; name: string; role: 'owner' | 'admin' | 'manager' | 'staff' };
  };
};

const app = new Hono<Env>();

// CORS — allow all origins for MVP
app.use('*', cors({ origin: '*' }));

// Rate limiting — runs before auth to block abuse early
app.use('*', rateLimitMiddleware);

// Auth middleware — skips /webhook and /docs automatically
app.use('*', authMiddleware);

// 監査ログ — 認証直後に挟む（c.get('staff') が解決済み）。成功した admin 変更のみ記録。
app.use('*', auditLogMiddleware);

// Mount route groups — MVP & Round 2
app.route('/', webhook);
app.route('/', friends);
app.route('/', tags);
app.route('/', scenarios);
app.route('/', broadcasts);
app.route('/', users);
app.route('/', lineAccounts);
app.route('/', conversions);
app.route('/', affiliates);
app.route('/', openapi);
app.route('/', liffRoutes);

// Mount route groups — Round 3
app.route('/', webhooks);
app.route('/', calendar);
app.route('/', reminders);
app.route('/', scoring);
app.route('/', templates);
app.route('/', chats);
app.route('/', notifications);
app.route('/', stripe);
app.route('/', health);
app.route('/', automations);
app.route('/', richMenus);
app.route('/', trackedLinks);
app.route('/', forms);
app.route('/', adPlatforms);
app.route('/', staff);
app.route('/', images);

// 撮影予約システム
app.route('/', booking);
app.route('/', bookingInvites);
app.route('/', bookingRequests);
app.route('/', staffAvailability);

// 出品フォーム LINE 連携 (BOXIV)
app.route('/', listingFormLine);
// アプリ出品 LINE 連携（/app-listing/start・BOXIV）
app.route('/', appListing);
// LINE Login 共有コールバック（/link/callback ＋ 旧 /listing-form/callback エイリアス・BOXIV）
app.route('/', linkCallback);

// バッテリー劣化診断 LIFF フォーム (BOXIV)
app.route('/', diagnosisForm);

// 最安EVピックアップの手動更新（管理用・要Bearer）
app.post('/api/admin/refresh-cheapest', async (c) => {
  const result = await refreshCheapestListings(c.env);
  return c.json({ success: result.ok, data: result });
});

// 顧客ステータス (BOXIV)
app.route('/', friendStatus);

// 個別チャット送信予約 (BOXIV)
app.route('/', scheduledMessages);

// チャット用メディア (BOXIV)
app.route('/', media);

// 友だち↔Notion 連携 (BOXIV)
app.route('/', friendNotion);

// リッチメニュー × 顧客ステータス マッピング (BOXIV)
app.route('/', richMenuStatus);
// 既存フォロワーの一括インポート (BOXIV, Lステップ移行)
app.route('/', friendImport);
// prod スキーマ整合 (BOXIV)
app.route('/', schemaReconcile);
// 顧客ステータス Notion 連携の受信口 (BOXIV, PR6 / 案2 automation Send webhook)
app.route('/', notionWebhook);
// 監査ログ閲覧 (BOXIV)
app.route('/', auditLogs);

// Short link: /r/:ref → landing page with LINE open button
app.get('/r/:ref', (c) => {
  const ref = c.req.param('ref');
  const liffUrl = c.env.LIFF_URL;
  if (!liffUrl) {
    return c.json({ error: 'LIFF_URL is not configured. Set it via wrangler secret put LIFF_URL.' }, 500);
  }
  const target = `${liffUrl}?ref=${encodeURIComponent(ref)}`;

  return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LINE Harness</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hiragino Sans',system-ui,sans-serif;background:#0d1117;color:#fff;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{text-align:center;max-width:400px;width:90%;padding:48px 24px}
h1{font-size:28px;font-weight:800;margin-bottom:8px}
.sub{font-size:14px;color:rgba(255,255,255,0.5);margin-bottom:40px}
.btn{display:block;width:100%;padding:18px;border:none;border-radius:12px;font-size:18px;font-weight:700;text-decoration:none;text-align:center;color:#fff;background:#0f172a;transition:opacity .15s}
.btn:active{opacity:.85}
.note{font-size:12px;color:rgba(255,255,255,0.3);margin-top:24px;line-height:1.6}
</style>
</head>
<body>
<div class="card">
<h1>LINE Harness</h1>
<p class="sub">L社 / U社 の無料代替 OSS</p>
<a href="${target}" class="btn">LINE で体験する</a>
<p class="note">友だち追加するだけで<br>ステップ配信・フォーム・自動返信を体験できます</p>
</div>
</body>
</html>`);
});

// Convenience redirect for /book path
app.get('/book', (c) => c.redirect('/?page=book'));

// 404 fallback — JSON for API paths, plain for others (Workers Assets SPA fallback handles it)
app.notFound((c) => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/api/') || path === '/webhook' || path === '/docs' || path === '/openapi.json') {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  return c.notFound();
});

// Scheduled handler for cron triggers — runs for all active LINE accounts
async function scheduled(
  event: ScheduledEvent,
  env: Env['Bindings'],
  _ctx: ExecutionContext,
): Promise<void> {
  // BOXIV: cron はアカウントの 5 トリガー上限を避けるため単一(* * * * *)に集約し、
  // 実行時刻(scheduledTime)で分岐する:
  //   毎分      → Slack 受信通知のバースト flush（軽量・30秒デバウンス）
  //   5分ごと   → 配信系ジョブ（ステップ/ブロードキャスト/リマインダ/催促 等）
  //   12時間ごと → Notion → D1 顧客ステータス reconcile（取りこぼし自己修復）
  const at = new Date(event.scheduledTime);
  const minute = at.getUTCMinutes();
  const hour = at.getUTCHours();

  // 毎分: Slack バースト flush（単一 invocation なので 5分ジョブとの二重送信レースも無い）
  await processSlackBurstNotify(env);

  // 以降は 5 分ごと
  if (minute % 5 !== 0) return;

  // 配信系ジョブ（ステップ/ブロードキャスト/リマインダ）は account でスコープされておらず
  // 全 due 行を対象にするため、トークン毎に実行すると同じ配信が二重に走る（複数トークン時）。
  // よって既定の env トークンで「1回だけ」実行する。
  // ⚠️ マルチOA配信は未対応（各OAのトークンで各OA分だけ送る account スコープ化が必要）。
  //    現状 prod は単一OAのため実害なし。多OA化する際はここを account 単位に作り替えること。
  const jobs = [];
  const defaultClient = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN);
  jobs.push(
    processStepDeliveries(env.DB, defaultClient, env.WORKER_URL),
    processScheduledBroadcasts(env.DB, defaultClient, env.WORKER_URL),
    processReminderDeliveries(env.DB, defaultClient),
  );
  jobs.push(checkAccountHealth(env.DB));
  jobs.push(refreshLineAccessTokens(env.DB));
  // BOXIV: 個別チャット送信予約 (友だちに紐づく line_account を内部で解決)
  jobs.push(processScheduledMessages(env.DB, env.LINE_CHANNEL_ACCESS_TOKEN, LineClient));
  // BOXIV: 出品フォーム未連携者へのフォローアップメール催促（夜間抑止/上限/間隔/重送ガードは内部で実施）
  jobs.push(processListingFormReminders(env));

  // BOXIV: 12時間ごと(UTC 00:00 / 12:00 = JST 09:00 / 21:00) — Notion → D1 ステータス reconcile
  if (minute === 0 && hour % 12 === 0) {
    jobs.push(reconcileNotionStatuses(env.DB, env));
  }

  await Promise.allSettled(jobs);

  // BOXIV: 毎日 UTC 21:00 (= JST 06:00) に最安EVピックアップ更新を開始。
  // サブリクエスト上限対策で1回40ページずつの分割巡回（D1のcrawl_stateで継続）。
  // 21:00 以外の 5分tick では「進行中の巡回があれば続きだけ」実行する（init=false は state 無しなら noop）。
  //
  // ⚠️ 上の配信系ジョブ群と同時に走らせない（Promise.allSettled の外・後で単独実行）。
  // クロールの saveState は他ジョブの D1 書き込みと同一DBで競合すると
  // "storage operation exceeded timeout / object to be reset" を誘発するため、同時D1負荷を避ける。
  // 進行中でない tick は loadState 1回で noop 即return するのでコストは無視できる。
  try {
    await refreshCheapestListings(env, { init: minute === 0 && hour === 21 });
  } catch (e) {
    console.error('scheduled: refreshCheapestListings failed', e);
  }

  // BOXIV: spec_API 取得に失敗した診断リードの後追い補完（毎時 15分/45分）。
  // 上のクロールや配信ジョブと同時に走らせない（同時 D1 書き込み競合の回避）。
  // 1 tick 最大3件・指数バックオフ（5分→30分→2h→6h→24h）で再取得し、
  // 6回で打ち切って Slack に手動対応を促す。分岐は 0/30 分の重い tick を避けている。
  if (minute % 30 === 15) {
    try {
      await backfillDiagnosisSpecs(env);
    } catch (e) {
      console.error('scheduled: backfillDiagnosisSpecs failed', e);
    }
  }
}

export default {
  fetch: app.fetch,
  scheduled,
};
