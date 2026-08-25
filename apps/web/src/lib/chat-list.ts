// オペレーターチャット一覧の並び順と絞り込み（BOXIV）。
//
// 並びは「最後にメッセージがあった順」だけで決める。
// 以前は「全て」タブで 出品者 → 購入者 → 未分類 にグループ化していたため、
// Notion 未連携（= 出品者/購入者の分類タグが付いていない）友だちは、たった今
// メッセージを送っても一覧の最下部に沈み、赤い未読バッジに気づけなかった。
// 連携の有無で見落としが起きるのを避けるため、グループ化はやめている。

export interface ChatListItem {
  id: string
  lastMessageAt: string | null
  unreadCount?: number
}

/** 最終メッセージ日時（epoch ms）。無い/壊れている場合は末尾に沈める。 */
function recencyEpoch(chat: ChatListItem): number {
  if (!chat.lastMessageAt) return Number.NEGATIVE_INFINITY
  const t = new Date(chat.lastMessageAt).getTime()
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t
}

/**
 * 最終メッセージが新しい順。日時が無いものは末尾。
 * 日時は JST(+09:00) と Z が混在し得るので、文字列比較ではなく epoch で比べる。
 */
export function compareChatRecency(a: ChatListItem, b: ChatListItem): number {
  const ta = recencyEpoch(a)
  const tb = recencyEpoch(b)
  // 両方 -Infinity のときに NaN を返さないよう先に同値判定する。
  if (ta === tb) return 0
  return tb - ta
}

/** 新しい順に並べ替えた新しい配列を返す（入力は変更しない）。 */
export function sortChatsByRecency<T extends ChatListItem>(chats: T[]): T[] {
  return [...chats].sort(compareChatRecency)
}

/**
 * 「未読」チェックボックスの絞り込み。
 * keepId（開いているチャット）は未読が 0 になっても残す — 「既読」を押した瞬間に
 * 行が消えると、どこを見ていたのか分からなくなるため。
 */
export function filterUnreadChats<T extends ChatListItem>(
  chats: T[],
  opts: { enabled: boolean; keepId?: string | null },
): T[] {
  if (!opts.enabled) return chats
  return chats.filter(
    (chat) => (chat.unreadCount ?? 0) > 0 || (opts.keepId != null && chat.id === opts.keepId),
  )
}
