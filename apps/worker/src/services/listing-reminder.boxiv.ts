// BOXIV-only: 出品フォーム未連携者への催促（フォローアップメール）を CRON で送る。
// 旧 reconcile-daemon の「24h 未連携→メール」を Worker scheduled に移植。SMS は次段（列とフックのみ用意）。
//
// 送信ガード:
//   - status='form_only'（未連携）かつ email あり
//   - 作成から LISTING_REMINDER_AFTER_MINUTES 以上経過
//   - 直近送信から LISTING_REMINDER_MIN_INTERVAL_MINUTES 以上（重送防止）
//   - reminder_count < LISTING_REMINDER_MAX（送りすぎ防止）
//   - 1 tick あたり LISTING_REMINDER_MAX_PER_TICK 件まで（一斉送信防止）
//   - JST 夜間（既定 21:00–09:00）は送らない

import { listDueForReminder, markReminderSent } from './listing-entry.boxiv.js';
import { sendEmail } from './sendgrid.boxiv.js';
import type { ListingEntry } from './listing-entry.boxiv.js';
import type { SendGridEnv } from './sendgrid.boxiv.js';

export interface ReminderEnv extends SendGridEnv {
  DB: D1Database;
  WORKER_URL?: string;
  LIFF_URL?: string;
  LISTING_REMINDER_AFTER_MINUTES?: string;
  LISTING_REMINDER_MIN_INTERVAL_MINUTES?: string;
  LISTING_REMINDER_MAX?: string;
  LISTING_REMINDER_MAX_PER_TICK?: string;
  LISTING_REMINDER_QUIET_START_HOUR_JST?: string;
  LISTING_REMINDER_QUIET_END_HOUR_JST?: string;
  LISTING_REMINDER_RETURN_TO?: string;
}

const DEFAULT_RETURN_TO = 'https://lightning.boxiv.co.jp/thanks';

/** メールに載せる連携リンク。LIFF でラップしてモバイルは LINE アプリで自動ログインさせる。 */
function buildLinkUrl(env: ReminderEnv, entry: ListingEntry): string {
  const base = (env.WORKER_URL || 'https://line-connect.boxiv.workers.dev').replace(/\/+$/, '');
  const returnTo = entry.return_to || env.LISTING_REMINDER_RETURN_TO || DEFAULT_RETURN_TO;
  const start = `${base}/listing-form/start?form_id=${encodeURIComponent(entry.match_key)}&return_to=${encodeURIComponent(returnTo)}`;
  if (env.LIFF_URL && /liff\.line\.me/.test(env.LIFF_URL)) {
    return `${env.LIFF_URL}?redirect=${encodeURIComponent(start)}`;
  }
  return start;
}

function buildEmail(entry: ListingEntry, link: string): { subject: string; text: string; html: string } {
  const name = (entry.name || '').trim();
  const greeting = name ? `${name} 様` : 'お客様';
  const subject = '【BOXIV Lightning】LINE連携のお願い（査定・撮影予約のご案内）';
  const text =
`${greeting}

先日は BOXIV Lightning の出品フォームにご入力いただきありがとうございます。
スムーズに次のステップ（査定・撮影予約のご案内）へお進みいただくため、
以下のリンクから公式 LINE アカウントへの連携をお願いいたします。

▼ LINE連携はこちら
${link}

※スマートフォンで開くと LINE アプリが起動し、自動でログインされます。
お心当たりのない場合は本メールを破棄してください。

— BOXIV Lightning`;
  const html =
`<div style="font-family:'Hiragino Sans',system-ui,sans-serif;font-size:14px;line-height:1.8;color:#222">
  <p>${greeting}</p>
  <p>先日は BOXIV Lightning の出品フォームにご入力いただきありがとうございます。<br>
  スムーズに次のステップ（査定・撮影予約のご案内）へお進みいただくため、以下から公式 LINE アカウントへの連携をお願いいたします。</p>
  <p style="margin:24px 0">
    <a href="${link}" style="display:inline-block;background:#06c755;color:#fff;text-decoration:none;font-weight:700;padding:12px 24px;border-radius:8px">LINEで連携する</a>
  </p>
  <p style="font-size:12px;color:#888">※スマートフォンで開くと LINE アプリが起動し、自動でログインされます。お心当たりのない場合は本メールを破棄してください。</p>
  <p style="font-size:12px;color:#888">— BOXIV Lightning</p>
</div>`;
  return { subject, text, html };
}

export async function processListingFormReminders(env: ReminderEnv): Promise<void> {
  // メール未設定なら何もしない（フロー安全）
  if (!env.SENDGRID_API_KEY || !env.SENDGRID_FROM_EMAIL) return;

  const afterMin = Number(env.LISTING_REMINDER_AFTER_MINUTES || 1440); // 24h
  const interval = Number(env.LISTING_REMINDER_MIN_INTERVAL_MINUTES || 1440); // 24h
  const maxReminders = Number(env.LISTING_REMINDER_MAX || 3);
  const perTick = Number(env.LISTING_REMINDER_MAX_PER_TICK || 20);
  const quietStart = Number(env.LISTING_REMINDER_QUIET_START_HOUR_JST ?? 21);
  const quietEnd = Number(env.LISTING_REMINDER_QUIET_END_HOUR_JST ?? 9);

  // 夜間抑止（JST = UTC+9）
  const jstHour = (new Date().getUTCHours() + 9) % 24;
  const inQuiet = quietStart < quietEnd
    ? jstHour >= quietStart && jstHour < quietEnd
    : jstHour >= quietStart || jstHour < quietEnd;
  if (inQuiet) return;

  const due = await listDueForReminder(env.DB, {
    olderThanMinutes: afterMin,
    minIntervalMinutes: interval,
    maxReminders,
    limit: perTick,
  });
  if (!due.length) return;

  for (const entry of due) {
    if (!entry.email) continue;
    const link = buildLinkUrl(env, entry);
    const { subject, text, html } = buildEmail(entry, link);
    const r = await sendEmail(env, entry.email, subject, { text, html });
    if (r.ok) {
      await markReminderSent(env.DB, entry.match_key, 'email');
    } else {
      console.error(`listing reminder: send failed match_key=${entry.match_key} status=${r.status} ${r.error}`);
    }
  }
}
