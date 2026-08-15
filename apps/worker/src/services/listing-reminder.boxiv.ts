// BOXIV-only: フォーム未連携者への催促エンジン（Worker scheduled cron, 5分毎）。
//
// 出品者（source='seller'）と購入者（source='buyer'）の両方を同じ台帳から拾い、
// 連携リンク・メール文面・Slack 通知先だけを source で切り替える。
//
// スケジュール（提出=created_at 起点）: 10分 / 24h / 48h に email + SMS を同送。
// 72h 未連携 → Slack エスカレ（フォーム通知スレッドに返信）。
// 対象は status='form_only'（未連携）のみ＝LINE連携が完了したら以降一切送らない。
//
// 設定（未設定のチャネルはスキップ／全部未設定なら no-op）:
//   メール: SENDGRID_API_KEY / SENDGRID_FROM_EMAIL
//   SMS  : TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM
//   Slack: SELLENTRY_SLACK_BOT_TOKEN / SLACK_LISTING_LINK_CHANNEL_ID（出品者）
//                                    / SLACK_BUYER_LINK_CHANNEL_ID（購入者）
// 夜間(JST 既定21-9時)は催促メール/SMSを保留（72hエスカレは内部Slackなので常時送る）。

import { listFormOnlyForReminder, markStepSent, markEscalated } from './listing-entry.boxiv.js';
import { sendEmail } from './sendgrid.boxiv.js';
import { sendSms, twilioConfigured } from './sms-twilio.boxiv.js';
import { slackPost, buildSlackCard, escapeSlackText, slackChannelFor, slackTokenFor } from './slack.boxiv.js';
import { buildReminderEmail, buildReminderSms, buildBuyerReminderEmail, buildBuyerReminderSms } from './listing-email.boxiv.js';
import type { ListingEntry, EntrySource } from './listing-entry.boxiv.js';
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
  BUYER_REMINDER_RETURN_TO?: string;              // 購入者の催促リンク return_to
}

const DEFAULT_RETURN_TO = 'https://lightning.boxiv.co.jp/thanks';
const DEFAULT_BUYER_RETURN_TO = 'https://lightning.boxiv.co.jp/car/buy/thanks';
const DEFAULT_STEPS = [10, 1440, 2880]; // 10min / 24h / 48h
const DEFAULT_ESCALATE = 4320;          // 72h

/** 台帳行の source（旧行は列が無い時期があるので 'seller' に寄せる）。 */
function entrySource(e: ListingEntry): EntrySource {
  return e.source === 'buyer' ? 'buyer' : 'seller';
}

function parseSteps(s?: string): number[] {
  if (!s) return DEFAULT_STEPS;
  const arr = s.split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n >= 0);
  return arr.length ? arr : DEFAULT_STEPS;
}

/** 連携リンク（LIFF ラップでモバイルは LINE アプリ自動ログイン）。source で start パスが変わる。 */
function buildLink(env: ReminderEnv, entry: ListingEntry): string {
  const base = (env.WORKER_URL || 'https://line-connect.boxiv.workers.dev').replace(/\/+$/, '');
  const buyer = entrySource(entry) === 'buyer';
  const returnTo = entry.return_to
    || (buyer ? env.BUYER_REMINDER_RETURN_TO || DEFAULT_BUYER_RETURN_TO : env.LISTING_REMINDER_RETURN_TO || DEFAULT_RETURN_TO);
  const path = buyer ? '/buyer-form/start' : '/listing-form/start';
  const start = `${base}${path}?form_id=${encodeURIComponent(entry.match_key)}&return_to=${encodeURIComponent(returnTo)}`;
  if (env.LIFF_URL && /liff\.line\.me/.test(env.LIFF_URL)) {
    return `${env.LIFF_URL}?redirect=${encodeURIComponent(start)}`;
  }
  return start;
}

/** SMS 用の短縮リンク（/r/<key>・購入者は /rb/<key> → 302 で LIFF ラップ先へ）。SMSで長い encoded URL を避ける。 */
function buildSmsLink(env: ReminderEnv, entry: ListingEntry): string {
  const base = (env.WORKER_URL || 'https://line-connect.boxiv.workers.dev').replace(/\/+$/, '');
  const prefix = entrySource(entry) === 'buyer' ? 'rb' : 'r';
  return `${base}/${prefix}/${encodeURIComponent(entry.match_key)}`;
}

/** 催促ステップ間隔(分)を人間可読に（10→「10分後」, 1440→「24時間後」）。 */
function stepHuman(min: number): string {
  return min < 60 ? `${min}分後` : `${Math.round(min / 60)}時間後`;
}

/** ミラー見出しのコンパクト attachment（color サイドバー + 太字タイトル + フィールド）を組み立てる。
 *  本文は別途スレッド返信に入れるため、ここには含めない（チャンネルのタイムラインを圧迫しない）。 */
function buildMirrorAttachment(
  kind: 'メール' | 'SMS',
  to: string,
  entry: ListingEntry,
  stepIdx: number,
  steps: number[],
): Record<string, unknown> {
  const icon = kind === 'メール' ? '📧' : '📱';
  const color = kind === 'メール' ? '#2eb67d' : '#4a9fe0';
  const when = steps[stepIdx] != null ? stepHuman(steps[stepIdx]) : '—';
  const who = entrySource(entry) === 'buyer' ? '購入者' : '出品者';
  // 宛先(メール/電話)と氏名はフォーム入力＝ユーザー制御。Slack mrkdwn インジェクション防止にエスケープ。
  return buildSlackCard({
    title: `${icon} ${who}へ${kind}リマインドを送信しました`,
    color,
    fields: [
      { label: 'タイミング', value: `提出から${when} / ${stepIdx + 1}通目` },
      { label: '宛先', value: escapeSlackText(to) },
      { label: 'お名前', value: escapeSlackText(entry.name) || '—' },
      { label: 'match_key', value: `\`${entry.match_key}\`` },
    ],
  });
}

/**
 * 送信ミラーを Slack に投稿（best-effort・非致命）。
 * 見出しはコンパクト attachment、本文(メール件名+本文 / SMS本文)は同じスレッドへ別投稿し、
 * チャンネルのタイムラインには本文を出さない。フォーム通知スレッド(slack_thread_ts)があれば
 * その中へ、無ければ見出し自身をスレッド親にして本文をぶら下げる。
 */
async function mirror(
  env: ReminderEnv,
  kind: 'メール' | 'SMS',
  to: string,
  body: string,
  entry: ListingEntry,
  stepIdx: number,
  steps: number[],
): Promise<void> {
  const src = entrySource(entry);
  const channel = slackChannelFor(env, src);
  const token = slackTokenFor(env, src);
  const attachment = buildMirrorAttachment(kind, to, entry, stepIdx, steps);
  const head = await slackPost(env, attachment.fallback as string, {
    threadTs: entry.slack_thread_ts,
    attachments: [attachment],
    channel,
    token,
  });
  if (!head.ok) {
    console.error(`listing reminder: slack mirror head failed: ${head.error}`);
    return;
  }
  // 本文はスレッド内へ（フォーム通知スレッド優先、無ければ見出しの ts をスレッド親に）。
  const parent = entry.slack_thread_ts ?? head.ts ?? null;
  const r = await slackPost(env, `\`\`\`\n${body}\n\`\`\``, { threadTs: parent, channel, token });
  if (!r.ok) console.error(`listing reminder: slack mirror body failed: ${r.error}`);
}

export async function processListingFormReminders(env: ReminderEnv): Promise<void> {
  const haveEmail = !!(env.SENDGRID_API_KEY && env.SENDGRID_FROM_EMAIL);
  const haveSms = twilioConfigured(env);
  // Slack は source ごとにチャンネルが違う。どちらか一方だけ設定されている構成も許す。
  const haveSlackToken = !!env.SELLENTRY_SLACK_BOT_TOKEN;
  const haveSlack = haveSlackToken && !!(env.SLACK_LISTING_LINK_CHANNEL_ID || env.SLACK_BUYER_LINK_CHANNEL_ID);
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

    const source = entrySource(e);
    const channel = slackChannelFor(env, source);
    const token = slackTokenFor(env, source);
    const formLabel = source === 'buyer' ? '購入エントリー' : '出品フォーム';

    // 72h エスカレ（Slack・内部通知なので夜間も送る。フォーム通知スレッドに返信）
    if (haveSlackToken && channel && elapsedMin >= escalateMin && !e.escalated_at) {
      // <!channel> メンションは attachment 内だと通知されないため本体 text に置く。詳細はカードに。
      const card = buildSlackCard({
        title: '⚠️ 72時間 LINE未連携です。フォローをお願いします',
        color: '#e01e5a', // 赤: 要対応
        fields: [
          { label: 'お名前', value: escapeSlackText(e.name) || '—' },
          { label: '連絡先', value: [e.phone, e.email].filter(Boolean).map(escapeSlackText).join(' / ') || '—' },
          { label: 'match_key', value: `\`${e.match_key}\`` },
        ],
      });
      const r = await slackPost(env, `⚠️ <!channel> ${formLabel}送信から72時間 LINE未連携です。`, {
        threadTs: e.slack_thread_ts,
        attachments: [card],
        channel,
        token,
      });
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
          // メールはLIFFラップ(ボタン裏)。文面は source で切り替える（出品/購入で導線が違う）。
          const link = buildLink(env, e);
          const { subject, text, html } = source === 'buyer' ? buildBuyerReminderEmail(link) : buildReminderEmail(link);
          const r = await sendEmail(env, e.email, subject, { text, html });
          sentEmail = r.ok;
          if (r.ok) await mirror(env, 'メール', e.email, `件名: ${subject}\n\n${text}`, e, e.reminder_count, steps);
          else console.error(`listing reminder: email failed ${e.match_key} ${r.error}`);
        }
        if (haveSms && e.phone) {
          const smsLink = buildSmsLink(env, e); // SMSは短縮リンク
          const smsBody = source === 'buyer' ? buildBuyerReminderSms(smsLink) : buildReminderSms(smsLink);
          const r = await sendSms(env, e.phone, smsBody);
          sentSms = r.ok;
          if (r.ok) await mirror(env, 'SMS', e.phone, smsBody, e, e.reminder_count, steps);
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
