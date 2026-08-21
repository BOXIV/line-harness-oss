// テンプレートの送り先分類（出品者向け / 購入者向け / 共通）。
//
// 値は DB / worker の TEMPLATE_SOURCES（packages/db/src/templates.ts, migration 922）と
// 一致させること。友だち側の分類（lib/friend-source.ts の FriendSource）と語彙を揃えて
// あるので、チャットの相手が seller / buyer ならそのままテンプレの絞り込みに使える。
// 色も /chats の出品者・購入者バッジと同じ（emerald / blue）にしてある。

import type { TemplateSource } from '@line-crm/shared'
import type { FriendSource } from './friend-source'

export type { TemplateSource }

export const TEMPLATE_SOURCES: readonly TemplateSource[] = ['seller', 'buyer', 'common']

/** 選択肢・バッジの表示名。 */
export const TEMPLATE_SOURCE_LABELS: Record<TemplateSource, string> = {
  seller: '出品者向け',
  buyer: '購入者向け',
  common: '共通',
}

/** タブの短いラベル。 */
export const TEMPLATE_SOURCE_TAB_LABELS: Record<TemplateSource, string> = {
  seller: '出品者',
  buyer: '購入者',
  common: '共通',
}

export const TEMPLATE_SOURCE_TABS: { key: 'all' | TemplateSource; label: string }[] = [
  { key: 'all', label: '全て' },
  { key: 'seller', label: TEMPLATE_SOURCE_TAB_LABELS.seller },
  { key: 'buyer', label: TEMPLATE_SOURCE_TAB_LABELS.buyer },
  { key: 'common', label: TEMPLATE_SOURCE_TAB_LABELS.common },
]

export const TEMPLATE_SOURCE_BADGE_CLASS: Record<TemplateSource, string> = {
  seller: 'bg-emerald-100 text-emerald-700',
  buyer: 'bg-blue-100 text-blue-700',
  common: 'bg-gray-100 text-gray-600',
}

export function isTemplateSource(value: unknown): value is TemplateSource {
  return typeof value === 'string' && (TEMPLATE_SOURCES as readonly string[]).includes(value)
}

/** 未知の値（source を持たない古いレスポンス等）は共通扱いに倒す。 */
export function normalizeTemplateSource(value: unknown): TemplateSource {
  return isTemplateSource(value) ? value : 'common'
}

/**
 * 友だちの分類 → 最初に開くテンプレタブ。
 * 未分類（どちらのタグも無い）の相手では絞り込まず「全て」から選ばせる。
 */
export function initialTemplateTab(source: FriendSource | undefined): 'all' | TemplateSource {
  return source ?? 'all'
}
