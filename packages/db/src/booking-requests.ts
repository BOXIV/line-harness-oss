import { jstNow } from './utils.js';

export interface BookingRequestRow {
  id: string;
  friend_id: string | null;
  staff_id: string | null;
  invite_token: string;
  notion_page_id: string | null;
  customer_name: string | null;
  prefecture: string;
  area: string;
  vehicle_info: string | null;
  slot_id: string | null;
  candidate_1_date: string | null;
  candidate_1_start: string | null;
  candidate_1_end: string | null;
  candidate_2_date: string | null;
  candidate_2_start: string | null;
  candidate_2_end: string | null;
  candidate_3_date: string | null;
  candidate_3_start: string | null;
  candidate_3_end: string | null;
  selected_candidate: number | null;
  plate_number: string | null;
  status: string;
  approved_by: string | null;
  approved_at: string | null;
  notes: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateBookingInviteInput {
  inviteToken: string;
  friendId?: string | null;
  customerName?: string | null;
  prefecture: string;
  area: string;
  vehicleInfo?: string | null;
  notionPageId?: string | null;
  metadata?: string | null;
}

export interface ListBookingRequestsFilter {
  status?: string;
  area?: string;
  staffId?: string;
  friendId?: string;
  dateFrom?: string;
  dateTo?: string;
}

export async function createBookingInvite(
  db: D1Database,
  input: CreateBookingInviteInput,
): Promise<BookingRequestRow> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO booking_requests
       (id, friend_id, invite_token, notion_page_id, customer_name, prefecture, area, vehicle_info, status, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_invite', ?, ?, ?)`,
    )
    .bind(
      id,
      input.friendId ?? null,
      input.inviteToken,
      input.notionPageId ?? null,
      input.customerName ?? null,
      input.prefecture,
      input.area,
      input.vehicleInfo ?? null,
      input.metadata ?? null,
      now,
      now,
    )
    .run();
  return (await getBookingRequestById(db, id))!;
}

export async function getBookingRequestById(
  db: D1Database,
  id: string,
): Promise<BookingRequestRow | null> {
  return db
    .prepare(`SELECT * FROM booking_requests WHERE id = ?`)
    .bind(id)
    .first<BookingRequestRow>();
}

export async function getBookingRequestByToken(
  db: D1Database,
  token: string,
): Promise<BookingRequestRow | null> {
  return db
    .prepare(`SELECT * FROM booking_requests WHERE invite_token = ?`)
    .bind(token)
    .first<BookingRequestRow>();
}

export async function listBookingRequests(
  db: D1Database,
  filter: ListBookingRequestsFilter = {},
): Promise<BookingRequestRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.status) {
    where.push('br.status = ?');
    params.push(filter.status);
  }
  if (filter.area) {
    where.push('br.area = ?');
    params.push(filter.area);
  }
  if (filter.staffId) {
    where.push('br.staff_id = ?');
    params.push(filter.staffId);
  }
  if (filter.friendId) {
    where.push('br.friend_id = ?');
    params.push(filter.friendId);
  }
  // 日付フィルタは紐付くスロットのdateで判定（slot_idがある場合のみ）
  if (filter.dateFrom) {
    where.push('(sa.date >= ? OR sa.date IS NULL)');
    params.push(filter.dateFrom);
  }
  if (filter.dateTo) {
    where.push('(sa.date <= ? OR sa.date IS NULL)');
    params.push(filter.dateTo);
  }

  const sql = `
    SELECT br.*, sa.date as slot_date, sa.start_time as slot_start, sa.end_time as slot_end
    FROM booking_requests br
    LEFT JOIN staff_availability sa ON br.slot_id = sa.id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY br.created_at DESC
  `;

  const result = await db.prepare(sql).bind(...params).all<BookingRequestRow>();
  return result.results;
}

export async function updateBookingRequest(
  db: D1Database,
  id: string,
  input: {
    staffId?: string | null;
    slotId?: string | null;
    plateNumber?: string | null;
    status?: string;
    notes?: string | null;
    friendId?: string | null;
    selectedCandidate?: number | null;
  },
): Promise<BookingRequestRow | null> {
  const fields: string[] = [];
  const params: unknown[] = [];

  if (input.staffId !== undefined) {
    fields.push('staff_id = ?');
    params.push(input.staffId);
  }
  if (input.slotId !== undefined) {
    fields.push('slot_id = ?');
    params.push(input.slotId);
  }
  if (input.plateNumber !== undefined) {
    fields.push('plate_number = ?');
    params.push(input.plateNumber);
  }
  if (input.status !== undefined) {
    fields.push('status = ?');
    params.push(input.status);
  }
  if (input.notes !== undefined) {
    fields.push('notes = ?');
    params.push(input.notes);
  }
  if (input.friendId !== undefined) {
    fields.push('friend_id = ?');
    params.push(input.friendId);
  }
  if (input.selectedCandidate !== undefined) {
    fields.push('selected_candidate = ?');
    params.push(input.selectedCandidate);
  }

  if (fields.length === 0) return getBookingRequestById(db, id);

  fields.push('updated_at = ?');
  params.push(jstNow());
  params.push(id);

  await db
    .prepare(`UPDATE booking_requests SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...params)
    .run();

  return getBookingRequestById(db, id);
}

export async function approveBookingRequest(
  db: D1Database,
  id: string,
  approvedBy: string | null,
): Promise<BookingRequestRow | null> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE booking_requests
       SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(approvedBy, now, now, id)
    .run();
  return getBookingRequestById(db, id);
}

export async function rejectBookingRequest(
  db: D1Database,
  id: string,
  approvedBy: string | null,
  notes?: string,
): Promise<BookingRequestRow | null> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE booking_requests
       SET status = 'rejected', approved_by = ?, approved_at = ?, notes = COALESCE(?, notes), updated_at = ?
       WHERE id = ?`,
    )
    .bind(approvedBy, now, notes ?? null, now, id)
    .run();
  return getBookingRequestById(db, id);
}

export async function deleteBookingRequest(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM booking_requests WHERE id = ?`).bind(id).run();
}
