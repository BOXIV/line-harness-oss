// BOXIV-only: 出品フォーム台帳（listing_entries）の D1 アクセス層。
//
// form_submit で行を作り（status='form_only'）、LINE 連携で line_user_id を追記し
// （status='linked'）、催促 CRON が未連携を抽出する。Notion は本テーブルのミラー。
// migration: 905_listing_entries.sql

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

export interface ListingEntry {
  match_key: string;
  form_data: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  line_user_id: string | null;
  display_name: string | null;
  notion_page_id: string | null;
  status: 'form_only' | 'linked';
  reminder_count: number;
  email_sent_at: string | null;
  sms_sent_at: string | null;
  return_to: string | null;
  created_at: string;
  linked_at: string | null;
  updated_at: string;
}

export interface SubmitInput {
  matchKey: string;
  formData: Record<string, unknown>;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  returnTo?: string | null;
}

/**
 * form_submit 時の upsert。
 * - 新規 match_key → 行作成（status='form_only'）。
 * - 既存（同じ match_key で再送信）→ フォーム内容/連絡先を更新（連携済みなら status/line_user_id は保持）。
 * 返り値: upsert 後の行。
 */
export async function upsertOnSubmit(db: D1Database, input: SubmitInput): Promise<ListingEntry | null> {
  const formJson = JSON.stringify(input.formData ?? {});
  await db
    .prepare(
      `INSERT INTO listing_entries (match_key, form_data, name, phone, email, return_to, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'form_only', ${NOW}, ${NOW})
       ON CONFLICT(match_key) DO UPDATE SET
         form_data  = excluded.form_data,
         name       = COALESCE(excluded.name, listing_entries.name),
         phone      = COALESCE(excluded.phone, listing_entries.phone),
         email      = COALESCE(excluded.email, listing_entries.email),
         return_to  = COALESCE(excluded.return_to, listing_entries.return_to),
         updated_at = ${NOW}`,
    )
    .bind(
      input.matchKey,
      formJson,
      input.name ?? null,
      input.phone ?? null,
      input.email ?? null,
      input.returnTo ?? null,
    )
    .run();
  return getEntry(db, input.matchKey);
}

/**
 * LINE 連携時に line_user_id / display_name / status='linked' を追記する。
 * 返り値: 更新後の行（notion_page_id を含む。Notion 側 PATCH に使う）。
 * match_key 行が存在しない場合（メールリンクや直叩きで form_submit が無いケース）は null を返す。
 */
export async function markLinked(
  db: D1Database,
  matchKey: string,
  lineUserId: string,
  displayName: string | null,
): Promise<ListingEntry | null> {
  await db
    .prepare(
      `UPDATE listing_entries
         SET line_user_id = ?, display_name = COALESCE(?, display_name),
             status = 'linked', linked_at = ${NOW}, updated_at = ${NOW}
       WHERE match_key = ?`,
    )
    .bind(lineUserId, displayName, matchKey)
    .run();
  return getEntry(db, matchKey);
}

/** form_submit が無いまま連携された場合のフォールバック行（orphan link）。Notion 突合は worker 側 lineUserId フォールバックで実施。 */
export async function insertOrphanLink(
  db: D1Database,
  matchKey: string,
  lineUserId: string,
  displayName: string | null,
): Promise<ListingEntry | null> {
  await db
    .prepare(
      `INSERT INTO listing_entries (match_key, line_user_id, display_name, status, created_at, linked_at, updated_at)
       VALUES (?, ?, ?, 'linked', ${NOW}, ${NOW}, ${NOW})
       ON CONFLICT(match_key) DO UPDATE SET
         line_user_id = excluded.line_user_id,
         display_name = COALESCE(excluded.display_name, listing_entries.display_name),
         status = 'linked', linked_at = ${NOW}, updated_at = ${NOW}`,
    )
    .bind(matchKey, lineUserId, displayName)
    .run();
  return getEntry(db, matchKey);
}

export async function getEntry(db: D1Database, matchKey: string): Promise<ListingEntry | null> {
  return db
    .prepare(`SELECT * FROM listing_entries WHERE match_key = ?`)
    .bind(matchKey)
    .first<ListingEntry>();
}

export async function setNotionPageId(db: D1Database, matchKey: string, pageId: string): Promise<void> {
  await db
    .prepare(`UPDATE listing_entries SET notion_page_id = ?, updated_at = ${NOW} WHERE match_key = ?`)
    .bind(pageId, matchKey)
    .run();
}

/**
 * 催促対象（未連携かつ経過時間しきい値超え）を抽出する。
 * - status='form_only' かつ email がある
 * - created_at が olderThanMinutes 以上前
 * - 直近送信から minIntervalMinutes 以上経過（重送ガード）
 * - reminder_count < maxReminders（送りすぎ防止）
 */
export async function listDueForReminder(
  db: D1Database,
  opts: { olderThanMinutes: number; minIntervalMinutes: number; maxReminders: number; limit: number },
): Promise<ListingEntry[]> {
  const res = await db
    .prepare(
      // created_at / email_sent_at は ISO8601(strftime '%Y-%m-%dT%H:%M:%SZ') 保存。
      // datetime('now') はスペース区切り(...HH:MM:SS)を返すため、'T' > ' ' で文字列比較が常に偽になる。
      // 同じ strftime 形式で比較する（ここを間違えるとリマインダーが永久に発火しない）。
      `SELECT * FROM listing_entries
        WHERE status = 'form_only'
          AND email IS NOT NULL AND email <> ''
          AND reminder_count < ?
          AND created_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ? || ' minutes')
          AND (email_sent_at IS NULL OR email_sent_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ? || ' minutes'))
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .bind(opts.maxReminders, `-${opts.olderThanMinutes}`, `-${opts.minIntervalMinutes}`, opts.limit)
    .all<ListingEntry>();
  return res.results ?? [];
}

export async function markReminderSent(
  db: D1Database,
  matchKey: string,
  channel: 'email' | 'sms',
): Promise<void> {
  const col = channel === 'email' ? 'email_sent_at' : 'sms_sent_at';
  await db
    .prepare(
      `UPDATE listing_entries
         SET ${col} = ${NOW}, reminder_count = reminder_count + 1, updated_at = ${NOW}
       WHERE match_key = ?`,
    )
    .bind(matchKey)
    .run();
}
