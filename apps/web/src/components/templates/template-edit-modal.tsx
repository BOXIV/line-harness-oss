'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import FlexPreviewPane from './flex-preview-pane'
import {
  TEMPLATE_SOURCE_LABELS,
  normalizeTemplateSource,
  type TemplateSource,
} from '@/lib/template-source'

export interface EditingTemplate {
  id: string
  name: string
  category: string
  messageType: string
  messageContent: string
  /** 出品者向け / 購入者向け / 共通（migration 922）。 */
  source: TemplateSource
}

interface TemplateEditModalProps {
  isOpen: boolean
  template: EditingTemplate | null
  onClose: () => void
  onSaved: () => void
}

export default function TemplateEditModal({ isOpen, template, onClose, onSaved }: TemplateEditModalProps) {
  const [name, setName] = useState('')
  const [category, setCategory] = useState('')
  const [messageType, setMessageType] = useState('text')
  const [messageContent, setMessageContent] = useState('')
  const [source, setSource] = useState<TemplateSource>('common')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (template) {
      setName(template.name)
      setCategory(template.category)
      setMessageType(template.messageType)
      setMessageContent(template.messageContent)
      setSource(normalizeTemplateSource(template.source))
      setError('')
    }
  }, [template])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  const handleSave = async () => {
    if (!template) return
    if (!name.trim() || !category.trim() || !messageContent.trim()) {
      setError('名前 / カテゴリ / 本文は必須です')
      return
    }
    if (messageType === 'flex') {
      try {
        JSON.parse(messageContent)
      } catch (e) {
        setError(`Flex JSON が不正: ${e instanceof Error ? e.message : String(e)}`)
        return
      }
    }
    setSaving(true)
    setError('')
    try {
      const res = await api.templates.update(template.id, {
        name: name.trim(),
        category: category.trim(),
        messageType,
        messageContent,
        source,
      })
      if (res.success) {
        onSaved()
        onClose()
      } else {
        setError(res.error)
      }
    } catch {
      setError('保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  if (!isOpen || !template) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      <div className={`relative bg-white rounded-xl shadow-2xl w-full max-h-[90vh] flex flex-col ${messageType === 'flex' ? 'max-w-6xl' : 'max-w-2xl'}`}>
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">テンプレートを編集</h2>
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

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className={`grid gap-6 ${messageType === 'flex' ? 'lg:grid-cols-2' : ''}`}>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  テンプレート名 <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  カテゴリ <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">区分</label>
                <select
                  value={source}
                  onChange={(e) => setSource(e.target.value as TemplateSource)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
                >
                  <option value="seller">{TEMPLATE_SOURCE_LABELS.seller}</option>
                  <option value="buyer">{TEMPLATE_SOURCE_LABELS.buyer}</option>
                  <option value="common">{TEMPLATE_SOURCE_LABELS.common}</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">メッセージタイプ</label>
                <select
                  value={messageType}
                  onChange={(e) => setMessageType(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
                >
                  <option value="text">テキスト</option>
                  <option value="image">画像</option>
                  <option value="flex">Flex</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  メッセージ内容 <span className="text-red-500">*</span>
                </label>
                <textarea
                  rows={messageType === 'flex' ? 18 : 6}
                  value={messageContent}
                  onChange={(e) => setMessageContent(e.target.value)}
                  className={`w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-y ${messageType === 'flex' ? 'font-mono' : ''}`}
                  placeholder={messageType === 'flex' ? '{ "type": "bubble", "body": { ... } }' : '本文'}
                />
              </div>
            </div>

            {messageType === 'flex' && (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">プレビュー</label>
                <FlexPreviewPane json={messageContent} maxWidth={480} />
              </div>
            )}
          </div>

          {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
        </div>

        <div className="px-5 py-3 border-t border-gray-200 flex items-center gap-2 justify-end">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 min-h-[44px] text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg disabled:opacity-50 transition-colors"
          >
            キャンセル
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
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
