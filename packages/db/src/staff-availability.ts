import { jstNow } from './utils.js';

export interface StaffAvailabilityRow {
  id: string;
  staff_id: string;
  date: string;       // YYYY-MM-DD
  start_time: string; // HH:MM
  end_time: string;   // HH:MM
  area: string;
  is_booked: number;
  created_at: string;
  updated_at: string;
}

export interface CreateStaffAvailabilityInput {
  staffId: string;
  date: string;
  startTime: string;
  endTime: string;
  area: string;
}

export interface ListStaffAvailabilityFilter {
  staffId?: string;
  date?: string;
  dateFrom?: string;
  dateTo?: string;
  area?: string;
  includeBooked?: boolean;
}

export async function createStaffAvailability(
  db: D1Database,
  input: CreateStaffAvailabilityInput,
): Promise<StaffAvailabilityRow> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO staff_availability (id, staff_id, date, start_time, end_time, area, is_booked, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .bind(id, input.staffId, input.date, input.startTime, input.endTime, input.area, now, now)
    .run();
  return (await getStaffAvailabilityById(db, id))!;
}

export async function getStaffAvailabilityById(
  db: D1Database,
  id: string,
): Promise<StaffAvailabilityRow | null> {
  return db
    .prepare(`SELECT * FROM staff_availability WHERE id = ?`)
    .bind(id)
    .first<StaffAvailabilityRow>();
}

export async function listStaffAvailability(
  db: D1Database,
  filter: ListStaffAvailabilityFilter = {},
): Promise<StaffAvailabilityRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.staffId) {
    where.push('staff_id = ?');
    params.push(filter.staffId);
  }
  if (filter.date) {
    where.push('date = ?');
    params.push(filter.date);
  }
  if (filter.dateFrom) {
    where.push('date >= ?');
    params.push(filter.dateFrom);
  }
  if (filter.dateTo) {
    where.push('date <= ?');
    params.push(filter.dateTo);
  }
  if (filter.area) {
    where.push('area = ?');
    params.push(filter.area);
  }
  if (!filter.includeBooked) {
    where.push('is_booked = 0');
  }

  const sql = `SELECT * FROM staff_availability ${
    where.length ? `WHERE ${where.join(' AND ')}` : ''
  } ORDER BY date ASC, start_time ASC`;

  const result = await db.prepare(sql).bind(...params).all<StaffAvailabilityRow>();
  return result.results;
}

/**
 * 指定エリア・日付・時間枠で空いているスタッフのavailability行を返す。
 * 開始/終了時刻が完全一致するもののみ（120分スロット前提）。
 */
export async function findAvailableStaffForSlot(
  db: D1Database,
  area: string,
  date: string,
  startTime: string,
  endTime: string,
): Promise<StaffAvailabilityRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM staff_availability
       WHERE area = ? AND date = ? AND start_time = ? AND end_time = ? AND is_booked = 0
       ORDER BY staff_id ASC`,
    )
    .bind(area, date, startTime, endTime)
    .all<StaffAvailabilityRow>();
  return result.results;
}

export async function markSlotBooked(db: D1Database, id: string): Promise<void> {
  const now = jstNow();
  await db
    .prepare(`UPDATE staff_availability SET is_booked = 1, updated_at = ? WHERE id = ?`)
    .bind(now, id)
    .run();
}

export async function markSlotUnbooked(db: D1Database, id: string): Promise<void> {
  const now = jstNow();
  await db
    .prepare(`UPDATE staff_availability SET is_booked = 0, updated_at = ? WHERE id = ?`)
    .bind(now, id)
    .run();
}

export async function updateStaffAvailability(
  db: D1Database,
  id: string,
  input: Partial<CreateStaffAvailabilityInput>,
): Promise<StaffAvailabilityRow | null> {
  const fields: string[] = [];
  const params: unknown[] = [];

  if (input.date !== undefined) {
    fields.push('date = ?');
    params.push(input.date);
  }
  if (input.startTime !== undefined) {
    fields.push('start_time = ?');
    params.push(input.startTime);
  }
  if (input.endTime !== undefined) {
    fields.push('end_time = ?');
    params.push(input.endTime);
  }
  if (input.area !== undefined) {
    fields.push('area = ?');
    params.push(input.area);
  }
  if (input.staffId !== undefined) {
    fields.push('staff_id = ?');
    params.push(input.staffId);
  }

  if (fields.length === 0) return getStaffAvailabilityById(db, id);

  fields.push('updated_at = ?');
  params.push(jstNow());
  params.push(id);

  await db
    .prepare(`UPDATE staff_availability SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...params)
    .run();

  return getStaffAvailabilityById(db, id);
}

export async function deleteStaffAvailability(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM staff_availability WHERE id = ?`).bind(id).run();
}

/**
 * 指定スタッフの「同日・同エリア・既存予約数」をカウント（集約アサイン用）。
 */
export async function countStaffBookingsForDay(
  db: D1Database,
  staffId: string,
  date: string,
  area: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) as cnt FROM staff_availability
       WHERE staff_id = ? AND date = ? AND area = ? AND is_booked = 1`,
    )
    .bind(staffId, date, area)
    .first<{ cnt: number }>();
  return row?.cnt ?? 0;
}
