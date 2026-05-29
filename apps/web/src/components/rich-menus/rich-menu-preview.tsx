'use client'

import type { RichMenu, RichMenuAction } from '@/lib/rich-menu-types'

interface Props {
  menu: Pick<RichMenu, 'size' | 'areas' | 'name'>
  /** PNG 画像 URL（任意。PR1 時点では取得 API が無いので未指定で areas のみ描画） */
  imageUrl?: string | null
  /** プレビューの最大幅 (px)。SVG は aspect-ratio で縦も追随 */
  maxWidth?: number
  className?: string
}

function actionSummary(action: RichMenuAction): string {
  switch (action.type) {
    case 'postback':
      return action.label ? `📩 ${action.label}` : `📩 postback`
    case 'message':
      return action.label ? `💬 ${action.label}` : `💬 ${action.text.slice(0, 16)}`
    case 'uri':
      return action.label ? `🔗 ${action.label}` : `🔗 ${action.uri.slice(0, 24)}`
    case 'datetimepicker':
      return action.label ? `📅 ${action.label}` : `📅 datetimepicker`
    case 'richmenuswitch':
      return action.label ? `🔀 ${action.label}` : `🔀 switch`
  }
}

export default function RichMenuPreview({ menu, imageUrl, maxWidth = 480, className }: Props) {
  const { width, height } = menu.size

  return (
    <div
      className={className ?? 'inline-block bg-gray-50 rounded-lg border border-gray-200 overflow-hidden'}
      style={{ maxWidth, width: '100%' }}
    >
      <div className="relative" style={{ aspectRatio: `${width} / ${height}` }}>
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt={menu.name}
            className="absolute inset-0 w-full h-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 w-full h-full bg-gradient-to-br from-gray-100 to-gray-200" />
        )}
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="absolute inset-0 w-full h-full"
        >
          {menu.areas.map((area, i) => (
            <g key={i}>
              <rect
                x={area.bounds.x}
                y={area.bounds.y}
                width={area.bounds.width}
                height={area.bounds.height}
                fill="rgba(15, 23, 42, 0.08)"
                stroke="rgba(15, 23, 42, 0.6)"
                strokeWidth={Math.max(width, height) / 400}
              />
              <text
                x={area.bounds.x + area.bounds.width / 2}
                y={area.bounds.y + area.bounds.height / 2}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="rgba(15, 23, 42, 0.85)"
                fontSize={Math.max(width, height) / 36}
                fontFamily="system-ui, -apple-system, sans-serif"
              >
                {actionSummary(area.action)}
              </text>
            </g>
          ))}
        </svg>
      </div>
    </div>
  )
}
