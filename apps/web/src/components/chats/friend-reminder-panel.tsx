'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'

interface Reminder {
  id: string
  name: string
  description: string | null
  isActive: boolean
}

interface FriendReminder {
  friendReminderId: string
  reminderId: string
  reminderName: string
  reminderIsActive: boolean
  targetDate: string
  status: string
  totalSteps: number
  deliveredSteps: number
}

interface FriendReminderPanelProps {
  isOpen: boolean
  onClose: () => void
  friendId: string
  friendName: string
}

const statusLabel: Record<string, { label: string; cls: string }> = {
  active: { label: '進行中', cls: 'bg-yellow-100 text-yellow-700' },
  completed: { label: '完了', cls: 'bg-green-100 text-green-700' },
  cancelled: { label: 'キャンセル', cls: 'bg-gray-100 text-gray-500' },
}

function todayJstYmd(): string {
  const now = new Date()
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  return jst.toISOString().slice(0, 10)
}

export default function FriendReminderPanel({
  isOpen,
  onClose,
  friendId,
  friendName,
}: FriendReminderPanelProps) {
  const [reminders, setReminders] = useState<Reminder[]>([])
  const [enrollments, setEnrollments] = useState<FriendReminder[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedReminderId, setSelectedReminderId] = useState('')
  const [targetDate, setTargetDate] = useState(todayJstYmd())
  const [submitting, setSubmitting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [remindersRes, enrollRes] = await Promise.all([
        api.reminders.list(),
        api.reminders.listFriendReminders(friendId),
      ])
      if (remindersRes.success) {
        const active = remindersRes.data.filter((r) => r.isActive)
        setReminders(active)
        if (!selectedReminderId && active[0]) setSelectedReminderId(active[0].id)
      }
      if (enrollRes.success) setEnrollments(enrollRes.data)
    } catch {
      setError('読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [friendId, selectedReminderId])

  useEffect(() => {
    if (isOpen) load()
  }, [isOpen, load])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  const handleEnroll = async () => {
    if (!selectedReminderId || !targetDate) return
    setSubmitting(true)
    setError('')
    try {
      const res = await api.reminders.enrollFriend(selectedReminderId, friendId, { targetDate })
      if (res.success) {
        await load()
      } else {
        setError(res.error)
      }
    } catch {
      setError('登録に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  const handleCancel = async (frId: string) => {
    if (!confirm('このリマインダーをキャンセルしますか？')) return
    try {
      await api.reminders.cancelFriendReminder(frId)
      await load()
    } catch {
      setError('キャンセルに失敗しました')
    }
  }

  if (!isOpen) return null

  const active = enrollments.filter((e) => e.status === 'active')
  const past = enrollments.filter((e) => e.status !== 'active')

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-xl max-h-[85vh] flex flex-col">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">⏰ リマインダー</h2>
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

          {/* Active enrollments */}
          <div>
            <h3 className="text-xs font-semibold text-gray-700 mb-2">進行中 ({active.length})</h3>
            {loading ? (
              <div className="space-y-2">
                {[...Array(2)].map((_, i) => (
                  <div key={i} className="h-16 bg-gray-100 rounded animate-pulse" />
                ))}
              </div>
            ) : active.length === 0 ? (
              <p className="text-xs text-gray-400 py-2">進行中のリマインダーはありません</p>
            ) : (
              <ul className="space-y-2">
                {active.map((e) => {
                  const remaining = Math.max(0, e.totalSteps - e.deliveredSteps)
                  return (
                    <li
                      key={e.friendReminderId}
                      className="flex items-start justify-between gap-2 p-3 border border-gray-200 rounded-lg"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-gray-900 truncate">{e.reminderName}</p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          対象日: {e.targetDate} ｜ 残 {remaining} / {e.totalSteps} ステップ
                        </p>
                      </div>
                      <button
                        onClick={() => handleCancel(e.friendReminderId)}
                        className="px-2 py-1 min-h-[44px] text-xs text-red-600 bg-red-50 hover:bg-red-100 rounded transition-colors shrink-0"
                      >
                        キャンセル
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          {/* Past enrollments */}
          {past.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-gray-700 mb-2">履歴 ({past.length})</h3>
              <ul className="space-y-1">
                {past.map((e) => {
                  const status = statusLabel[e.status] ?? statusLabel.cancelled
                  return (
                    <li key={e.friendReminderId} className="flex items-center gap-2 text-xs text-gray-500 py-1">
                      <span className={`px-1.5 py-0.5 rounded ${status.cls}`}>{status.label}</span>
                      <span className="truncate">{e.reminderName}</span>
                      <span className="text-gray-400">— {e.targetDate}</span>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {/* New enrollment */}
          <div className="pt-3 border-t border-gray-100">
            <h3 className="text-xs font-semibold text-gray-700 mb-2">新しいリマインダーを追加</h3>
            {reminders.length === 0 ? (
              <p className="text-xs text-gray-400">
                有効なリマインダーがありません。<a href="/reminders" className="text-blue-600 hover:underline">/reminders</a> で先に作成してください。
              </p>
            ) : (
              <div className="space-y-2">
                <label className="block">
                  <span className="text-xs text-gray-600">リマインダー</span>
                  <select
                    value={selectedReminderId}
                    onChange={(e) => setSelectedReminderId(e.target.value)}
                    className="mt-1 w-full text-sm border border-gray-300 rounded-lg px-3 py-2 min-h-[44px] bg-white focus:outline-none focus:border-slate-900"
                  >
                    {reminders.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-xs text-gray-600">対象日</span>
                  <input
                    type="date"
                    value={targetDate}
                    min={todayJstYmd()}
                    onChange={(e) => setTargetDate(e.target.value)}
                    className="mt-1 w-full text-sm border border-gray-300 rounded-lg px-3 py-2 min-h-[44px] bg-white focus:outline-none focus:border-slate-900"
                  />
                </label>
                <button
                  onClick={handleEnroll}
                  disabled={submitting || !selectedReminderId || !targetDate}
                  className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity"
                  style={{ backgroundColor: '#0f172a' }}
                >
                  {submitting ? '登録中...' : '登録'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
