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

/**
 * 催促ステップの送信権を **送る前に** 原子的に確保する（reminder_count を expected → expected+1）。
 *
 * 従来は「送信 → markStepSent」の順で、送信後の UPDATE が D1 の一時エラーで落ちると
 * 次 tick が同じ行を同じ reminder_count で再取得し、同じ顧客へ同じ催促メール+SMS を
 * 再送していた（2026-08-29 監査。同 tick の D1 競合は cheapest-listings で実測済み）。
 * 先に count を進めておけば、最悪でも「1 ステップ分の催促が届かない」側に倒れる
 * （次ステップは通常どおり進む）。二重送信より欠落の方が軽い。
 *
 * 戻り値 false = 他 tick が先に進めた／行が消えた。呼び出し側は送らない。
 */
export async function claimReminderStep(
  db: D1Database,
  matchKey: string,
  expectedCount: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE listing_entries
         SET reminder_count = reminder_count + 1, updated_at = ${NOW}
       WHERE match_key = ? AND status = 'form_only' AND reminder_count = ?`,
    )
    .bind(matchKey, expectedCount)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** claim 後、実際に送れたチャネルの時刻だけを記録する（count は claim 済みなので触らない）。 */
export async function recordReminderSent(
  db: D1Database,
  matchKey: string,
  sent: { email: boolean; sms: boolean },
): Promise<void> {
  if (!sent.email && !sent.sms) return;
  await db
    .prepare(
      `UPDATE listing_entries
         SET email_sent_at = CASE WHEN ? THEN ${NOW} ELSE email_sent_at END,
             sms_sent_at   = CASE WHEN ? THEN ${NOW} ELSE sms_sent_at END,
             updated_at = ${NOW}
       WHERE match_key = ?`,
    )
    .bind(sent.email ? 1 : 0, sent.sms ? 1 : 0, matchKey)
    .run();
}

/**
 * 同じ連絡先（メール or 電話）へ、別の match_key から直近 `withinHours` 時間以内に
 * 催促を送っていたら true。
 *
 * /listing-form/submit・/buyer-form/submit は公開エンドポイントなので、他人のメール/電話を
 * 入れた偽エントリーを大量に投げると、催促 cron が BOXIV 名義のメール+SMS を
 * その宛先へ最大 3 通ずつ送る「送信リレー」になっていた（2026-08-29 監査）。
 * 1 連絡先あたり 24h に 1 連鎖までに絞る。正規の再送信（同じ人が同じ日にもう一度
 * フォームを出す）でも 2 本目の催促連鎖は不要なので実害は無い。
 */
export async function hasRecentReminderToContact(
  db: D1Database,
  opts: { email: string | null; phone: string | null; excludeMatchKey: string; withinHours: number },
): Promise<boolean> {
  if (!opts.email && !opts.phone) return false;
  // 時間幅は整数に丸めて SQL リテラルに埋める（値バインドではなくコード由来の数値）
  const hours = Math.max(1, Math.floor(opts.withinHours));
  const since = `strftime('%Y-%m-%dT%H:%M:%SZ','now','-${hours} hours')`;
  const conds: string[] = [];
  const binds: unknown[] = [opts.excludeMatchKey];
  if (opts.email) {
    conds.push(`(email = ? AND email_sent_at IS NOT NULL AND email_sent_at >= ${since})`);
    binds.push(opts.email);
  }
  if (opts.phone) {
    conds.push(`(phone = ? AND sms_sent_at IS NOT NULL AND sms_sent_at >= ${since})`);
    binds.push(opts.phone);
  }
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM listing_entries
        WHERE match_key != ? AND (${conds.join(' OR ')})
        LIMIT 1`,
    )
    .bind(...binds)
    .first<{ hit: number }>();
  return !!row;
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

/**
 * 連携完了通知の送信権を **送る前に** 原子的に確保する。
 *
 * 従来は「hasLinkCompletedNotified で読む → fireEvent → markLinkCompletedNotified」の
 * check→fire→mark で、OAuth コールバック（listing-form-line / buyer-form-line）と
 * follow webhook が数秒差で同じ friend に到達すると両方が送信に進み、価格お知らせが
 * 2 通届いていた（既知 H3・2026-08-29 時点で未修正）。
 * フラグが未設定の行にだけ立てる条件付き UPDATE にし、changes で勝者を 1 つに決める。
 * 送信に失敗したら unmarkLinkCompletedNotified で戻す（次の機会に送れるように）。
 */
export async function claimLinkCompletedNotified(
  db: D1Database,
  friendId: string,
  source: EntrySource = 'seller',
): Promise<boolean> {
  const path = LINK_NOTIFIED_PATH[source];
  const res = await db
    .prepare(
      `UPDATE friends
         SET metadata = json_set(COALESCE(metadata, '{}'), '${path}', json('true'))
       WHERE id = ?
         AND COALESCE(json_extract(metadata, '${path}'), 0) = 0`,
    )
    .bind(friendId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** claim 後に送信できなかったとき、フラグを戻す（follow 時の救済フローが再送できるように）。 */
export async function unmarkLinkCompletedNotified(
  db: D1Database,
  friendId: string,
  source: EntrySource = 'seller',
): Promise<void> {
  await db
    .prepare(`UPDATE friends SET metadata = json_remove(COALESCE(metadata, '{}'), '${LINK_NOTIFIED_PATH[source]}') WHERE id = ?`)
    .bind(friendId)
    .run();
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
