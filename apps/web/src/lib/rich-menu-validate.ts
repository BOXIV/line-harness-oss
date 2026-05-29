// リッチメニュー編集ドラフトのバリデーション.
//
// クライアント側で「LINE Platform にそのまま送って成功する」状態かを判定する.
// 重なり禁止・最小サイズ警告・action 各フィールドの長さや URL 形式など、
// LINE API のドキュメント記載の制約をなるべく事前に検出する.

import type {
  RichMenu,
  RichMenuArea,
  RichMenuBounds,
  RichMenuAction,
  RichMenuSize,
} from '@line-crm/shared'

export type RichMenuDraft = Pick<RichMenu, 'name' | 'chatBarText' | 'selected' | 'size' | 'areas'>

export interface AreaIssue {
  index: number
  message: string
  /** UI で矩形を赤く塗るための強調フラグ */
  highlight: boolean
}

export interface ValidationResult {
  ok: boolean
  /** メタ情報や全体に関するエラー */
  general: string[]
  /** area ごとのエラー (UI 強調用) */
  areas: AreaIssue[]
}

const MIN_TAP_PX = 50

function rectsOverlap(a: RichMenuBounds, b: RichMenuBounds): boolean {
  // 完全に隣接（共有辺）は OK としたいが、LINE は重なり禁止なので「1px でも交差」を禁止
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  )
}

function validateAction(action: RichMenuAction): string | null {
  if (action.label && action.label.length > 20) return 'label は 20 文字以下にしてください'
  switch (action.type) {
    case 'postback':
      if (!action.data) return 'postback の data は必須です'
      if (action.data.length > 300) return 'postback.data は 300 文字以下にしてください'
      return null
    case 'message':
      if (!action.text) return 'message の text は必須です'
      if (action.text.length > 300) return 'message.text は 300 文字以下にしてください'
      return null
    case 'uri':
      if (!action.uri) return 'uri は必須です'
      if (!/^https?:\/\/|^line:\/\/|^tel:/.test(action.uri)) return 'uri は https:// / line:// / tel: で始まる必要があります'
      return null
    case 'datetimepicker':
      if (!action.data) return 'datetimepicker の data は必須です'
      return null
    case 'richmenuswitch':
      if (!action.richMenuAliasId) return 'richMenuAliasId は必須です'
      return null
  }
}

export function validateDraft(draft: RichMenuDraft): ValidationResult {
  const general: string[] = []
  const areas: AreaIssue[] = []

  if (!draft.name.trim()) general.push('管理名を入力してください')
  if (draft.name.length > 300) general.push('管理名は 300 文字以下にしてください')
  if (!draft.chatBarText.trim()) general.push('チャットバーの表示テキストを入力してください')
  if (draft.chatBarText.length > 14) general.push('チャットバーは 14 文字以下にしてください')

  if (draft.areas.length === 0) general.push('エリアを 1 つ以上追加してください')
  if (draft.areas.length > 20) general.push('エリアは 20 個以下にしてください')

  draft.areas.forEach((area, i) => {
    const b = area.bounds
    if (b.x < 0 || b.y < 0) {
      areas.push({ index: i, message: '画像範囲外（左/上）', highlight: true })
    }
    if (b.x + b.width > draft.size.width || b.y + b.height > draft.size.height) {
      areas.push({ index: i, message: '画像範囲外（右/下）', highlight: true })
    }
    if (b.width < 1 || b.height < 1) {
      areas.push({ index: i, message: 'エリアのサイズが小さすぎます', highlight: true })
    } else if (b.width < MIN_TAP_PX || b.height < MIN_TAP_PX) {
      areas.push({ index: i, message: `タップしづらいサイズです (${b.width}×${b.height})`, highlight: false })
    }
    const actionErr = validateAction(area.action)
    if (actionErr) areas.push({ index: i, message: actionErr, highlight: true })
  })

  // 矩形重なりチェック
  for (let i = 0; i < draft.areas.length; i++) {
    for (let j = i + 1; j < draft.areas.length; j++) {
      if (rectsOverlap(draft.areas[i].bounds, draft.areas[j].bounds)) {
        areas.push({ index: i, message: `エリア ${j + 1} と重なっています`, highlight: true })
        areas.push({ index: j, message: `エリア ${i + 1} と重なっています`, highlight: true })
      }
    }
  }

  // highlight 付きの issue があるか、または general 不備があれば ok=false
  const ok = general.length === 0 && areas.every((a) => !a.highlight)
  return { ok, general, areas }
}

/** UI で「このエリアを強調する？」を高速判定する set */
export function buildHighlightSet(issues: AreaIssue[]): Set<number> {
  const s = new Set<number>()
  issues.forEach((i) => { if (i.highlight) s.add(i.index) })
  return s
}

/** size プロパティが LINE 仕様の許可セットに入っているか */
export function isAllowedSize(size: RichMenuSize): boolean {
  return (
    (size.width === 2500 && (size.height === 1686 || size.height === 843)) ||
    (size.width === 1200 && (size.height === 810 || size.height === 405)) ||
    (size.width === 800 && (size.height === 540 || size.height === 270))
  )
}

export function normalizeBounds(b: RichMenuBounds): RichMenuBounds {
  return {
    x: Math.round(Math.min(b.x, b.x + b.width)),
    y: Math.round(Math.min(b.y, b.y + b.height)),
    width: Math.round(Math.abs(b.width)),
    height: Math.round(Math.abs(b.height)),
  }
}

export function clampBoundsToSize(b: RichMenuBounds, size: RichMenuSize): RichMenuBounds {
  const x = Math.max(0, Math.min(b.x, size.width - 1))
  const y = Math.max(0, Math.min(b.y, size.height - 1))
  const width = Math.max(1, Math.min(b.width, size.width - x))
  const height = Math.max(1, Math.min(b.height, size.height - y))
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
}

export function defaultActionFor(type: RichMenuAction['type']): RichMenuArea['action'] {
  switch (type) {
    case 'postback':
      return { type: 'postback', data: 'action=' }
    case 'message':
      return { type: 'message', text: '' }
    case 'uri':
      return { type: 'uri', uri: 'https://' }
    case 'datetimepicker':
      return { type: 'datetimepicker', data: 'datetime=', mode: 'date' }
    case 'richmenuswitch':
      return { type: 'richmenuswitch', richMenuAliasId: '', data: '' }
  }
}
