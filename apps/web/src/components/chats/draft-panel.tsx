'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, type MessageDraft } from '@/lib/api'
import { draftAuthorLabel } from '@/lib/chat-draft'

interface DraftPanelProps {
  isOpen: boolean
  onClose: () => void
  friendId: string
  friendName: string
  /** 入力欄の現在値。「今の入力を下書きに保存」で使う。 */
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
  const [newTitle, setNewTitle] = useState('')
  const [newContent, setNewContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editContent, setEditContent] = useState('')

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
      setNewTitle('')
      setNewContent('')
      setEditingId(null)
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
    const content = newContent.trim()
    if (!content) return
    setSubmitting(true)
    setError('')
    try {
      const res = await api.drafts.create(friendId, { content, title: newTitle.trim() || null })
      if (res.success) {
        setNewTitle('')
        setNewContent('')
        await load()
        onChanged?.()
      } else {
        setError(res.error)
      }
    } catch {
      setError('下書きの保存に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  const handleSaveEdit = async (id: string) => {
    const content = editContent.trim()
    if (!content) return
    setSubmitting(true)
    setError('')
    try {
      const res = await api.drafts.update(id, { content })
      if (res.success) {
        setEditingId(null)
        await load()
      } else {
        setError(res.error)
      }
    } catch {
      setError('下書きの更新に失敗しました')
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

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-xl max-h-[85vh] flex flex-col">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-gray-900">✏️ 下書き</h2>
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

          {/* 保存済みの下書き */}
          <div>
            <h3 className="text-xs font-semibold text-gray-700 mb-2">
              保存済みの下書き{items.length > 0 && `（${items.length} 件）`}
            </h3>
            {loading ? (
              <p className="text-xs text-gray-400">読み込み中...</p>
            ) : items.length === 0 ? (
              <p className="text-xs text-gray-400">
                まだ下書きはありません。下のフォームか、Claude の MCP / API から追加できます。
              </p>
            ) : (
              <ul className="space-y-2">
                {items.map((draft) => (
                  <li key={draft.id} className="border border-gray-200 rounded-lg p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
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
                    </div>

                    {editingId === draft.id ? (
                      <div className="mt-2 space-y-2">
                        <textarea
                          value={editContent}
                          onChange={(e) => setEditContent(e.target.value)}
                          rows={4}
                          className="w-full text-xs border border-gray-300 rounded px-2 py-1.5 bg-white focus:outline-none focus:border-slate-900 resize-y"
                        />
                        <div className="flex gap-2 justify-end">
                          <button
                            onClick={() => setEditingId(null)}
                            className="px-3 py-1 min-h-[32px] text-xs border border-gray-300 rounded text-gray-700 hover:bg-gray-50"
                          >
                            キャンセル
                          </button>
                          <button
                            onClick={() => handleSaveEdit(draft.id)}
                            disabled={submitting || !editContent.trim()}
                            className="px-3 py-1 min-h-[32px] text-xs font-medium text-white bg-slate-900 rounded disabled:opacity-50"
                          >
                            保存
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
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
                            onClick={() => { setEditingId(draft.id); setEditContent(draft.content) }}
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
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 新しい下書き */}
          <div>
            <h3 className="text-xs font-semibold text-gray-700 mb-2">新しい下書きを保存</h3>
            <div className="space-y-2">
              <input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="見出し（任意。例: 価格交渉の返信案）"
                className="w-full text-xs border border-gray-300 rounded px-2 py-1.5 bg-white focus:outline-none focus:border-slate-900"
              />
              <textarea
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                rows={4}
                placeholder="送る前に用意しておく文面"
                className="w-full text-xs border border-gray-300 rounded px-2 py-1.5 bg-white focus:outline-none focus:border-slate-900 resize-y"
              />
              <div className="flex items-center gap-2 justify-end">
                <button
                  onClick={() => setNewContent(currentInput)}
                  disabled={!currentInput.trim()}
                  className="px-3 py-1 min-h-[32px] text-xs border border-gray-300 rounded text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                  title="入力欄に書きかけの文面をこのフォームに写す"
                >
                  今の入力を使う
                </button>
                <button
                  onClick={handleCreate}
                  disabled={submitting || !newContent.trim()}
                  className="px-3 py-1 min-h-[32px] text-xs font-medium text-white bg-slate-900 rounded disabled:opacity-50"
                >
                  {submitting ? '保存中...' : '下書きに保存'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
