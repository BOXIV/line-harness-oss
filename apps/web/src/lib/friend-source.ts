// 友だちのタグから「出品者 / 購入者」を判別する。
// Notion の出品者DB と購入者DB のどちらの Status options を表示するか、
// および /chats・/friends の「全て / 出品者 / 購入者」タブの絞り込みに使う。
//
// タグ名は worker 側 services/source-tag.boxiv.ts の SOURCE_TAG_NAMES と一致させること
// （連携確定時にコードで付与している分類タグ）。

export type FriendSource = 'seller' | 'buyer' | null

/** 分類タグ名。worker の SOURCE_TAG_NAMES と同値。 */
export const SOURCE_TAG_NAMES: Record<'seller' | 'buyer', string> = {
  seller: '出品者',
  buyer: '購入者',
}

/** タブ等の表示ラベル。 */
export const SOURCE_LABELS: Record<'seller' | 'buyer', string> = {
  seller: '出品者',
  buyer: '購入者',
}

export function detectFriendSource(tags: { name: string }[] | null | undefined): FriendSource {
  if (!tags) return null
  const names = tags.map((t) => t.name)
  if (names.includes(SOURCE_TAG_NAMES.seller)) return 'seller'
  if (names.includes(SOURCE_TAG_NAMES.buyer)) return 'buyer'
  return null
}

/**
 * 一覧の並び順（出品者 → 購入者 → 未分類）。
 * 安定ソートと組み合わせて使い、グループ内の元の並び順は保つ。
 */
export function friendSourceRank(source: FriendSource): number {
  if (source === 'seller') return 0
  if (source === 'buyer') return 1
  return 2
}
