// BOXIV-only: 出品/購入フォーム台帳（listing_entries）の D1 アクセス層。
//
// form_submit で行を作り（status='form_only'）、LINE 連携で line_user_id を追記し
// （status='linked'）、催促 CRON が未連携を抽出する。Notion は本テーブルのミラー。
// 出品者（source='seller'）と購入者（source='buyer'）は同一フローなので同じ表を共有し、
// Notion 書き込み先・Slack 通知先・催促文面だけを source で切り替える。
// migration: 905_listing_entries.sql / 916_listing_entries_source.sql

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

/** 台帳の由来。出品者フォーム(/listing-form/*) と 購入者エントリー(/buyer-form/*)。 */
export type EntrySource = 'seller' | 'buyer';

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
  source: EntrySource;
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
  /** 既定 'seller'（既存の出品フォーム呼び出しを壊さない）。購入者エントリーは 'buyer'。 */
  source?: EntrySource;
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
      `INSERT INTO listing_entries (match_key, form_data, name, phone, email, return_to, source, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'form_only', ${NOW}, ${NOW})
       ON CONFLICT(match_key) DO UPDATE SET
         form_data  = excluded.form_data,
         name       = COALESCE(excluded.name, listing_entries.name),
         phone      = COALESCE(excluded.phone, listing_entries.phone),
         email      = COALESCE(excluded.email, listing_entries.email),
         return_to  = COALESCE(excluded.return_to, listing_entries.return_to),
         source     = excluded.source,
         updated_at = ${NOW}`,
    )
    .bind(
      input.matchKey,
      formJson,
      input.name ?? null,
      input.phone ?? null,
      input.email ?? null,
      input.returnTo ?? null,
      input.source ?? 'seller',
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
  source: EntrySource = 'seller',
): Promise<ListingEntry | null> {
  await db
    .prepare(
      `INSERT INTO listing_entries (match_key, line_user_id, display_name, source, status, created_at, linked_at, updated_at)
       VALUES (?, ?, ?, ?, 'linked', ${NOW}, ${NOW}, ${NOW})
       ON CONFLICT(match_key) DO UPDATE SET
         line_user_id = excluded.line_user_id,
         display_name = COALESCE(excluded.display_name, listing_entries.display_name),
         status = 'linked', linked_at = ${NOW}, updated_at = ${NOW}`,
    )
    .bind(matchKey, lineUserId, displayName, source)
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
  opts: { minElapsedMinutes: number; limit: number; source?: EntrySource },
): Promise<ListingEntry[]> {
  const sourceClause = opts.source ? `AND source = ?` : '';
  const binds: unknown[] = [`-${opts.minElapsedMinutes}`];
  if (opts.source) binds.push(opts.source);
  binds.push(opts.limit);
  const res = await db
    .prepare(
      `SELECT * FROM listing_entries
        WHERE status = 'form_only'
          AND created_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ? || ' minutes')
          ${sourceClause}
          AND (reminder_count < 3 OR escalated_at IS NULL)
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .bind(...binds)
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
 * lineUserId で「連携済み(status='linked')」の台帳行を返す（友だち追加完了時の連携済み判定用）。
 * 同一 lineUserId で複数 match_key が連携されている場合は最新の連携を返す（出品/購入は問わない —
 * 呼び出し側が row.source を見て送るイベントを決める）。未連携なら null。
 */
export async function getLinkedEntryByLineUserId(db: D1Database, lineUserId: string): Promise<ListingEntry | null> {
  return db
    .prepare(`SELECT * FROM listing_entries WHERE line_user_id = ? AND status = 'linked' ORDER BY linked_at DESC LIMIT 1`)
    .bind(lineUserId)
    .first<ListingEntry>();
}

/**
 * 連携完了通知の「送信済み」フラグ名（friend.metadata のキー）。
 * OAuth 完了時と follow webhook 救済の二重送信を防ぐ。source ごとに別フラグにしているので、
 * 出品者として連携済みの人が後から購入エントリーしても購入者向けの通知は1回届く。
 */
// JSON パスは SQL リテラルとして埋め込む（値バインドではなくコード内定数の二択）。
const LINK_NOTIFIED_PATH: Record<EntrySource, string> = {
  seller: '$.listing_price_notified', // 歴史的な名前（出品価格お知らせ）。既存 friend の値を引き継ぐため変えない
  buyer: '$.buyer_link_notified',
};

/** 連携完了通知（seller=listing_link_completed / buyer=buyer_link_completed）を送信済みか。二重送信防止。 */
export async function hasLinkCompletedNotified(
  db: D1Database,
  friendId: string,
  source: EntrySource = 'seller',
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT json_extract(metadata, '${LINK_NOTIFIED_PATH[source]}') AS f FROM friends WHERE id = ?`)
    .bind(friendId)
    .first<{ f: unknown }>();
  return !!(row && row.f);
}

/** 連携完了通知の送信済みフラグを friend.metadata に立てる。 */
export async function markLinkCompletedNotified(
  db: D1Database,
  friendId: string,
  source: EntrySource = 'seller',
): Promise<void> {
  await db
    .prepare(
      `UPDATE friends SET metadata = json_set(COALESCE(metadata, '{}'), '${LINK_NOTIFIED_PATH[source]}', json('true')) WHERE id = ?`,
    )
    .bind(friendId)
    .run();
}
