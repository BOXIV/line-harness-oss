/**
 * スタッフ自動アサイン + 移動バッファ判定
 *
 * 集約ロジック: 同じ時間帯に複数スタッフが空いている場合、
 * 既に同日同エリアで予約が入っているスタッフを優先してアサインする。
 * これにより他スタッフの稼働日を最小化する。
 *
 * 移動バッファ: あるスタッフの直前枠に「別の県」の予約が入っている場合、
 * そのスタッフでは次の枠に移動時間が足りないためアサイン不可にする。
 * ただし同エリアで別の空きスタッフがいれば、そちらにアサインして予約可能扱い。
 *
 * 注意: 集約/バッファはアサイン先の選択ロジック。
 * 1人でも空きスタッフがいれば出品者には常に「予約可能」として表示する。
 */

import {
  findAvailableStaffForSlot,
  countStaffBookingsForDay,
  type StaffAvailabilityRow,
} from '@line-crm/db';

/**
 * 指定スタッフの「直前の時間枠」に別の県の予約があるかを判定する。
 * 直前枠 = 指定 startTime と同日で end_time === startTime のスロット
 *
 * @returns 直前枠に予約がない → null
 * @returns 直前枠に同県の予約 → null（バッファ不要）
 * @returns 直前枠に別県の予約 → そのprefecture文字列を返す（バッファ必要）
 */
async function getBlockingAdjacentPrefecture(
  db: D1Database,
  staffId: string,
  date: string,
  startTime: string,
  sellerPrefecture: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT br.prefecture AS prev_prefecture
       FROM staff_availability sa
       JOIN booking_requests br ON br.slot_id = sa.id
       WHERE sa.staff_id = ? AND sa.date = ? AND sa.end_time = ?
         AND sa.is_booked = 1
         AND br.status IN ('pending', 'approved')
       LIMIT 1`,
    )
    .bind(staffId, date, startTime)
    .first<{ prev_prefecture: string }>();
  if (!row?.prev_prefecture) return null;
  if (row.prev_prefecture === sellerPrefecture) return null;
  return row.prev_prefecture;
}

/**
 * バッファでブロックされないスタッフのavailability行だけをフィルタする。
 */
async function filterStaffByBuffer(
  db: D1Database,
  candidates: StaffAvailabilityRow[],
  sellerPrefecture: string | null,
): Promise<StaffAvailabilityRow[]> {
  if (!sellerPrefecture || candidates.length === 0) return candidates;
  const results = await Promise.all(
    candidates.map(async (c) => {
      const blocking = await getBlockingAdjacentPrefecture(
        db,
        c.staff_id,
        c.date,
        c.start_time,
        sellerPrefecture,
      );
      return blocking ? null : c;
    }),
  );
  return results.filter((c): c is StaffAvailabilityRow => c !== null);
}

/**
 * 指定エリア・日付・時間枠で予約可能か判定し、アサイン候補スタッフを返す。
 * バッファ適用 → 集約ロジック（既存予約数の多いスタッフ優先）。
 *
 * @param sellerPrefecture 出品者の都道府県。バッファ判定に使用。省略時はバッファ判定なし。
 * @returns アサインすべきスタッフのavailability行。null=空きなし
 */
export async function pickStaffForSlot(
  db: D1Database,
  area: string,
  date: string,
  startTime: string,
  endTime: string,
  sellerPrefecture: string | null = null,
): Promise<StaffAvailabilityRow | null> {
  const rawCandidates = await findAvailableStaffForSlot(db, area, date, startTime, endTime);
  if (rawCandidates.length === 0) return null;

  const candidates = await filterStaffByBuffer(db, rawCandidates, sellerPrefecture);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // 集約: 同日同エリアの既存予約数が多い順 → staff_id順
  const withCounts = await Promise.all(
    candidates.map(async (c) => ({
      row: c,
      count: await countStaffBookingsForDay(db, c.staff_id, date, area),
    })),
  );
  withCounts.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.row.staff_id.localeCompare(b.row.staff_id);
  });
  return withCounts[0].row;
}

/**
 * 出品者向けに、指定エリア・日付の空きスロット一覧を返す。
 *
 * 各時間帯について「バッファを考慮した上で1人でも空きスタッフがいれば available=true」を返す。
 * スタッフ名は出品者には見せないため、スタッフIDは含めない。
 *
 * @param sellerPrefecture 出品者の都道府県。バッファ判定に使用。
 */
export async function getAvailableSlotsForSeller(
  db: D1Database,
  area: string,
  date: string,
  slots: Array<{ startTime: string; endTime: string }>,
  sellerPrefecture: string | null = null,
): Promise<Array<{ startTime: string; endTime: string; available: boolean }>> {
  return Promise.all(
    slots.map(async (slot) => {
      const raw = await findAvailableStaffForSlot(db, area, date, slot.startTime, slot.endTime);
      const filtered = await filterStaffByBuffer(db, raw, sellerPrefecture);
      return {
        startTime: slot.startTime,
        endTime: slot.endTime,
        available: filtered.length > 0,
      };
    }),
  );
}

/**
 * エリア×日付範囲で1つでも空きスロットがある日を返す（日付ピッカー用）。
 */
export async function findDatesWithAvailability(
  db: D1Database,
  area: string,
  dates: string[],
): Promise<Set<string>> {
  if (dates.length === 0) return new Set();
  const placeholders = dates.map(() => '?').join(',');
  const result = await db
    .prepare(
      `SELECT DISTINCT date FROM staff_availability
       WHERE area = ? AND is_booked = 0 AND date IN (${placeholders})`,
    )
    .bind(area, ...dates)
    .all<{ date: string }>();
  return new Set(result.results.map((r) => r.date));
}
