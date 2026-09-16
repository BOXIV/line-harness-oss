'use client'

import type { ReactNode } from 'react'
import StatusPicker from '@/components/friends/status-picker'
import RichMenuPicker from '@/components/rich-menus/rich-menu-picker'
import NotionLinkPicker from '@/components/chats/notion-link-picker'
import type { FriendSource } from '@/lib/friend-source'

export interface InfoPanelNotionLink {
  source: 'seller' | 'buyer'
  pageId: string
  /** 出品者: 掲載ID / 購入者: 商談ID */
  label: string | null
  realName: string | null
  listingType?: string | null
  vehicle?: string | null
  pinned?: boolean
  candidateCount?: number
}

/** ピルの接頭辞。出品者は掲載ID、購入者は商談ID。 */
const NOTION_PILL_PREFIX: Record<'seller' | 'buyer', string> = {
  seller: '掲載',
  buyer: '取引',
}

/** Notion 由来の取引メモ（source ごと / migration 927）。 */
export interface InfoPanelMemo {
  source: 'seller' | 'buyer'
  memo: string | null
  updatedAt: string
}

const MEMO_SOURCE_LABELS: Record<'seller' | 'buyer', string> = {
  seller: '出品者',
  buyer: '購入者',
}

function formatMemoStamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export interface FriendInfoPanelProps {
  friendId: string
  /** 画面に出す表示名（管理名 or Notion 合成名）。 */
  displayLabel: string
  pictureUrl: string | null
  lineUserId: string | null
  /** 出品者/購入者それぞれの連携。両方持ち得るのであるものを全て出す。 */
  links: InfoPanelNotionLink[]
  /** 相手の分類。ステータス候補の絞り込みに使う。 */
  source: FriendSource
  onEditName: () => void
  onNotionLinked: (message: string, linked: boolean) => void
  onOpenSchedulePanel: () => void
  onSendScheduleInvite: () => void
  sendingSchedule: boolean
  /** Notion 連携／日程調整送信の結果メッセージ（数秒で消える）。 */
  notice?: string
  /**
   * Notion の取引メモ。Notion がマスターで、ここは表示のみ（編集させない）。
   * 出品者行と購入者行の両方に連携している人は 2 件並ぶ。
   */
  memos: InfoPanelMemo[]
  /** ドロワー表示のときだけ渡す。渡すと右上に閉じるボタンが出る。 */
  onClose?: () => void
  /** 取引メモなど、下側に積みたい追加ブロック。 */
  children?: ReactNode
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="text-[11px] font-semibold text-gray-500 mb-1.5">{title}</h3>
      {children}
    </div>
  )
}

/**
 * 個別チャットの「ユーザー情報」。
 *
 * もとはトーク画面の上（ヘッダ）に横並びで詰め込んでいたが、項目が増えるほど
 * 名前が痩せ、メッセージの表示領域も削られていた。縦に積める右カラムへ移す。
 *
 * xl 以上ではトークの右に常駐し、それ未満ではドロワーとして開く（同じ中身を使い回す）。
 */
export default function FriendInfoPanel({
  friendId,
  displayLabel,
  pictureUrl,
  lineUserId,
  links,
  source,
  onEditName,
  onNotionLinked,
  onOpenSchedulePanel,
  onSendScheduleInvite,
  sendingSchedule,
  notice,
  memos,
  onClose,
  children,
}: FriendInfoPanelProps) {
  return (
    <>
      <div className="px-4 py-3 border-b border-gray-200 flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {pictureUrl ? (
            <img src={pictureUrl} alt="" className="w-9 h-9 rounded-full flex-shrink-0" />
          ) : (
            <div className="w-9 h-9 rounded-full bg-gray-200 flex-shrink-0" />
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate">{displayLabel}</p>
              <button
                onClick={onEditName}
                className="flex-shrink-0 text-gray-400 hover:text-slate-700 transition-colors"
                title="表示名を編集"
                aria-label="表示名を編集"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
            </div>
            {lineUserId && (
              <p className="text-[11px] text-gray-400 truncate select-all" title={lineUserId}>
                {lineUserId}
              </p>
            )}
          </div>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="flex-shrink-0 text-gray-400 hover:text-gray-600 min-h-[44px] min-w-[44px] flex items-center justify-center -mr-2 -mt-2"
            aria-label="閉じる"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4">
        {notice && (
          <div className="px-2 py-1.5 text-[11px] text-slate-600 bg-slate-50 border border-slate-200 rounded">
            {notice}
          </div>
        )}

        <Section title="ステータス">
          <StatusPicker friendId={friendId} preferredSource={source} compact />
        </Section>

        <Section title="Notion 連携">
          <div className="space-y-1.5">
            {links.length === 0 ? (
              <p className="text-[11px] text-gray-400">未連携</p>
            ) : (
              links.map((link) => (
                <div
                  key={link.source}
                  className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600 max-w-full"
                  title={[
                    link.source === 'seller' ? link.listingType : link.vehicle,
                    link.pinned ? '行を選択して固定済み（同じDBの他の行のステータスは反映されません）' : '自動判定で連携中',
                    (link.candidateCount ?? 0) > 1 ? `候補 ${link.candidateCount} 件` : null,
                  ].filter(Boolean).join(' / ')}
                >
                  <span className="truncate">
                    {NOTION_PILL_PREFIX[link.source]} {link.label}
                  </span>
                  {link.pinned && <span className="ml-1 flex-shrink-0">📌</span>}
                </div>
              ))
            )}
            <div>
              <NotionLinkPicker friendId={friendId} onLinked={onNotionLinked} />
            </div>
          </div>
        </Section>

        <Section title="リッチメニュー">
          <RichMenuPicker friendId={friendId} />
        </Section>

        <Section title="操作">
          <div className="flex flex-col gap-1.5">
            <button
              onClick={onSendScheduleInvite}
              disabled={sendingSchedule}
              className="w-full px-3 py-2 min-h-[40px] text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 disabled:opacity-50 rounded-md transition-colors"
              title="撮影日程調整の招待を LINE で送信（日程調整フロー開始）。住所/都道府県は Notion から補完"
            >
              {sendingSchedule ? '⏳' : '🗓️'} 日程調整送信
            </button>
            <button
              onClick={onOpenSchedulePanel}
              className="w-full px-3 py-2 min-h-[40px] text-xs font-medium text-purple-700 bg-purple-50 hover:bg-purple-100 rounded-md transition-colors"
            >
              📅 送信予約
            </button>
          </div>
        </Section>

        <Section title="取引メモ">
          {/* Notion がマスター。ここで編集させると「どちらが正か」が崩れるので表示専用。 */}
          {memos.length === 0 ? (
            <p className="text-[11px] text-gray-400">
              Notion の「取引メモ」が入力されると、ここに自動で表示されます。
            </p>
          ) : (
            <div className="space-y-2">
              {memos.map((m) => (
                <div key={m.source} className="rounded-md border border-gray-200 bg-gray-50 px-2.5 py-2">
                  <p className="text-[10px] text-gray-400 mb-1">
                    {MEMO_SOURCE_LABELS[m.source]} ・ {formatMemoStamp(m.updatedAt)} 時点
                  </p>
                  {m.memo ? (
                    <p className="text-xs text-gray-700 whitespace-pre-wrap break-words">{m.memo}</p>
                  ) : (
                    <p className="text-[11px] text-gray-400">（空）</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </Section>

        {children}
      </div>
    </>
  )
}
