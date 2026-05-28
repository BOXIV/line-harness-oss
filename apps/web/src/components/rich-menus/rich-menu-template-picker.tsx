'use client'

import { RICH_MENU_PRESETS } from '@/lib/rich-menu-presets'
import type { RichMenuPreset } from '@/lib/rich-menu-presets'

interface Props {
  onSelect: (preset: RichMenuPreset) => void
  disabled?: boolean
}

const audienceColor: Record<RichMenuPreset['audience'], string> = {
  seller: 'bg-amber-100 text-amber-700',
  buyer: 'bg-sky-100 text-sky-700',
  generic: 'bg-gray-100 text-gray-700',
}

const audienceLabel: Record<RichMenuPreset['audience'], string> = {
  seller: '出品者',
  buyer: '購入者',
  generic: '汎用',
}

export default function RichMenuTemplatePicker({ onSelect, disabled }: Props) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {RICH_MENU_PRESETS.map((preset) => (
        <button
          key={preset.id}
          type="button"
          disabled={disabled}
          onClick={() => onSelect(preset)}
          className="text-left rounded-lg border border-gray-200 hover:border-gray-300 bg-white p-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <div className="flex items-start justify-between gap-2 mb-2">
            <div className="text-sm font-medium text-gray-900">{preset.label}</div>
            <span className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${audienceColor[preset.audience]}`}>
              {audienceLabel[preset.audience]}
            </span>
          </div>
          <div className="text-xs text-gray-500 mb-2 line-clamp-2">{preset.description}</div>
          <svg
            viewBox={`0 0 ${preset.size.width} ${preset.size.height}`}
            className="w-full bg-gray-100 rounded"
            preserveAspectRatio="none"
            style={{ aspectRatio: `${preset.size.width} / ${preset.size.height}` }}
          >
            {preset.areas.map((area, i) => (
              <rect
                key={i}
                x={area.bounds.x}
                y={area.bounds.y}
                width={area.bounds.width}
                height={area.bounds.height}
                fill="rgba(15,23,42,0.12)"
                stroke="rgba(15,23,42,0.6)"
                strokeWidth={Math.max(preset.size.width, preset.size.height) / 400}
              />
            ))}
          </svg>
        </button>
      ))}
    </div>
  )
}
