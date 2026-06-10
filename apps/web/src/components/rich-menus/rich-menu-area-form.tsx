'use client'

import type { RichMenuArea, RichMenuAction } from '@line-crm/shared'
import { defaultActionFor } from '@/lib/rich-menu-validate'

interface Props {
  index: number
  area: RichMenuArea
  issues: string[]
  onChange: (next: RichMenuArea) => void
  onDelete: () => void
}

const ACTION_TYPES: Array<{ value: RichMenuAction['type']; label: string }> = [
  { value: 'postback', label: 'postback (Bot にデータ送信)' },
  { value: 'message', label: 'message (テキスト送信)' },
  { value: 'uri', label: 'uri (URL を開く)' },
  { value: 'datetimepicker', label: 'datetimepicker (日付選択)' },
  { value: 'richmenuswitch', label: 'richmenuswitch (メニュー切替)' },
]

function fieldClass(invalid: boolean) {
  return `w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 ${
    invalid ? 'border-red-300 bg-red-50' : 'border-gray-300'
  }`
}

export default function RichMenuAreaForm({ index, area, issues, onChange, onDelete }: Props) {
  const setAction = (action: RichMenuAction) => onChange({ ...area, action })

  const setType = (type: RichMenuAction['type']) => {
    setAction(defaultActionFor(type) as RichMenuAction)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-800">エリア {index + 1}</h3>
        <button
          type="button"
          onClick={onDelete}
          className="px-2.5 py-1 text-xs font-medium text-red-500 hover:text-red-700 bg-red-50 hover:bg-red-100 rounded-md transition-colors"
        >
          このエリアを削除
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] text-gray-500">
        <div>x: <span className="font-mono">{area.bounds.x}</span></div>
        <div>y: <span className="font-mono">{area.bounds.y}</span></div>
        <div>w: <span className="font-mono">{area.bounds.width}</span></div>
        <div>h: <span className="font-mono">{area.bounds.height}</span></div>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">アクションタイプ</label>
        <select
          value={area.action.type}
          onChange={(e) => setType(e.target.value as RichMenuAction['type'])}
          className={fieldClass(false) + ' bg-white'}
        >
          {ACTION_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">label (任意・20 文字以下)</label>
        <input
          type="text"
          value={area.action.label ?? ''}
          onChange={(e) => setAction({ ...area.action, label: e.target.value || undefined })}
          maxLength={20}
          placeholder="例: 出品手順"
          className={fieldClass(false)}
        />
      </div>

      {area.action.type === 'postback' && (
        <>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">data <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={area.action.data}
              onChange={(e) => setAction({ ...area.action, type: 'postback', data: e.target.value })}
              placeholder="例: action=show_listing&id=123"
              className={fieldClass(!area.action.data)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">displayText (任意・トーク欄に表示)</label>
            <input
              type="text"
              value={area.action.displayText ?? ''}
              onChange={(e) => setAction({ ...area.action, type: 'postback', data: area.action.type === 'postback' ? area.action.data : '', displayText: e.target.value || undefined })}
              placeholder="例: 出品手順を表示"
              className={fieldClass(false)}
            />
          </div>
        </>
      )}

      {area.action.type === 'message' && (
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">text <span className="text-red-500">*</span></label>
          <textarea
            value={area.action.text}
            onChange={(e) => setAction({ type: 'message', text: e.target.value, label: area.action.label })}
            rows={2}
            placeholder="ユーザーが送信するテキスト"
            className={fieldClass(!area.action.text)}
          />
        </div>
      )}

      {area.action.type === 'uri' && (
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">uri <span className="text-red-500">*</span></label>
          <input
            type="url"
            value={area.action.uri}
            onChange={(e) => setAction({ type: 'uri', uri: e.target.value, label: area.action.label })}
            placeholder="https://lightning.boxiv.co.jp/..."
            className={fieldClass(!area.action.uri)}
          />
        </div>
      )}

      {area.action.type === 'datetimepicker' && (
        <>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">data <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={area.action.data}
              onChange={(e) => setAction({ type: 'datetimepicker', data: e.target.value, mode: area.action.type === 'datetimepicker' ? area.action.mode : 'date', label: area.action.label })}
              placeholder="例: pickup_date"
              className={fieldClass(!area.action.data)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">mode</label>
            <select
              value={area.action.mode}
              onChange={(e) => setAction({ type: 'datetimepicker', data: area.action.type === 'datetimepicker' ? area.action.data : '', mode: e.target.value as 'date' | 'time' | 'datetime', label: area.action.label })}
              className={fieldClass(false) + ' bg-white'}
            >
              <option value="date">date</option>
              <option value="time">time</option>
              <option value="datetime">datetime</option>
            </select>
          </div>
        </>
      )}

      {area.action.type === 'richmenuswitch' && (
        <>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">richMenuAliasId <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={area.action.richMenuAliasId}
              onChange={(e) => setAction({ type: 'richmenuswitch', richMenuAliasId: e.target.value, data: area.action.type === 'richmenuswitch' ? area.action.data : '', label: area.action.label })}
              placeholder="例: buyer_menu_alias"
              className={fieldClass(!area.action.richMenuAliasId)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">data</label>
            <input
              type="text"
              value={area.action.data}
              onChange={(e) => setAction({ type: 'richmenuswitch', richMenuAliasId: area.action.type === 'richmenuswitch' ? area.action.richMenuAliasId : '', data: e.target.value, label: area.action.label })}
              className={fieldClass(false)}
            />
          </div>
        </>
      )}

      {issues.length > 0 && (
        <ul className="text-xs text-red-600 space-y-0.5 pt-1 border-t border-red-100">
          {issues.map((msg, i) => <li key={i}>• {msg}</li>)}
        </ul>
      )}
    </div>
  )
}
