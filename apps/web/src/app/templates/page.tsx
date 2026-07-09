'use client'

import { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react'
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

  // ── 行のインライン並び替え（ポインタ操作 + FLIP アニメーション）──────────
  // 以前は HTML5 の draggable を使っていたが、ドラッグ中に行を DOM 上で並べ替えると
  // Chrome がドラッグを中断し「掴めるが並びが変わらない」状態になった。ポインタ
  // イベントで自前に処理する（タッチ端末でも動く）。順序が変わった行は FLIP で
  // スライド表示して入れ替わりが分かるようにする。
  // sort_order はカテゴリ内スコープ＝入替えは「同じカテゴリ内」のみ。「全て」表示で
  // カテゴリを跨いだ移動は無視する。確定時に該当カテゴリの id 順を保存し、失敗時のみ
  // load() でサーバ順に戻す。
  const templatesRef = useRef<Template[]>([])
  useEffect(() => { templatesRef.current = templates }, [templates])

  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map())
  const rowTops = useRef<Map<string, number>>(new Map()) // 直前レンダーの各行の縦位置（FLIP 用）
  const animateNext = useRef(false)                       // 並び替え起因のレンダーだけアニメする

  const dragId = useRef<string | null>(null)
  const dragCat = useRef<string | null>(null)
  // ドラッグ開始時の同カテゴリ各行の固定スロット（縦位置）。ドラッグ中は行が入れ替わっても
  // スロット（位置の集合）は不変なので、これを基準に「ポインタが何番目のスロットにいるか」を
  // 決める。FLIP アニメ中の getBoundingClientRect はアニメ位置を返して当てにならないため、
  // ライブの rect で判定すると入替えを取りこぼす（＝「半分くらい動かせない」の原因）。
  const dragSlots = useRef<{ mid: number }[]>([])
  const startIds = useRef<string[]>([]) // 変化が無ければ保存しない用のスナップショット
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [reorderSaving, setReorderSaving] = useState(false)

  const catIds = (list: Template[], cat: string) =>
    list.filter((t) => t.category === cat).map((t) => t.id)

  // FLIP: 前回レンダーからの縦位置差ぶんだけ旧位置→新位置へスライドさせる。
  // Web Animations API を使うのは、アニメ後にインライン style が残らない＝タブ非表示で
  // rAF が止まっても要素が変な位置に固定されないため（fill 既定 = none）。
  useLayoutEffect(() => {
    // 並び替え起因のレンダーでは、計測前に前回のスライドを終端まで進めて実レイアウトを読む
    // （アニメ途中の rect を基準にすると次のスライドがガタつく）。
    if (animateNext.current) {
      rowRefs.current.forEach((el) => el.getAnimations?.().forEach((a) => a.finish()))
    }
    const nextTops = new Map<string, number>()
    rowRefs.current.forEach((el, id) => nextTops.set(id, el.getBoundingClientRect().top))
    if (animateNext.current) {
      nextTops.forEach((top, id) => {
        const prev = rowTops.current.get(id)
        const el = rowRefs.current.get(id)
        if (prev != null && el && Math.abs(prev - top) > 0.5 && typeof el.animate === 'function') {
          el.animate(
            [{ transform: `translateY(${prev - top}px)` }, { transform: 'translateY(0)' }],
            { duration: 200, easing: 'ease' },
          )
        }
      })
      animateNext.current = false
    }
    rowTops.current = nextTops
  })

  const canDragRows = !loading && !reorderSaving && templates.length >= 2

  const startRowDrag = (e: React.PointerEvent, t: Template) => {
    if (!canDragRows || e.button !== 0) return
    e.preventDefault()
    dragId.current = t.id
    dragCat.current = t.category
    startIds.current = catIds(templatesRef.current, t.category)
    setDraggingId(t.id)
    document.body.style.userSelect = 'none'

    // 同カテゴリ行の固定スロットをスナップショット（残アニメを終端させてから計測）。
    dragSlots.current = templatesRef.current
      .filter((x) => x.category === t.category)
      .map((x) => rowRefs.current.get(x.id))
      .filter((el): el is HTMLTableRowElement => !!el)
      .map((el) => {
        el.getAnimations?.().forEach((a) => a.finish())
        const r = el.getBoundingClientRect()
        return { top: r.top, mid: r.top + r.height / 2 }
      })
      .sort((a, b) => a.top - b.top)
      .map(({ mid }) => ({ mid }))

    const onMove = (ev: PointerEvent) => {
      const did = dragId.current
      const cat = dragCat.current
      const slots = dragSlots.current
      if (!did || !cat || slots.length === 0) return
      // ポインタが何番目のスロット（＝カテゴリ内の何番目の位置）にいるか。固定値なので安定。
      let to = slots.findIndex((s) => ev.clientY < s.mid)
      if (to === -1) to = slots.length - 1
      const catItems = templatesRef.current.filter((x) => x.category === cat)
      const from = catItems.findIndex((x) => x.id === did)
      const target = Math.max(0, Math.min(to, catItems.length - 1))
      if (from < 0 || from === target) return // 位置が変わらないなら何もしない
      animateNext.current = true
      setTemplates((prev) => {
        const items = prev.filter((x) => x.category === cat)
        const f = items.findIndex((x) => x.id === did)
        const tg = Math.max(0, Math.min(to, items.length - 1))
        if (f < 0 || f === tg) return prev
        const reordered = [...items]
        const [moved] = reordered.splice(f, 1)
        reordered.splice(tg, 0, moved)
        let k = 0
        return prev.map((x) => (x.category === cat ? reordered[k++] : x)) // 該当カテゴリ位置だけ差し替え
      })
    }

    const onUp = async () => {
      document.removeEventListener('pointermove', onMove)
      document.body.style.userSelect = ''
      const cat = dragCat.current
      dragId.current = null
      dragCat.current = null
      dragSlots.current = []
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

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp, { once: true })
  }

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
                  ref={(el) => {
                    if (el) rowRefs.current.set(template.id, el)
                    else rowRefs.current.delete(template.id)
                  }}
                  className={`${
                    draggingId === template.id
                      ? 'bg-blue-50 shadow-sm relative z-10'
                      : 'hover:bg-gray-50 transition-colors'
                  }`}
                >
                  {/* Drag handle */}
                  <td className="w-8 px-2 py-3">
                    <span
                      onPointerDown={(e) => startRowDrag(e, template)}
                      style={{ touchAction: 'none' }}
                      className={`flex items-center justify-center ${
                        canDragRows
                          ? 'cursor-grab active:cursor-grabbing text-gray-300 hover:text-gray-500'
                          : 'cursor-not-allowed text-gray-200'
                      }`}
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
