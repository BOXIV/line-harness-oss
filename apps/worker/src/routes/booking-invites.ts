/**
 * 撮影予約 招待作成API
 *
 * メインフロー: lineUserId を受け取り、Notion DB から顧客情報を取得して招待を作成する。
 * フォールバック: Notion 未設定 or 検索失敗時は手動指定 (customerName/prefecture/vehicleInfo) を利用。
 *
 * Notion からは以下を取得:
 *  - お客様名
 *  - 都道府県 → エリア判定に使用
 *  - 車両情報
 *  - 電話番号、住所（管理画面表示用、メタデータとして保存）
 */

import { Hono } from 'hono';
import {
  getFriendByLineUserId,
  getFriendById,
  createBookingInvite as dbCreateBookingInvite,
  getBookingRequestByToken,
  jstNow,
} from '@line-crm/db';
import { prefectureToArea, generateInviteToken } from '../utils/area.js';
import { queryCustomerByLineUserId, getCustomerByPageId } from '../services/notion.js';
import type { Env } from '../index.js';

const bookingInvites = new Hono<Env>();

/**
 * POST /api/booking-invites
 *
 * body: {
 *   lineUserId?: string;           // 主キー（Notionで検索 or friendsで解決）
 *   friendId?: string;             // 代替（既に解決済みのfriend_id）
 *   notionPageId?: string;         // Notionページを直接指定（管理画面から）
 *   // 以下はフォールバック or Notion未使用時の手動指定
 *   customerName?: string;
 *   prefecture?: string;
 *   vehicleInfo?: string | Record<string, unknown>;
 *   sendLineMessage?: boolean;
 * }
 *
 * response: { success, data: { id, token, url, area, customerName, prefecture, friendId } }
 */
bookingInvites.post('/api/booking-invites', async (c) => {
  try {
    const body = await c.req.json<{
      lineUserId?: string;
      friendId?: string;
      notionPageId?: string;
      customerName?: string | null;
      prefecture?: string;
      vehicleInfo?: string | Record<string, unknown> | null;
      phone?: string | null;
      address?: string | null;
      sendLineMessage?: boolean;
    }>();

    // ── Step 1: Notion から顧客情報を取得（任意・可能なら） ──
    let notionCustomer = null;
    if (body.notionPageId) {
      notionCustomer = await getCustomerByPageId(body.notionPageId, c.env);
    } else if (body.lineUserId) {
      notionCustomer = await queryCustomerByLineUserId(body.lineUserId, c.env);
    }

    // ── Step 2: 値をマージ（body > Notion） ──
    const customerName = body.customerName ?? notionCustomer?.customerName ?? null;
    const prefecture = body.prefecture ?? notionCustomer?.prefecture ?? null;
    const lineUserId = body.lineUserId ?? notionCustomer?.lineUserId ?? null;
    const notionPageId = body.notionPageId ?? notionCustomer?.pageId ?? null;

    if (!prefecture) {
      return c.json(
        {
          success: false,
          error:
            'prefecture is required (not found in body or Notion). Make sure Notion NOTION_PROP_PREFECTURE matches your DB column.',
        },
        400,
      );
    }
    if (!lineUserId && !body.friendId) {
      return c.json({ success: false, error: 'lineUserId or friendId is required' }, 400);
    }

    // ── Step 3: friend解決 ──
    let friend = body.friendId ? await getFriendById(c.env.DB, body.friendId) : null;
    if (!friend && lineUserId) {
      friend = await getFriendByLineUserId(c.env.DB, lineUserId);
    }
    if (!friend) {
      return c.json(
        {
          success: false,
          error:
            'Friend not found in LINE Harness. Make sure the user has added the bot as a friend.',
        },
        404,
      );
    }

    // ── Step 4: エリア判定 + 招待レコード作成 ──
    const area = prefectureToArea(prefecture);
    const inviteToken = generateInviteToken();

    // vehicle_info + 補助情報をJSONにまとめる
    const vehicleInfoObj: Record<string, unknown> = {};
    if (typeof body.vehicleInfo === 'string') {
      vehicleInfoObj.raw = body.vehicleInfo;
    } else if (body.vehicleInfo) {
      Object.assign(vehicleInfoObj, body.vehicleInfo);
    } else if (notionCustomer?.vehicleInfo) {
      vehicleInfoObj.raw = notionCustomer.vehicleInfo;
    }
    if (body.phone || notionCustomer?.phone) {
      vehicleInfoObj.phone = body.phone ?? notionCustomer?.phone;
    }
    if (body.address || notionCustomer?.address) {
      vehicleInfoObj.address = body.address ?? notionCustomer?.address;
    }
    const vehicleInfoStr = Object.keys(vehicleInfoObj).length > 0 ? JSON.stringify(vehicleInfoObj) : null;

    const record = await dbCreateBookingInvite(c.env.DB, {
      inviteToken,
      friendId: friend.id,
      customerName: customerName ?? friend.display_name ?? null,
      prefecture,
      area,
      vehicleInfo: vehicleInfoStr,
      notionPageId,
    });

    const baseUrl = c.env.BOOKING_BASE_URL || c.env.WORKER_URL || new URL(c.req.url).origin;
    const url = `${baseUrl}/booking?token=${inviteToken}`;

    // ── Step 5: 任意でLINE送信 ──
    if (body.sendLineMessage && friend.line_user_id) {
      try {
        const { LineClient } = await import('@line-crm/line-sdk');
        const accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
        const client = new LineClient(accessToken);
        const flex = buildBookingInviteFlex(record.customer_name, url);
        await client.pushMessage(friend.line_user_id, [
          {
            type: 'flex',
            altText: '撮影日程のご予約',
            contents: flex,
          },
        ]);
        // BOXIV: Log to messages_log so individual chat view shows this notification
        await c.env.DB
          .prepare(
            `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, created_at)
             VALUES (?, ?, 'outgoing', 'flex', ?, NULL, NULL, 'push', ?)`,
          )
          .bind(crypto.randomUUID(), friend.id, JSON.stringify(flex), jstNow())
          .run();
      } catch (err) {
        console.error('booking-invites: LINE push failed (non-blocking):', err);
      }
    }

    return c.json(
      {
        success: true,
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
      },
      201,
    );
  } catch (err) {
    console.error('POST /api/booking-invites error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** GET /api/booking-debug/version — デプロイ確認用 */
bookingInvites.get('/api/booking-debug/version', async (c) => {
  return c.json({
    success: true,
    data: {
      bookingOtherFormHasInlineErrors: true, // marker: 2026-04-08 inline error rev
      version: '2026-04-08-inline-errors',
    },
  });
});

/** GET /api/booking-debug/dates?token=xxx — 日付ピッカーのデバッグ用 */
bookingInvites.get('/api/booking-debug/dates', async (c) => {
  try {
    const token = c.req.query('token');
    if (!token) return c.json({ success: false, error: 'token required' }, 400);
    const record = await getBookingRequestByToken(c.env.DB, token);
    if (!record) return c.json({ success: false, error: 'not found' }, 404);
    const { getDateRange } = await import('../utils/area.js');
    const { findDatesWithAvailability } = await import('../utils/staff-assignment.js');
    const dates = getDateRange(28);
    const datesWithAvail = await findDatesWithAvailability(c.env.DB, record.area, dates);
    return c.json({
      success: true,
      data: {
        area: record.area,
        prefecture: record.prefecture,
        today: new Date().toISOString(),
        datesInRange: dates,
        datesWithAvailability: Array.from(datesWithAvail).sort(),
      },
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

/** GET /api/booking-invites/:token — 招待情報取得（デバッグ用） */
bookingInvites.get('/api/booking-invites/:token', async (c) => {
  try {
    const token = c.req.param('token');
    const record = await getBookingRequestByToken(c.env.DB, token);
    if (!record) {
      return c.json({ success: false, error: 'Invite not found' }, 404);
    }
    return c.json({ success: true, data: record });
  } catch (err) {
    console.error('GET /api/booking-invites/:token error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** Flex Message: 招待リンク */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildBookingInviteFlex(customerName: string | null, url: string): any {
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
          action: {
            type: 'uri',
            label: '日程を予約する',
            uri: url,
          },
        },
      ],
      paddingAll: '16px',
    },
  };
}

export { bookingInvites };
