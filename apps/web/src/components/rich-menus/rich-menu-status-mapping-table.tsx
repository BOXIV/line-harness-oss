'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/api'
import type { RichMenu } from '@/lib/rich-menu-types'

interface StatusOption {
  id: string
  source: 'seller' | 'buyer'
  name: string
  color: string | null
  sortOrder: number
  isArchived: boolean
}

interface Mapping {
  id: string
  statusOptionId: string
  richMenuId: string
  richMenuName: string | null
  isActive: boolean
}

const sourceLabel: Record<StatusOption['source'], string> = {
  seller: '出品者',
  buyer: '購入者',
}

export default function RichMenuStatusMappingTable() {
  const [statuses, setStatuses] = useState<StatusOption[]>([])
  const [menus, setMenus] = useState<RichMenu[]>([])
  const [mappingsByStatus, setMappingsByStatus] = useState<Map<string, Mapping>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyStatusId, setBusyStatusId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [statusRes, menuRes, mappingRes] = await Promise.all([
        api.friendStatus.listOptions(),
        api.richMenus.list(),
        api.richMenus.autoSwitch.list(),
      ])
      if (statusRes.success) setStatuses(statusRes.data.filter((s) => !s.isArchived))
      else setError(statusRes.error)
      if (menuRes.success) setMenus(menuRes.data)
      if (mappingRes.success) {
        const m = new Map<string, Mapping>()
        mappingRes.data.forEach((row) => {
          m.set(row.statusOptionId, {
            id: row.id,
            statusOptionId: row.statusOptionId,
            richMenuId: row.richMenuId,
            richMenuName: row.richMenuName,
            isActive: row.isActive,
          })
        })
        setMappingsByStatus(m)
      }
    } catch {
      setError('データの読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const handleChange = async (statusOptionId: string, richMenuId: string) => {
    if (busyStatusId) return
    setBusyStatusId(statusOptionId)
    setError('')
    try {
      if (richMenuId === '') {
        const res = await api.richMenus.autoSwitch.delete(statusOptionId)
        if (!res.success) {
          setError(res.error)
          return
        }
      } else {
        const menu = menus.find((m) => m.richMenuId === richMenuId)
        const res = await api.richMenus.autoSwitch.upsert(statusOptionId, {
          richMenuId,
          richMenuName: menu?.name ?? null,
        })
        if (!res.success) {
          setError(res.error)
          return
        }
      }
      await load()
    } catch {
      setError('更新に失敗しました')
    } finally {
      setBusyStatusId(null)
    }
  }

  const grouped = useMemo(() => {
    const sellers = statuses.filter((s) => s.source === 'seller').sort((a, b) => a.sortOrder - b.sortOrder)
    const buyers = statuses.filter((s) => s.source === 'buyer').sort((a, b) => a.sortOrder - b.sortOrder)
    return { seller: sellers, buyer: buyers }
  }, [statuses])

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="h-4 w-32 bg-gray-200 rounded animate-pulse mb-3" />
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-8 bg-gray-100 rounded animate-pulse" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {menus.length === 0 && (
        <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm">
          リッチメニューが 1 つも登録されていません。先に <a href="/rich-menus/new" className="underline">新規作成</a> してください。
        </div>
      )}

      {(['seller', 'buyer'] as const).map((source) => {
        const list = grouped[source]
        if (list.length === 0) return null
        return (
          <div key={source} className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
              <h2 className="text-sm font-semibold text-gray-800">
                {sourceLabel[source]} ステータス × リッチメニュー
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px]">
                <thead>
                  <tr className="border-b border-gray-200 text-xs text-gray-500">
                    <th className="px-4 py-2 text-left font-semibold">ステータス</th>
                    <th className="px-4 py-2 text-left font-semibold">割当てるリッチメニュー</th>
                    <th className="px-4 py-2 text-right" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {list.map((status) => {
                    const mapping = mappingsByStatus.get(status.id)
                    const busy = busyStatusId === status.id
                    return (
                      <tr key={status.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 py-3 text-sm text-gray-900 align-middle">
                          {status.color && (
                            <span
                              className="inline-block w-2.5 h-2.5 rounded-full mr-2 align-middle"
                              style={{ backgroundColor: status.color.startsWith('#') ? status.color : undefined }}
                            />
                          )}
                          {status.name}
                        </td>
                        <td className="px-4 py-3">
                          <select
                            value={mapping?.richMenuId ?? ''}
                            onChange={(e) => handleChange(status.id, e.target.value)}
                            disabled={busy || menus.length === 0}
                            className="text-sm border border-gray-300 rounded px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-green-500 disabled:opacity-50 w-full max-w-xs"
                          >
                            <option value="">— 割当てない —</option>
                            {menus.map((m) => (
                              <option key={m.richMenuId} value={m.richMenuId}>
                                {m.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-4 py-3 text-right text-[10px] text-gray-400">
                          {busy ? '更新中...' : mapping ? `${mapping.richMenuName ?? mapping.richMenuId.slice(-8)}` : ''}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}

      <div className="text-xs text-gray-500 px-1">
        この設定は、管理画面の「個別チャット」からステータスを変更したときに自動で適用されます。
        Notion 側でステータスを直接変更した場合の自動切替は現状未対応です（手動で /chats のステータスピッカーを再選択してください）。
      </div>
    </div>
  )
}
