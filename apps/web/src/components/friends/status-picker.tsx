'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'

interface StatusOption {
  id: string
  source: 'seller' | 'buyer'
  name: string
  color: string | null
  sortOrder?: number
}

interface StatusPickerProps {
  friendId: string
  /** Friend's tag-based source ('seller' | 'buyer'). null = 未判定 */
  preferredSource: 'seller' | 'buyer' | null
  /** Compact pill (table row) vs. expanded button (chat header). */
  compact?: boolean
  onChanged?: () => void
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

function pillClassFor(color: string | null | undefined) {
  return colorClass[color ?? 'default'] || colorClass.default
}

export default function StatusPicker({ friendId, preferredSource, compact, onChanged }: StatusPickerProps) {
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<StatusOption[]>([])
  const [current, setCurrent] = useState<StatusOption | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [optionsRes, currentRes] = await Promise.all([
        api.friendStatus.listOptions(
          preferredSource ? { source: preferredSource } : undefined,
        ),
        api.friendStatus.getFriend(friendId),
      ])
      if (optionsRes.success) setOptions(optionsRes.data)
      if (currentRes.success) {
        setCurrent(currentRes.data?.option ?? null)
      }
    } catch {
      setError('読み込みに失敗')
    } finally {
      setLoading(false)
    }
  }, [friendId, preferredSource])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    // Capture phase scroll handler — close on OUTER scrolls but ignore
    // scrolls inside the dropdown itself so the user can browse options.
    const onScroll = (e: Event) => {
      const menu = menuRef.current
      if (menu && e.target instanceof Node && menu.contains(e.target)) return
      setOpen(false)
    }
    const onResize = () => setOpen(false)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  const toggleOpen = () => {
    if (!open && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      const menuWidth = Math.max(220, rect.width)
      const margin = 8
      const viewportWidth = window.innerWidth
      // align menu's right edge with button's right edge if it would overflow
      let left = rect.left
      if (left + menuWidth + margin > viewportWidth) {
        left = Math.max(margin, rect.right - menuWidth)
      }
      setMenuPos({ top: rect.bottom + 4, left, width: menuWidth })
    }
    setOpen((v) => !v)
  }

  const handleSet = async (optionId: string | null) => {
    setSaving(true)
    setError('')
    try {
      await api.friendStatus.setFriend(friendId, optionId)
      await load()
      setOpen(false)
      onChanged?.()
    } catch {
      setError('更新に失敗')
    } finally {
      setSaving(false)
    }
  }

  const pillCls = `inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${pillClassFor(current?.color)}`

  return (
    <div className="inline-block">
      <button
        ref={buttonRef}
        type="button"
        onClick={toggleOpen}
        disabled={loading}
        className={
          compact
            ? `${pillCls} hover:opacity-80 transition-opacity disabled:opacity-40`
            : `${pillCls} px-3 py-1 hover:opacity-80 transition-opacity disabled:opacity-40`
        }
      >
        {loading ? '...' : current ? current.name : '未設定'}
        <svg className="ml-1 w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && menuPos && (
        <>
          <div className="fixed inset-0 z-[55]" onClick={() => setOpen(false)} />
          <div
            ref={menuRef}
            className="fixed z-[60] bg-white rounded-lg shadow-lg border border-gray-200 max-h-80 overflow-y-auto overscroll-contain"
            style={{ top: menuPos.top, left: menuPos.left, minWidth: menuPos.width }}
          >
            {error && <div className="px-3 py-2 text-xs text-red-600">{error}</div>}
            {!preferredSource && (
              <div className="px-3 py-2 text-xs text-gray-400 border-b border-gray-100">
                出品者/購入者タグを付けると候補が絞られます
              </div>
            )}
            <button
              onClick={() => handleSet(null)}
              disabled={saving}
              className="w-full text-left px-3 py-2 text-xs text-gray-500 hover:bg-gray-50 disabled:opacity-50"
            >
              ✕ 未設定にする
            </button>
            {options.length === 0 && !loading && (
              <p className="px-3 py-2 text-xs text-gray-400">候補がありません</p>
            )}
            {options.map((o) => (
              <button
                key={o.id}
                onClick={() => handleSet(o.id)}
                disabled={saving || o.id === current?.id}
                className="w-full text-left px-3 py-2 text-xs hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2"
              >
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full ${pillClassFor(o.color)}`}>
                  {o.name}
                </span>
                {o.id === current?.id && <span className="text-gray-400">現在</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
