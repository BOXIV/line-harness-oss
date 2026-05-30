'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { RichMenu, RichMenuAction } from '@line-crm/shared'

interface Props {
  menu: Pick<RichMenu, 'size' | 'areas' | 'name'>
  /** PNG 画像 URL（明示的に渡したい場合）。未指定 + richMenuId 指定なら自動取得 */
  imageUrl?: string | null
  /** richMenuId を渡すと LINE から画像本体を取得し blob URL として背景に表示する (BOXIV) */
  richMenuId?: string
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

export default function RichMenuPreview({ menu, imageUrl, richMenuId, maxWidth = 480, className }: Props) {
  const { width, height } = menu.size
  const [fetchedUrl, setFetchedUrl] = useState<string | null>(null)

  // imageUrl 未指定かつ richMenuId 指定時は、Worker プロキシ経由で LINE から画像を取得。
  // Bearer 認証が要るため blob URL に変換して背景に表示し、unmount 時に revoke する。
  useEffect(() => {
    if (imageUrl || !richMenuId) return
    let cancelled = false
    let createdUrl: string | null = null
    ;(async () => {
      try {
        const blob = await api.richMenus.fetchImage(richMenuId)
        if (cancelled || !blob) return
        createdUrl = URL.createObjectURL(blob)
        setFetchedUrl(createdUrl)
      } catch {
        // 取得失敗時はプレースホルダにフォールバック
      }
    })()
    return () => {
      cancelled = true
      if (createdUrl) URL.revokeObjectURL(createdUrl)
    }
  }, [imageUrl, richMenuId])

  const resolvedImageUrl = imageUrl ?? fetchedUrl

  return (
    <div
      className={className ?? 'inline-block bg-gray-50 rounded-lg border border-gray-200 overflow-hidden'}
      style={{ maxWidth, width: '100%' }}
    >
      <div className="relative" style={{ aspectRatio: `${width} / ${height}` }}>
        {resolvedImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={resolvedImageUrl}
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
