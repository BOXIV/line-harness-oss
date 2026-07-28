// BOXIV-only: 連携完了した購入者へタグ「購入者」を付ける。
//
// このタグは表示用のラベルではなく分類の入力になっている:
//   - /chats・/friends のステータス選択が出品者DB/購入者DBどちらの options を出すか（friend-source.ts）
//   - リッチメニュー自動切替（顧客ステータス → メニュー）の source 判定
// そのため automation 設定に依存させず、連携確定時にコードで必ず付ける。
//
// タグが無い環境（test 等）では作ってから付ける。名前の一意制約が無いテーブルなので、
// 同時実行で二重作成しないよう「取得 → 無ければ作成 → もう一度取得」で最後に勝った行に寄せる。

import { addTagToFriend } from '@line-crm/db';

/** 購入者分類に使うタグ名。friend-source.ts の判定文字列と一致させること。 */
export const BUYER_TAG_NAME = '購入者';

/** 購入者タグの色（管理UIのタグ一覧での見え方。青系＝購入導線）。 */
const BUYER_TAG_COLOR = '#2563EB';

async function findTagIdByName(db: D1Database, name: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT id FROM tags WHERE name = ? ORDER BY created_at ASC LIMIT 1`)
    .bind(name)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/**
 * 友だちにタグ「購入者」を付ける（冪等）。タグが無ければ作成する。
 * 失敗しても連携自体は成立しているので、呼び出し側は catch してログのみに留めること。
 */
export async function ensureBuyerTag(db: D1Database, friendId: string): Promise<void> {
  let tagId = await findTagIdByName(db, BUYER_TAG_NAME);
  if (!tagId) {
    try {
      const id = crypto.randomUUID();
      await db
        .prepare(`INSERT INTO tags (id, name, color, created_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`)
        .bind(id, BUYER_TAG_NAME, BUYER_TAG_COLOR)
        .run();
      tagId = id;
    } catch {
      // 同時実行で別リクエストが先に作った可能性 → 取り直す
      tagId = await findTagIdByName(db, BUYER_TAG_NAME);
    }
  }
  if (!tagId) throw new Error(`tag "${BUYER_TAG_NAME}" を解決できませんでした`);
  await addTagToFriend(db, friendId, tagId);
}
