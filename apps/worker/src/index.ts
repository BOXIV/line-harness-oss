import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { LineClient } from '@line-crm/line-sdk';
import { getLineAccounts } from '@line-crm/db';
import { processStepDeliveries } from './services/step-delivery.js';
import { processScheduledBroadcasts } from './services/broadcast.js';
import { processReminderDeliveries } from './services/reminder-delivery.js';
import { processScheduledMessages } from './services/scheduled-message-delivery.boxiv.js';
import { processListingFormReminders } from './services/listing-reminder.boxiv.js';
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
    // 顧客ステータス (BOXIV) — Notion 出品者DB / 購入者DB の Status 同期用
    NOTION_SELLER_DB_ID?: string;
    NOTION_BUYER_DB_ID?: string;
    NOTION_SELLER_STATUS_PROP?: string;  // default: ステータス
    NOTION_BUYER_STATUS_PROP?: string;
    NOTION_SELLER_LISTING_ID_PROP?: string;  // default: 掲載ID
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
  _event: ScheduledEvent,
  env: Env['Bindings'],
  _ctx: ExecutionContext,
): Promise<void> {
  // Get all active accounts from DB, plus the default env account
  const dbAccounts = await getLineAccounts(env.DB);
  const activeTokens = new Set<string>();

  // Default account from env
  activeTokens.add(env.LINE_CHANNEL_ACCESS_TOKEN);

  // DB accounts
  for (const account of dbAccounts) {
    if (account.is_active) {
      activeTokens.add(account.channel_access_token);
    }
  }

  // Run delivery for each account
  const jobs = [];
  for (const token of activeTokens) {
    const lineClient = new LineClient(token);
    jobs.push(
      processStepDeliveries(env.DB, lineClient, env.WORKER_URL),
      processScheduledBroadcasts(env.DB, lineClient, env.WORKER_URL),
      processReminderDeliveries(env.DB, lineClient),
    );
  }
  jobs.push(checkAccountHealth(env.DB));
  jobs.push(refreshLineAccessTokens(env.DB));
  // BOXIV: 個別チャット送信予約 (友だちに紐づく line_account を内部で解決)
  jobs.push(processScheduledMessages(env.DB, env.LINE_CHANNEL_ACCESS_TOKEN, LineClient));
  // BOXIV: 出品フォーム未連携者へのフォローアップメール催促（夜間抑止/上限/間隔/重送ガードは内部で実施）
  jobs.push(processListingFormReminders(env));

  await Promise.allSettled(jobs);
}

export default {
  fetch: app.fetch,
  scheduled,
};
