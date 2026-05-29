// 撮影エリア定数 (apps/worker/src/utils/area.ts と同期。Worker 側がマスタ)
// Worker パッケージは web の依存に入っていないので、web 側にもコピーを持つ。

export type AreaId = 'shutoken' | 'chubu' | 'kinki' | 'kanto_suburban' | 'kyushu' | 'other'

// Record<string, string> にしているのは、DB から来る area カラムが string 型のため。
// UI 側で string をそのままキーに使えるようにしている。
export const AREA_LABELS: Record<string, string> = {
  shutoken: '首都圏',
  chubu: '中部',
  kinki: '近畿',
  kanto_suburban: '関東郊外',
  kyushu: '九州',
  other: 'その他',
}

export const AREA_PREFECTURES: Record<AreaId, string[]> = {
  shutoken: ['東京都', '千葉県', '神奈川県', '埼玉県'],
  chubu: ['静岡県', '愛知県'],
  kinki: ['京都府', '大阪府', '兵庫県'],
  kanto_suburban: ['群馬県', '長野県', '栃木県', '茨城県'],
  kyushu: ['福岡県'],
  other: [],
}

/** 表示順 (other は通常 UI に出さない) */
export const AREA_IDS: AreaId[] = ['shutoken', 'chubu', 'kinki', 'kanto_suburban', 'kyushu']

/** 都道府県を短く表示するため「県/府/都」を落とした版 */
export function shortPrefecture(p: string): string {
  return p.replace(/[都道府県]$/, '')
}
