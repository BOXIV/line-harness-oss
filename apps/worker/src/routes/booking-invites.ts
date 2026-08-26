/**
 * 撮影予約 招待作成API
 *
 * メインフロー: lineUserId を受け取り、Notion DB から顧客情報を取得して招待を作成する。
 * フォールバック: Notion 未設定 or 検索失敗時は手動指定 (customerName/prefecture/vehicleInfo) を利用。
 *
 * 実処理は services/booking-invite.ts の createAndSendBookingInvite に委譲（event-bus の
 * send_booking_invite アクションと共用）。
 */

import { Hono } from 'hono';
import { getBookingRequestByToken } from '@line-crm/db';
import { createAndSendBookingInvite } from '../services/booking-invite.js';
import type { BookingInviteInput } from '../services/booking-invite.js';
import type { Env } from '../index.js';

const bookingInvites = new Hono<Env>();

/**
 * POST /api/booking-invites
 *
 * body: BookingInviteInput
 *   { lineUserId?, friendId?, notionPageId?, customerName?, prefecture?, vehicleInfo?,
 *     phone?, address?, sendLineMessage? }
 * response: { success, data: { id, token, url, area, customerName, prefecture, friendId } }
 */
bookingInvites.post('/api/booking-invites', async (c) => {
  try {
    const body = await c.req.json<BookingInviteInput>();
    const result = await createAndSendBookingInvite(c.env, {
      ...body,
      requestOrigin: new URL(c.req.url).origin,
      // 送信者は認証済み context から。body より後に置いて、クライアント指定の
      // actor を必ず上書きする（送信者名のなりすまし防止）。
      actor: c.get('staff') ?? null,
    });
    if (!result.ok) {
      return c.json({ success: false, error: result.error }, result.status);
    }
    return c.json({ success: true, data: result.data }, 201);
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

export { bookingInvites };
