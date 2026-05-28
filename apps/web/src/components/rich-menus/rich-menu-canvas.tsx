'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { RichMenuArea, RichMenuBounds, RichMenuSize } from '@/lib/rich-menu-types'
import { clampBoundsToSize, normalizeBounds } from '@/lib/rich-menu-validate'

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

type Drag =
  | { kind: 'create'; startX: number; startY: number; currentX: number; currentY: number }
  | { kind: 'move'; index: number; startBounds: RichMenuBounds; startX: number; startY: number }
  | { kind: 'resize'; index: number; handle: Handle; startBounds: RichMenuBounds; startX: number; startY: number }

interface Props {
  size: RichMenuSize
  imageUrl: string | null
  areas: RichMenuArea[]
  selectedIndex: number | null
  highlightIndices?: Set<number>
  /** グリッドスナップ (None / 6 / 3 / 2) */
  snapDivisions: 0 | 2 | 3 | 6
  onChange: (areas: RichMenuArea[]) => void
  onSelect: (index: number | null) => void
}

const HANDLE_KINDS: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

function handlePosition(b: RichMenuBounds, h: Handle): { x: number; y: number } {
  const cx = b.x + b.width / 2
  const cy = b.y + b.height / 2
  switch (h) {
    case 'nw': return { x: b.x, y: b.y }
    case 'n': return { x: cx, y: b.y }
    case 'ne': return { x: b.x + b.width, y: b.y }
    case 'e': return { x: b.x + b.width, y: cy }
    case 'se': return { x: b.x + b.width, y: b.y + b.height }
    case 's': return { x: cx, y: b.y + b.height }
    case 'sw': return { x: b.x, y: b.y + b.height }
    case 'w': return { x: b.x, y: cy }
  }
}

function handleCursor(h: Handle): string {
  switch (h) {
    case 'nw': case 'se': return 'nwse-resize'
    case 'ne': case 'sw': return 'nesw-resize'
    case 'n': case 's': return 'ns-resize'
    case 'e': case 'w': return 'ew-resize'
  }
}

export default function RichMenuCanvas({
  size,
  imageUrl,
  areas,
  selectedIndex,
  highlightIndices,
  snapDivisions,
  onChange,
  onSelect,
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)

  const snap = useCallback(
    (val: number, axis: 'x' | 'y'): number => {
      if (!snapDivisions) return val
      const range = axis === 'x' ? size.width : size.height
      const step = range / snapDivisions
      return Math.round(val / step) * step
    },
    [snapDivisions, size.width, size.height],
  )

  const toImageCoords = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const svg = svgRef.current
      if (!svg) return null
      const rect = svg.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return null
      const x = ((clientX - rect.left) / rect.width) * size.width
      const y = ((clientY - rect.top) / rect.height) * size.height
      return { x, y }
    },
    [size.width, size.height],
  )

  const startCreate = (e: ReactPointerEvent<SVGSVGElement>) => {
    if ((e.target as Element).getAttribute('data-area-index') != null) return
    if ((e.target as Element).getAttribute('data-handle') != null) return
    const p = toImageCoords(e.clientX, e.clientY)
    if (!p) return
    onSelect(null)
    setDrag({ kind: 'create', startX: snap(p.x, 'x'), startY: snap(p.y, 'y'), currentX: p.x, currentY: p.y })
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const startMove = (e: ReactPointerEvent, index: number) => {
    e.stopPropagation()
    const p = toImageCoords(e.clientX, e.clientY)
    if (!p) return
    onSelect(index)
    setDrag({ kind: 'move', index, startBounds: { ...areas[index].bounds }, startX: p.x, startY: p.y })
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }

  const startResize = (e: ReactPointerEvent, index: number, handle: Handle) => {
    e.stopPropagation()
    const p = toImageCoords(e.clientX, e.clientY)
    if (!p) return
    onSelect(index)
    setDrag({ kind: 'resize', index, handle, startBounds: { ...areas[index].bounds }, startX: p.x, startY: p.y })
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }

  const handlePointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag) return
    const p = toImageCoords(e.clientX, e.clientY)
    if (!p) return

    if (drag.kind === 'create') {
      setDrag({ ...drag, currentX: p.x, currentY: p.y })
    } else if (drag.kind === 'move') {
      const dx = p.x - drag.startX
      const dy = p.y - drag.startY
      const moved = clampBoundsToSize(
        { ...drag.startBounds, x: snap(drag.startBounds.x + dx, 'x'), y: snap(drag.startBounds.y + dy, 'y') },
        size,
      )
      const next = areas.slice()
      next[drag.index] = { ...next[drag.index], bounds: moved }
      onChange(next)
    } else if (drag.kind === 'resize') {
      const dx = p.x - drag.startX
      const dy = p.y - drag.startY
      const sb = drag.startBounds
      let x = sb.x
      let y = sb.y
      let w = sb.width
      let h = sb.height
      if (drag.handle.includes('w')) { x = snap(sb.x + dx, 'x'); w = snap(sb.x + sb.width, 'x') - x }
      if (drag.handle.includes('e')) { w = snap(sb.x + sb.width + dx, 'x') - x }
      if (drag.handle.includes('n')) { y = snap(sb.y + dy, 'y'); h = snap(sb.y + sb.height, 'y') - y }
      if (drag.handle.includes('s')) { h = snap(sb.y + sb.height + dy, 'y') - y }
      const resized = clampBoundsToSize(normalizeBounds({ x, y, width: w, height: h }), size)
      const next = areas.slice()
      next[drag.index] = { ...next[drag.index], bounds: resized }
      onChange(next)
    }
  }

  const handlePointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag) return
    if (drag.kind === 'create') {
      const w = Math.abs(drag.currentX - drag.startX)
      const h = Math.abs(drag.currentY - drag.startY)
      if (w >= 20 && h >= 20) {
        const bounds = clampBoundsToSize(
          normalizeBounds({
            x: drag.startX,
            y: drag.startY,
            width: snap(drag.currentX, 'x') - drag.startX,
            height: snap(drag.currentY, 'y') - drag.startY,
          }),
          size,
        )
        const next = [...areas, { bounds, action: { type: 'message' as const, text: '' } }]
        onChange(next)
        onSelect(next.length - 1)
      }
    }
    setDrag(null)
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
  }

  // Delete / Backspace で選択中エリアを削除
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (selectedIndex == null) return
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      e.preventDefault()
      const next = areas.filter((_, i) => i !== selectedIndex)
      onChange(next)
      onSelect(null)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [areas, selectedIndex, onChange, onSelect])

  const dragRect = useMemo(() => {
    if (!drag || drag.kind !== 'create') return null
    return normalizeBounds({
      x: drag.startX,
      y: drag.startY,
      width: drag.currentX - drag.startX,
      height: drag.currentY - drag.startY,
    })
  }, [drag])

  const strokeBase = Math.max(size.width, size.height) / 400
  const handleSize = Math.max(size.width, size.height) / 100

  return (
    <div
      className="relative bg-gray-50 rounded-lg overflow-hidden select-none"
      style={{ aspectRatio: `${size.width} / ${size.height}` }}
    >
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt="リッチメニュー画像"
          className="absolute inset-0 w-full h-full object-cover pointer-events-none"
          draggable={false}
        />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-gray-100 to-gray-200 flex items-center justify-center pointer-events-none">
          <p className="text-xs text-gray-500">画像をアップロードするとここに表示されます</p>
        </div>
      )}

      <svg
        ref={svgRef}
        viewBox={`0 0 ${size.width} ${size.height}`}
        preserveAspectRatio="none"
        className="absolute inset-0 w-full h-full cursor-crosshair touch-none"
        onPointerDown={startCreate}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {/* スナップグリッド (オプション) */}
        {snapDivisions > 0 && (
          <g>
            {Array.from({ length: snapDivisions - 1 }, (_, i) => (
              <line
                key={`vx-${i}`}
                x1={((i + 1) * size.width) / snapDivisions}
                y1={0}
                x2={((i + 1) * size.width) / snapDivisions}
                y2={size.height}
                stroke="rgba(15,23,42,0.15)"
                strokeWidth={strokeBase / 2}
                strokeDasharray={`${strokeBase * 3} ${strokeBase * 3}`}
              />
            ))}
            {Array.from({ length: snapDivisions - 1 }, (_, i) => (
              <line
                key={`hx-${i}`}
                x1={0}
                y1={((i + 1) * size.height) / snapDivisions}
                x2={size.width}
                y2={((i + 1) * size.height) / snapDivisions}
                stroke="rgba(15,23,42,0.15)"
                strokeWidth={strokeBase / 2}
                strokeDasharray={`${strokeBase * 3} ${strokeBase * 3}`}
              />
            ))}
          </g>
        )}

        {/* 既存エリア */}
        {areas.map((area, i) => {
          const b = area.bounds
          const isSelected = i === selectedIndex
          const isError = highlightIndices?.has(i) ?? false
          const fill = isError ? 'rgba(239, 68, 68, 0.18)' : isSelected ? 'rgba(15, 23, 42, 0.18)' : 'rgba(15, 23, 42, 0.08)'
          const stroke = isError ? 'rgb(239, 68, 68)' : isSelected ? 'rgb(15, 23, 42)' : 'rgba(15, 23, 42, 0.6)'
          return (
            <g key={i}>
              <rect
                data-area-index={i}
                x={b.x}
                y={b.y}
                width={b.width}
                height={b.height}
                fill={fill}
                stroke={stroke}
                strokeWidth={isSelected ? strokeBase * 2 : strokeBase}
                style={{ cursor: 'move' }}
                onPointerDown={(e) => startMove(e, i)}
              />
              <text
                x={b.x + b.width / 2}
                y={b.y + b.height / 2}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="rgba(15, 23, 42, 0.9)"
                fontSize={Math.max(size.width, size.height) / 40}
                fontFamily="system-ui, -apple-system, sans-serif"
                pointerEvents="none"
              >
                {i + 1}
              </text>
              {isSelected && HANDLE_KINDS.map((h) => {
                const pos = handlePosition(b, h)
                return (
                  <circle
                    key={h}
                    data-handle={h}
                    cx={pos.x}
                    cy={pos.y}
                    r={handleSize}
                    fill="white"
                    stroke="rgb(15, 23, 42)"
                    strokeWidth={strokeBase}
                    style={{ cursor: handleCursor(h) }}
                    onPointerDown={(e) => startResize(e, i, h)}
                  />
                )
              })}
            </g>
          )
        })}

        {/* ドラッグ中の新規矩形プレビュー */}
        {dragRect && (
          <rect
            x={dragRect.x}
            y={dragRect.y}
            width={dragRect.width}
            height={dragRect.height}
            fill="rgba(15, 23, 42, 0.15)"
            stroke="rgb(15, 23, 42)"
            strokeWidth={strokeBase * 2}
            strokeDasharray={`${strokeBase * 4} ${strokeBase * 4}`}
            pointerEvents="none"
          />
        )}
      </svg>
    </div>
  )
}
