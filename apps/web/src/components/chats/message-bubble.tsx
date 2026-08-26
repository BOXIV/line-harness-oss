'use client'

import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import FlexPreview from '@/components/flex-preview'

/** 引用元メッセージのプレビュー（quoted_message_id を messages_log で解決したもの）。 */
export interface QuotedMessagePreview {
  id: string
  direction: 'incoming' | 'outgoing'
  messageType: string
  content: string
}

export interface ChatMessageRow {
  id: string
  direction: 'incoming' | 'outgoing'
  messageType: string
  content: string
  /** 'failed'=送信失敗（未フォロー宛/LINE APIエラーで不達）。null/'sent'=成功。 */
  status?: string | null
  /**
   * 送信したオペレーターの表示名（送信メッセージのみ / migration 923）。
   * 自動送信（シナリオ・一斉配信・自動応答・automation）は null＝名前を出さない。
   * 管理画面だけの表示で、顧客の LINE トークには一切出ない。
   */
  sentByName?: string | null
  createdAt: string
  /** 引用返信のとき、引用元の LINE メッセージID（非NULL = 引用あり）。 */
  quotedMessageId?: string | null
  /** 引用元メッセージ（解決できた場合のみ。未解決なら null）。 */
  quotedMessage?: QuotedMessagePreview | null
}

interface MessageBubbleProps {
  message: ChatMessageRow
  /** Friend avatar shown next to incoming messages. Optional — falls back to a placeholder circle. */
  friendPictureUrl?: string | null
  /** Hide avatars / formatting overrides for compact rendering (DM panel etc.). */
  variant?: 'chat' | 'compact'
  /** DOM id set on the message root so a quote can scroll to it. */
  domId?: string
  /** 引用プレビューをクリックしたとき、引用元メッセージ(messages_log の id)へジャンプするコールバック。 */
  onQuoteJump?: (originalMessageId: string) => void
}

function MediaContent({ messageType, content }: { messageType: string; content: string }) {
  if (messageType === 'flex') {
    return (
      <div className="overflow-x-auto" style={{ maxWidth: 'min(640px, 80vw)' }}>
        <FlexPreview content={content} maxWidth={300} />
      </div>
    )
  }
  if (messageType === 'image') {
    try {
      const parsed = JSON.parse(content)
      const src = parsed.originalContentUrl || parsed.previewImageUrl || parsed.url
      if (!src) return <span>🖼️ [画像]</span>
      return (
        <a href={src} target="_blank" rel="noreferrer">
          <img src={src} alt="" className="max-w-[240px] rounded" />
        </a>
      )
    } catch {
      return <span>🖼️ [画像]</span>
    }
  }
  if (messageType === 'video') {
    try {
      const parsed = JSON.parse(content)
      const src = parsed.originalContentUrl || parsed.url
      if (!src) return <span>🎬 [動画]</span>
      return <video src={src} controls preload="metadata" className="max-w-[280px] rounded" />
    } catch {
      return <span>🎬 [動画]</span>
    }
  }
  if (messageType === 'audio') {
    try {
      const parsed = JSON.parse(content)
      const src = parsed.url
      if (!src) return <span>🎵 [音声]</span>
      return <audio src={src} controls className="w-[240px]" />
    } catch {
      return <span>🎵 [音声]</span>
    }
  }
  if (messageType === 'file') {
    try {
      const parsed = JSON.parse(content)
      const url = parsed.url
      const filename = parsed.filename || parsed.fileName || 'file'
      if (!url) return <span>📄 [ファイル]</span>
      return (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 px-2 py-1.5 rounded bg-white/20 hover:bg-white/30 transition-colors"
        >
          <span className="text-xl">📄</span>
          <span className="text-xs underline truncate max-w-[200px]">{filename}</span>
        </a>
      )
    } catch {
      return <span>📄 [ファイル]</span>
    }
  }
  // text fallback
  return <span>{content}</span>
}

/** Rich content (flex/image/video/audio/file) は自前のフレームを持つので、
 * バブル側の bg / padding を被せない。 */
const RICH_TYPES = new Set(['flex', 'image', 'video', 'audio', 'file'])

/** チャットのタイムスタンプ。時刻だけでなく日付も表示する（例: 06/17 14:30）。 */
function formatStamp(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

/** 引用元メッセージを 1 行 + サムネイルの簡易プレビューに変換する。 */
function quotePreviewParts(messageType: string, content: string): { thumb?: string; icon?: string; text: string } {
  if (messageType === 'image') {
    try {
      const p = JSON.parse(content)
      return { thumb: p.url || p.previewImageUrl || p.originalContentUrl, icon: '🖼️', text: '画像' }
    } catch {
      return { icon: '🖼️', text: '画像' }
    }
  }
  if (messageType === 'video') return { icon: '🎬', text: '動画' }
  if (messageType === 'audio') return { icon: '🎵', text: '音声' }
  if (messageType === 'file') {
    try {
      const p = JSON.parse(content)
      return { icon: '📄', text: p.filename || p.fileName || 'ファイル' }
    } catch {
      return { icon: '📄', text: 'ファイル' }
    }
  }
  if (messageType === 'flex') return { icon: '💬', text: 'メッセージ' }
  return { text: content }
}

const clamp2: CSSProperties = {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
}

/** 友だちがトーク画面で「引用」した元メッセージを、バブル上部に表示する。
 * tone: 'onDark'=チャット(スレート背景・明色文字) / 'onLight'=DMパネル(白背景・濃色文字)。 */
function QuotedBubble({
  quotedMessageId,
  quotedMessage,
  tone,
  onJump,
}: {
  quotedMessageId?: string | null
  quotedMessage?: QuotedMessagePreview | null
  tone: 'onDark' | 'onLight'
  /** 引用元へジャンプ。解決済みかつ提供されたときだけクリック可能になる。 */
  onJump?: (originalMessageId: string) => void
}) {
  // 引用が無いメッセージ（quotedMessageId 未設定）は何も描画しない。
  if (!quotedMessageId) return null

  const onDark = tone === 'onDark'
  const boxBg = onDark ? 'bg-black/20' : 'bg-gray-100'
  const labelCls = onDark ? 'text-white/70' : 'text-gray-500'
  const bodyCls = onDark ? 'text-white/80' : 'text-gray-600'

  // 引用元を解決できなかった場合（旧データ等）はプレースホルダを出す（クリック不可）。
  if (!quotedMessage) {
    return (
      <div className={`mb-1 max-w-[300px] rounded-lg border-l-4 border-gray-300 ${boxBg} px-2.5 py-1.5 text-xs italic ${onDark ? 'text-white/60' : 'text-gray-400'}`}>
        引用元のメッセージ（表示できません）
      </div>
    )
  }

  const label = quotedMessage.direction === 'outgoing' ? '自分' : '相手'
  const p = quotePreviewParts(quotedMessage.messageType, quotedMessage.content)
  const clickable = Boolean(onJump)
  const handleJump = () => onJump?.(quotedMessage.id)
  return (
    <div
      className={`mb-1 max-w-[300px] rounded-lg border-l-4 border-emerald-400 ${boxBg} px-2.5 py-1.5 ${clickable ? 'cursor-pointer transition hover:brightness-110' : ''}`}
      {...(clickable
        ? {
            role: 'button' as const,
            tabIndex: 0,
            title: '引用元のメッセージへ移動',
            onClick: handleJump,
            onKeyDown: (e: ReactKeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                handleJump()
              }
            },
          }
        : {})}
    >
      <div className={`mb-0.5 text-[11px] font-semibold ${labelCls}`}>{label}</div>
      <div className={`flex items-center gap-1.5 text-xs ${bodyCls}`}>
        {p.thumb ? (
          <img src={p.thumb} alt="" className="h-8 w-8 flex-shrink-0 rounded object-cover" />
        ) : p.icon ? (
          <span className="flex-shrink-0">{p.icon}</span>
        ) : null}
        <span className="break-words" style={clamp2}>{p.text}</span>
      </div>
    </div>
  )
}

export default function MessageBubble({ message, friendPictureUrl, variant = 'chat', domId, onQuoteJump }: MessageBubbleProps) {
  const isOutgoing = message.direction === 'outgoing'
  const isRich = RICH_TYPES.has(message.messageType)
  const isFailed = isOutgoing && message.status === 'failed'
  // 「誰が送ったか」を日時の左に出す（送信側のみ・管理画面だけの表示）。
  // 名前が無いのは自動送信 or migration 923 より前の記録なので、その場合は何も出さない。
  const senderLabel = isOutgoing ? message.sentByName?.trim() || null : null

  if (variant === 'compact') {
    // Tailwind-light variant for the DM panel that doesn't share the LINE-style background.
    return (
      <div id={domId} className={`flex flex-col ${isOutgoing ? 'items-end' : 'items-start'}`}>
        <QuotedBubble quotedMessageId={message.quotedMessageId} quotedMessage={message.quotedMessage} tone="onLight" onJump={onQuoteJump} />
        <div
          className={
            isRich
              ? 'max-w-[75%]'
              : `max-w-[75%] rounded-2xl px-4 py-2 ${
                  isOutgoing ? 'bg-green-500 text-white' : 'bg-gray-100 text-gray-900'
                }`
          }
        >
          <div className={isRich ? '' : 'text-sm whitespace-pre-wrap break-words'}>
            <MediaContent messageType={message.messageType} content={message.content} />
          </div>
          <p className={`text-xs mt-1 ${isRich ? 'text-gray-500' : isOutgoing ? 'text-green-200' : 'text-gray-400'}`}>
            {isFailed && <span className="text-red-500 font-semibold mr-1">⚠ 送信失敗（未達）</span>}
            {senderLabel && <span className="mr-1 font-medium">{senderLabel}</span>}
            {formatStamp(message.createdAt)}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div id={domId} className={`flex items-end gap-2 ${isOutgoing ? 'justify-end' : 'justify-start'}`}>
      {!isOutgoing && (
        friendPictureUrl ? (
          <img src={friendPictureUrl} alt="" className="w-8 h-8 rounded-full flex-shrink-0 mb-1" />
        ) : (
          <div className="w-8 h-8 rounded-full bg-gray-300 flex-shrink-0 mb-1" />
        )
      )}

      <div className={`flex flex-col ${isOutgoing ? 'items-end' : 'items-start'}`}>
        <QuotedBubble quotedMessageId={message.quotedMessageId} quotedMessage={message.quotedMessage} tone="onDark" onJump={onQuoteJump} />
        {isRich ? (
          // Rich content renders its own frame (LINE-style card / video player / file card).
          // No outer bubble — keeps the chat background visible around it.
          // flex（カルーセル等）は MediaContent 側で幅と横スクロールを持つので外側 cap を外す。
          <div className={message.messageType === 'flex' ? '' : 'max-w-[320px]'}>
            <MediaContent messageType={message.messageType} content={message.content} />
          </div>
        ) : (
          <div
            className={`max-w-[320px] px-3 py-2 text-sm break-words whitespace-pre-wrap ${
              isOutgoing
                ? 'rounded-tl-2xl rounded-tr-md rounded-bl-2xl rounded-br-2xl text-white'
                : 'rounded-tl-md rounded-tr-2xl rounded-bl-2xl rounded-br-2xl bg-white text-gray-900'
            }`}
            style={isOutgoing ? { backgroundColor: '#0f172a' } : undefined}
          >
            <MediaContent messageType={message.messageType} content={message.content} />
          </div>
        )}
        <span className="text-xs text-white/50 mt-0.5 px-1">
          {isFailed && <span className="text-red-400 font-semibold mr-1">⚠ 送信失敗（未達）</span>}
          {senderLabel && <span className="mr-1 font-medium text-white/70">{senderLabel}</span>}
          {formatStamp(message.createdAt)}
        </span>
      </div>
    </div>
  )
}
