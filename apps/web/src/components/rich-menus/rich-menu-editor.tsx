'use client'

// リッチメニュー編集オーケストレータ.
//
// メタ情報フォーム / サイズ選択 / テンプレート挿入 / 画像アップロード /
// キャンバス / エリア タブ / アクション編集パネル / バリデーション結果 を
// 1 つに組み合わせる. リッチメニュー本体の persistence は親側 (/rich-menus/new
// or /rich-menus/detail) が責任を持つ — このエディタは controlled component.

import { useMemo, useState } from 'react'
import type { RichMenuArea, RichMenuSize } from '@line-crm/shared'
import type { RichMenuPreset } from '@/lib/rich-menu-presets'
import { buildHighlightSet, type RichMenuDraft, type ValidationResult } from '@/lib/rich-menu-validate'
import RichMenuCanvas from './rich-menu-canvas'
import RichMenuAreaForm from './rich-menu-area-form'
import RichMenuSizePicker from './rich-menu-size-picker'
import RichMenuTemplatePicker from './rich-menu-template-picker'

interface Props {
  value: RichMenuDraft
  onChange: (next: RichMenuDraft) => void
  imageUrl: string | null
  /** PNG/JPEG を受け取り、データURL を imageUrl に反映する責務は親 */
  onImageSelected: (file: File) => void
  validation: ValidationResult
  disabled?: boolean
}

export default function RichMenuEditor({ value, onChange, imageUrl, onImageSelected, validation, disabled }: Props) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [snapDivisions, setSnapDivisions] = useState<0 | 2 | 3 | 6>(0)

  const highlightSet = useMemo(() => buildHighlightSet(validation.areas), [validation.areas])

  const issuesByArea = useMemo(() => {
    const m = new Map<number, string[]>()
    validation.areas.forEach((issue) => {
      const arr = m.get(issue.index) ?? []
      arr.push(issue.message)
      m.set(issue.index, arr)
    })
    return m
  }, [validation.areas])

  const setAreas = (areas: RichMenuArea[]) => onChange({ ...value, areas })

  const setSize = (size: RichMenuSize) => {
    if (value.areas.length > 0) {
      if (!confirm('サイズを変更するとエリアがリセットされます。続行しますか？')) return
    }
    onChange({ ...value, size, areas: [] })
    setSelectedIndex(null)
  }

  const applyPreset = (preset: RichMenuPreset) => {
    if (value.areas.length > 0 || value.name.trim()) {
      if (!confirm('テンプレートを適用するとエリアとメタ情報が上書きされます。続行しますか？')) return
    }
    onChange({
      ...value,
      size: preset.size,
      areas: preset.areas,
      name: value.name.trim() ? value.name : preset.defaultName,
      chatBarText: value.chatBarText.trim() ? value.chatBarText : preset.defaultChatBarText,
    })
    setSelectedIndex(null)
  }

  const updateArea = (index: number, next: RichMenuArea) => {
    const arr = value.areas.slice()
    arr[index] = next
    setAreas(arr)
  }

  const deleteArea = (index: number) => {
    const arr = value.areas.filter((_, i) => i !== index)
    setAreas(arr)
    setSelectedIndex(null)
  }

  return (
    <div className="space-y-6">
      {/* メタ情報 */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-800">基本情報</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              管理名 <span className="text-red-500">*</span>
              <span className="text-gray-400 ml-1">(LINE 管理画面で表示)</span>
            </label>
            <input
              type="text"
              value={value.name}
              maxLength={300}
              onChange={(e) => onChange({ ...value, name: e.target.value })}
              disabled={disabled}
              placeholder="例: BOXIV 出品者向け メニュー v2"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              チャットバーテキスト <span className="text-red-500">*</span>
              <span className="text-gray-400 ml-1">(14 文字以下)</span>
            </label>
            <input
              type="text"
              value={value.chatBarText}
              maxLength={14}
              onChange={(e) => onChange({ ...value, chatBarText: e.target.value })}
              disabled={disabled}
              placeholder="メニュー"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
        </div>
        <label className="inline-flex items-center gap-2 text-xs text-gray-600">
          <input
            type="checkbox"
            checked={value.selected}
            onChange={(e) => onChange({ ...value, selected: e.target.checked })}
            disabled={disabled}
            className="rounded"
          />
          チャットを開いたときメニューを展開した状態で表示する (LINE の selected)
          <span className="text-gray-400">— 既定メニューにするかどうかとは別です</span>
        </label>
      </div>

      {/* サイズ */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <h2 className="text-sm font-semibold text-gray-800 mb-3">サイズ</h2>
        <RichMenuSizePicker value={value.size} onChange={setSize} disabled={disabled} />
      </div>

      {/* テンプレート */}
      <details className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <summary className="text-sm font-semibold text-gray-800 cursor-pointer">テンプレートから挿入</summary>
        <p className="text-xs text-gray-500 mt-2 mb-3">出品者向け / 購入者向けの推奨レイアウトを開始点として使えます。</p>
        <RichMenuTemplatePicker onSelect={applyPreset} disabled={disabled} />
      </details>

      {/* 画像 + Canvas */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="text-sm font-semibold text-gray-800">画像 & エリア</h2>
          <div className="flex items-center gap-3 text-xs">
            <span className="text-gray-500">スナップ:</span>
            {([0, 2, 3, 6] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setSnapDivisions(d)}
                className={`px-2 py-1 rounded ${snapDivisions === d ? 'bg-slate-900 text-white' : 'text-gray-600 hover:bg-gray-100'}`}
              >
                {d === 0 ? 'なし' : `${d}分割`}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            画像 (PNG / JPEG, {value.size.width} × {value.size.height} 推奨, 1MB 以下)
          </label>
          <input
            type="file"
            accept="image/png,image/jpeg"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) onImageSelected(f)
              e.target.value = ''
            }}
            disabled={disabled}
            className="text-xs"
          />
        </div>

        <p className="text-[11px] text-gray-500">
          空き領域をドラッグして矩形を作成 / 矩形クリックで選択 / ハンドルでリサイズ / 内側ドラッグで移動 / Delete キーで削除
        </p>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_160px_320px] gap-4">
          <RichMenuCanvas
            size={value.size}
            imageUrl={imageUrl}
            areas={value.areas}
            selectedIndex={selectedIndex}
            highlightIndices={highlightSet}
            snapDivisions={snapDivisions}
            onChange={setAreas}
            onSelect={setSelectedIndex}
          />

          {/* 縦タブ: エリア選択 */}
          <div className="lg:max-h-[600px] lg:overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-1.5 space-y-1">
            <div className="px-2 py-1 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
              エリア ({value.areas.length})
            </div>
            {value.areas.length === 0 ? (
              <p className="px-2 py-3 text-[11px] text-gray-400 leading-relaxed">
                Canvas を空き領域からドラッグするか、テンプレートを適用してください。
              </p>
            ) : (
              value.areas.map((area, i) => {
                const err = highlightSet.has(i)
                const active = i === selectedIndex
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setSelectedIndex(i)}
                    aria-selected={active}
                    className={`w-full text-left px-2.5 py-2 rounded text-xs transition-colors border ${
                      active
                        ? 'bg-slate-900 text-white border-slate-900'
                        : err
                        ? 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100'
                        : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-100'
                    }`}
                  >
                    <div className="font-medium flex items-center gap-1">
                      <span>エリア {i + 1}</span>
                      {err && (
                        <span aria-label="エラー" title="エラーあり" className={active ? 'text-red-300' : 'text-red-500'}>
                          ⚠
                        </span>
                      )}
                    </div>
                    <div className={`opacity-75 truncate mt-0.5 ${active ? 'text-gray-200' : ''}`}>
                      {area.action.label || area.action.type}
                    </div>
                  </button>
                )
              })
            )}
          </div>

          {/* 詳細: 選択中エリアのフォーム */}
          <div className="lg:max-h-[600px] lg:overflow-y-auto">
            {selectedIndex == null ? (
              <div className="bg-gray-50 rounded-lg border border-dashed border-gray-300 p-4 text-xs text-gray-500">
                左のタブからエリアを選択すると、ここでアクションを編集できます。
                {value.areas.length === 0 && (
                  <div className="mt-3 text-gray-400">
                    まずはエリアを 1 つ作成してください。
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-white rounded-lg border border-gray-200 p-4">
                <RichMenuAreaForm
                  index={selectedIndex}
                  area={value.areas[selectedIndex]}
                  issues={issuesByArea.get(selectedIndex) ?? []}
                  onChange={(next) => updateArea(selectedIndex, next)}
                  onDelete={() => deleteArea(selectedIndex)}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* バリデーション結果 */}
      {validation.general.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-xs font-semibold text-red-700 mb-1">入力エラー</p>
          <ul className="text-xs text-red-700 space-y-0.5">
            {validation.general.map((msg, i) => <li key={i}>• {msg}</li>)}
          </ul>
        </div>
      )}
    </div>
  )
}
