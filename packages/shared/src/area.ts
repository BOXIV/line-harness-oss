// 撮影エリア定義 (web/worker 共用).
//
// BOXIV Lightning 撮影予約システム用の都道府県 ↔ エリア マッピング.
// 営業時間 / スロット計算など I/O や時刻に依存するロジックは
// apps/worker/src/utils/area.ts に置く. ここは「型と定数」だけ.

export type AreaId =
  | 'shutoken'
  | 'chubu'
  | 'kinki'
  | 'kanto_suburban'
  | 'kyushu'
  | 'other'

export const AREA_LABELS: Record<AreaId, string> = {
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

/** 都道府県 → エリアID. AREA_PREFECTURES から派生. */
export const PREFECTURE_TO_AREA: Record<string, AreaId> = Object.fromEntries(
  (Object.entries(AREA_PREFECTURES) as Array<[AreaId, string[]]>).flatMap(
    ([area, prefs]) => prefs.map((p) => [p, area] as const),
  ),
)

/** 表示用の標準 ID 順 (other は通常 UI に出さない). */
export const AREA_IDS: ReadonlyArray<AreaId> = ['shutoken', 'chubu', 'kinki', 'kanto_suburban', 'kyushu']

/** 都道府県 → エリアID. マッピングがなければ 'other'. */
export function prefectureToArea(prefecture: string): AreaId {
  return PREFECTURE_TO_AREA[prefecture] ?? 'other'
}

/** 都道府県を短く表示するため「都/道/府/県」を落とした版. */
export function shortPrefecture(prefecture: string): string {
  return prefecture.replace(/[都道府県]$/, '')
}
