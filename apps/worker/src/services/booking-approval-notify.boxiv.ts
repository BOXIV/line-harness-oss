// BOXIV-only: 撮影予約 承認時の後処理（Notion 出品者リストへの自動入力 + 撮影スタッフへのメール通知）。
//
// PUT /api/booking-requests/:id/approve から waitUntil + catch で呼ばれる（fire-and-forget）。
// 承認そのものは Notion / SendGrid 障害で絶対に止めない。ここでの失敗（Notion 更新失敗・
// ページ未解決・スタッフのメール未設定・送信失敗）はすべて Slack（CHAT_ALERT_SLACK_* =
// 既存の予約確定通知と同じチャンネル）へ通報し、静かに落ちる経路を作らない。
//
// 冪等性:
//   - Notion 書き込みは同値 PATCH なので再承認しても壊れない（撮影予定日は常に最新で上書き）。
//   - メールは notify_dedupe（migration 921）で「予約ID+確定日時+宛先」を claim し二重送信を防ぐ。
//     日時やスタッフが変わった再承認は別キーになり、新しい内容で改めて送られる。
//
// PII: メール本文には出品者の電話番号が載るが、Slack 通報・console にはマスクせず載せることを
// しない（そもそも出さない）。ナンバーも Slack へは出さない。

import {
  getBookingRequestById,
  getFriendById,
  getStaffById,
  getStaffAvailabilityById,
  type BookingRequestRow,
} from '@line-crm/db';
import { readNotionLinks } from './notion-friend-link.boxiv.js';
import { sendEmail, type SendGridEnv } from './sendgrid.boxiv.js';
import { buildDedupeKey, claimNotifyDedupe, releaseNotifyDedupe } from './notify-dedupe.boxiv.js';
import { AREA_LABELS, formatJstDateLabel, type AreaId } from '../utils/area.js';
import { escapeSlackText } from './slack.boxiv.js';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

// 二重承認の吸収ウィンドウ。notify_dedupe は 7 日より古い行を掃除するため、それ以下にすること。
// 24h を超えて同一日時・同一スタッフのまま再承認されるのは意図的な再送とみなして送り直す。
export const APPROVAL_EMAIL_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface BookingApprovalNotifyEnv extends SendGridEnv {
  DB: D1Database;
  NOTION_API_KEY?: string;
  /** 書込先プロパティ名（出品者リストの実名。test DB 等で違う場合のみ上書き） */
  NOTION_BOOKING_DATE_PROP?: string; // default '撮影予定日'
  NOTION_BOOKING_PLATE_PROP?: string; // default '[LINE]ナンバー下4桁'
  /** メール本文用の読み出しプロパティのフォールバック（booking 系既存設定を流用） */
  NOTION_PROP_VEHICLE?: string; // default '[LINE]車種名'
  NOTION_PROP_PHONE?: string; // default '[LINE]電話番号'
  CHAT_ALERT_SLACK_BOT_TOKEN?: string;
  CHAT_ALERT_SLACK_CHANNEL_ID?: string;
}

/** テスト・ログ用に「何をしたか」を返す。呼び出し側（route）は捨ててよい。 */
export interface BookingApprovalFollowupResult {
  notion:
    | 'updated'
    | 'skipped_no_page'
    | 'skipped_nothing_to_write'
    | 'skipped_not_configured'
    | 'failed';
  email:
    | 'sent'
    | 'deduped'
    | 'failed'
    | 'skipped_no_staff'
    | 'skipped_no_email'
    | 'skipped_no_datetime';
  /** Slack 通報を試みた回数（通報経路が生きているかのテスト検証用） */
  alerts: number;
}

// ─── Slack 通報（失敗を握り潰さないための唯一の出口） ──────────────────

async function alertSlack(env: BookingApprovalNotifyEnv, text: string): Promise<void> {
  const token = env.CHAT_ALERT_SLACK_BOT_TOKEN;
  const channel = env.CHAT_ALERT_SLACK_CHANNEL_ID;
  // Slack 未設定（OSS 構成等）では console のみ。BOXIV では test/prod とも設定済み。
  if (!token || !channel) {
    console.error('booking-approval-notify alert (slack not configured):', text);
    return;
  }
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        channel,
        text: `⚠️ 撮影予約 承認後処理: ${text}`,
        unfurl_links: false,
        unfurl_media: false,
      }),
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!j.ok) console.error('booking-approval-notify slack alert failed:', j.error || `http ${res.status}`);
  } catch (err) {
    console.error('booking-approval-notify slack alert failed:', err);
  }
}

// ─── Notion 読み書き（このサービス内で完結する最小クライアント） ─────────

async function notionGetPage(
  env: BookingApprovalNotifyEnv,
  pageId: string,
): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
    headers: { Authorization: `Bearer ${env.NOTION_API_KEY}`, 'Notion-Version': NOTION_VERSION },
  });
  if (!res.ok) {
    throw new Error(`Notion GET page → ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
  return ((await res.json()) as { properties?: Record<string, unknown> }).properties ?? null;
}

async function notionPatchPage(
  env: BookingApprovalNotifyEnv,
  pageId: string,
  properties: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${env.NOTION_API_KEY}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) {
    throw new Error(`Notion PATCH page → ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
}

/** Notion プロパティ値 → 文字列（rich_text / title / select / phone_number / number のみ対応） */
function propText(prop: unknown): string | null {
  if (!prop || typeof prop !== 'object') return null;
  const p = prop as Record<string, unknown>;
  const type = p.type as string | undefined;
  const val = type ? p[type] : null;
  if (val == null) return null;
  if (type === 'rich_text' || type === 'title') {
    if (!Array.isArray(val)) return null;
    const s = val
      .map((t) => (t && typeof t === 'object' ? String((t as Record<string, unknown>).plain_text ?? '') : ''))
      .join('')
      .trim();
    return s || null;
  }
  if (type === 'select') return (val as { name?: string }).name || null;
  if (type === 'phone_number') return typeof val === 'string' ? val : null;
  if (type === 'number') return typeof val === 'number' ? String(val) : null;
  return null;
}

/** 候補プロパティ名を順に見て最初に値が入っているものを返す。 */
function pickProp(props: Record<string, unknown> | null, names: string[]): string | null {
  if (!props) return null;
  for (const name of names) {
    const v = propText(props[name]);
    if (v) return v;
  }
  return null;
}

// ─── 確定日時の解決（LINE 通知 / Slack 通知と同じ規則） ──────────────────

interface FixedSlot {
  date: string; // YYYY-MM-DD
  start: string; // HH:MM
  end: string; // HH:MM
  staffId: string | null; // slot 由来のスタッフ（booking.staff_id が無い場合の補完）
}

async function resolveFixedSlot(
  db: D1Database,
  booking: BookingRequestRow,
): Promise<FixedSlot | null> {
  if (booking.slot_id) {
    const slot = await getStaffAvailabilityById(db, booking.slot_id);
    if (slot) return { date: slot.date, start: slot.start_time, end: slot.end_time, staffId: slot.staff_id };
  }
  // 「その他の県」の3候補フロー: 承認時に選ばれた候補が確定日時
  if (booking.selected_candidate) {
    const row = booking as unknown as Record<string, string | null>;
    const n = booking.selected_candidate;
    const date = row[`candidate_${n}_date`];
    const start = row[`candidate_${n}_start`];
    const end = row[`candidate_${n}_end`];
    if (date && start && end) return { date, start, end, staffId: null };
  }
  return null;
}

// ─── メイン ────────────────────────────────────────────────────────────

/**
 * 承認確定後の Notion 自動入力 + 撮影スタッフへのメール通知。
 * throw しない（すべての失敗は Slack 通報 + console に落とし、結果を返すだけ）。
 * 呼び出し側は waitUntil(....catch(...)) で包む（既存の notifyBookingSlack と同じ形）。
 */
export async function notifyBookingApprovedFollowups(
  env: BookingApprovalNotifyEnv,
  bookingId: string,
): Promise<BookingApprovalFollowupResult> {
  const result: BookingApprovalFollowupResult = {
    notion: 'skipped_not_configured',
    email: 'skipped_no_staff',
    alerts: 0,
  };
  const alert = async (text: string) => {
    result.alerts++;
    await alertSlack(env, text);
  };

  try {
    const booking = await getBookingRequestById(env.DB, bookingId);
    if (!booking) {
      await alert(`予約が見つかりません（id=${bookingId}）`);
      return result;
    }
    // 承認直後に呼ばれる想定。並行キャンセル等で状態が変わっていたら何もしない。
    if (booking.status !== 'approved') {
      console.warn(`booking-approval-notify: booking ${bookingId} is ${booking.status}, skip`);
      return result;
    }

    const customer = escapeSlackText(booking.customer_name || '-');
    const slot = await resolveFixedSlot(env.DB, booking);

    // ── Notion ページ解決 ──
    // 第一候補: 招待作成時に確定している booking_requests.notion_page_id。
    // 第二候補: friends.metadata の出品者リンク。metadata.notion はプライマリ（seller 優先だが
    // buyer になり得る）の後方互換写しなので使わず、正である notionLinks を readNotionLinks() で
    // 読み、seller 側だけを使う（購入者リストの行に撮影予定日を書かないため）。
    let pageId = booking.notion_page_id;
    if (!pageId && booking.friend_id) {
      const friend = await getFriendById(env.DB, booking.friend_id);
      pageId = readNotionLinks(friend?.metadata).seller?.pageId ?? null;
    }

    // ── Notion 自動入力（撮影予定日 / [LINE]ナンバー下4桁） ──
    let notionProps: Record<string, unknown> | null = null;
    if (!env.NOTION_API_KEY) {
      result.notion = 'skipped_not_configured';
      await alert(`NOTION_API_KEY 未設定のため出品者リストを更新できません（お客様: ${customer}）`);
    } else if (!pageId) {
      result.notion = 'skipped_no_page';
      await alert(
        `Notion ページを解決できず出品者リストを更新できません。撮影予定日とナンバーを手動入力してください（お客様: ${customer} / 予約ID: ${booking.id}）`,
      );
    } else {
      try {
        // メール本文用の車種名・電話番号も同じ GET で読む（PATCH 失敗時にも使う）
        notionProps = await notionGetPage(env, pageId);

        const props: Record<string, unknown> = {};
        const dateProp = env.NOTION_BOOKING_DATE_PROP || '撮影予定日';
        const plateProp = env.NOTION_BOOKING_PLATE_PROP || '[LINE]ナンバー下4桁';

        // 撮影予定日: 既存データは全件「開始時刻あり・終了なし・+09:00」形式（本番30件を実測）。
        // 再承認・日程変更後の承認では常に最新の確定日時で上書きする。
        if (slot) {
          props[dateProp] = { date: { start: `${slot.date}T${slot.start}:00+09:00` } };
        }

        // [LINE]ナンバー下4桁: オペレーターが「品川300あ1234」等のフル表記を手入力している行が
        // 多数ある（実測: 既存50件中40件超）。下4桁だけの値で情報量の多い既存値を潰さない:
        //   空 → 書く / 既存値に今回の下4桁が含まれる → 保持 / 含まれない → 新しい申告として上書き
        const plate = booking.plate_number?.trim();
        if (plate) {
          const existingPlate = propText(notionProps?.[plateProp]);
          if (!existingPlate || !existingPlate.includes(plate)) {
            props[plateProp] = { rich_text: [{ type: 'text', text: { content: plate } }] };
          }
        }

        if (Object.keys(props).length === 0) {
          result.notion = 'skipped_nothing_to_write';
        } else {
          await notionPatchPage(env, pageId, props);
          result.notion = 'updated';
        }
      } catch (err) {
        result.notion = 'failed';
        console.error('booking-approval-notify: notion update failed:', err);
        await alert(
          `出品者リストの自動入力に失敗しました。撮影予定日とナンバーを手動入力してください（お客様: ${customer} / 予約ID: ${booking.id} / ${err instanceof Error ? err.message : String(err)}）`,
        );
      }
    }

    // ── 撮影スタッフへのメール通知 ──
    const staffId = booking.staff_id ?? slot?.staffId ?? null;
    if (!staffId) {
      result.email = 'skipped_no_staff';
      await alert(`担当スタッフが未割当のためメール通知できません（お客様: ${customer} / 予約ID: ${booking.id}）`);
      return result;
    }
    const staff = await getStaffById(env.DB, staffId);
    // staff_members.email は nullable・検証なし（boxiv-main 時点）。null 前提で扱う。
    const to = staff?.email?.trim();
    if (!staff || !to) {
      result.email = 'skipped_no_email';
      await alert(
        `撮影スタッフ「${escapeSlackText(staff?.name || staffId)}」のメールアドレスが未設定のため撮影確定メールを送れません。スタッフ管理で設定してください（お客様: ${customer} / 予約ID: ${booking.id}）`,
      );
      return result;
    }
    if (!slot) {
      result.email = 'skipped_no_datetime';
      await alert(
        `確定日時を解決できずメール通知できません（お客様: ${customer} / 予約ID: ${booking.id}）`,
      );
      return result;
    }

    // 二重承認の吸収: 同一予約・同一日時・同一宛先は 1 通だけ。日時/宛先が変われば別キー＝再送。
    const dedupeKey = await buildDedupeKey('booking-approval-email', {
      bookingId: booking.id,
      date: slot.date,
      start: slot.start,
      end: slot.end,
      to,
    });
    if (!(await claimNotifyDedupe(env.DB, dedupeKey, APPROVAL_EMAIL_DEDUPE_WINDOW_MS))) {
      result.email = 'deduped';
      console.warn(`booking-approval-notify: duplicate approval email suppressed (booking ${booking.id})`);
      return result;
    }

    const dateLabel = `${formatJstDateLabel(slot.date)} ${slot.start} 〜 ${slot.end}`;
    const vehicle =
      pickProp(notionProps, ['[Form]車種名', env.NOTION_PROP_VEHICLE || '[LINE]車種名']) ??
      parseVehicleRaw(booking.vehicle_info);
    const phone =
      pickProp(notionProps, ['[Form]電話番号', env.NOTION_PROP_PHONE || '[LINE]電話番号']) ??
      parseVehiclePhone(booking.vehicle_info);
    const areaLabel = AREA_LABELS[booking.area as AreaId] || booking.area;

    const text = [
      `${staff.name} 様`,
      '',
      '撮影日程が確定しました。下記の内容でお伺いをお願いいたします。',
      '',
      `■ 撮影日時: ${dateLabel}`,
      `■ お客様名: ${booking.customer_name || '-'}`,
      `■ エリア: ${booking.prefecture}（${areaLabel}）`,
      `■ 車種名: ${vehicle || '-'}`,
      `■ ナンバー下4桁: ${booking.plate_number || '-'}`,
      `■ お客様電話番号: ${phone || '-'}`,
      '',
      '※ このメールは LINE Connect から自動送信されています。',
      '※ 内容の確認・変更は管理画面の「撮影予約」からお願いします。',
      '',
      // SendGrid の抑制リストはアカウント全体・アドレス単位。迷惑メール報告されると
      // 以後 202 のまま静かに破棄され（Slack 通報も鳴らない）、同じ送信元を使う
      // 管理画面ログインの認証メールまで届かなくなる。文言はユーザー確定（2026-08-19）。
      '⚠️ このメールを迷惑メール報告しないでください。管理画面ログイン用の認証メールを含む、BOXIV からのすべてのメールが届かなくなります。',
    ].join('\n');

    const sent = await sendEmail(env, to, `【撮影確定】${dateLabel}`, { text });
    if (!sent.ok) {
      result.email = 'failed';
      // 失敗したら claim を解放し、再承認（リトライ）で送り直せるようにする。
      await releaseNotifyDedupe(env.DB, dedupeKey).catch(() => {});
      await alert(
        `撮影スタッフ「${escapeSlackText(staff.name)}」宛の撮影確定メール送信に失敗しました（宛先: ${to} / 予約ID: ${booking.id} / ${sent.error ?? `status ${sent.status}`}）`,
      );
      return result;
    }
    result.email = 'sent';
    return result;
  } catch (err) {
    // 想定外の失敗も握り潰さない（throw もしない: 呼び出し側 waitUntil を汚さない）
    console.error('booking-approval-notify: unexpected failure:', err);
    await alertSlack(
      env,
      `予期しないエラーで承認後処理が失敗しました（予約ID: ${bookingId} / ${err instanceof Error ? err.message : String(err)}）`,
    ).catch(() => {});
    result.alerts++;
    return result;
  }
}

// booking_requests.vehicle_info（JSON: { raw?, phone?, address? }）からのフォールバック読み出し。
// 招待作成時に Notion から補完された値で、Notion GET が失敗した時の保険。
function parseVehicleRaw(vehicleInfo: string | null): string | null {
  return parseVehicleField(vehicleInfo, 'raw');
}
function parseVehiclePhone(vehicleInfo: string | null): string | null {
  return parseVehicleField(vehicleInfo, 'phone');
}
function parseVehicleField(vehicleInfo: string | null, key: string): string | null {
  if (!vehicleInfo) return null;
  try {
    const v = (JSON.parse(vehicleInfo) as Record<string, unknown>)[key];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}
