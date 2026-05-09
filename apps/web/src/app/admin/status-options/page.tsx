'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import Header from '@/components/layout/header'

interface StatusOption {
  id: string
  source: 'seller' | 'buyer'
  name: string
  color: string | null
  sortOrder: number
  isArchived: boolean
  syncedAt: string
}

interface SyncResult {
  source: 'seller' | 'buyer'
  success: boolean
  inserted?: number
  updated?: number
  archived?: number
  total?: number
  error?: string
}

const colorClass: Record<string, string> = {
  default: 'bg-gray-100 text-gray-700',
  gray: 'bg-gray-100 text-gray-700',
  brown: 'bg-amber-100 text-amber-800',
  orange: 'bg-orange-100 text-orange-800',
  yellow: 'bg-yellow-100 text-yellow-800',
  green: 'bg-green-100 text-green-700',
  blue: 'bg-blue-100 text-blue-700',
  purple: 'bg-purple-100 text-purple-700',
  pink: 'bg-pink-100 text-pink-700',
  red: 'bg-red-100 text-red-700',
}

const sourceLabel = { seller: '出品者', buyer: '購入者' } as const

export default function StatusOptionsAdminPage() {
  const [options, setOptions] = useState<StatusOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [lastSync, setLastSync] = useState<SyncResult[] | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.friendStatus.listOptions({ includeArchived: showArchived })
      if (res.success) setOptions(res.data)
      else setError(res.error)
    } catch {
      setError('読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [showArchived])

  useEffect(() => {
    load()
  }, [load])

  const handleSync = async (source?: 'seller' | 'buyer') => {
    setSyncing(true)
    setError('')
    setLastSync(null)
    try {
      const res = await api.friendStatus.sync(source ? [source] : undefined)
      if (res.success) {
        setLastSync(res.data)
        await load()
      } else {
        setError(res.error)
      }
    } catch {
      setError('同期に失敗しました')
    } finally {
      setSyncing(false)
    }
  }

  const sellers = options.filter((o) => o.source === 'seller')
  const buyers = options.filter((o) => o.source === 'buyer')

  return (
    <div>
      <Header title="顧客ステータス" />

      <div className="mb-4 p-4 bg-white rounded-lg border border-gray-200">
        <h2 className="text-sm font-semibold text-gray-800 mb-2">Notion 同期</h2>
        <p className="text-xs text-gray-500 mb-3">
          出品者リスト DB / 購入者リスト DB の Status プロパティから option を取得して、ローカル D1 にミラーします。
          option はこの画面では編集できず、Notion がマスターです。
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => handleSync()}
            disabled={syncing}
            className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity"
            style={{ backgroundColor: '#0f172a' }}
          >
            {syncing ? '同期中...' : 'すべて同期'}
          </button>
          <button
            onClick={() => handleSync('seller')}
            disabled={syncing}
            className="px-3 py-2 min-h-[44px] text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg disabled:opacity-50 transition-colors"
          >
            出品者のみ
          </button>
          <button
            onClick={() => handleSync('buyer')}
            disabled={syncing}
            className="px-3 py-2 min-h-[44px] text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg disabled:opacity-50 transition-colors"
          >
            購入者のみ
          </button>
          <label className="ml-auto inline-flex items-center gap-2 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            アーカイブ済みも表示
          </label>
        </div>
        {lastSync && (
          <ul className="mt-3 space-y-1 text-xs">
            {lastSync.map((r) => (
              <li key={r.source} className={r.success ? 'text-green-700' : 'text-red-600'}>
                [{sourceLabel[r.source]}]{' '}
                {r.success
                  ? `+${r.inserted} 新規 / ${r.updated} 更新 / ${r.archived} アーカイブ (合計 ${r.total})`
                  : `エラー: ${r.error}`}
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
      )}

      {(['seller', 'buyer'] as const).map((src) => {
        const list = src === 'seller' ? sellers : buyers
        return (
          <div key={src} className="mb-6 bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-800">{sourceLabel[src]}リスト ({list.length})</h3>
            </div>
            {loading ? (
              <div className="p-4 space-y-2">
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="h-8 bg-gray-100 animate-pulse rounded" />
                ))}
              </div>
            ) : list.length === 0 ? (
              <p className="p-6 text-center text-sm text-gray-400">同期されていません。「{sourceLabel[src]}のみ」ボタンで取り込んでください。</p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {list.map((o) => (
                  <li
                    key={o.id}
                    className={`px-4 py-2 flex items-center gap-3 ${o.isArchived ? 'opacity-50' : ''}`}
                  >
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                        colorClass[o.color ?? 'default'] || colorClass.default
                      }`}
                    >
                      {o.name}
                    </span>
                    <span className="text-xs text-gray-400">sort {o.sortOrder}</span>
                    {o.isArchived && (
                      <span className="text-xs text-orange-500">アーカイブ済み</span>
                    )}
                    <span className="ml-auto text-xs text-gray-400">
                      最終同期: {new Date(o.syncedAt).toLocaleString('ja-JP')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}
