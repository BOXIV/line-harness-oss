'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/api'
import TemplatePickerModal from '@/components/chats/template-picker-modal'
import type { FriendSource } from '@/lib/friend-source'

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
  /** 送信相手の分類。テンプレ選択の初期タブ（出品者向け/購入者向け）に使う。 */
  friendSource?: FriendSource
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

/**
 * 送信予約。
 *
 * 画面は 2 段階（テンプレート選択モーダル・下書きと同じ作り）。
 *   作成: 日時と本文を書く。**高さを 92vh に固定して余白を本文欄に配る**ので、
 *         入力欄はブラウザ縦幅の 7 割前後になる（rows 固定の小さい箱では書きにくかった）。
 *   一覧: 予約中と履歴。作成できたらここへ戻すので、登録されたことがその場で見える。
 */
export default function ScheduledMessagePanel({
  isOpen,
  onClose,
  friendId,
  friendName,
  friendSource,
}: ScheduledMessagePanelProps) {
  const [items, setItems] = useState<ScheduledMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [scheduledAtLocal, setScheduledAtLocal] = useState(defaultScheduledAt())
  const [content, setContent] = useState('')
  const [messageType, setMessageType] = useState<'text' | 'flex'>('text')
  const [showTemplatePicker, setShowTemplatePicker] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  /** 開いた直後は「予約を作る」画面。登録できたら一覧へ切り替える。 */
  const [view, setView] = useState<'compose' | 'list'>('compose')

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
      setMessageType('text')
      setView('compose')
    }
  }, [isOpen, load])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // テンプレ選択が前面にあるときは、そちらの Escape に任せる（後ろのパネルまで閉じない）。
      if (showTemplatePicker) return
      // 一覧を見ている最中の Escape は作成画面に戻すだけ（書きかけを閉じない）。
      if (view === 'list') setView('compose')
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, view, showTemplatePicker, onClose])

  const handleCreate = async () => {
    const trimmed = content.trim()
    if (!scheduledAtLocal || !trimmed) return
    if (messageType === 'flex') {
      try { JSON.parse(trimmed) } catch { setError('Flex テンプレートの JSON が不正です'); return }
    }
    setSubmitting(true)
    setError('')
    try {
      const res = await api.scheduledMessages.create(friendId, {
        scheduledAt: jstLocalToIso(scheduledAtLocal),
        messageType,
        content: trimmed,
      })
      if (res.success) {
        setContent('')
        setMessageType('text')
        await load()
        // 登録された予約がその場で見えるように一覧へ。
        setView('list')
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

  const composing = view === 'compose'

  return (
    <>
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* 作成中だけ高さを固定する。固定しないと本文欄が中身なりに縮み、
          「箱が小さいから入力欄も小さい」状態に戻ってしまう。 */}
      <div
        className={`relative bg-white rounded-xl shadow-2xl w-full flex flex-col ${
          composing ? 'h-[92vh] max-w-2xl' : 'max-h-[85vh] max-w-xl'
        }`}
      >
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-gray-900">
              {composing ? '📅 新しい送信予約' : '📅 予約の一覧'}
            </h2>
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

        {composing ? (
          <>
            {/* min-h-0 が無いと flex-1 が縮まず、本文欄が画面外へはみ出す。 */}
            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3 flex flex-col gap-2">
              {error && (
                <div className="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700 shrink-0">{error}</div>
              )}

              {/* 日時とテンプレ選択は 1 行に畳む。行を増やすほど本文欄が痩せるため。 */}
              <div className="flex items-end gap-2 shrink-0">
                <label className="flex-1 min-w-0">
                  <span className="text-xs text-gray-600">送信日時 (JST)</span>
                  <input
                    type="datetime-local"
                    value={scheduledAtLocal}
                    onChange={(e) => setScheduledAtLocal(e.target.value)}
                    className="mt-1 w-full text-sm border border-gray-300 rounded-lg px-3 py-2 min-h-[44px] bg-white focus:outline-none focus:border-slate-900"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setShowTemplatePicker(true)}
                  className="shrink-0 px-3 min-h-[44px] text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
                >
                  📋 テンプレートから選択
                </button>
              </div>

              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={messageType === 'flex' ? 'Flex JSON（テンプレートから選択を推奨）' : '送信したいメッセージを入力（またはテンプレートから選択）'}
                className={`w-full flex-1 min-h-[45vh] text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-slate-900 resize-y ${messageType === 'flex' ? 'font-mono text-xs' : ''}`}
              />

              {messageType === 'flex' && (
                <p className="text-[11px] text-gray-400 shrink-0">
                  <span className="mr-1.5 px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">Flex</span>
                  テンプレート選択済み。予約時刻にこの JSON が Flex として配信されます。テキストに戻すにはテンプレートから選び直すか、本文を書き換えてください。
                </p>
              )}
              <p className="text-xs text-gray-400 shrink-0">
                予約は 5 分間隔の cron で配信されます (誤差 ±5 分)
              </p>
            </div>

            <div className="px-5 py-3 border-t border-gray-200 flex items-center gap-2 flex-wrap">
              <button
                onClick={() => setView('list')}
                className="px-3 py-2 min-h-[44px] text-sm text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
              >
                予約の一覧{scheduled.length > 0 && `（${scheduled.length}）`} →
              </button>
              <div className="flex-1" />
              <button
                onClick={handleCreate}
                disabled={submitting || !content.trim() || !scheduledAtLocal}
                className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity"
                style={{ backgroundColor: '#0f172a' }}
              >
                {submitting ? '登録中...' : '予約する'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
              {error && (
                <div className="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700">{error}</div>
              )}

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

            <div className="px-5 py-3 border-t border-gray-200">
              <button
                onClick={() => setView('compose')}
                className="w-full px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
                style={{ backgroundColor: '#0f172a' }}
              >
                ＋ 新しい予約を作成
              </button>
            </div>
          </>
        )}
      </div>
    </div>

    <TemplatePickerModal
      isOpen={showTemplatePicker}
      onClose={() => setShowTemplatePicker(false)}
      onSubmit={({ content: c, messageType: mt }) => {
        setContent(c)
        setMessageType(mt === 'flex' ? 'flex' : 'text')
        setShowTemplatePicker(false)
      }}
      submitLabel="この内容を予約フォームに反映"
      friendSource={friendSource}
    />
    </>
  )
}
