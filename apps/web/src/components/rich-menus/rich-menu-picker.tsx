'use client'

import { useEffect, useState, useCallback } from 'react'
import { api } from '@/lib/api'
import type { RichMenu } from '@line-crm/shared'

interface Props {
  friendId: string
  /** アサイン変更後に呼ばれる任意コールバック */
  onChanged?: (richMenuId: string | null) => void
  className?: string
}

export default function RichMenuPicker({ friendId, onChanged, className }: Props) {
  const [menus, setMenus] = useState<RichMenu[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [listRes, currentRes] = await Promise.all([
        api.richMenus.list(),
        api.richMenus.getAssignedTo(friendId),
      ])
      if (listRes.success) setMenus(listRes.data)
      else setError(listRes.error)
      if (currentRes.success) setCurrentId(currentRes.data?.richMenuId ?? null)
    } catch {
      setError('リッチメニューの取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [friendId])

  useEffect(() => {
    load()
  }, [load])

  const handleChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value
    if (busy) return
    setBusy(true)
    setError('')
    try {
      if (value === '') {
        // 解除
        const res = await api.richMenus.unassignFromFriend(friendId)
        if (res.success) {
          setCurrentId(null)
          onChanged?.(null)
        } else {
          setError(res.error)
        }
      } else {
        const res = await api.richMenus.assignToFriend(friendId, value)
        if (res.success) {
          setCurrentId(value)
          onChanged?.(value)
        } else {
          setError(res.error)
        }
      }
    } catch {
      setError('アサイン変更に失敗しました')
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className={className}>
        <div className="h-7 w-40 bg-gray-100 rounded animate-pulse" />
      </div>
    )
  }

  if (menus.length === 0) {
    return (
      <div className={className}>
        <span className="text-[11px] text-gray-400">リッチメニュー未登録</span>
      </div>
    )
  }

  return (
    <div className={className}>
      <div className="flex items-center gap-1.5">
        <label className="text-[11px] text-gray-500 shrink-0">メニュー:</label>
        <select
          value={currentId ?? ''}
          onChange={handleChange}
          disabled={busy}
          className="text-xs border border-gray-300 rounded px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-green-500 disabled:opacity-50 max-w-[180px]"
        >
          <option value="">デフォルト</option>
          {menus.map((m) => (
            <option key={m.richMenuId} value={m.richMenuId}>
              {m.name}
            </option>
          ))}
        </select>
        {busy && <span className="text-[10px] text-gray-400">更新中...</span>}
      </div>
      {error && <p className="text-[10px] text-red-600 mt-0.5">{error}</p>}
    </div>
  )
}
