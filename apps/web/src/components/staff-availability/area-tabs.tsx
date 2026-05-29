'use client'

import { AREA_IDS, AREA_LABELS, AREA_PREFECTURES, shortPrefecture, type AreaId } from '@/lib/area-meta'

interface Props {
  value: AreaId | 'all' | string
  onChange: (value: AreaId | 'all') => void
  /** 「すべてのエリア」タブを先頭に表示するか (リスト絞り込み用途) */
  includeAll?: boolean
  className?: string
}

export default function AreaTabs({ value, onChange, includeAll = false, className }: Props) {
  const ids: Array<'all' | AreaId> = includeAll ? ['all', ...AREA_IDS] : AREA_IDS

  return (
    <div className={`flex flex-wrap gap-1.5 ${className ?? ''}`} role="tablist" aria-label="エリア">
      {ids.map((id) => {
        const active = value === id
        const label = id === 'all' ? 'すべてのエリア' : AREA_LABELS[id]
        const prefs = id === 'all' ? null : AREA_PREFECTURES[id]
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
              active
                ? 'bg-slate-900 text-white border-slate-900'
                : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50 hover:border-gray-300'
            }`}
          >
            <div className="flex items-center gap-2">
              <span>{label}</span>
              {prefs && prefs.length > 0 && (
                <span className={`text-[10px] ${active ? 'text-gray-300' : 'text-gray-400'}`}>
                  {prefs.map(shortPrefecture).join('・')}
                </span>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}
