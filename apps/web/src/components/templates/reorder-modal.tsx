'use client'

import { useEffect, useState } from 'react'

export interface ReorderItem {
  key: string
  label: string
  sub?: string
}

interface ReorderModalProps {
  isOpen: boolean
  title: string
  items: ReorderItem[]
  onClose: () => void
  /** 新しい並び順の key 配列で呼ばれる。成功時は親側でモーダルを閉じる。 */
  onSave: (keys: string[]) => Promise<void>
}

/**
 * 汎用並び替えモーダル。ドラッグ&ドロップ（デスクトップ）と
 * ↑↓ボタン（タッチ端末でも操作可能）の両対応。
 */
export default function ReorderModal({ isOpen, title, items, onClose, onSave }: ReorderModalProps) {
  const [order, setOrder] = useState<ReorderItem[]>(items)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (isOpen) {
      setOrder(items)
      setDragIndex(null)
    }
  }, [isOpen, items])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, saving, onClose])

  if (!isOpen) return null

  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length || from === to) return
    setOrder((prev) => {
      const next = [...prev]
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      return next
    })
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave(order.map((o) => o.key))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={() => !saving && onClose()} />

      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-md max-h-[85vh] flex flex-col">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
          <button
            onClick={onClose}
            disabled={saving}
            className="text-gray-400 hover:text-gray-600 min-h-[44px] min-w-[44px] flex items-center justify-center"
            aria-label="閉じる"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="px-5 pt-3 text-xs text-gray-500">
          ドラッグ または ↑↓ボタンで並び替えて「保存」を押してください
        </p>

        <ul className="flex-1 overflow-y-auto px-5 py-3 space-y-1.5">
          {order.map((item, i) => (
            <li
              key={item.key}
              draggable={!saving}
              onDragStart={() => setDragIndex(i)}
              onDragOver={(e) => {
                e.preventDefault()
                if (dragIndex !== null && dragIndex !== i) {
                  move(dragIndex, i)
                  setDragIndex(i)
                }
              }}
              onDrop={(e) => e.preventDefault()}
              onDragEnd={() => setDragIndex(null)}
              className={`flex items-center gap-2 p-2 rounded-lg border select-none ${
                dragIndex === i
                  ? 'border-slate-900 bg-gray-50 opacity-70'
                  : 'border-gray-200 bg-white'
              }`}
            >
              <svg className="w-4 h-4 text-gray-400 shrink-0 cursor-grab" fill="currentColor" viewBox="0 0 20 20">
                <path d="M7 4a1 1 0 110-2 1 1 0 010 2zM7 8a1 1 0 110-2 1 1 0 010 2zM7 12a1 1 0 110-2 1 1 0 010 2zM7 16a1 1 0 110-2 1 1 0 010 2zM13 4a1 1 0 110-2 1 1 0 010 2zM13 8a1 1 0 110-2 1 1 0 010 2zM13 12a1 1 0 110-2 1 1 0 010 2zM13 16a1 1 0 110-2 1 1 0 010 2z" />
              </svg>
              <span className="text-xs text-gray-400 w-5 text-right shrink-0">{i + 1}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-900 truncate">{item.label}</p>
                {item.sub && <p className="text-xs text-gray-400 truncate">{item.sub}</p>}
              </div>
              <div className="flex gap-1 shrink-0">
                <button
                  onClick={() => move(i, i - 1)}
                  disabled={saving || i === 0}
                  className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 disabled:opacity-30"
                  aria-label="上へ"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                  </svg>
                </button>
                <button
                  onClick={() => move(i, i + 1)}
                  disabled={saving || i === order.length - 1}
                  className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 disabled:opacity-30"
                  aria-label="下へ"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
              </div>
            </li>
          ))}
        </ul>

        <div className="px-5 py-3 border-t border-gray-200 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 min-h-[44px] text-sm text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            onClick={handleSave}
            disabled={saving || order.length === 0}
            className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity"
            style={{ backgroundColor: '#0f172a' }}
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
