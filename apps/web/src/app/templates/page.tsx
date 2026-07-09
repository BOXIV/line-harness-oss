'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '@/lib/api'
import Header from '@/components/layout/header'
import FlexPreviewPane from '@/components/templates/flex-preview-pane'
import TemplateEditModal from '@/components/templates/template-edit-modal'
import type { EditingTemplate } from '@/components/templates/template-edit-modal'
import ReorderModal from '@/components/templates/reorder-modal'

interface Template {
  id: string
  name: string
  category: string
  messageType: string
  messageContent: string
  createdAt: string
  updatedAt: string
}

const messageTypeLabels: Record<string, string> = {
  text: 'テキスト',
  image: '画像',
  flex: 'Flex',
}

interface CreateFormState {
  name: string
  category: string
  messageType: string
  messageContent: string
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [selectedCategory, setSelectedCategory] = useState<string>('all')
  const [form, setForm] = useState<CreateFormState>({
    name: '',
    category: '',
    messageType: 'text',
    messageContent: '',
  })
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [editing, setEditing] = useState<EditingTemplate | null>(null)
  const [categories, setCategories] = useState<{ id: string | null; name: string; sortOrder: number }[]>([])
  const [reordering, setReordering] = useState<'categories' | 'templates' | null>(null)

  const loadCategories = useCallback(async () => {
    try {
      const res = await api.templateCategories.list()
      if (res.success) setCategories(res.data)
    } catch {
      // カテゴリ取得失敗はチップバー非表示に留める（一覧自体は表示できる）
    }
  }, [])

  useEffect(() => {
    loadCategories()
  }, [loadCategories])

  // 選択中カテゴリの最後のテンプレを削除/別カテゴリへ移動すると、そのカテゴリは
  // API から消える。selectedCategory を放置するとどのチップも選択状態にならず、
  // 一覧が空のまま理由が分からなくなるので「全て」に戻す。
  useEffect(() => {
    if (
      selectedCategory !== 'all' &&
      categories.length > 0 &&
      !categories.some((c) => c.name === selectedCategory)
    ) {
      setSelectedCategory('all')
    }
  }, [categories, selectedCategory])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.templates.list(
        selectedCategory !== 'all' ? selectedCategory : undefined
      )
      if (res.success) {
        setTemplates(res.data)
      } else {
        setError(res.error)
      }
    } catch {
      setError('テンプレートの読み込みに失敗しました。もう一度お試しください。')
    } finally {
      setLoading(false)
    }
  }, [selectedCategory])

  useEffect(() => {
    load()
  }, [load])

  const handleCreate = async () => {
    if (!form.name.trim()) {
      setFormError('テンプレート名を入力してください')
      return
    }
    if (!form.category.trim()) {
      setFormError('カテゴリを入力してください')
      return
    }
    if (!form.messageContent.trim()) {
      setFormError('メッセージ内容を入力してください')
      return
    }
    setSaving(true)
    setFormError('')
    try {
      const res = await api.templates.create({
        name: form.name,
        category: form.category,
        messageType: form.messageType,
        messageContent: form.messageContent,
      })
      if (res.success) {
        setShowCreate(false)
        setForm({ name: '', category: '', messageType: 'text', messageContent: '' })
        load()
        loadCategories()
      } else {
        setFormError(res.error)
      }
    } catch {
      setFormError('作成に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('このテンプレートを削除してもよいですか？')) return
    try {
      await api.templates.delete(id)
      load()
      loadCategories()
    } catch {
      setError('削除に失敗しました')
    }
  }

  // ── 行のインライン並び替え（ドラッグ&ドロップ）─────────────────────
  // sort_order はカテゴリ内スコープ。行のドラッグは「同じカテゴリ内」でのみ入替える。
  // 「全て」表示ではカテゴリを跨いだ移動は無視する（別カテゴリの行に重ねても動かない）。
  // ドラッグ中は templates を直接 optimistic に並べ替え、確定時に該当カテゴリの
  // id 順を保存する。失敗時のみ load() でサーバ順に戻す。
  const templatesRef = useRef<Template[]>([])
  useEffect(() => { templatesRef.current = templates }, [templates])

  const dragId = useRef<string | null>(null)
  const dragCat = useRef<string | null>(null)
  const lastOverId = useRef<string | null>(null) // 同一ターゲットへの dragover 再処理を抑止
  const startIds = useRef<string[]>([])           // 変化が無ければ保存しない用のスナップショット
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [reorderSaving, setReorderSaving] = useState(false)

  const catIds = (list: Template[], cat: string) =>
    list.filter((t) => t.category === cat).map((t) => t.id)

  const onRowDragStart = (e: React.DragEvent, t: Template) => {
    dragId.current = t.id
    dragCat.current = t.category
    lastOverId.current = null
    startIds.current = catIds(templatesRef.current, t.category)
    setDraggingId(t.id)
    try { e.dataTransfer.effectAllowed = 'move' } catch { /* jsdom 等 */ }
  }

  const onRowDragOver = (e: React.DragEvent, target: Template) => {
    e.preventDefault()
    // ドラッグ元は ref から読む。dragover は state コミットを待たず連続発火するため。
    if (!dragId.current || dragCat.current !== target.category) return // 同一カテゴリ内のみ
    if (target.id === dragId.current || lastOverId.current === target.id) return
    lastOverId.current = target.id
    setTemplates((prev) => {
      const from = prev.findIndex((x) => x.id === dragId.current)
      const to = prev.findIndex((x) => x.id === target.id)
      if (from < 0 || to < 0 || from === to) return prev
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }

  const onRowDragEnd = async () => {
    const cat = dragCat.current
    dragId.current = null
    dragCat.current = null
    lastOverId.current = null
    setDraggingId(null)
    if (!cat) return
    const ids = catIds(templatesRef.current, cat)
    if (ids.length < 2 || JSON.stringify(ids) === JSON.stringify(startIds.current)) return
    setReorderSaving(true)
    try {
      const res = await api.templates.reorder(ids)
      if (!res.success) { setError('並び順の保存に失敗しました'); load() }
    } catch {
      setError('並び順の保存に失敗しました')
      load()
    } finally {
      setReorderSaving(false)
    }
  }

  const canDragRows = !loading && !reorderSaving && templates.length >= 2

  return (
    <div>
      <Header
        title="テンプレート管理"
        action={
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
            style={{ backgroundColor: '#0f172a' }}
          >
            + 新規テンプレート
          </button>
        }
      />

      {/* Error */}
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Category filter */}
      {categories.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2 items-center">
          <button
            onClick={() => setSelectedCategory('all')}
            className={`px-3 py-1.5 min-h-[44px] text-xs font-medium rounded-full transition-colors ${
              selectedCategory === 'all'
                ? 'text-white'
                : 'text-gray-600 bg-gray-100 hover:bg-gray-200'
            }`}
            style={selectedCategory === 'all' ? { backgroundColor: '#0f172a' } : undefined}
          >
            全て
          </button>
          {categories.map((cat) => (
            <button
              key={cat.name}
              onClick={() => setSelectedCategory(cat.name)}
              className={`px-3 py-1.5 min-h-[44px] text-xs font-medium rounded-full transition-colors ${
                selectedCategory === cat.name
                  ? 'text-white'
                  : 'text-gray-600 bg-gray-100 hover:bg-gray-200'
              }`}
              style={selectedCategory === cat.name ? { backgroundColor: '#0f172a' } : undefined}
            >
              {cat.name}
            </button>
          ))}
          {categories.length >= 2 && (
            <button
              onClick={() => setReordering('categories')}
              className="px-3 py-1.5 min-h-[44px] text-xs font-medium rounded-full border border-dashed border-gray-300 text-gray-500 hover:border-gray-400 hover:text-gray-700 transition-colors"
            >
              ⇅ カテゴリ並び替え
            </button>
          )}
        </div>
      )}

      {/* Template reorder のヒント + タッチ端末向けモーダルボタン */}
      {!loading && templates.length >= 2 && (
        <div className="mb-3 flex items-center justify-between gap-2 flex-wrap">
          <p className="text-xs text-gray-400">
            行の左端 <span className="align-middle">⣿</span> をドラッグして並び替えできます（同じカテゴリ内）
          </p>
          {selectedCategory !== 'all' && (
            <button
              onClick={() => setReordering('templates')}
              className="px-3 py-1.5 min-h-[44px] text-xs font-medium rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
            >
              ⇅ 一覧で並び替え
            </button>
          )}
        </div>
      )}

      {/* Create form */}
      {showCreate && (
        <div className="mb-6 bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-sm font-semibold text-gray-800 mb-4">新規テンプレートを作成</h2>
          <div className={`grid gap-6 ${form.messageType === 'flex' ? 'lg:grid-cols-[1fr_auto]' : 'max-w-lg'}`}>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">テンプレート名 <span className="text-red-500">*</span></label>
                <input
                  type="text"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  placeholder="例: ウェルカムメッセージ"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">カテゴリ <span className="text-red-500">*</span></label>
                <input
                  type="text"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  placeholder="例: 挨拶、キャンペーン、通知"
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">メッセージタイプ</label>
                <select
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
                  value={form.messageType}
                  onChange={(e) => setForm({ ...form, messageType: e.target.value })}
                >
                  <option value="text">テキスト</option>
                  <option value="image">画像</option>
                  <option value="flex">Flex</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">メッセージ内容 <span className="text-red-500">*</span></label>
                <textarea
                  className={`w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-y ${form.messageType === 'flex' ? 'font-mono' : ''}`}
                  rows={form.messageType === 'flex' ? 12 : 4}
                  placeholder={
                    form.messageType === 'flex'
                      ? '{ "type": "bubble", "body": { ... } }'
                      : 'メッセージ内容を入力してください'
                  }
                  value={form.messageContent}
                  onChange={(e) => setForm({ ...form, messageContent: e.target.value })}
                />
              </div>

              {formError && <p className="text-xs text-red-600">{formError}</p>}

              <div className="flex gap-2">
                <button
                  onClick={handleCreate}
                  disabled={saving}
                  className="px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity"
                  style={{ backgroundColor: '#0f172a' }}
                >
                  {saving ? '作成中...' : '作成'}
                </button>
                <button
                  onClick={() => { setShowCreate(false); setFormError('') }}
                  className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
                >
                  キャンセル
                </button>
              </div>
            </div>

            {form.messageType === 'flex' && (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">プレビュー</label>
                <FlexPreviewPane json={form.messageContent} maxWidth={480} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Loading skeleton */}
      {loading ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="px-4 py-4 border-b border-gray-100 flex items-center gap-4 animate-pulse">
              <div className="flex-1 space-y-2">
                <div className="h-3 bg-gray-200 rounded w-48" />
                <div className="h-2 bg-gray-100 rounded w-32" />
              </div>
              <div className="h-5 bg-gray-100 rounded-full w-16" />
              <div className="h-3 bg-gray-100 rounded w-24" />
            </div>
          ))}
        </div>
      ) : templates.length === 0 && !showCreate ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
          <p className="text-gray-500">テンプレートがありません。「新規テンプレート」から作成してください。</p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="w-8 px-2 py-3" />
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  テンプレート名
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  カテゴリ
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  メッセージタイプ
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  作成日時
                </th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {templates.map((template) => (
                <tr
                  key={template.id}
                  draggable={canDragRows}
                  onDragStart={(e) => onRowDragStart(e, template)}
                  onDragOver={(e) => onRowDragOver(e, template)}
                  onDrop={(e) => e.preventDefault()}
                  onDragEnd={onRowDragEnd}
                  className={`transition-colors ${
                    draggingId === template.id ? 'opacity-40 bg-gray-50' : 'hover:bg-gray-50'
                  }`}
                >
                  {/* Drag handle */}
                  <td className="w-8 px-2 py-3">
                    <span
                      className={`flex items-center justify-center text-gray-300 ${canDragRows ? 'cursor-grab hover:text-gray-500' : 'cursor-not-allowed'}`}
                      title={canDragRows ? '同じカテゴリ内でドラッグして並び替え' : undefined}
                      aria-hidden="true"
                    >
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M7 4a1 1 0 110-2 1 1 0 010 2zM7 8a1 1 0 110-2 1 1 0 010 2zM7 12a1 1 0 110-2 1 1 0 010 2zM7 16a1 1 0 110-2 1 1 0 010 2zM13 4a1 1 0 110-2 1 1 0 010 2zM13 8a1 1 0 110-2 1 1 0 010 2zM13 12a1 1 0 110-2 1 1 0 010 2zM13 16a1 1 0 110-2 1 1 0 010 2z" />
                      </svg>
                    </span>
                  </td>

                  {/* Name */}
                  <td className="px-4 py-3">
                    <div>
                      <p className="text-sm font-medium text-gray-900">{template.name}</p>
                      <p className="text-xs text-gray-400 mt-0.5 truncate max-w-xs">
                        {template.messageContent.slice(0, 50)}
                        {template.messageContent.length > 50 ? '...' : ''}
                      </p>
                    </div>
                  </td>

                  {/* Category */}
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
                      {template.category}
                    </span>
                  </td>

                  {/* Message Type */}
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {messageTypeLabels[template.messageType] || template.messageType}
                  </td>

                  {/* Created At */}
                  <td className="px-4 py-3 text-sm text-gray-500">
                    {formatDate(template.createdAt)}
                  </td>

                  {/* Actions */}
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button
                      onClick={() => setEditing(template)}
                      className="mr-2 px-3 py-1 text-xs font-medium text-white rounded-md transition-opacity hover:opacity-90"
                      style={{ backgroundColor: '#0f172a' }}
                    >
                      編集
                    </button>
                    <button
                      onClick={() => handleDelete(template.id)}
                      className="px-3 py-1 text-xs font-medium text-red-500 hover:text-red-700 bg-red-50 hover:bg-red-100 rounded-md transition-colors"
                    >
                      削除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      <TemplateEditModal
        isOpen={editing !== null}
        template={editing}
        onClose={() => setEditing(null)}
        onSaved={() => { load(); loadCategories() }}
      />

      {/* カテゴリ並び替え（失敗時は throw してモーダル内にエラー表示。並びは保持される） */}
      <ReorderModal
        isOpen={reordering === 'categories'}
        title="カテゴリの並び替え"
        items={categories.map((c) => ({ key: c.name, label: c.name }))}
        onClose={() => setReordering(null)}
        onSave={async (names) => {
          const res = await api.templateCategories.reorder(names)
          if (!res.success) throw new Error(res.error)
          setCategories(res.data)
          setReordering(null)
          load()
        }}
      />

      {/* カテゴリ内テンプレ並び替え */}
      <ReorderModal
        isOpen={reordering === 'templates'}
        title={`「${selectedCategory}」内の並び替え`}
        items={templates.map((t) => ({
          key: t.id,
          label: t.name,
          sub: t.messageContent.slice(0, 40),
        }))}
        onClose={() => setReordering(null)}
        onSave={async (ids) => {
          const res = await api.templates.reorder(ids)
          if (!res.success) throw new Error(res.error)
          setReordering(null)
          load()
        }}
      />
    </div>
  )
}
