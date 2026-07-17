/**
 * 撮影予約申請 管理API
 *
 * 管理者が予約一覧を確認し、承認・却下・スタッフ変更・編集・削除を行うAPI。
 */

import { Hono } from 'hono';
import {
  listBookingRequests,
  getBookingRequestById,
  updateBookingRequest,
  approveBookingRequest,
  rejectBookingRequest,
  cancelBookingRequest,
  getStaffById,
  deleteBookingRequest,
  getStaffAvailabilityById,
  markSlotBooked,
  markSlotUnbooked,
  getFriendById,
  getStaffMembers,
  findAvailableStaffForSlot,
} from '@line-crm/db';
import type { Env } from '../index.js';
import { firstSentMessageId } from '../utils/quote.js';

const bookingRequests = new Hono<Env>();

/** GET /api/booking-requests — 一覧（フィルタ付き）
 *
 * 権限: staffロールは自分が担当する予約のみ。admin/ownerは全体。
 */
bookingRequests.get('/api/booking-requests', async (c) => {
  try {
    const currentStaff = c.get('staff');
    const isStaffRole = currentStaff?.role === 'staff';

    const status = c.req.query('status') ?? undefined;
    const area = c.req.query('area') ?? undefined;
    let staffId = c.req.query('staffId') ?? undefined;
    const friendId = c.req.query('friendId') ?? undefined;
    const dateFrom = c.req.query('dateFrom') ?? undefined;
    const dateTo = c.req.query('dateTo') ?? undefined;

    if (isStaffRole) {
      staffId = currentStaff.id;
    }

    const items = await listBookingRequests(c.env.DB, {
      status,
      area,
      staffId,
      friendId,
      dateFrom,
      dateTo,
    });

    // スタッフ + 友だち情報を結合
    const staffList = await getStaffMembers(c.env.DB);
    const staffMap = new Map(staffList.map((s) => [s.id, s]));

    const data = await Promise.all(
      items.map(async (row) => {
        const friend = row.friend_id ? await getFriendById(c.env.DB, row.friend_id) : null;
        const slot = row.slot_id ? await getStaffAvailabilityById(c.env.DB, row.slot_id) : null;
        return {
          id: row.id,
          friendId: row.friend_id,
          friendName: friend?.display_name ?? null,
          staffId: row.staff_id,
          staffName: row.staff_id ? staffMap.get(row.staff_id)?.name ?? null : null,
          inviteToken: row.invite_token,
          customerName: row.customer_name,
          prefecture: row.prefecture,
          area: row.area,
          vehicleInfo: row.vehicle_info,
          slot: slot
            ? {
                id: slot.id,
                date: slot.date,
                startTime: slot.start_time,
                endTime: slot.end_time,
                area: slot.area,
              }
            : null,
          plateNumber: row.plate_number,
          status: row.status,
          notes: row.notes,
          approvedBy: row.approved_by,
          approvedAt: row.approved_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      }),
    );

    return c.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/booking-requests error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** GET /api/booking-requests/:id — 詳細 + 同時間帯の代替スタッフ候補 */
bookingRequests.get('/api/booking-requests/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const row = await getBookingRequestById(c.env.DB, id);
    if (!row) return c.json({ success: false, error: 'Not found' }, 404);

    const friend = row.friend_id ? await getFriendById(c.env.DB, row.friend_id) : null;
    const slot = row.slot_id ? await getStaffAvailabilityById(c.env.DB, row.slot_id) : null;

    const staffList = await getStaffMembers(c.env.DB);
    const staffMap = new Map(staffList.map((s) => [s.id, s]));

    // 同時間帯の代替スタッフ候補（変更用）— 現担当は除外
    let alternativeStaff: unknown[] = [];
    if (slot) {
      const candidates = await findAvailableStaffForSlot(
        c.env.DB,
        slot.area,
        slot.date,
        slot.start_time,
        slot.end_time,
      );
      alternativeStaff = candidates
        .filter((cand) => cand.staff_id !== row.staff_id)
        .map((cand) => ({
          availabilityId: cand.id,
          staffId: cand.staff_id,
          staffName: staffMap.get(cand.staff_id)?.name ?? null,
        }));
    }

    return c.json({
      success: true,
      data: {
        ...row,
        friend_name: friend?.display_name ?? null,
        staff_name: row.staff_id ? staffMap.get(row.staff_id)?.name ?? null : null,
        slot,
        alternativeStaff,
      },
    });
  } catch (err) {
    console.error('GET /api/booking-requests/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * PUT /api/booking-requests/:id — 編集（スタッフ変更等）
 * body: { staffId?, slotId?, plateNumber?, notes?, status? }
 *
 * スタッフ/スロット変更時:
 *  - 旧スロットがあれば is_booked=0 に戻す
 *  - 新スロットを is_booked=1 にする
 */
bookingRequests.put('/api/booking-requests/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const currentStaff = c.get('staff');
    const body = await c.req.json<{
      staffId?: string;
      slotId?: string;
      plateNumber?: string;
      notes?: string;
      status?: string;
    }>();

    const existing = await getBookingRequestById(c.env.DB, id);
    if (!existing) return c.json({ success: false, error: 'Not found' }, 404);

    // BOXIV: 担当スタッフ(staff_id)とシフト枠(slot_id)は必ず一体で更新する。
    // 旧実装は片方だけ更新できたため、一覧（staff_id 表示）とシフトUI（slot の持ち主に表示）が
    // 別々のスタッフを指す不整合が起きた（例: 撮影予約 8736 = 一覧は小林・ガント×は薄井）。
    let targetStaffId = body.staffId;
    let targetSlotId = body.slotId;

    if (targetSlotId) {
      // 枠を指定 → 担当スタッフは枠の持ち主に自動追従（同一枠の再指定でも同期＝自己修復）
      const newSlot = await getStaffAvailabilityById(c.env.DB, targetSlotId);
      if (!newSlot) {
        return c.json({ success: false, error: '指定されたシフト枠が見つかりません' }, 404);
      }
      if (targetSlotId !== existing.slot_id && newSlot.is_booked) {
        return c.json({ success: false, error: 'そのシフト枠は既に他の予約で埋まっています' }, 409);
      }
      if (targetStaffId && targetStaffId !== newSlot.staff_id) {
        return c.json({ success: false, error: 'staffId とシフト枠の担当スタッフが一致しません' }, 400);
      }
      targetStaffId = newSlot.staff_id;
    } else if (targetStaffId && targetStaffId !== existing.staff_id && targetSlotId === undefined) {
      // 担当だけ指定 → 同一日時・同一エリアの変更先スタッフの空き枠にシフト枠も差し替える
      const currentSlot = existing.slot_id
        ? await getStaffAvailabilityById(c.env.DB, existing.slot_id)
        : null;
      if (currentSlot) {
        const candidates = await findAvailableStaffForSlot(
          c.env.DB,
          currentSlot.area,
          currentSlot.date,
          currentSlot.start_time,
          currentSlot.end_time,
        );
        const newSlot = candidates.find((s) => s.staff_id === targetStaffId);
        if (!newSlot) {
          return c.json(
            { success: false, error: '変更先スタッフに同一日時の空き枠がありません（先にシフトを登録してください）' },
            409,
          );
        }
        targetSlotId = newSlot.id;
      }
    }

    // staffロールは自分担当のみ編集可、かつ担当変更は不可
    if (currentStaff?.role === 'staff') {
      if (existing.staff_id !== currentStaff.id) {
        return c.json({ success: false, error: 'Forbidden' }, 403);
      }
      if (targetStaffId && targetStaffId !== currentStaff.id) {
        return c.json({ success: false, error: 'Forbidden: cannot reassign booking' }, 403);
      }
      // approve/reject/cancel は専用エンドポイント(manager以上)に一本化。staff が汎用 PUT で
      // status を直接書き換える抜け道を塞ぐ（cancel を含めないとスロット未開放・通知なしの
      // 不整合キャンセルを staff が作れてしまう）。
      if (body.status && ['approved', 'rejected', 'cancelled'].includes(body.status)) {
        return c.json({ success: false, error: 'Forbidden: only owner/admin/manager can change status' }, 403);
      }
    }

    // スロット差し替え（staff_id も同時に更新され、一覧とシフトUIの整合が保たれる）
    if (targetSlotId !== undefined && targetSlotId !== existing.slot_id) {
      if (existing.slot_id) {
        await markSlotUnbooked(c.env.DB, existing.slot_id);
      }
      if (targetSlotId) {
        await markSlotBooked(c.env.DB, targetSlotId);
      }
    }

    const updated = await updateBookingRequest(c.env.DB, id, {
      ...body,
      staffId: targetStaffId,
      slotId: targetSlotId,
    });
    return c.json({ success: true, data: updated });
  } catch (err) {
    console.error('PUT /api/booking-requests/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** PUT /api/booking-requests/:id/approve — 承認 + LINE通知
 *
 * body (optional): { selectedCandidate?: 1|2|3 } — 「その他の県」の3候補から選ぶ場合に指定
 */
bookingRequests.put('/api/booking-requests/:id/approve', async (c) => {
  try {
    const id = c.req.param('id');
    const staff = c.get('staff');
    if (!staff) return c.json({ success: false, error: 'Unauthorized' }, 401);

    // 権限: owner/admin/manager が承認可能
    if (staff.role !== 'admin' && staff.role !== 'owner' && staff.role !== 'manager') {
      return c.json({ success: false, error: 'Forbidden: owner/admin/manager only' }, 403);
    }

    // body に selectedCandidate が含まれる場合は保存
    const body = await c.req
      .json<{ selectedCandidate?: number }>()
      .catch(() => ({} as { selectedCandidate?: number }));

    if (body.selectedCandidate && [1, 2, 3].includes(body.selectedCandidate)) {
      await updateBookingRequest(c.env.DB, id, { selectedCandidate: body.selectedCandidate });
    }

    // env-owner や実在しないスタッフIDの場合は FK 違反を避けるため null を渡す
    const realStaff = await getStaffById(c.env.DB, staff.id);
    const approverId = realStaff ? staff.id : null;
    const updated = await approveBookingRequest(c.env.DB, id, approverId);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);

    // LINE通知（非ブロッキング、ただしレスポンス後もWorkerを生かす）
    c.executionCtx.waitUntil(
      sendBookingStatusNotification(c.env, id, 'approved').catch((err) =>
        console.error('approve notification failed:', err),
      ),
    );

    return c.json({ success: true, data: updated });
  } catch (err) {
    console.error('PUT /api/booking-requests/:id/approve error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** PUT /api/booking-requests/:id/reject — 却下 + LINE通知（owner/admin/manager） */
bookingRequests.put('/api/booking-requests/:id/reject', async (c) => {
  try {
    const id = c.req.param('id');
    const staff = c.get('staff');
    if (!staff) return c.json({ success: false, error: 'Unauthorized' }, 401);
    if (staff.role !== 'admin' && staff.role !== 'owner' && staff.role !== 'manager') {
      return c.json({ success: false, error: 'Forbidden: owner/admin/manager only' }, 403);
    }

    const body = await c.req.json<{ notes?: string }>().catch(() => ({} as { notes?: string }));

    const existing = await getBookingRequestById(c.env.DB, id);
    if (!existing) return c.json({ success: false, error: 'Not found' }, 404);

    // 紐付くスロットを開放
    if (existing.slot_id) {
      await markSlotUnbooked(c.env.DB, existing.slot_id);
    }

    const realStaff = await getStaffById(c.env.DB, staff.id);
    const approverId = realStaff ? staff.id : null;
    const updated = await rejectBookingRequest(c.env.DB, id, approverId, body.notes);

    c.executionCtx.waitUntil(
      sendBookingStatusNotification(c.env, id, 'rejected').catch((err) =>
        console.error('reject notification failed:', err),
      ),
    );

    return c.json({ success: true, data: updated });
  } catch (err) {
    console.error('PUT /api/booking-requests/:id/reject error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** PUT /api/booking-requests/:id/cancel — 承認済み日程のキャンセル + LINE通知（owner/admin/manager）
 *
 * 雨天中止などで確定済みの撮影日程を取り消す。スロットを開放し、対象ユーザーへキャンセル通知を送る。
 * キャンセル後は個別チャットの「日程調整送信」から改めて最新日程のフォームを再送できる。
 * body (optional): { reason?: string } — キャンセル理由（例: 雨天のため）。通知に含め notes にも保存。
 */
bookingRequests.put('/api/booking-requests/:id/cancel', async (c) => {
  try {
    const id = c.req.param('id');
    const staff = c.get('staff');
    if (!staff) return c.json({ success: false, error: 'Unauthorized' }, 401);
    // 権限: owner/admin/manager（マネージャー以上）
    if (staff.role !== 'admin' && staff.role !== 'owner' && staff.role !== 'manager') {
      return c.json({ success: false, error: 'Forbidden: owner/admin/manager only' }, 403);
    }

    const existing = await getBookingRequestById(c.env.DB, id);
    if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
    // 承認済みの予約のみキャンセル可能（未承認は却下フローを使う）
    if (existing.status !== 'approved') {
      return c.json({ success: false, error: 'Only approved bookings can be cancelled' }, 400);
    }

    const body = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));
    const reason = body.reason?.trim() || undefined;

    // 確定スロットを開放（他の予約で再利用できるように）
    if (existing.slot_id) {
      await markSlotUnbooked(c.env.DB, existing.slot_id);
    }

    const updated = await cancelBookingRequest(c.env.DB, id, reason);

    c.executionCtx.waitUntil(
      sendBookingStatusNotification(c.env, id, 'cancelled', reason).catch((err) =>
        console.error('cancel notification failed:', err),
      ),
    );

    return c.json({ success: true, data: updated });
  } catch (err) {
    console.error('PUT /api/booking-requests/:id/cancel error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** DELETE /api/booking-requests/:id （admin/owner のみ） */
bookingRequests.delete('/api/booking-requests/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const staff = c.get('staff');
    if (staff && staff.role !== 'admin' && staff.role !== 'owner') {
      return c.json({ success: false, error: 'Forbidden: admin/owner only' }, 403);
    }
    const existing = await getBookingRequestById(c.env.DB, id);
    if (!existing) return c.json({ success: false, error: 'Not found' }, 404);

    if (existing.slot_id) {
      await markSlotUnbooked(c.env.DB, existing.slot_id);
    }
    await deleteBookingRequest(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/booking-requests/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ─── LINE通知ヘルパー ──────────────────────────────────────

async function sendBookingStatusNotification(
  env: Env['Bindings'],
  bookingId: string,
  status: 'approved' | 'rejected' | 'cancelled',
  reason?: string,
): Promise<void> {
  const booking = await getBookingRequestById(env.DB, bookingId);
  if (!booking?.friend_id) return;
  const friend = await getFriendById(env.DB, booking.friend_id);
  if (!friend?.line_user_id) return;

  const { formatJstDateLabel } = await import('../utils/area.js');
  const slot = booking.slot_id ? await getStaffAvailabilityById(env.DB, booking.slot_id) : null;
  let dateLabel = '';
  let timeLabel = '';
  if (slot) {
    dateLabel = formatJstDateLabel(slot.date);
    timeLabel = `${slot.start_time} 〜 ${slot.end_time}`;
  } else if (booking.area === 'other' && booking.selected_candidate) {
    const n = booking.selected_candidate;
    const row = booking as unknown as Record<string, string | null>;
    const date = row[`candidate_${n}_date`];
    const start = row[`candidate_${n}_start`];
    const end = row[`candidate_${n}_end`];
    if (date && start && end) {
      dateLabel = formatJstDateLabel(date);
      timeLabel = `${start} 〜 ${end}`;
    }
  }

  const isApproved = status === 'approved';
  const isCancelled = status === 'cancelled';
  // approved=濃紺 / rejected=赤 / cancelled=グレー
  const headerColor = isApproved ? '#0f172a' : isCancelled ? '#475569' : '#dc2626';
  const headerEmoji = isApproved ? '🎉' : isCancelled ? '🌧️' : '⚠️';
  const headerText = isApproved
    ? '撮影日が確定しました'
    : isCancelled
      ? '撮影日程がキャンセルされました'
      : 'ご予約日程について';
  const headerSub = isApproved
    ? '下記の日程でお伺いします'
    : isCancelled
      ? '改めて日程調整のご案内をお送りします'
      : '日程の再調整をお願いします';
  const bodyText = isApproved
    ? '当日は車両のナンバープレートを確認の上、撮影スタッフがお伺いいたします。お時間に余裕を持ってご準備ください。'
    : isCancelled
      ? `申し訳ございませんが、上記の撮影日程はキャンセルとなりました。${reason ? `\n理由: ${reason}` : ''}\n改めて撮影日程調整のご案内をLINEでお送りしますので、少々お待ちください。`
      : '申し訳ございませんが、ご予約日程の調整をお願いいたします。担当者より別途ご連絡いたします。';

  const hasDateInfo = !!dateLabel && !!timeLabel;
  // カード色: approved=緑 / cancelled=グレー / rejected=赤
  const cardBg = isApproved ? '#f0fdf4' : isCancelled ? '#f1f5f9' : '#fef2f2';
  const cardLabelColor = isApproved ? '#15803d' : isCancelled ? '#475569' : '#b91c1c';
  const cardTitle = isCancelled ? '📅 キャンセルされた日時' : '📅 撮影日時';

  const flex = {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      contents: [
        { type: 'text', text: `${headerEmoji} ${headerText}`, weight: 'bold', size: 'lg', color: '#ffffff', wrap: true },
        { type: 'text', text: headerSub, size: 'xs', color: '#ffffff', margin: 'sm', wrap: true },
      ],
      backgroundColor: headerColor,
      paddingAll: '20px',
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        // 日時を大きく目立たせるカード
        ...(hasDateInfo
          ? [
              {
                type: 'box',
                layout: 'vertical',
                backgroundColor: cardBg,
                cornerRadius: 'lg',
                paddingAll: '20px',
                contents: [
                  {
                    type: 'text',
                    text: cardTitle,
                    size: 'xs',
                    color: cardLabelColor,
                    weight: 'bold',
                  },
                  {
                    type: 'text',
                    text: dateLabel,
                    size: 'xl',
                    weight: 'bold',
                    color: isCancelled ? '#94a3b8' : '#0f172a',
                    ...(isCancelled ? { decoration: 'line-through' } : {}),
                    margin: 'sm',
                    wrap: true,
                  },
                  {
                    type: 'text',
                    text: timeLabel,
                    size: 'xl',
                    weight: 'bold',
                    color: isCancelled ? '#94a3b8' : '#0f172a',
                    ...(isCancelled ? { decoration: 'line-through' } : {}),
                    margin: 'xs',
                  },
                ],
              },
              { type: 'separator', margin: 'md' },
              {
                type: 'box',
                layout: 'vertical',
                spacing: 'sm',
                margin: 'md',
                contents: [
                  {
                    type: 'box',
                    layout: 'horizontal',
                    contents: [
                      { type: 'text', text: 'お客様', size: 'xs', color: '#94a3b8', flex: 3 },
                      { type: 'text', text: booking.customer_name || '-', size: 'sm', color: '#1e293b', weight: 'bold', flex: 7, wrap: true },
                    ],
                  },
                  {
                    type: 'box',
                    layout: 'horizontal',
                    contents: [
                      { type: 'text', text: '都道府県', size: 'xs', color: '#94a3b8', flex: 3 },
                      { type: 'text', text: booking.prefecture, size: 'sm', color: '#1e293b', weight: 'bold', flex: 7 },
                    ],
                  },
                  {
                    type: 'box',
                    layout: 'horizontal',
                    contents: [
                      { type: 'text', text: 'ナンバー下4桁', size: 'xs', color: '#94a3b8', flex: 3 },
                      { type: 'text', text: booking.plate_number || '-', size: 'sm', color: '#1e293b', weight: 'bold', flex: 7 },
                    ],
                  },
                ],
              },
              { type: 'separator', margin: 'md' },
            ]
          : []),
        { type: 'text', text: bodyText, size: 'sm', color: '#475569', wrap: true, margin: 'md' },
      ],
      paddingAll: '20px',
    },
  };

  // 未フォロー（友だち未追加/ブロック中）には届かない。送信失敗として記録してスキップ。
  if (!friend.is_following) {
    const { logFailedOutgoing } = await import('../services/message-log.boxiv.js');
    await logFailedOutgoing(env.DB, friend.id, 'flex', JSON.stringify(flex));
    return;
  }
  const { LineClient } = await import('@line-crm/line-sdk');
  const client = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN);
  const sentLineId = firstSentMessageId(await client.pushMessage(friend.line_user_id, [
    {
      type: 'flex',
      altText: isApproved ? '撮影日が確定しました' : isCancelled ? '撮影日程がキャンセルされました' : 'ご予約日程について',
      contents: flex,
    },
  ]));
  // BOXIV: messages_log に記録して個別チャット画面に表示。line_message_id=友だちの引用解決用。
  try {
    const { jstNow } = await import('@line-crm/db');
    await env.DB
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, line_message_id, delivery_type, created_at)
         VALUES (?, ?, 'outgoing', 'flex', ?, NULL, NULL, ?, 'push', ?)`,
      )
      .bind(crypto.randomUUID(), friend.id, JSON.stringify(flex), sentLineId, jstNow())
      .run();
  } catch (err) {
    console.error('booking-requests log to messages_log failed (non-blocking):', err);
  }
}

export { bookingRequests };
