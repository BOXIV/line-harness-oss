'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, type MessageDraft } from '@/lib/api'
import { draftAuthorLabel } from '@/lib/chat-draft'

interface DraftPanelProps {
  isOpen: boolean
  onClose: () => void
  friendId: string
  friendName: string
  /** 入力欄の現在値。「今の入力を使う」で使う。 */
  currentInput: string
  /** 下書きを入力欄へ挿入する。送信できたら呼び出し側がこの下書きを消す。 */
  onInsert: (draft: MessageDraft) => void
  /** 件数が変わったとき（作成/削除）。チャット一覧の ✏️ バッジを更新するため。 */
  onChanged?: () => void
}

function formatDt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/**
 * 送信相手ごとの下書き。
 *
 * 事前に用意しておいた文面（Claude の MCP / API 経由でも、オペレーターが手で書いたものでも）を
 * 選んで入力欄に入れる。**この画面からは送信しない** — 送信は必ず入力欄で内容を見てから。
 *
 * 画面は 2 段階（テンプレート選択モーダルと同じ作り）。
 *   一覧: 保存済みの下書きを選ぶ。高さは中身なり（最大 85vh）。
 *   編集: 本文を書く。**高さを 92vh に固定して余白を本文欄に配る**ので、
 *         入力欄はブラウザ縦幅の 7 割前後になる（rows 固定の小さい箱では書きにくかった）。
 */
export default function DraftPanel({
  isOpen,
  onClose,
  friendId,
  friendName,
  currentInput,
  onInsert,
  onChanged,
}: DraftPanelProps) {
  const [items, setItems] = useState<MessageDraft[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  /** 一覧 / 編集の切り替え。編集中に何を保存するかは editingId が持つ。 */
  const [view, setView] = useState<'list' | 'compose'>('list')
  /** 編集対象の下書き ID。null なら新規作成。 */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formTitle, setFormTitle] = useState('')
  const [formContent, setFormContent] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.drafts.list(friendId)
      if (res.success) setItems(res.data)
      else setError(res.error)
    } catch {
      setError('下書きの読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [friendId])

  useEffect(() => {
    if (isOpen) {
      load()
      setView('list')
      setEditingId(null)
      setFormTitle('')
      setFormContent('')
    }
  }, [isOpen, load])

  /**
   * 書きかけを捨てる操作の前に一度だけ聞く。
   * 本文欄が画面の 7 割あるぶん長文を書くので、背景クリックや ✕ で
   * 数百字が黙って消えると被害が大きい。
   */
  const confirmDiscard = useCallback(
    () => view !== 'compose' || !formContent.trim() || confirm('書きかけの内容を破棄しますか？'),
    [view, formContent],
  )

  const backToList = useCallback(() => {
    if (!confirmDiscard()) return
    setView('list')
    setEditingId(null)
    setFormTitle('')
    setFormContent('')
    setError('')
  }, [confirmDiscard])

  const requestClose = useCallback(() => {
    if (!confirmDiscard()) return
    onClose()
  }, [confirmDiscard, onClose])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      // 編集中の Escape は一覧に戻すだけ（書きかけをモーダルごと閉じない）。
      if (e.key !== 'Escape') return
      if (view === 'compose') backToList()
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, view, backToList, onClose])


  /** 新規作成なら draft を渡さない。 */
  const openCompose = (draft?: MessageDraft) => {
    setEditingId(draft?.id ?? null)
    setFormTitle(draft?.title ?? '')
    setFormContent(draft?.content ?? '')
    setError('')
    setView('compose')
  }

  const handleSave = async () => {
    const content = formContent.trim()
    if (!content) return
    const title = formTitle.trim() || null
    setSubmitting(true)
    setError('')
    try {
      const res = editingId
        ? await api.drafts.update(editingId, { content, title })
        : await api.drafts.create(friendId, { content, title })
      if (res.success) {
        const wasNew = editingId === null
        // 保存できているので破棄の確認は挟まない。
        setView('list')
        setEditingId(null)
        setFormTitle('')
        setFormContent('')
        await load()
        // 件数が変わるのは新規のときだけ（更新では ✏️ バッジは動かない）。
        if (wasNew) onChanged?.()
      } else {
        setError(res.error)
      }
    } catch {
      setError(editingId ? '下書きの更新に失敗しました' : '下書きの保存に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('この下書きを削除しますか？')) return
    setError('')
    try {
      const res = await api.drafts.delete(id)
      if (!res.success) {
        setError(res.error)
        return
      }
      await load()
      onChanged?.()
    } catch {
      setError('下書きの削除に失敗しました')
    }
  }

  if (!isOpen) return null

  const composing = view === 'compose'

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={requestClose} />

      {/* 編集中だけ高さを固定する。固定しないと本文欄が中身なりに縮み、
          「箱が小さいから入力欄も小さい」状態に戻ってしまう。 */}
      <div
        className={`relative bg-white rounded-xl shadow-2xl w-full flex flex-col ${
          composing ? 'h-[92vh] max-w-2xl' : 'max-h-[85vh] max-w-xl'
        }`}
      >
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-gray-900">
              {composing ? (editingId ? '✏️ 下書きを編集' : '✏️ 新しい下書き') : '✏️ 下書き'}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5 truncate">{friendName}</p>
          </div>
          <button
            onClick={requestClose}
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
              <input
                type="text"
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
                placeholder="見出し（任意。例: 価格交渉の返信案）"
                className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-slate-900 shrink-0"
              />
              <textarea
                value={formContent}
                onChange={(e) => setFormContent(e.target.value)}
                placeholder="送る前に用意しておく文面"
                className="w-full flex-1 min-h-[45vh] text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-slate-900 resize-y"
              />
            </div>

            <div className="px-5 py-3 border-t border-gray-200 flex items-center gap-2 flex-wrap">
              <button
                onClick={backToList}
                className="px-3 py-2 min-h-[44px] text-sm text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
              >
                ← 一覧に戻る
              </button>
              <button
                onClick={() => setFormContent(currentInput)}
                disabled={!currentInput.trim()}
                className="px-3 py-2 min-h-[44px] text-sm text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg disabled:opacity-40 transition-colors"
                title="入力欄に書きかけの文面をこのフォームに写す"
              >
                今の入力を使う
              </button>
              <div className="flex-1" />
              <button
                onClick={handleSave}
                disabled={submitting || !formContent.trim()}
                className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity"
                style={{ backgroundColor: '#0f172a' }}
              >
                {submitting ? '保存中...' : editingId ? '更新する' : '下書きに保存'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
              {error && (
                <div className="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700">{error}</div>
              )}

              <h3 className="text-xs font-semibold text-gray-700">
                保存済みの下書き{items.length > 0 && `（${items.length} 件）`}
              </h3>
              {loading ? (
                <p className="text-xs text-gray-400">読み込み中...</p>
              ) : items.length === 0 ? (
                <p className="text-xs text-gray-400">
                  まだ下書きはありません。下のボタンか、Claude の MCP / API から追加できます。
                </p>
              ) : (
                <ul className="space-y-2">
                  {items.map((draft) => (
                    <li key={draft.id} className="border border-gray-200 rounded-lg p-3">
                      <div className="min-w-0">
                        {draft.title && (
                          <p className="text-xs font-semibold text-gray-900 truncate">{draft.title}</p>
                        )}
                        <p className="text-[11px] text-gray-400 mt-0.5">
                          <span
                            className={`inline-flex items-center px-1.5 rounded text-[10px] font-medium leading-4 mr-1.5 ${
                              draft.createdVia === 'api'
                                ? 'bg-violet-100 text-violet-700'
                                : 'bg-gray-100 text-gray-600'
                            }`}
                          >
                            {draftAuthorLabel(draft)}
                          </span>
                          {formatDt(draft.createdAt)}
                        </p>
                      </div>

                      <p className="mt-1.5 text-xs text-gray-700 whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
                        {draft.content}
                      </p>
                      <div className="mt-2 flex gap-2 justify-end">
                        <button
                          onClick={() => handleDelete(draft.id)}
                          className="px-2 py-1 min-h-[32px] text-xs text-red-600 hover:bg-red-50 rounded"
                        >
                          削除
                        </button>
                        <button
                          onClick={() => openCompose(draft)}
                          className="px-2 py-1 min-h-[32px] text-xs border border-gray-300 rounded text-gray-700 hover:bg-gray-50"
                        >
                          編集
                        </button>
                        <button
                          onClick={() => onInsert(draft)}
                          className="px-3 py-1 min-h-[32px] text-xs font-medium text-white bg-slate-900 rounded hover:opacity-90"
                          title="入力欄に入れる（送信はされない）"
                        >
                          入力欄に挿入
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="px-5 py-3 border-t border-gray-200">
              <button
                onClick={() => openCompose()}
                className="w-full px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
                style={{ backgroundColor: '#0f172a' }}
              >
                ＋ 新しい下書きを作成
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
