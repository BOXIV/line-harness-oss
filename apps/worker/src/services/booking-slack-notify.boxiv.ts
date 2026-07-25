// BOXIV-only: 撮影予約の Slack 通知（#pj-lightning-line）。
//
// 送るタイミングは 2 つだけ:
//   requested — お客様が日程調整フォームから予約申請した時（/booking/submit, /booking/other/submit）
//   approved  — 管理画面で予約が承認＝確定した時（PUT /api/booking-requests/:id/approve）
// 却下・キャンセル・日程変更は通知しない（運用要件）。
//
// 宛先は受信メッセージ通知（slack-burst-notify.boxiv.ts）と同じ CHAT_ALERT_SLACK_* を使う。
// 別チャンネルに分けたくなったら env を足すのではなく、この 1 ファイルの解決先だけ変えればよい。
// CHAT_ALERT_SLACK_* 未設定なら no-op（test 環境や未設定 OA で誤爆しない）。
//
// 呼び出し側は必ず waitUntil + catch で包む（Slack 障害で予約フロー自体を壊さない）。

import { getBookingRequestById, getFriendById, getStaffById, getStaffAvailabilityById } from '@line-crm/db';
import { AREA_LABELS, formatJstDateLabel, type AreaId } from '../utils/area.js';
import { escapeSlackText } from './slack.boxiv.js';

export interface BookingSlackEnv {
  DB: D1Database;
  CHAT_ALERT_SLACK_BOT_TOKEN?: string;
  CHAT_ALERT_SLACK_CHANNEL_ID?: string;
}

export type BookingSlackKind = 'requested' | 'approved';

/** friends.metadata の Notion 連携情報から掲載ID(label)/管理名(realName)を取り出す。 */
function parseNotionMeta(metadataJson: string | null | undefined): { label?: string | null; realName?: string | null } | null {
  if (typeof metadataJson !== 'string' || !metadataJson) return null;
  try {
    const m = JSON.parse(metadataJson) as { notion?: { label?: string | null; realName?: string | null } };
    return m.notion ?? null;
  } catch {
    return null;
  }
}

/** 「YYYY年M月D日 (曜) HH:MM 〜 HH:MM」。日付が無ければ null。 */
function formatSlotLabel(date: string | null | undefined, start: string | null | undefined, end: string | null | undefined): string | null {
  if (!date) return null;
  const time = start && end ? ` ${start} 〜 ${end}` : '';
  return `${formatJstDateLabel(date)}${time}`;
}

/**
 * 撮影予約の申請/確定を Slack へ通知する。失敗しても throw しない（呼び出し側は非致命扱い）。
 */
export async function notifyBookingSlack(
  env: BookingSlackEnv,
  bookingId: string,
  kind: BookingSlackKind,
): Promise<void> {
  const token = env.CHAT_ALERT_SLACK_BOT_TOKEN;
  const channel = env.CHAT_ALERT_SLACK_CHANNEL_ID;
  if (!token || !channel) return;

  const booking = await getBookingRequestById(env.DB, bookingId);
  if (!booking) return;

  const friend = booking.friend_id ? await getFriendById(env.DB, booking.friend_id) : null;
  const notion = parseNotionMeta(friend?.metadata);
  // お客様名は招待作成時に Notion から入った customer_name を最優先。無ければ Notion 実名 → LINE表示名。
  const customerName = booking.customer_name || notion?.realName || friend?.display_name || '-';
  const listingId = notion?.label || '-';

  const staff = booking.staff_id ? await getStaffById(env.DB, booking.staff_id) : null;
  const staffName = staff?.name || '未割当';

  const areaLabel = AREA_LABELS[booking.area as AreaId] || booking.area;
  const areaField = booking.prefecture ? `${booking.prefecture}（${areaLabel}）` : areaLabel;

  // 日時: 枠が確定していれば その枠 / 「その他の県」の3候補フローは第1〜3希望を並べる。
  // 承認済みで selected_candidate があれば確定した候補だけを出す。
  const slot = booking.slot_id ? await getStaffAvailabilityById(env.DB, booking.slot_id) : null;
  const row = booking as unknown as Record<string, string | null>;
  // 日時が1つに定まったか。定まらない（＝3候補のまま）場合は承認通知でも「確定日時」とは書かない。
  let fixedDate: string | null = null;
  if (slot) {
    fixedDate = formatSlotLabel(slot.date, slot.start_time, slot.end_time);
  } else if (booking.selected_candidate) {
    const n = booking.selected_candidate;
    fixedDate = formatSlotLabel(row[`candidate_${n}_date`], row[`candidate_${n}_start`], row[`candidate_${n}_end`]);
  }
  const candidateLines = fixedDate
    ? []
    : [1, 2, 3]
        .map((n) => {
          const label = formatSlotLabel(row[`candidate_${n}_date`], row[`candidate_${n}_start`], row[`candidate_${n}_end`]);
          return label ? `第${n}希望　*${escapeSlackText(label)}*` : null;
        })
        .filter((v): v is string => v !== null);

  const isApproved = kind === 'approved';
  const title = isApproved ? '予約が確定しました。' : '予約申請がありました。';
  const dateLabel = isApproved && fixedDate ? '確定日時' : '希望日時';

  // 日時は 1 件なら 1 行、3候補なら見出し＋インデントした候補行にする。
  let dateLines: string;
  if (fixedDate) {
    dateLines = `${dateLabel}　*${escapeSlackText(fixedDate)}*`;
  } else if (candidateLines.length) {
    dateLines = `${dateLabel}\n${candidateLines.map((l) => `　　${l}`).join('\n')}`;
  } else {
    dateLines = `${dateLabel}　*-*`;
  }

  // 明細は attachment 内の context ブロックで小さく出す。
  // context = 小さいグレー文字、attachment の color = 左のカラーサイドバー（申請=アンバー/確定=緑）で
  // 見出しと明細のメリハリを付ける。値は escapeSlackText 済みを埋め込む。
  const details = [
    `👤 お客様名　*${escapeSlackText(customerName)}*`,
    `🏷️ 掲載ID　*${escapeSlackText(listingId)}*`,
    `🗓️ ${dateLines}`,
    `📍 エリア　*${escapeSlackText(areaField)}*`,
    `📸 担当スタッフ　*${escapeSlackText(staffName)}*`,
  ].join('\n');

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      channel,
      text: title, // 通知バナー用フォールバック
      unfurl_links: false,
      unfurl_media: false,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `<!here>\n*${title}*` } }],
      attachments: [
        {
          color: isApproved ? '#16a34a' : '#f59e0b',
          fallback: title,
          blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: details }] }],
        },
      ],
    }),
  });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!j.ok) {
    console.error(`notifyBookingSlack(${kind}) failed:`, j.error || `http ${res.status}`);
  }
}
