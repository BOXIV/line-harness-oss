/**
 * スタッフ対応可能日（シフト）管理API
 *
 * 撮影スタッフが管理画面から自分のシフトを登録するためのAPI。
 * 1日1エリア × 120分スロット単位。
 */

import { Hono } from 'hono';
import {
  listStaffAvailability,
  createStaffAvailability,
  getStaffAvailabilityById,
  updateStaffAvailability,
  deleteStaffAvailability,
  getStaffMembers,
} from '@line-crm/db';
import type { Env } from '../index.js';

const staffAvailability = new Hono<Env>();

/**
 * シフト登録対象は撮影スタッフ(role='staff')のみ許可する。
 * オーナー/マネージャー/管理者は全撮影スタッフのシフトを閲覧できるが、
 * 自身は撮影に入らないためシフト登録者にはなれない。
 * 戻り値が null なら OK、object ならその status/error で拒否する。
 */
async function checkShiftTarget(
  db: D1Database,
  staffId: string,
): Promise<{ status: 403 | 404; error: string } | null> {
  const target = (await getStaffMembers(db)).find((s) => s.id === staffId);
  if (!target) return { status: 404, error: 'Staff not found' };
  if (target.role !== 'staff') {
    return {
      status: 403,
      error: 'シフト登録は撮影スタッフ(staff)のみ可能です（オーナー/マネージャーは登録対象外）',
    };
  }
  return null;
}

/** GET /api/staff-availability — 一覧
 *
 * 権限: staffロールは自分のシフトのみ。admin/ownerは全員 or 指定staffIdで絞り込み。
 */
staffAvailability.get('/api/staff-availability', async (c) => {
  try {
    const currentStaff = c.get('staff');
    const isStaffRole = currentStaff?.role === 'staff';

    let staffId = c.req.query('staffId') ?? undefined;
    if (isStaffRole) {
      // staffロールは自分のシフトのみ強制
      staffId = currentStaff.id;
    }

    const date = c.req.query('date') ?? undefined;
    const dateFrom = c.req.query('dateFrom') ?? undefined;
    const dateTo = c.req.query('dateTo') ?? undefined;
    const area = c.req.query('area') ?? undefined;
    const includeBooked = c.req.query('includeBooked') === 'true';

    const items = await listStaffAvailability(c.env.DB, {
      staffId,
      date,
      dateFrom,
      dateTo,
      area,
      includeBooked,
    });

    // スタッフ情報をJOIN代わりにメモリで結合
    const staffList = await getStaffMembers(c.env.DB);
    const staffMap = new Map(staffList.map((s) => [s.id, s]));

    const data = items.map((row) => ({
      id: row.id,
      staffId: row.staff_id,
      staffName: staffMap.get(row.staff_id)?.name ?? null,
      date: row.date,
      startTime: row.start_time,
      endTime: row.end_time,
      area: row.area,
      isBooked: Boolean(row.is_booked),
      createdAt: row.created_at,
    }));

    return c.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/staff-availability error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** POST /api/staff-availability — 作成（staffは自分のみ） */
staffAvailability.post('/api/staff-availability', async (c) => {
  try {
    const currentStaff = c.get('staff');
    const body = await c.req.json<{
      staffId: string;
      date: string;
      startTime: string;
      endTime: string;
      area: string;
    }>();

    if (!body.staffId || !body.date || !body.startTime || !body.endTime || !body.area) {
      return c.json({ success: false, error: 'staffId, date, startTime, endTime, area are required' }, 400);
    }

    if (currentStaff?.role === 'staff' && body.staffId !== currentStaff.id) {
      return c.json({ success: false, error: 'Forbidden: cannot create shift for another staff' }, 403);
    }

    const targetErr = await checkShiftTarget(c.env.DB, body.staffId);
    if (targetErr) return c.json({ success: false, error: targetErr.error }, targetErr.status);

    const row = await createStaffAvailability(c.env.DB, body);
    return c.json({ success: true, data: row }, 201);
  } catch (err) {
    console.error('POST /api/staff-availability error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/staff-availability/bulk — 一括作成
 * body: { staffId, area, dates: string[], slots: { startTime, endTime }[] }
 */
staffAvailability.post('/api/staff-availability/bulk', async (c) => {
  try {
    const currentStaff = c.get('staff');
    const body = await c.req.json<{
      staffId: string;
      area: string;
      dates: string[];
      slots: { startTime: string; endTime: string }[];
    }>();

    if (!body.staffId || !body.area || !Array.isArray(body.dates) || !Array.isArray(body.slots)) {
      return c.json({ success: false, error: 'Invalid bulk input' }, 400);
    }

    if (currentStaff?.role === 'staff' && body.staffId !== currentStaff.id) {
      return c.json({ success: false, error: 'Forbidden: cannot create shifts for another staff' }, 403);
    }

    const targetErr = await checkShiftTarget(c.env.DB, body.staffId);
    if (targetErr) return c.json({ success: false, error: targetErr.error }, targetErr.status);

    const created: unknown[] = [];
    for (const date of body.dates) {
      for (const slot of body.slots) {
        const row = await createStaffAvailability(c.env.DB, {
          staffId: body.staffId,
          area: body.area,
          date,
          startTime: slot.startTime,
          endTime: slot.endTime,
        });
        created.push(row);
      }
    }

    return c.json({ success: true, data: { count: created.length } }, 201);
  } catch (err) {
    console.error('POST /api/staff-availability/bulk error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** PUT /api/staff-availability/:id — 編集（staffは自分のみ） */
staffAvailability.put('/api/staff-availability/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const currentStaff = c.get('staff');
    const body = await c.req.json<{
      staffId?: string;
      date?: string;
      startTime?: string;
      endTime?: string;
      area?: string;
    }>();

    if (currentStaff?.role === 'staff') {
      const existing = await getStaffAvailabilityById(c.env.DB, id);
      if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
      if (existing.staff_id !== currentStaff.id) {
        return c.json({ success: false, error: 'Forbidden' }, 403);
      }
      // staffは他人の staffId に変更できない
      if (body.staffId && body.staffId !== currentStaff.id) {
        return c.json({ success: false, error: 'Forbidden: cannot reassign shift' }, 403);
      }
    }

    const row = await updateStaffAvailability(c.env.DB, id, body);
    if (!row) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: row });
  } catch (err) {
    console.error('PUT /api/staff-availability/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** DELETE /api/staff-availability/:id — 削除（staffは自分のみ） */
staffAvailability.delete('/api/staff-availability/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const currentStaff = c.get('staff');
    const existing = await getStaffAvailabilityById(c.env.DB, id);
    if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
    if (currentStaff?.role === 'staff' && existing.staff_id !== currentStaff.id) {
      return c.json({ success: false, error: 'Forbidden' }, 403);
    }
    if (existing.is_booked) {
      return c.json({ success: false, error: 'Cannot delete a booked slot' }, 400);
    }
    await deleteStaffAvailability(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/staff-availability/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { staffAvailability };
