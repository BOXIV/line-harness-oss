// Notion select / status の color → Tailwind pill class マップ
// 顧客ステータス UI (StatusPicker / 管理画面) で共有。

export const notionColorClass: Record<string, string> = {
  default: 'bg-gray-100 text-gray-700',
  gray: 'bg-gray-100 text-gray-700',
  brown: 'bg-amber-100 text-amber-800',
  orange: 'bg-orange-100 text-orange-800',
  yellow: 'bg-yellow-100 text-yellow-800',
  green: 'bg-green-100 text-green-700',
  blue: 'bg-blue-100 text-blue-700',
  purple: 'bg-purple-100 text-purple-700',
  pink: 'bg-pink-100 text-pink-700',
  red: 'bg-red-100 text-red-700',
}

export function notionPillClass(color: string | null | undefined): string {
  return notionColorClass[color ?? 'default'] || notionColorClass.default
}
