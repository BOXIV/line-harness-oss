// BOXIV-only: 連携が確定した友だちへ「出品者 / 購入者」の分類タグを付ける。
//
// このタグは表示用のラベルではなく分類の入力になっている:
//   - /chats・/friends のステータス選択が出品者DB/購入者DBどちらの options を出すか（friend-source.ts）
//   - /chats の「全て / 出品者 / 購入者」タブと並び順
//   - リッチメニュー自動切替（顧客ステータス → メニュー）の source 判定
// そのため automation 設定に依存させず、連携確定時にコードで必ず付ける。
//
// ⚠️ 誤タグはステータス選択とリッチメニュー切替を誤動作させる。source が確定している
// （listing_entries.source が付いた連携 / 出品フロー由来）ときだけ呼ぶこと。
//
// タグが無い環境（test 等）では作ってから付ける。名前の一意制約が無いテーブルなので、
// 同時実行で二重作成しないよう「取得 → 無ければ作成 → もう一度取得」で最後に勝った行に寄せる。

import { addTagToFriend } from '@line-crm/db';

/** listing_entries.source と同じ語彙。 */
export type EntrySource = 'seller' | 'buyer';

/** 分類に使うタグ名。web 側 friend-source.ts の判定文字列と一致させること。 */
export const SOURCE_TAG_NAMES: Record<EntrySource, string> = {
  seller: '出品者',
  buyer: '購入者',
};

/** タグの色（管理UIのタグ一覧での見え方）。緑＝出品導線 / 青＝購入導線。 */
const SOURCE_TAG_COLORS: Record<EntrySource, string> = {
  seller: '#16A34A',
  buyer: '#2563EB',
};

async function findTagIdByName(db: D1Database, name: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT id FROM tags WHERE name = ? ORDER BY created_at ASC LIMIT 1`)
    .bind(name)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/**
 * 友だちに分類タグ（出品者 / 購入者）を付ける（冪等）。タグが無ければ作成する。
 * 失敗しても連携自体は成立しているので、呼び出し側は catch してログのみに留めること。
 */
export async function ensureSourceTag(
  db: D1Database,
  friendId: string,
  source: EntrySource,
): Promise<void> {
  const name = SOURCE_TAG_NAMES[source];
  let tagId = await findTagIdByName(db, name);
  if (!tagId) {
    try {
      const id = crypto.randomUUID();
      await db
        .prepare(`INSERT INTO tags (id, name, color, created_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`)
        .bind(id, name, SOURCE_TAG_COLORS[source])
        .run();
      tagId = id;
    } catch {
      // 同時実行で別リクエストが先に作った可能性 → 取り直す
      tagId = await findTagIdByName(db, name);
    }
  }
  if (!tagId) throw new Error(`tag "${name}" を解決できませんでした`);
  await addTagToFriend(db, friendId, tagId);
}
