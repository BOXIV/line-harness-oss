// 友だちのタグから「出品者 / 購入者」を判別する。
// Notion の出品者DB と購入者DB のどちらの Status options を表示するかを決めるのに使う。

export type FriendSource = 'seller' | 'buyer' | null

export function detectFriendSource(tags: { name: string }[] | null | undefined): FriendSource {
  if (!tags) return null
  const names = tags.map((t) => t.name)
  if (names.includes('出品者')) return 'seller'
  if (names.includes('購入者')) return 'buyer'
  return null
}
