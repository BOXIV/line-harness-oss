// LINE Messaging API のリッチメニュー型 (web/worker 共用).
//
// LINE 仕様: https://developers.line.biz/en/reference/messaging-api/#rich-menu-object
// このパッケージは依存ゼロの「型と定数」専用なので、I/O や fetch は呼ばない。
// 画像サイズ・座標は LINE Platform 上の実画像ピクセル値を保持する。

export interface RichMenuSize {
  width: number
  height: number
}

export interface RichMenuBounds {
  x: number
  y: number
  width: number
  height: number
}

export type RichMenuAction =
  | { type: 'postback'; data: string; displayText?: string; label?: string }
  | { type: 'message'; text: string; label?: string }
  | { type: 'uri'; uri: string; label?: string }
  | { type: 'datetimepicker'; data: string; mode: 'date' | 'time' | 'datetime'; label?: string }
  | { type: 'richmenuswitch'; richMenuAliasId: string; data: string; label?: string }

export interface RichMenuArea {
  bounds: RichMenuBounds
  action: RichMenuAction
}

/** GET /api/rich-menus の要素 (LINE Platform 上のメニュー1件). */
export interface RichMenu {
  richMenuId: string
  size: RichMenuSize
  selected: boolean
  name: string
  chatBarText: string
  areas: RichMenuArea[]
}

/** POST /api/rich-menus への入力 (richMenuId は LINE 側で発番). */
export interface CreateRichMenuInput {
  size: RichMenuSize
  selected: boolean
  name: string
  chatBarText: string
  areas: RichMenuArea[]
}

/** LINE 仕様の許可サイズ. UI で選択肢を作る用. */
export const RICH_MENU_SIZES: ReadonlyArray<RichMenuSize & { label: string }> = [
  { width: 2500, height: 1686, label: '2500 × 1686 (大)' },
  { width: 2500, height: 843, label: '2500 × 843 (大・コンパクト)' },
  { width: 1200, height: 810, label: '1200 × 810 (中)' },
  { width: 1200, height: 405, label: '1200 × 405 (中・コンパクト)' },
  { width: 800, height: 540, label: '800 × 540 (小)' },
  { width: 800, height: 270, label: '800 × 270 (小・コンパクト)' },
]
