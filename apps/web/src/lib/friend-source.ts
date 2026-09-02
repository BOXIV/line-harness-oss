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

/** 一覧タブの区分。'unlinked' は顧客レコードに紐づいていない友だち（未連携）。 */
export type FriendTabKey = 'all' | 'seller' | 'buyer' | 'unlinked'

/** 「未連携」タブ・行内ピルの表示ラベル。 */
export const UNLINKED_LABEL = '未連携'

/**
 * 「未連携」＝ 出品者にも購入者にも紐づいていない友だち。
 *
 * 連携の根拠は 2 つあり、**どちらも無い**ものだけを未連携とする:
 *   - 分類タグ（出品者/購入者）… 連携が確定した時点で worker が付ける（source-tag.boxiv.ts）
 *   - Notion 連携（出品者DB / 購入者DB）… オペレーターがチャット画面で手動連携した場合は
 *     分類タグが付かないので、タグだけで判定すると手動連携済みの人まで未連携に出てしまう
 *
 * worker 側 `GET /api/friends?linkState=unlinked` の SQL と同じ意味にすること。
 */
export function isUnlinkedFriend(friend: {
  source: FriendSource
  notion?: { pageId?: string | null } | null
}): boolean {
  if (friend.source) return false
  return !friend.notion?.pageId
}
