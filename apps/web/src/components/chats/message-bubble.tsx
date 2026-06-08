'use client'

import FlexPreview from '@/components/flex-preview'

export interface ChatMessageRow {
  id: string
  direction: 'incoming' | 'outgoing'
  messageType: string
  content: string
  createdAt: string
}

interface MessageBubbleProps {
  message: ChatMessageRow
  /** Friend avatar shown next to incoming messages. Optional — falls back to a placeholder circle. */
  friendPictureUrl?: string | null
  /** Hide avatars / formatting overrides for compact rendering (DM panel etc.). */
  variant?: 'chat' | 'compact'
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

export default function MessageBubble({ message, friendPictureUrl, variant = 'chat' }: MessageBubbleProps) {
  const isOutgoing = message.direction === 'outgoing'
  const isRich = RICH_TYPES.has(message.messageType)

  if (variant === 'compact') {
    // Tailwind-light variant for the DM panel that doesn't share the LINE-style background.
    return (
      <div className={`flex ${isOutgoing ? 'justify-end' : 'justify-start'}`}>
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
            {new Date(message.createdAt).toLocaleString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className={`flex items-end gap-2 ${isOutgoing ? 'justify-end' : 'justify-start'}`}>
      {!isOutgoing && (
        friendPictureUrl ? (
          <img src={friendPictureUrl} alt="" className="w-8 h-8 rounded-full flex-shrink-0 mb-1" />
        ) : (
          <div className="w-8 h-8 rounded-full bg-gray-300 flex-shrink-0 mb-1" />
        )
      )}

      <div className={`flex flex-col ${isOutgoing ? 'items-end' : 'items-start'}`}>
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
          {new Date(message.createdAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
    </div>
  )
}
