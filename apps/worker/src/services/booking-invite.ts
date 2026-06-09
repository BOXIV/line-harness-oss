/**
 * 撮影予約 招待の作成 + LINE送信サービス。
 *
 * POST /api/booking-invites（routes/booking-invites.ts）と event-bus の
 * `send_booking_invite` アクションの両方から呼ばれる共用ロジック。
 * lineUserId / friendId を受け取り、Notion から顧客情報を補完して招待を作成し、
 * 任意で「📷 撮影日程のご予約」Flex（BB-BOOK-01）を本人へ push する。
 */
import {
  getFriendByLineUserId,
  getFriendById,
  createBookingInvite as dbCreateBookingInvite,
  jstNow,
} from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { prefectureToArea, generateInviteToken } from '../utils/area.js';
import { queryCustomerByLineUserId, getCustomerByPageId } from './notion.js';
import type { Env } from '../index.js';

export interface BookingInviteInput {
  lineUserId?: string;
  friendId?: string;
  notionPageId?: string;
  customerName?: string | null;
  prefecture?: string;
  vehicleInfo?: string | Record<string, unknown> | null;
  phone?: string | null;
  address?: string | null;
  sendLineMessage?: boolean;
  /** route からの origin フォールバック（BOOKING_BASE_URL / WORKER_URL が未設定時） */
  requestOrigin?: string;
}

export interface BookingInviteData {
  id: string;
  token: string;
  url: string;
  area: string;
  customerName: string | null;
  prefecture: string | null;
  friendId: string;
  notionPageId: string | null;
  sourcedFromNotion: boolean;
}

export type BookingInviteResult =
  | { ok: true; data: BookingInviteData }
  | { ok: false; status: 400 | 404; error: string };

/** Flex Message: 招待リンク（BB-BOOK-01） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildBookingInviteFlex(customerName: string | null, url: string): any {
  const greeting = customerName ? `${customerName} 様` : 'お客様';
  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      contents: [
        { type: 'text', text: '📷 撮影日程のご予約', weight: 'bold', size: 'lg', color: '#ffffff' },
      ],
      backgroundColor: '#0f172a',
      paddingAll: '20px',
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        { type: 'text', text: greeting, size: 'md', color: '#1e293b', weight: 'bold' },
        {
          type: 'text',
          text: 'ご出品いただく車両の撮影日程をお選びください。',
          size: 'sm',
          color: '#475569',
          wrap: true,
        },
        {
          type: 'text',
          text: '※ ご都合のよい日時を選択し、ナンバープレート下4桁をご入力ください。',
          size: 'xs',
          color: '#94a3b8',
          wrap: true,
          margin: 'md',
        },
      ],
      paddingAll: '20px',
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#0f172a',
          action: { type: 'uri', label: '日程を予約する', uri: url },
        },
      ],
      paddingAll: '16px',
    },
  };
}

/**
 * 撮影予約 招待を作成し、任意で本人へ Flex を送信する。
 * 失敗時は { ok:false, status, error } を返す（route はそれを HTTP に写像、
 * event-bus は throw して automation_logs に partial/failed として記録）。
 */
export async function createAndSendBookingInvite(
  env: Env['Bindings'],
  input: BookingInviteInput,
): Promise<BookingInviteResult> {
  // ── Step 1: Notion から顧客情報を取得（任意・可能なら） ──
  let notionCustomer = null;
  if (input.notionPageId) {
    notionCustomer = await getCustomerByPageId(input.notionPageId, env);
  } else if (input.lineUserId) {
    notionCustomer = await queryCustomerByLineUserId(input.lineUserId, env);
  }

  // ── Step 2: 値をマージ（input > Notion） ──
  const customerName = input.customerName ?? notionCustomer?.customerName ?? null;
  const prefecture = input.prefecture ?? notionCustomer?.prefecture ?? null;
  const lineUserId = input.lineUserId ?? notionCustomer?.lineUserId ?? null;
  const notionPageId = input.notionPageId ?? notionCustomer?.pageId ?? null;

  if (!prefecture) {
    return {
      ok: false,
      status: 400,
      error: 'prefecture is required (not found in input or Notion).',
    };
  }
  if (!lineUserId && !input.friendId) {
    return { ok: false, status: 400, error: 'lineUserId or friendId is required' };
  }

  // ── Step 3: friend 解決 ──
  let friend = input.friendId ? await getFriendById(env.DB, input.friendId) : null;
  if (!friend && lineUserId) {
    friend = await getFriendByLineUserId(env.DB, lineUserId);
  }
  if (!friend) {
    return { ok: false, status: 404, error: 'Friend not found in LINE Harness.' };
  }

  // ── Step 4: エリア判定 + 招待レコード作成 ──
  const area = prefectureToArea(prefecture);
  const inviteToken = generateInviteToken();

  const vehicleInfoObj: Record<string, unknown> = {};
  if (typeof input.vehicleInfo === 'string') {
    vehicleInfoObj.raw = input.vehicleInfo;
  } else if (input.vehicleInfo) {
    Object.assign(vehicleInfoObj, input.vehicleInfo);
  } else if (notionCustomer?.vehicleInfo) {
    vehicleInfoObj.raw = notionCustomer.vehicleInfo;
  }
  if (input.phone || notionCustomer?.phone) {
    vehicleInfoObj.phone = input.phone ?? notionCustomer?.phone;
  }
  if (input.address || notionCustomer?.address) {
    vehicleInfoObj.address = input.address ?? notionCustomer?.address;
  }
  const vehicleInfoStr = Object.keys(vehicleInfoObj).length > 0 ? JSON.stringify(vehicleInfoObj) : null;

  const record = await dbCreateBookingInvite(env.DB, {
    inviteToken,
    friendId: friend.id,
    customerName: customerName ?? friend.display_name ?? null,
    prefecture,
    area,
    vehicleInfo: vehicleInfoStr,
    notionPageId,
  });

  const baseUrl = env.BOOKING_BASE_URL || env.WORKER_URL || input.requestOrigin || '';
  const url = `${baseUrl}/booking?token=${inviteToken}`;

  // ── Step 5: 任意で LINE 送信 ──
  if (input.sendLineMessage && friend.line_user_id) {
    try {
      const client = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN);
      const flex = buildBookingInviteFlex(record.customer_name, url);
      await client.pushMessage(friend.line_user_id, [
        { type: 'flex', altText: '撮影日程のご予約', contents: flex },
      ]);
      // 個別チャット画面に反映するため messages_log にも残す
      await env.DB.prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, created_at)
         VALUES (?, ?, 'outgoing', 'flex', ?, NULL, NULL, 'push', ?)`,
      )
        .bind(crypto.randomUUID(), friend.id, JSON.stringify(flex), jstNow())
        .run();
    } catch (err) {
      console.error('booking-invite service: LINE push failed (non-blocking):', err);
    }
  }

  return {
    ok: true,
    data: {
      id: record.id,
      token: inviteToken,
      url,
      area,
      customerName: record.customer_name,
      prefecture: record.prefecture,
      friendId: friend.id,
      notionPageId,
      sourcedFromNotion: !!notionCustomer,
    },
  };
}
