/**
 * 「未連携」の判定（BOXIV / apps/web/src/lib/friend-source.ts）。
 *
 * オペレーターチャットのタブ「全て / 出品者 / 購入者 / 未連携」で使う。
 * 未連携 = 分類タグ（出品者/購入者）が無く、かつ Notion 連携も無い友だち。
 * タグだけで判定すると、オペレーターが手動で Notion 連携した友だち
 * （手動連携は分類タグを付けない）まで未連携に出てしまう。
 *
 * worker 側 `GET /api/friends?linkState=unlinked` の SQL と同じ意味であること
 * （そちらは apps/worker/test/friends-unlinked.test.ts が固定している）。
 */
import { describe, expect, it } from 'vitest'
import { detectFriendSource, isUnlinkedFriend } from '../src/lib/friend-source'

const link = { pageId: 'page-1', label: '10394' }

describe('isUnlinkedFriend', () => {
  it('分類タグも Notion 連携も無ければ未連携', () => {
    expect(isUnlinkedFriend({ source: null, notion: null })).toBe(true)
    expect(isUnlinkedFriend({ source: null })).toBe(true)
  })

  it('分類タグがあれば未連携ではない', () => {
    expect(isUnlinkedFriend({ source: 'seller', notion: null })).toBe(false)
    expect(isUnlinkedFriend({ source: 'buyer', notion: null })).toBe(false)
  })

  it('タグが無くても Notion 連携があれば未連携ではない（手動連携）', () => {
    expect(isUnlinkedFriend({ source: null, notion: link })).toBe(false)
  })

  it('pageId の無い連携の残骸は連携とみなさない', () => {
    expect(isUnlinkedFriend({ source: null, notion: { pageId: null } })).toBe(true)
  })
})

describe('detectFriendSource', () => {
  it('分類タグ名から source を決める（出品者を優先）', () => {
    expect(detectFriendSource([{ name: '出品者' }])).toBe('seller')
    expect(detectFriendSource([{ name: '購入者' }])).toBe('buyer')
    expect(detectFriendSource([{ name: '購入者' }, { name: '出品者' }])).toBe('seller')
    expect(detectFriendSource([{ name: '診断' }])).toBeNull()
    expect(detectFriendSource(null)).toBeNull()
  })
})
