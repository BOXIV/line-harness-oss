import { jstNow } from './utils.js';
export interface Friend {
  id: string;
  line_user_id: string;
  display_name: string | null;
  managed_name: string | null;
  picture_url: string | null;
  status_message: string | null;
  is_following: number;
  user_id: string | null;
  line_account_id: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface GetFriendsOptions {
  limit?: number;
  offset?: number;
  tagId?: string;
}

export async function getFriends(
  db: D1Database,
  opts: GetFriendsOptions = {},
): Promise<Friend[]> {
  const { limit = 50, offset = 0, tagId } = opts;

  if (tagId) {
    const result = await db
      .prepare(
        `SELECT f.*
         FROM friends f
         INNER JOIN friend_tags ft ON ft.friend_id = f.id
         WHERE ft.tag_id = ?
         ORDER BY f.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(tagId, limit, offset)
      .all<Friend>();
    return result.results;
  }

  const result = await db
    .prepare(
      `SELECT * FROM friends
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(limit, offset)
    .all<Friend>();
  return result.results;
}

export async function getFriendByLineUserId(
  db: D1Database,
  lineUserId: string,
): Promise<Friend | null> {
  return db
    .prepare(`SELECT * FROM friends WHERE line_user_id = ?`)
    .bind(lineUserId)
    .first<Friend>();
}

export async function getFriendById(
  db: D1Database,
  id: string,
): Promise<Friend | null> {
  return db
    .prepare(`SELECT * FROM friends WHERE id = ?`)
    .bind(id)
    .first<Friend>();
}

/**
 * 管理画面で編集する friend の可変フィールドを更新する。
 * managed_name は LINE 再同期に上書きされない管理者編集の表示名（display_name は別管理）。
 */
export async function updateFriend(
  db: D1Database,
  id: string,
  fields: { managedName?: string | null },
): Promise<Friend | null> {
  if ('managedName' in fields) {
    await db
      .prepare(`UPDATE friends SET managed_name = ?, updated_at = ? WHERE id = ?`)
      .bind(fields.managedName ?? null, jstNow(), id)
      .run();
  }
  return getFriendById(db, id);
}

export interface UpsertFriendInput {
  lineUserId: string;
  displayName?: string | null;
  pictureUrl?: string | null;
  statusMessage?: string | null;
  /**
   * 友だち（フォロー）状態を明示的に設定する。
   *   - 省略時: 既存行は現状維持（is_following を上書きしない）、新規行は 1（後方互換）。
   *   - true/false 指定時: その値を書き込む。
   *
   * 重要: OAuth / Web 連携経路（friends.user_id を付与する経路）は、ユーザーが実際に
   * 友だち追加したか分からないまま呼ばれる。以前はこの関数が無条件に is_following=1 を
   * 立てていたため「連携済みだが未フォロー（=配信不達）」が is_following=1 と誤検知された。
   * これらの経路は Messaging API の実フォロー判定（LineClient.isFollowing）の結果を
   * 必ず isFollowing で渡すこと。follow webhook は true、lazy backfill（接触＝友だち）も true。
   */
  isFollowing?: boolean;
}

export async function upsertFriend(
  db: D1Database,
  input: UpsertFriendInput,
): Promise<Friend> {
  const now = jstNow();
  const existing = await getFriendByLineUserId(db, input.lineUserId);

  if (existing) {
    // 省略時は既存の is_following を維持する（連携経路が勝手に 1 へ上書きしない）。
    const nextFollowing =
      input.isFollowing === undefined ? existing.is_following : input.isFollowing ? 1 : 0;
    await db
      .prepare(
        `UPDATE friends
         SET display_name = ?,
             picture_url = ?,
             status_message = ?,
             is_following = ?,
             updated_at = ?
         WHERE line_user_id = ?`,
      )
      .bind(
        'displayName' in input ? (input.displayName ?? null) : existing.display_name,
        'pictureUrl' in input ? (input.pictureUrl ?? null) : existing.picture_url,
        'statusMessage' in input ? (input.statusMessage ?? null) : existing.status_message,
        nextFollowing,
        now,
        input.lineUserId,
      )
      .run();

    return (await getFriendByLineUserId(db, input.lineUserId))!;
  }

  // 新規行: 省略時は 1（後方互換）。連携経路は明示的に実フォロー判定値を渡す。
  const insertFollowing = input.isFollowing === undefined ? 1 : input.isFollowing ? 1 : 0;
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO friends (id, line_user_id, display_name, picture_url, status_message, is_following, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.lineUserId,
      input.displayName ?? null,
      input.pictureUrl ?? null,
      input.statusMessage ?? null,
      insertFollowing,
      now,
      now,
    )
    .run();

  return (await getFriendById(db, id))!;
}

export async function updateFriendFollowStatus(
  db: D1Database,
  lineUserId: string,
  isFollowing: boolean,
): Promise<void> {
  await db
    .prepare(
      `UPDATE friends
       SET is_following = ?, updated_at = ?
       WHERE line_user_id = ?`,
    )
    .bind(isFollowing ? 1 : 0, jstNow(), lineUserId)
    .run();
}

export async function getFriendCount(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) as count FROM friends`)
    .first<{ count: number }>();
  return row?.count ?? 0;
}
