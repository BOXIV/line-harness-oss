'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import type { Tag } from '@line-crm/shared'
import { api } from '@/lib/api'
import type { FriendWithTags } from '@/lib/api'
import Header from '@/components/layout/header'
import FriendTable from '@/components/friends/friend-table'
import { useAccount } from '@/contexts/account-context'
import { SOURCE_LABELS, SOURCE_TAG_NAMES } from '@/lib/friend-source'

const PAGE_SIZE = 20

export default function FriendsPage() {
  const { selectedAccountId } = useAccount()
  const [friends, setFriends] = useState<FriendWithTags[]>([])
  const [allTags, setAllTags] = useState<Tag[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [hasNextPage, setHasNextPage] = useState(false)
  const [selectedTagId, setSelectedTagId] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedStatusId, setSelectedStatusId] = useState('')
  const [statusOptions, setStatusOptions] = useState<Array<{ id: string; name: string; color: string | null; source: 'seller' | 'buyer' }>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadTags = useCallback(async () => {
    try {
      const res = await api.tags.list()
      if (res.success) setAllTags(res.data)
    } catch {
      // Non-blocking — tags used for filter
    }
  }, [])

  const loadFriends = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params: Record<string, string> = {
        offset: String((page - 1) * PAGE_SIZE),
        limit: String(PAGE_SIZE),
      }
      if (selectedTagId) params.tagId = selectedTagId
      if (selectedAccountId) params.accountId = selectedAccountId
      if (selectedStatusId) params.statusOptionId = selectedStatusId
      if (searchQuery) params.search = searchQuery

      const res = await api.friends.list(params)
      if (res.success) {
        setFriends(res.data.items)
        setTotal(res.data.total)
        setHasNextPage(res.data.hasNextPage)
      } else {
        setError(res.error)
      }
    } catch {
      setError('友だちの読み込みに失敗しました。もう一度お試しください。')
    } finally {
      setLoading(false)
    }
  }, [page, selectedTagId, selectedAccountId, selectedStatusId, searchQuery])

  useEffect(() => {
    loadTags()
  }, [loadTags])

  useEffect(() => {
    api.friendStatus.listOptions().then((res) => {
      if (res.success) setStatusOptions(res.data.map((o) => ({ id: o.id, name: o.name, color: o.color, source: o.source })))
    }).catch(() => {})
  }, [])

  useEffect(() => {
    setPage(1)
  }, [selectedTagId, selectedAccountId, selectedStatusId, searchQuery])

  // 検索 debounce（300ms）
  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(searchInput.trim()), 300)
    return () => clearTimeout(t)
  }, [searchInput])

  useEffect(() => {
    loadFriends()
  }, [loadFriends])

  const handleTagFilter = (tagId: string) => {
    setSelectedTagId(tagId)
  }

  // 出品者/購入者タブ。判別の実体は分類タグなので、タブはタグ絞り込みへ委譲する
  // （= サーバ側で絞る＝ページングと件数がそのまま正しい）。タグ未作成なら押せない。
  const sourceTabs = useMemo(
    () => {
      const idOf = (name: string) => allTags.find((t) => t.name === name)?.id ?? ''
      return [
        { key: 'all' as const, label: '全て', tagId: '' },
        { key: 'seller' as const, label: SOURCE_LABELS.seller, tagId: idOf(SOURCE_TAG_NAMES.seller) },
        { key: 'buyer' as const, label: SOURCE_LABELS.buyer, tagId: idOf(SOURCE_TAG_NAMES.buyer) },
      ]
    },
    [allTags],
  )

  return (
    <div>
      <Header title="友だち管理" />

      {/* 出品者 / 購入者タブ。分類タグでの絞り込み（= タグ絞り込みのショートカット）なので
          タグ選択と同じ state を動かす。タグがまだ無い環境では押せない。 */}
      <div className="flex gap-1 bg-gray-100 rounded-lg p-1 mb-4 max-w-sm" role="tablist" aria-label="友だちの区分">
        {sourceTabs.map((tab) => {
          const disabled = tab.key !== 'all' && !tab.tagId
          const active = !disabled && selectedTagId === tab.tagId
          return (
            <button
              key={tab.key}
              role="tab"
              aria-selected={active}
              disabled={disabled}
              title={disabled ? `タグ「${tab.label}」がまだありません` : undefined}
              onClick={() => handleTagFilter(tab.tagId)}
              className={`flex-1 px-3 py-1.5 min-h-[36px] rounded-md text-sm font-medium transition-colors ${
                active ? 'bg-white text-slate-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
              } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-2 flex-1 min-w-[240px] max-w-md">
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="🔍 名前 / LINE ユーザーID / 内部IDで検索"
            className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 min-h-[44px] bg-white focus:outline-none focus:border-slate-900"
          />
          {searchInput && (
            <button
              onClick={() => setSearchInput('')}
              className="text-xs text-gray-500 hover:text-gray-700 whitespace-nowrap"
            >
              クリア
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600 font-medium whitespace-nowrap">タグ:</label>
          <select
            className="text-sm border border-gray-300 rounded-lg px-3 py-2 min-h-[44px] bg-white focus:outline-none focus:border-slate-900 flex-1 sm:flex-none"
            value={selectedTagId}
            onChange={(e) => handleTagFilter(e.target.value)}
          >
            <option value="">すべて</option>
            {allTags.map((tag) => (
              <option key={tag.id} value={tag.id}>{tag.name}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600 font-medium whitespace-nowrap">ステータス:</label>
          <select
            className="text-sm border border-gray-300 rounded-lg px-3 py-2 min-h-[44px] bg-white focus:outline-none focus:border-slate-900 flex-1 sm:flex-none"
            value={selectedStatusId}
            onChange={(e) => setSelectedStatusId(e.target.value)}
          >
            <option value="">すべて</option>
            {statusOptions.some((o) => o.source === 'seller') && (
              <optgroup label="出品者">
                {statusOptions.filter((o) => o.source === 'seller').map((o) => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </optgroup>
            )}
            {statusOptions.some((o) => o.source === 'buyer') && (
              <optgroup label="購入者">
                {statusOptions.filter((o) => o.source === 'buyer').map((o) => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
        <span className="text-sm text-gray-500">
          {loading ? '読み込み中...' : `${total.toLocaleString('ja-JP')} 件`}
        </span>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Loading skeleton */}
      {loading ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="px-4 py-4 border-b border-gray-100 flex items-center gap-4 animate-pulse">
              <div className="w-9 h-9 rounded-full bg-gray-200" />
              <div className="flex-1 space-y-2">
                <div className="h-3 bg-gray-200 rounded w-32" />
                <div className="h-2 bg-gray-100 rounded w-20" />
              </div>
              <div className="h-5 bg-gray-100 rounded-full w-16" />
              <div className="h-5 bg-gray-100 rounded-full w-12" />
              <div className="h-3 bg-gray-100 rounded w-20" />
            </div>
          ))}
        </div>
      ) : (
        <FriendTable
          friends={friends}
          allTags={allTags}
          onRefresh={loadFriends}
        />
      )}

      {/* Pagination */}
      {!loading && total > 0 && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mt-4">
          <p className="text-sm text-gray-500">
            {((page - 1) * PAGE_SIZE) + 1}〜{Math.min(page * PAGE_SIZE, total)} 件 / 全{total.toLocaleString('ja-JP')}件
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-3 py-2 min-h-[44px] text-sm border border-gray-300 rounded-lg bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              前へ
            </button>
            <span className="text-sm text-gray-600 px-1">{page} ページ</span>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={!hasNextPage}
              className="px-3 py-2 min-h-[44px] text-sm border border-gray-300 rounded-lg bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              次へ
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
