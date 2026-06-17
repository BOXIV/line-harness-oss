'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/api'
import FlexPreviewPane from '@/components/templates/flex-preview-pane'

interface Template {
  id: string
  name: string
  category: string
  messageType: string
  messageContent: string
}

interface TemplatePickerModalProps {
  isOpen: boolean
  onClose: () => void
  onSubmit: (payload: { content: string; messageType: string }) => void
  /** 確定ボタンの文言。即時送信なら「この内容で送信」(既定)、予約フォームへ反映する用途なら「この内容を反映」等。 */
  submitLabel?: string
}

const messageTypeLabels: Record<string, string> = {
  text: 'テキスト',
  image: '画像',
  flex: 'Flex',
  carousel: 'カルーセル',
}

export default function TemplatePickerModal({ isOpen, onClose, onSubmit, submitLabel = 'この内容で送信' }: TemplatePickerModalProps) {
  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [selectedCategory, setSelectedCategory] = useState<string>('all')
  const [selected, setSelected] = useState<Template | null>(null)
  const [editedContent, setEditedContent] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.templates.list()
      if (res.success) {
        setTemplates(res.data)
      } else {
        setError(res.error)
      }
    } catch {
      setError('テンプレートの読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isOpen && templates.length === 0 && !loading) {
      load()
    }
  }, [isOpen, templates.length, loading, load])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selected) {
          setSelected(null)
        } else {
          onClose()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, selected, onClose])

  const categories = useMemo(
    () => Array.from(new Set(templates.map((t) => t.category).filter(Boolean))),
    [templates],
  )

  const filtered = useMemo(() => {
    const q = searchInput.trim().toLowerCase()
    return templates.filter((t) => {
      if (selectedCategory !== 'all' && t.category !== selectedCategory) return false
      if (!q) return true
      return (
        t.name.toLowerCase().includes(q) ||
        t.messageContent.toLowerCase().includes(q)
      )
    })
  }, [templates, searchInput, selectedCategory])

  const handlePick = (t: Template) => {
    setSelected(t)
    setEditedContent(t.messageContent)
  }

  const handleReset = () => {
    if (selected) setEditedContent(selected.messageContent)
  }

  const handleSubmit = () => {
    if (!selected) return
    onSubmit({ content: editedContent, messageType: selected.messageType })
    handleClose()
  }

  const handleClose = () => {
    setSelected(null)
    setEditedContent('')
    setSearchInput('')
    setSelectedCategory('all')
    onClose()
  }

  if (!isOpen) return null

  const messageType = selected?.messageType
  const canEdit = messageType === 'text' || messageType === 'flex'
  const isFlex = messageType === 'flex'
  let flexJsonValid = true
  if (isFlex) {
    try { JSON.parse(editedContent) } catch { flexJsonValid = false }
  }
  const canSubmit =
    selected !== null && editedContent.trim().length > 0 && (!isFlex || flexJsonValid)

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={handleClose} />

      <div className={`relative bg-white rounded-xl shadow-2xl w-full max-h-[85vh] flex flex-col ${selected?.messageType === 'flex' ? 'max-w-5xl' : 'max-w-2xl'}`}>
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">
            {selected ? `${selected.name} を編集して送信` : 'テンプレートを選択'}
          </h2>
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-600 min-h-[44px] min-w-[44px] flex items-center justify-center"
            aria-label="閉じる"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {!selected ? (
          <>
            <div className="px-5 py-3 border-b border-gray-100 space-y-2">
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="🔍 テンプレ名・本文で検索"
                className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 min-h-[44px] focus:outline-none focus:border-slate-900"
              />
              {categories.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  <button
                    onClick={() => setSelectedCategory('all')}
                    className={`px-3 py-1 text-xs font-medium rounded-full transition-colors ${
                      selectedCategory === 'all' ? 'text-white' : 'text-gray-600 bg-gray-100 hover:bg-gray-200'
                    }`}
                    style={selectedCategory === 'all' ? { backgroundColor: '#0f172a' } : undefined}
                  >
                    全て
                  </button>
                  {categories.map((cat) => (
                    <button
                      key={cat}
                      onClick={() => setSelectedCategory(cat)}
                      className={`px-3 py-1 text-xs font-medium rounded-full transition-colors ${
                        selectedCategory === cat ? 'text-white' : 'text-gray-600 bg-gray-100 hover:bg-gray-200'
                      }`}
                      style={selectedCategory === cat ? { backgroundColor: '#0f172a' } : undefined}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-3">
              {error && (
                <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700">{error}</div>
              )}
              {loading ? (
                <div className="space-y-2">
                  {[...Array(4)].map((_, i) => (
                    <div key={i} className="animate-pulse h-14 bg-gray-100 rounded-lg" />
                  ))}
                </div>
              ) : filtered.length === 0 ? (
                <p className="text-center text-sm text-gray-400 py-8">
                  {templates.length === 0 ? 'テンプレートがありません' : '一致するテンプレートがありません'}
                </p>
              ) : (
                <ul className="space-y-2">
                  {filtered.map((t) => {
                    const supported = t.messageType === 'text' || t.messageType === 'flex'
                    return (
                      <li key={t.id}>
                        <button
                          onClick={() => supported && handlePick(t)}
                          disabled={!supported}
                          className={`w-full text-left p-3 rounded-lg border transition-colors ${
                            supported
                              ? 'border-gray-200 hover:border-slate-900 hover:bg-gray-50'
                              : 'border-gray-100 bg-gray-50 opacity-60 cursor-not-allowed'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2 mb-1">
                            <p className="text-sm font-medium text-gray-900">{t.name}</p>
                            <div className="flex items-center gap-1 shrink-0">
                              {t.category && (
                                <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">
                                  {t.category}
                                </span>
                              )}
                              <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                                {messageTypeLabels[t.messageType] || t.messageType}
                              </span>
                            </div>
                          </div>
                          <p className="text-xs text-gray-500 line-clamp-2 break-words">
                            {supported
                              ? t.messageContent.slice(0, 120)
                              : `※ ${messageTypeLabels[t.messageType] || t.messageType} はこのバージョンでは未対応`}
                          </p>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <span className="px-1.5 py-0.5 rounded bg-gray-100">
                  {messageTypeLabels[selected.messageType] || selected.messageType}
                </span>
                {selected.category && (
                  <span className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">{selected.category}</span>
                )}
              </div>

              {isFlex ? (
                <div className="grid gap-3 lg:grid-cols-2">
                  <textarea
                    value={editedContent}
                    onChange={(e) => setEditedContent(e.target.value)}
                    rows={14}
                    className="w-full text-xs border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:border-slate-900 resize-y font-mono"
                    placeholder="Flex JSON を編集"
                  />
                  <div className="flex justify-center">
                    <FlexPreviewPane json={editedContent} maxWidth={420} />
                  </div>
                </div>
              ) : canEdit ? (
                <textarea
                  value={editedContent}
                  onChange={(e) => setEditedContent(e.target.value)}
                  rows={10}
                  className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:border-slate-900 resize-y font-mono"
                  placeholder="本文を編集"
                />
              ) : (
                <div className="text-xs text-gray-500 p-3 bg-gray-50 rounded">
                  ※ {messageTypeLabels[selected.messageType] || selected.messageType} テンプレの編集は次バージョンで対応予定。本文をそのまま送信します。
                  <pre className="mt-2 whitespace-pre-wrap break-all text-[11px] text-gray-400">{selected.messageContent}</pre>
                </div>
              )}
            </div>

            <div className="px-5 py-3 border-t border-gray-200 flex items-center gap-2 flex-wrap">
              <button
                onClick={() => setSelected(null)}
                className="px-3 py-2 min-h-[44px] text-sm text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
              >
                ← 一覧に戻る
              </button>
              {canEdit && (
                <button
                  onClick={handleReset}
                  className="px-3 py-2 min-h-[44px] text-sm text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
                >
                  テンプレに戻す
                </button>
              )}
              <div className="flex-1" />
              <button
                onClick={handleSubmit}
                disabled={!canSubmit}
                className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity"
                style={{ backgroundColor: '#0f172a' }}
              >
                {submitLabel}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
