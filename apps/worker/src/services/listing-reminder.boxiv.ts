// BOXIV-only: 出品フォーム未連携者への催促エンジン（Worker scheduled cron, 5分毎）。
//
// スケジュール（提出=created_at 起点）: 10分 / 24h / 48h に email + SMS を同送。
// 72h 未連携 → Slack エスカレ（フォーム通知スレッドに返信）。
// 対象は status='form_only'（未連携）のみ＝LINE連携が完了したら以降一切送らない。
//
// 設定（未設定のチャネルはスキップ／全部未設定なら no-op）:
//   メール: SENDGRID_API_KEY / SENDGRID_FROM_EMAIL
//   SMS  : TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM
//   Slack: SELLENTRY_SLACK_BOT_TOKEN / SLACK_LISTING_LINK_CHANNEL_ID
// 夜間(JST 既定21-9時)は催促メール/SMSを保留（72hエスカレは内部Slackなので常時送る）。

import { listFormOnlyForReminder, markStepSent, markEscalated } from './listing-entry.boxiv.js';
import { sendEmail } from './sendgrid.boxiv.js';
import { sendSms, twilioConfigured } from './sms-twilio.boxiv.js';
import { slackPost, slackWebhookPost, escapeSlackText } from './slack.boxiv.js';
import { buildReminderEmail, buildReminderSms } from './listing-email.boxiv.js';
import type { ListingEntry } from './listing-entry.boxiv.js';
import type { SendGridEnv } from './sendgrid.boxiv.js';
import type { TwilioEnv } from './sms-twilio.boxiv.js';
import type { SlackEnv, SlackWebhookEnv } from './slack.boxiv.js';

export interface ReminderEnv extends SendGridEnv, TwilioEnv, SlackEnv, SlackWebhookEnv {
  DB: D1Database;
  WORKER_URL?: string;
  LIFF_URL?: string;
  LISTING_REMINDER_STEPS_MINUTES?: string;        // 既定 "10,1440,2880"（10分/24h/48h）
  LISTING_ESCALATE_MINUTES?: string;              // 既定 "4320"（72h）
  LISTING_REMINDER_MAX_PER_TICK?: string;         // 既定 30
  LISTING_REMINDER_QUIET_START_HOUR_JST?: string; // 既定 21
  LISTING_REMINDER_QUIET_END_HOUR_JST?: string;   // 既定 9
  LISTING_REMINDER_RETURN_TO?: string;
}

const DEFAULT_RETURN_TO = 'https://lightning.boxiv.co.jp/thanks';
const DEFAULT_STEPS = [10, 1440, 2880]; // 10min / 24h / 48h
const DEFAULT_ESCALATE = 4320;          // 72h

function parseSteps(s?: string): number[] {
  if (!s) return DEFAULT_STEPS;
  const arr = s.split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n >= 0);
  return arr.length ? arr : DEFAULT_STEPS;
}

/** 連携リンク（LIFF ラップでモバイルは LINE アプリ自動ログイン）。 */
function buildLink(env: ReminderEnv, entry: ListingEntry): string {
  const base = (env.WORKER_URL || 'https://line-connect.boxiv.workers.dev').replace(/\/+$/, '');
  const returnTo = entry.return_to || env.LISTING_REMINDER_RETURN_TO || DEFAULT_RETURN_TO;
  const start = `${base}/listing-form/start?form_id=${encodeURIComponent(entry.match_key)}&return_to=${encodeURIComponent(returnTo)}`;
  if (env.LIFF_URL && /liff\.line\.me/.test(env.LIFF_URL)) {
    return `${env.LIFF_URL}?redirect=${encodeURIComponent(start)}`;
  }
  return start;
}

/** SMS 用の短縮リンク（/r/<key> → 302 で LIFF ラップ先へ）。SMSで長い encoded URL を避ける。 */
function buildSmsLink(env: ReminderEnv, entry: ListingEntry): string {
  const base = (env.WORKER_URL || 'https://line-connect.boxiv.workers.dev').replace(/\/+$/, '');
  return `${base}/r/${encodeURIComponent(entry.match_key)}`;
}

/** 催促ステップ間隔(分)を人間可読に（10→「10分後」, 1440→「24時間後」）。 */
function stepHuman(min: number): string {
  return min < 60 ? `${min}分後` : `${Math.round(min / 60)}時間後`;
}

/** 監視用 Slack Webhook に流す本文（種類・宛先・内容 + 補助情報）を組み立てる。 */
function buildMirrorText(
  kind: 'メール' | 'SMS',
  to: string,
  content: string,
  entry: ListingEntry,
  stepIdx: number,
  steps: number[],
): string {
  const icon = kind === 'メール' ? '📧' : '📱';
  const when = steps[stepIdx] != null ? stepHuman(steps[stepIdx]) : '—';
  // 宛先(メール/電話)と氏名はフォーム入力＝ユーザー制御。Slack mrkdwn インジェクション防止にエスケープ。
  return [
    `${icon} *${kind}リマインド送信*（提出から${when} / ${stepIdx + 1}通目）`,
    `• 宛先: ${escapeSlackText(to)}`,
    `• お名前: ${escapeSlackText(entry.name) || '—'}`,
    `• match_key: \`${entry.match_key}\``,
    '• 内容:',
    '```',
    content,
    '```',
  ].join('\n');
}

/** 送信ミラーを監視 Webhook に投稿（best-effort・非致命）。 */
async function mirrorSend(env: ReminderEnv, text: string): Promise<void> {
  if (!env.SLACK_REMINDER_WEBHOOK_URL) return;
  const r = await slackWebhookPost(env.SLACK_REMINDER_WEBHOOK_URL, text);
  if (!r.ok) console.error(`listing reminder: slack webhook mirror failed: ${r.error}`);
}

export async function processListingFormReminders(env: ReminderEnv): Promise<void> {
  const haveEmail = !!(env.SENDGRID_API_KEY && env.SENDGRID_FROM_EMAIL);
  const haveSms = twilioConfigured(env);
  const haveSlack = !!(env.SELLENTRY_SLACK_BOT_TOKEN && env.SLACK_LISTING_LINK_CHANNEL_ID);
  if (!haveEmail && !haveSms && !haveSlack) return;

  const steps = parseSteps(env.LISTING_REMINDER_STEPS_MINUTES);
  const escalateMin = Number(env.LISTING_ESCALATE_MINUTES || DEFAULT_ESCALATE);
  const perTick = Number(env.LISTING_REMINDER_MAX_PER_TICK || 30);
  const quietStart = Number(env.LISTING_REMINDER_QUIET_START_HOUR_JST ?? 21);
  const quietEnd = Number(env.LISTING_REMINDER_QUIET_END_HOUR_JST ?? 9);

  const jstHour = (new Date().getUTCHours() + 9) % 24;
  const inQuiet = quietStart < quietEnd
    ? jstHour >= quietStart && jstHour < quietEnd
    : jstHour >= quietStart || jstHour < quietEnd;

  const minElapsed = Math.min(...steps, escalateMin); // 最小ステップ(既定10分)以上経過の行だけ取得
  const candidates = await listFormOnlyForReminder(env.DB, { minElapsedMinutes: minElapsed, limit: 200 });
  if (!candidates.length) return;

  const now = Date.now();
  let sends = 0;
  for (const e of candidates) {
    const createdMs = Date.parse(e.created_at);
    if (!Number.isFinite(createdMs)) continue;
    const elapsedMin = (now - createdMs) / 60000;

    // 72h エスカレ（Slack・内部通知なので夜間も送る。フォーム通知スレッドに返信）
    if (haveSlack && elapsedMin >= escalateMin && !e.escalated_at) {
      const lines = [
        '⚠️ <!channel> 出品フォーム送信から72時間 *LINE未連携* です。フォローをお願いします。',
        `• お名前: ${escapeSlackText(e.name) || '—'}`,
        `• 連絡先: ${[e.phone, e.email].filter(Boolean).map(escapeSlackText).join(' / ') || '—'}`,
        `• match_key: \`${e.match_key}\``,
      ];
      const r = await slackPost(env, lines.join('\n'), { threadTs: e.slack_thread_ts });
      if (r.ok) await markEscalated(env.DB, e.match_key);
    }

    // 催促ステップ（email + SMS 同送）
    if (e.reminder_count < steps.length) {
      const threshold = steps[e.reminder_count];
      if (elapsedMin >= threshold) {
        if (inQuiet) continue;          // 夜間は催促を保留（日中の次tickで送る）
        if (sends >= perTick) continue; // 1tick上限
        if (!e.email && !e.phone) continue; // 連絡先なし＝送れない
        let sentEmail = false, sentSms = false;
        if (haveEmail && e.email) {
          const { subject, text, html } = buildReminderEmail(buildLink(env, e)); // メールはLIFFラップ(ボタン裏)
          const r = await sendEmail(env, e.email, subject, { text, html });
          sentEmail = r.ok;
          if (r.ok) await mirrorSend(env, buildMirrorText('メール', e.email, `件名: ${subject}\n\n${text}`, e, e.reminder_count, steps));
          else console.error(`listing reminder: email failed ${e.match_key} ${r.error}`);
        }
        if (haveSms && e.phone) {
          const smsBody = buildReminderSms(buildSmsLink(env, e)); // SMSは短縮リンク
          const r = await sendSms(env, e.phone, smsBody);
          sentSms = r.ok;
          if (r.ok) await mirrorSend(env, buildMirrorText('SMS', e.phone, smsBody, e, e.reminder_count, steps));
          else if (!r.skipped) console.error(`listing reminder: sms failed ${e.match_key} ${r.error}`);
        }
        if (sentEmail || sentSms) {
          await markStepSent(env.DB, e.match_key, { email: sentEmail, sms: sentSms });
          sends++;
        }
      }
    }
  }
}
