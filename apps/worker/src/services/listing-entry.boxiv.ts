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
  slack_thread_ts: string | null;
  escalated_at: string | null;
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
 * 催促/エスカレ評価の候補（未連携 form_only）を取得する。
 * - status='form_only'（連携済みは対象外＝一度連携したら以降一切送らない）
 * - 作成から最小ステップ閾値(minElapsedMinutes、既定10分)以上経過
 * - 全ステップ未送信(reminder_count<3) または 未エスカレ(escalated_at IS NULL)
 * どのステップ/72hエスカレが due かは呼び出し側が created_at と reminder_count から判定する。
 * 日付は created_at の保存形式(ISO strftime)で比較する（datetime('now')はスペース区切りで不一致になるため使わない）。
 */
export async function listFormOnlyForReminder(
  db: D1Database,
  opts: { minElapsedMinutes: number; limit: number },
): Promise<ListingEntry[]> {
  const res = await db
    .prepare(
      `SELECT * FROM listing_entries
        WHERE status = 'form_only'
          AND created_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ? || ' minutes')
          AND (reminder_count < 3 OR escalated_at IS NULL)
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .bind(`-${opts.minElapsedMinutes}`, opts.limit)
    .all<ListingEntry>();
  return res.results ?? [];
}

/** 1 催促ステップ送信後の記録。reminder_count を1進め、送れたチャネルの時刻を更新。 */
export async function markStepSent(
  db: D1Database,
  matchKey: string,
  sent: { email: boolean; sms: boolean },
): Promise<void> {
  await db
    .prepare(
      `UPDATE listing_entries
         SET reminder_count = reminder_count + 1,
             email_sent_at = CASE WHEN ? THEN ${NOW} ELSE email_sent_at END,
             sms_sent_at   = CASE WHEN ? THEN ${NOW} ELSE sms_sent_at END,
             updated_at = ${NOW}
       WHERE match_key = ?`,
    )
    .bind(sent.email ? 1 : 0, sent.sms ? 1 : 0, matchKey)
    .run();
}

/** 72h 未連携エスカレ通知の送信記録（重複防止）。 */
export async function markEscalated(db: D1Database, matchKey: string): Promise<void> {
  await db
    .prepare(`UPDATE listing_entries SET escalated_at = ${NOW}, updated_at = ${NOW} WHERE match_key = ?`)
    .bind(matchKey)
    .run();
}

/** フォーム送信時に投稿した Slack 通知の ts を保存（連携完了/エスカレのスレッド返信キー）。 */
export async function setSlackThreadTs(db: D1Database, matchKey: string, ts: string): Promise<void> {
  await db
    .prepare(`UPDATE listing_entries SET slack_thread_ts = ?, updated_at = ${NOW} WHERE match_key = ?`)
    .bind(ts, matchKey)
    .run();
}

/**
 * lineUserId で「連携済み(status='linked')」の出品台帳行を返す（友だち追加完了時の連携済み判定用）。
 * 同一 lineUserId で複数 match_key が連携されている場合は最新の連携を返す。未連携なら null。
 */
export async function getLinkedEntryByLineUserId(db: D1Database, lineUserId: string): Promise<ListingEntry | null> {
  return db
    .prepare(`SELECT * FROM listing_entries WHERE line_user_id = ? AND status = 'linked' ORDER BY linked_at DESC LIMIT 1`)
    .bind(lineUserId)
    .first<ListingEntry>();
}

/** 出品価格お知らせ(listing_link_completed)を既に送信済みか（friend.metadata フラグ）。二重送信防止。 */
export async function hasListingPriceNotified(db: D1Database, friendId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT json_extract(metadata, '$.listing_price_notified') AS f FROM friends WHERE id = ?`)
    .bind(friendId)
    .first<{ f: unknown }>();
  return !!(row && row.f);
}

/** 出品価格お知らせ送信済みフラグを friend.metadata に立てる。 */
export async function markListingPriceNotified(db: D1Database, friendId: string): Promise<void> {
  await db
    .prepare(`UPDATE friends SET metadata = json_set(COALESCE(metadata, '{}'), '$.listing_price_notified', json('true')) WHERE id = ?`)
    .bind(friendId)
    .run();
}
