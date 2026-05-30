// リッチメニュー編集の出発点となるプリセット定義.
//
// BOXIV Lightning 運用 (出品者向け / 購入者向け) に最適化したレイアウト.
// テンプレートピッカーから挿入すると、size / areas / 既定の name + chatBarText が
// ドラフトに乗る. ユーザーはそこから矩形やアクションを編集して仕上げる.

import type { RichMenuArea, RichMenuSize } from '@line-crm/shared'

export interface RichMenuPreset {
  id: string
  label: string
  description: string
  size: RichMenuSize
  /** seller = 出品者向け / buyer = 購入者向け / generic = 汎用 */
  audience: 'seller' | 'buyer' | 'generic'
  defaultChatBarText: string
  defaultName: string
  areas: RichMenuArea[]
}

// 大サイズ (2500x1686): 6 分割 (3 列 × 2 行)
function grid3x2_big(): RichMenuArea[] {
  const W = 2500
  const H = 1686
  const cw = W / 3
  const ch = H / 2
  const cells: RichMenuArea[] = []
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 3; c++) {
      cells.push({
        bounds: {
          x: Math.round(c * cw),
          y: Math.round(r * ch),
          width: Math.round(cw),
          height: Math.round(ch),
        },
        action: { type: 'message', text: `セル${r * 3 + c + 1}` },
      })
    }
  }
  return cells
}

// 小サイズ (2500x843): 3 分割 (3 列 × 1 行)
function row3_compact(): RichMenuArea[] {
  const W = 2500
  const H = 843
  const cw = W / 3
  const cells: RichMenuArea[] = []
  for (let c = 0; c < 3; c++) {
    cells.push({
      bounds: {
        x: Math.round(c * cw),
        y: 0,
        width: Math.round(cw),
        height: H,
      },
      action: { type: 'message', text: `セル${c + 1}` },
    })
  }
  return cells
}

export const RICH_MENU_PRESETS: RichMenuPreset[] = [
  {
    id: 'seller-3x2',
    label: '出品者向け 6 分割',
    description: '出品手順、写真送信、車検証アップロード、進捗確認、サポート連絡、キャンペーン',
    size: { width: 2500, height: 1686 },
    audience: 'seller',
    defaultChatBarText: 'メニュー',
    defaultName: 'BOXIV 出品者向け メニュー',
    areas: ((): RichMenuArea[] => {
      const cells = grid3x2_big()
      const labels = ['出品手順', '写真送信', '車検証アップ', '進捗確認', 'サポート', 'お知らせ']
      return cells.map((cell, i) => ({
        ...cell,
        action: { type: 'postback', data: `seller_menu=${labels[i]}`, label: labels[i] },
      }))
    })(),
  },
  {
    id: 'buyer-3x2',
    label: '購入者向け 6 分割',
    description: '在庫一覧、商談状況、購入手順、見積依頼、納車予約、サポート',
    size: { width: 2500, height: 1686 },
    audience: 'buyer',
    defaultChatBarText: 'メニュー',
    defaultName: 'BOXIV 購入者向け メニュー',
    areas: ((): RichMenuArea[] => {
      const cells = grid3x2_big()
      const labels = ['在庫一覧', '商談状況', '購入手順', '見積依頼', '納車予約', 'サポート']
      return cells.map((cell, i) => ({
        ...cell,
        action: { type: 'postback', data: `buyer_menu=${labels[i]}`, label: labels[i] },
      }))
    })(),
  },
  {
    id: 'compact-3',
    label: '汎用 3 分割（コンパクト）',
    description: '高さ低めで邪魔にならない 3 セルレイアウト',
    size: { width: 2500, height: 843 },
    audience: 'generic',
    defaultChatBarText: 'メニュー',
    defaultName: '汎用 3 分割メニュー',
    areas: ((): RichMenuArea[] => {
      const cells = row3_compact()
      const labels = ['ホーム', 'お問合せ', 'お知らせ']
      return cells.map((cell, i) => ({
        ...cell,
        action: { type: 'postback', data: `menu=${labels[i]}`, label: labels[i] },
      }))
    })(),
  },
  {
    id: 'blank-big',
    label: 'まっさら（大）',
    description: '2500 × 1686、エリア無し。手動で全部配置',
    size: { width: 2500, height: 1686 },
    audience: 'generic',
    defaultChatBarText: 'メニュー',
    defaultName: '新規リッチメニュー',
    areas: [],
  },
]
