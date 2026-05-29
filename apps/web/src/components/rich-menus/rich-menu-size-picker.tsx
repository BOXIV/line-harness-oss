'use client'

import { RICH_MENU_SIZES } from '@line-crm/shared'
import type { RichMenuSize } from '@line-crm/shared'

interface Props {
  value: RichMenuSize
  onChange: (size: RichMenuSize) => void
  disabled?: boolean
}

export default function RichMenuSizePicker({ value, onChange, disabled }: Props) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
      {RICH_MENU_SIZES.map((size) => {
        const active = value.width === size.width && value.height === size.height
        return (
          <button
            key={`${size.width}x${size.height}`}
            type="button"
            disabled={disabled}
            onClick={() => onChange({ width: size.width, height: size.height })}
            className={`relative px-3 py-3 text-left rounded-lg border-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              active ? 'border-slate-900 bg-slate-50' : 'border-gray-200 hover:border-gray-300 bg-white'
            }`}
          >
            <div className="text-xs font-medium text-gray-900">
              {size.width} × {size.height}
            </div>
            <div className="text-[10px] text-gray-500 mt-0.5">{size.label.replace(/^\d+ × \d+ /, '')}</div>
            <svg
              viewBox={`0 0 ${size.width} ${size.height}`}
              className="mt-2 w-full h-8 bg-gray-100 rounded"
              preserveAspectRatio="none"
            >
              <rect x={0} y={0} width={size.width} height={size.height} fill="rgba(15,23,42,0.1)" />
            </svg>
          </button>
        )
      })}
    </div>
  )
}
