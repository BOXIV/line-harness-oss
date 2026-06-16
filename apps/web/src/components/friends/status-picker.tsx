'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { notionPillClass } from '@/lib/notion-color'

interface StatusOption {
  id: string
  source: 'seller' | 'buyer'
  name: string
  color: string | null
  sortOrder?: number
}

interface StatusPickerProps {
  friendId: string
  /** Friend's tag-based source — API 互換のため残す（表示専用なので未使用）。 */
  preferredSource?: 'seller' | 'buyer' | null
  /** Compact pill (table row) vs. expanded pill (chat header). */
  compact?: boolean
  onChanged?: () => void
}

// 顧客ステータスは Notion をマスターとし、LINE Connect 側は表示専用（read-only）。
// ダッシュボードからは変更できない（Notion の状態がそのまま反映される）。
// 変更経路（PUT /api/friends/:id/status）も worker 側で封鎖済み。
export default function StatusPicker({ friendId, compact }: StatusPickerProps) {
  const [current, setCurrent] = useState<StatusOption | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const currentRes = await api.friendStatus.getFriend(friendId)
      if (currentRes.success) setCurrent(currentRes.data?.option ?? null)
    } catch {
      /* 表示専用のため握りつぶす */
    } finally {
      setLoading(false)
    }
  }, [friendId])

  useEffect(() => {
    load()
  }, [load])

  const pillCls = `inline-flex items-center whitespace-nowrap px-2 py-0.5 rounded-md text-xs font-medium ${notionPillClass(current?.color)}`

  return (
    <span
      className={compact ? pillCls : `${pillCls} px-3 py-1`}
      title="顧客ステータスは Notion がマスターです（ここでは変更できません）"
    >
      {loading ? '...' : current ? current.name : '未設定'}
    </span>
  )
}
