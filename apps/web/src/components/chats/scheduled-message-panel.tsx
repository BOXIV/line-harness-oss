'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/api'

interface ScheduledMessage {
  id: string
  scheduledAt: string
  messageType: 'text' | 'image' | 'flex'
  content: string
  status: 'scheduled' | 'sent' | 'cancelled' | 'failed'
  sentAt: string | null
  error: string | null
  createdAt: string
}

interface ScheduledMessagePanelProps {
  isOpen: boolean
  onClose: () => void
  friendId: string
  friendName: string
}

const statusLabel: Record<string, { label: string; cls: string }> = {
  scheduled: { label: '予約中', cls: 'bg-yellow-100 text-yellow-700' },
  sent:      { label: '送信済', cls: 'bg-green-100 text-green-700' },
  cancelled: { label: 'キャンセル', cls: 'bg-gray-100 text-gray-500' },
  failed:    { label: '失敗', cls: 'bg-red-100 text-red-700' },
}

/** Returns YYYY-MM-DDTHH:mm in JST for default datetime-local input. */
function defaultScheduledAt(): string {
  const now = new Date()
  // +30 min from now, rounded down to nearest 5 min
  now.setMinutes(now.getMinutes() + 30)
  now.setMinutes(Math.floor(now.getMinutes() / 5) * 5)
  // datetime-local expects local time. browser already gives local format.
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`
}

/** Convert datetime-local (treated as JST) to ISO with +09:00 offset. */
function jstLocalToIso(local: string): string {
  // local is "YYYY-MM-DDTHH:mm" without TZ. Treat it as JST.
  return `${local}:00+09:00`
}

function formatDt(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

export default function ScheduledMessagePanel({
  isOpen,
  onClose,
  friendId,
  friendName,
}: ScheduledMessagePanelProps) {
  const [items, setItems] = useState<ScheduledMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [scheduledAtLocal, setScheduledAtLocal] = useState(defaultScheduledAt())
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.scheduledMessages.list(friendId)
      if (res.success) setItems(res.data as unknown as ScheduledMessage[])
      else setError(res.error)
    } catch {
      setError('読み込みに失敗')
    } finally {
      setLoading(false)
    }
  }, [friendId])

  useEffect(() => {
    if (isOpen) {
      load()
      setScheduledAtLocal(defaultScheduledAt())
      setContent('')
    }
  }, [isOpen, load])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  const handleCreate = async () => {
    if (!scheduledAtLocal || !content.trim()) return
    setSubmitting(true)
    setError('')
    try {
      const res = await api.scheduledMessages.create(friendId, {
        scheduledAt: jstLocalToIso(scheduledAtLocal),
        messageType: 'text',
        content: content.trim(),
      })
      if (res.success) {
        setContent('')
        await load()
      } else {
        setError(res.error)
      }
    } catch {
      setError('予約の登録に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  const handleCancel = async (id: string) => {
    if (!confirm('この予約をキャンセルしますか？')) return
    try {
      await api.scheduledMessages.cancel(id)
      await load()
    } catch {
      setError('キャンセルに失敗しました')
    }
  }

  const scheduled = useMemo(() => items.filter((i) => i.status === 'scheduled'), [items])
  const past = useMemo(() => items.filter((i) => i.status !== 'scheduled'), [items])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-xl max-h-[85vh] flex flex-col">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">📅 送信予約</h2>
            <p className="text-xs text-gray-500 mt-0.5 truncate">{friendName}</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 min-h-[44px] min-w-[44px] flex items-center justify-center"
            aria-label="閉じる"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700">{error}</div>
          )}

          {/* New scheduled message form */}
          <div>
            <h3 className="text-xs font-semibold text-gray-700 mb-2">新しい予約を作成</h3>
            <div className="space-y-2">
              <label className="block">
                <span className="text-xs text-gray-600">送信日時 (JST)</span>
                <input
                  type="datetime-local"
                  value={scheduledAtLocal}
                  onChange={(e) => setScheduledAtLocal(e.target.value)}
                  className="mt-1 w-full text-sm border border-gray-300 rounded-lg px-3 py-2 min-h-[44px] bg-white focus:outline-none focus:border-slate-900"
                />
              </label>
              <label className="block">
                <span className="text-xs text-gray-600">本文</span>
                <textarea
                  rows={4}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="送信したいメッセージを入力"
                  className="mt-1 w-full text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-slate-900 resize-y"
                />
              </label>
              <button
                onClick={handleCreate}
                disabled={submitting || !content.trim() || !scheduledAtLocal}
                className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity"
                style={{ backgroundColor: '#0f172a' }}
              >
                {submitting ? '登録中...' : '予約する'}
              </button>
              <p className="text-xs text-gray-400">
                予約は 5 分間隔の cron で配信されます (誤差 ±5 分)
              </p>
            </div>
          </div>

          {/* Active scheduled */}
          <div>
            <h3 className="text-xs font-semibold text-gray-700 mb-2">予約中 ({scheduled.length})</h3>
            {loading ? (
              <div className="space-y-2">
                {[...Array(2)].map((_, i) => <div key={i} className="h-16 bg-gray-100 rounded animate-pulse" />)}
              </div>
            ) : scheduled.length === 0 ? (
              <p className="text-xs text-gray-400 py-2">予約中のメッセージはありません</p>
            ) : (
              <ul className="space-y-2">
                {scheduled.map((sm) => (
                  <li
                    key={sm.id}
                    className="flex items-start justify-between gap-2 p-3 border border-gray-200 rounded-lg"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-gray-500">{formatDt(sm.scheduledAt)}</p>
                      <p className="text-sm text-gray-900 mt-1 line-clamp-3 whitespace-pre-wrap break-words">
                        {sm.content}
                      </p>
                    </div>
                    <button
                      onClick={() => handleCancel(sm.id)}
                      className="px-2 py-1 min-h-[44px] text-xs text-red-600 bg-red-50 hover:bg-red-100 rounded transition-colors shrink-0"
                    >
                      キャンセル
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Past */}
          {past.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-gray-700 mb-2">履歴 ({past.length})</h3>
              <ul className="space-y-1">
                {past.map((sm) => {
                  const s = statusLabel[sm.status] ?? statusLabel.cancelled
                  return (
                    <li key={sm.id} className="flex items-start gap-2 text-xs py-1">
                      <span className={`px-1.5 py-0.5 rounded shrink-0 ${s.cls}`}>{s.label}</span>
                      <div className="min-w-0 flex-1">
                        <span className="text-gray-400">{formatDt(sm.scheduledAt)}</span>
                        <span className="text-gray-600 ml-2 truncate inline-block max-w-[200px] align-bottom">{sm.content.slice(0, 40)}{sm.content.length > 40 ? '…' : ''}</span>
                        {sm.error && <p className="text-red-500 text-[11px]">{sm.error}</p>}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
