/**
 * 撮影エリア判定ユーティリティ
 *
 * BOXIV Lightning 撮影予約システム用。
 * 都道府県を6つのエリアにマッピングし、営業時間とスロット境界を計算する。
 */

export type AreaId =
  | 'shutoken'
  | 'chubu'
  | 'kinki'
  | 'kanto_suburban'
  | 'kyushu'
  | 'other';

export const PREFECTURE_TO_AREA: Record<string, AreaId> = {
  // 首都圏
  '東京都': 'shutoken',
  '千葉県': 'shutoken',
  '神奈川県': 'shutoken',
  '埼玉県': 'shutoken',
  // 中部
  '静岡県': 'chubu',
  '愛知県': 'chubu',
  // 近畿
  '京都府': 'kinki',
  '大阪府': 'kinki',
  '兵庫県': 'kinki',
  // 関東郊外
  '群馬県': 'kanto_suburban',
  '長野県': 'kanto_suburban',
  '栃木県': 'kanto_suburban',
  '茨城県': 'kanto_suburban',
  // 九州
  '福岡県': 'kyushu',
};

export const AREA_LABELS: Record<AreaId, string> = {
  shutoken: '首都圏',
  chubu: '中部',
  kinki: '近畿',
  kanto_suburban: '関東郊外',
  kyushu: '九州',
  other: 'その他の県',
};

export const AREA_PREFECTURES: Record<AreaId, string[]> = {
  shutoken: ['東京都', '千葉県', '神奈川県', '埼玉県'],
  chubu: ['静岡県', '愛知県'],
  kinki: ['京都府', '大阪府', '兵庫県'],
  kanto_suburban: ['群馬県', '長野県', '栃木県', '茨城県'],
  kyushu: ['福岡県'],
  other: [],
};

/** 都道府県 → エリアID。マッピングがなければ 'other' */
export function prefectureToArea(prefecture: string): AreaId {
  return PREFECTURE_TO_AREA[prefecture] ?? 'other';
}

/**
 * 営業時間（時単位）
 * 通常期 (9〜4月): 10:00〜16:00
 * 夏期 (5〜8月): 10:00〜18:00
 *
 * @param date YYYY-MM-DD
 */
export function getBusinessHours(date: string): { startHour: number; endHour: number } {
  const month = parseInt(date.slice(5, 7), 10);
  const isSummer = month >= 5 && month <= 8;
  return {
    startHour: 10,
    endHour: isSummer ? 18 : 16,
  };
}

/**
 * 120分単位のスロット境界を生成
 * 通常期: 10-12, 12-14, 14-16
 * 夏期: 10-12, 12-14, 14-16, 16-18
 */
export function generateSlots(date: string): Array<{ startTime: string; endTime: string }> {
  const { startHour, endHour } = getBusinessHours(date);
  const slots: Array<{ startTime: string; endTime: string }> = [];
  for (let h = startHour; h + 2 <= endHour; h += 2) {
    slots.push({
      startTime: `${String(h).padStart(2, '0')}:00`,
      endTime: `${String(h + 2).padStart(2, '0')}:00`,
    });
  }
  return slots;
}

/**
 * 招待トークン生成（URL-safe）
 */
export function generateInviteToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 日付の妥当性チェック（YYYY-MM-DD）
 */
export function isValidDateString(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * "YYYY-MM-DD" 文字列を JST 日付として解釈し、日付情報を返す。
 * Cloudflare Workers は UTC 環境なので、Date オブジェクトの getDate/getDay は
 * JST との時差で1日ずれる。文字列をそのままパースして JST 日付を取り出す。
 */
export function parseJstDate(dateStr: string): {
  year: number;
  month: number;  // 1-12
  day: number;    // 1-31
  dayOfWeek: number; // 0(日)-6(土)
  dayOfWeekJa: string;
} {
  const [year, month, day] = dateStr.split('-').map(Number);
  // Zeller's congruence or use Date in UTC noon to safely get weekday
  const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const dayOfWeek = d.getUTCDay();
  const dayOfWeekJa = ['日', '月', '火', '水', '木', '金', '土'][dayOfWeek];
  return { year, month, day, dayOfWeek, dayOfWeekJa };
}

/**
 * "YYYY-MM-DD" → "YYYY年M月D日 (曜)"
 */
export function formatJstDateLabel(dateStr: string): string {
  const p = parseJstDate(dateStr);
  return `${p.year}年${p.month}月${p.day}日 (${p.dayOfWeekJa})`;
}

/**
 * 今日からN日後までの日付配列を返す（JST基準）
 */
export function getDateRange(daysAhead: number): string[] {
  const dates: string[] = [];
  const now = new Date();
  // JST = UTC+9
  const jstOffset = 9 * 60 * 60 * 1000;
  const today = new Date(now.getTime() + jstOffset);
  for (let i = 0; i < daysAhead; i++) {
    const d = new Date(today.getTime() + i * 24 * 60 * 60 * 1000);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    dates.push(`${yyyy}-${mm}-${dd}`);
  }
  return dates;
}
