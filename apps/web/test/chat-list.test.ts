/**
 * オペレーターチャット一覧の並び順と「未読」絞り込み（BOXIV）。
 *
 * 直した不具合: 「全て」タブが 出品者 → 購入者 → 未分類 にグループ化されていたため、
 * Notion 未連携（分類タグ無し）の友だちは、たった今メッセージを送っても一覧の最下部に
 * 沈み、赤い未読バッジに気づけなかった。並びを最終メッセージ順だけにして、
 * 連携の有無で見落としが起きないようにしている。
 */
import { describe, expect, it } from 'vitest'
import { compareChatRecency, sortChatsByRecency, filterUnreadChats } from '../src/lib/chat-list'

const chat = (id: string, lastMessageAt: string | null, unreadCount = 0) => ({
  id,
  lastMessageAt,
  unreadCount,
})

describe('sortChatsByRecency', () => {
  it('連携の有無に関係なく、最終メッセージが新しい順に並ぶ', () => {
    const list = [
      chat('seller', '2026-08-25T09:00:00.000+09:00'),
      chat('unlinked', '2026-08-25T12:00:00.000+09:00', 1),
      chat('buyer', '2026-08-25T10:00:00.000+09:00'),
    ]
    expect(sortChatsByRecency(list).map((c) => c.id)).toEqual(['unlinked', 'buyer', 'seller'])
  })

  it('入力の配列を書き換えない', () => {
    const list = [chat('a', '2026-08-01T00:00:00.000+09:00'), chat('b', '2026-08-02T00:00:00.000+09:00')]
    sortChatsByRecency(list)
    expect(list.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('最終メッセージ日時が無いチャットは末尾に沈む', () => {
    const list = [chat('none', null), chat('old', '2020-01-01T00:00:00.000+09:00'), chat('none2', null)]
    expect(sortChatsByRecency(list).map((c) => c.id)).toEqual(['old', 'none', 'none2'])
  })

  it('JST(+09:00) と Z の混在を epoch で正しく比べる（文字列比較だと逆転する）', () => {
    // 文字列で比べると '2026-08-25T01:00:00.000Z' > '2026-08-25T09:30:00.000+09:00' になるが、
    // 実際は +09:00 の 09:30 = 00:30Z のほうが古い。
    const list = [chat('jst0930', '2026-08-25T09:30:00.000+09:00'), chat('utc0100', '2026-08-25T01:00:00.000Z')]
    expect(sortChatsByRecency(list).map((c) => c.id)).toEqual(['utc0100', 'jst0930'])
  })

  it('日時が壊れていても NaN 比較で並びを壊さない', () => {
    const list = [chat('broken', 'not-a-date'), chat('ok', '2026-08-25T09:00:00.000+09:00')]
    expect(sortChatsByRecency(list).map((c) => c.id)).toEqual(['ok', 'broken'])
    expect(compareChatRecency(chat('x', null), chat('y', null))).toBe(0)
  })
})

describe('filterUnreadChats', () => {
  const list = [chat('unread', '2026-08-25T12:00:00.000+09:00', 2), chat('read', '2026-08-25T11:00:00.000+09:00', 0)]

  it('OFF のときは何も絞らない', () => {
    expect(filterUnreadChats(list, { enabled: false, keepId: null }).map((c) => c.id)).toEqual(['unread', 'read'])
  })

  it('ON のときは未読があるものだけ残す', () => {
    expect(filterUnreadChats(list, { enabled: true, keepId: null }).map((c) => c.id)).toEqual(['unread'])
  })

  it('開いているチャットは既読になっても消えない', () => {
    expect(filterUnreadChats(list, { enabled: true, keepId: 'read' }).map((c) => c.id)).toEqual(['unread', 'read'])
  })

  it('unreadCount 未定義（旧 worker 応答）は未読扱いしない', () => {
    const legacy = [{ id: 'legacy', lastMessageAt: '2026-08-25T12:00:00.000+09:00' }]
    expect(filterUnreadChats(legacy, { enabled: true, keepId: null })).toEqual([])
  })
})
