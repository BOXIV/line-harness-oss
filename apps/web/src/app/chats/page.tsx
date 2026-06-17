'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { api, fetchApi } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import Header from '@/components/layout/header'
import MessageBubble from '@/components/chats/message-bubble'
import TemplatePickerModal from '@/components/chats/template-picker-modal'
import ScheduledMessagePanel from '@/components/chats/scheduled-message-panel'
import StatusPicker from '@/components/friends/status-picker'
import RichMenuPicker from '@/components/rich-menus/rich-menu-picker'
import { detectFriendSource } from '@/lib/friend-source'
import { notionPillClass } from '@/lib/notion-color'
import { formatFriendLabel, composeDisplayLabel } from '@/lib/friend-name'

interface NotionFriendLink {
  source: 'seller' | 'buyer'
  pageId: string
  label: string | null
  realName: string | null
  linkedAt?: string
}

interface CustomerStatus {
  id: string
  name: string
  color: string | null
  source: 'seller' | 'buyer'
}

interface Chat {
  id: string
  friendId: string
  friendName: string
  managedName: string | null
  friendPictureUrl: string | null
  notion: NotionFriendLink | null
  customerStatus: CustomerStatus | null
  operatorId: string | null
  status: 'unread' | 'in_progress' | 'resolved'
  notes: string | null
  lastMessageAt: string | null
  createdAt: string
  updatedAt: string
}

interface ChatMessage {
  id: string
  direction: 'incoming' | 'outgoing'
  messageType: string
  content: string
  status?: string | null
  createdAt: string
}

interface ChatDetail extends Chat {
  friendName: string
  friendPictureUrl: string | null
  messages?: ChatMessage[]
}

// BOXIV: shared formatter — friend管理 と 個別チャット を同じ表示に統一
// (formatChatLabel は旧 API のため alias として残す)
const formatChatLabel = formatFriendLabel

const SHOW_LOADING_PREF_KEY = 'lh_chat_show_loading_indicator'
const LOADING_SECONDS_PREF_KEY = 'lh_chat_loading_seconds'
const LOADING_REFRESH_INTERVAL_MS = 4000

function formatDatetime(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

interface FriendItem {
  id: string
  displayName: string
  pictureUrl: string | null
  isFollowing: boolean
  tags?: { id: string; name: string }[]
}

interface MessageLog {
  id: string
  direction: 'incoming' | 'outgoing'
  messageType: string
  content: string
  status?: string | null
  createdAt: string
}

function DirectMessagePanel({ friendId, friend, onBack, onSent }: {
  friendId: string
  friend: FriendItem | null
  onBack: () => void
  onSent: () => void
}) {
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [messages, setMessages] = useState<MessageLog[]>([])
  const [loadingMessages, setLoadingMessages] = useState(true)
  const [sendError, setSendError] = useState('')

  const loadMessages = useCallback(async () => {
    try {
      const res = await fetchApi<{ success: boolean; data: MessageLog[] }>(
        `/api/friends/${friendId}/messages`
      )
      if (res.success) setMessages(res.data)
    } catch { /* silent */ }
  }, [friendId])

  useEffect(() => {
    setLoadingMessages(true)
    loadMessages().finally(() => setLoadingMessages(false))
  }, [loadMessages])

  const handleSend = async () => {
    if (!message.trim() || sending) return
    setSending(true)
    setSendError('')
    const text = message
    try {
      await fetchApi(`/api/friends/${friendId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: text, messageType: 'text' }),
      })
      setMessage('')
      await loadMessages() // 送信済み行を取り込む（楽観追加はせず正本を反映）
    } catch {
      // 未フォロー(422)/LINE送信失敗(502) 等。messages_log に status='failed' が記録されるため
      // 再読込して「⚠ 送信失敗（未達）」バッジを反映しつつ、明示的なエラー文言も表示する。
      setSendError('送信に失敗しました（友だち未追加・ブロック中などで未達の可能性があります）')
      await loadMessages()
    }
    setSending(false)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-4 border-b border-gray-200 flex items-center gap-3">
        <button onClick={onBack} className="lg:hidden text-gray-400 hover:text-gray-600">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        {friend?.pictureUrl ? (
          <img src={friend.pictureUrl} alt="" className="w-8 h-8 rounded-full" />
        ) : (
          <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center">
            <span className="text-gray-500 text-xs">{(friend?.displayName || '?').charAt(0)}</span>
          </div>
        )}
        <div>
          <p className="text-sm font-bold text-gray-900">{friend?.displayName || '不明'}</p>
          <p className="text-xs text-gray-400">メッセージ履歴</p>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {loadingMessages ? (
          <p className="text-center text-gray-400 text-sm">読み込み中...</p>
        ) : messages.length === 0 ? (
          <p className="text-center text-gray-400 text-sm">メッセージ履歴がありません</p>
        ) : (
          messages.map((msg) => <MessageBubble key={msg.id} message={msg} variant="compact" />)
        )}
      </div>
      <div className="px-4 py-3 border-t border-gray-200">
        {sendError && <p className="text-xs text-red-500 mb-2">{sendError}</p>}
        <div className="flex items-stretch gap-2">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder="メッセージを入力... (Shift+Enter で送信)"
            rows={2}
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent resize-none"
          />
          <button
            onClick={handleSend}
            disabled={!message.trim() || sending}
            className="px-4 rounded-lg text-white text-sm font-medium disabled:opacity-50"
            style={{ backgroundColor: '#0f172a' }}
          >
            {sending ? '...' : '送信'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ChatsPage() {
  const { selectedAccountId } = useAccount()
  const [chats, setChats] = useState<Chat[]>([])
  const [allFriends, setAllFriends] = useState<FriendItem[]>([])
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null)
  const [selectedFriendId, setSelectedFriendId] = useState<string | null>(null)
  const [chatDetail, setChatDetail] = useState<ChatDetail | null>(null)
  const [customerStatusFilter, setCustomerStatusFilter] = useState<string>('all')
  const [statusOptions, setStatusOptions] = useState<Array<{ id: string; name: string; color: string | null; source: 'seller' | 'buyer' }>>([])
  const [linkingNotion, setLinkingNotion] = useState(false)
  const [notionMessage, setNotionMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState('')
  const [messageContent, setMessageContent] = useState('')
  const [sending, setSending] = useState(false)
  const [nameQuery, setNameQuery] = useState('')
  // 表示名編集モーダル（管理名 managedName を「表示中の文字列」としてフル編集）
  const [editOpen, setEditOpen] = useState(false)
  const [editName, setEditName] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState('')
  const [showLoadingIndicator, setShowLoadingIndicator] = useState(false)
  const [loadingSeconds, setLoadingSeconds] = useState(5)
  const lastLoadingTriggerAtRef = useRef<Record<string, number>>({})
  const [isMessageInputFocused, setIsMessageInputFocused] = useState(false)
  const [showTemplatePicker, setShowTemplatePicker] = useState(false)
  const [showSchedulePanel, setShowSchedulePanel] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null)

  useEffect(() => {
    try {
      const rawEnabled = localStorage.getItem(SHOW_LOADING_PREF_KEY)
      const rawSeconds = localStorage.getItem(LOADING_SECONDS_PREF_KEY)
      if (rawEnabled !== null) setShowLoadingIndicator(rawEnabled === '1')
      if (rawSeconds) {
        const n = Number.parseInt(rawSeconds, 10)
        if (Number.isFinite(n) && n >= 5 && n <= 60) setLoadingSeconds(n)
      }
    } catch {
      // localStorage unavailable
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(SHOW_LOADING_PREF_KEY, showLoadingIndicator ? '1' : '0')
      localStorage.setItem(LOADING_SECONDS_PREF_KEY, String(loadingSeconds))
    } catch {
      // localStorage unavailable
    }
  }, [showLoadingIndicator, loadingSeconds])

  const loadChats = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params: { statusOptionId?: string; accountId?: string } = {}
      if (customerStatusFilter !== 'all') params.statusOptionId = customerStatusFilter
      if (selectedAccountId) params.accountId = selectedAccountId
      const [chatRes, friendRes] = await Promise.allSettled([
        api.chats.list(params),
        api.friends.list({ accountId: selectedAccountId || undefined, limit: '800' }),
      ])
      if (chatRes.status === 'fulfilled' && chatRes.value.success) {
        setChats(chatRes.value.data as unknown as Chat[])
      }
      if (friendRes.status === 'fulfilled' && friendRes.value.success) {
        setAllFriends((friendRes.value.data as unknown as { items: FriendItem[] }).items)
      }
      setLastRefreshedAt(new Date())
    } catch {
      setError('チャットの読み込みに失敗しました。もう一度お試しください。')
    } finally {
      setLoading(false)
    }
  }, [customerStatusFilter, selectedAccountId])

  // Load all Notion-synced status options (both seller + buyer) for the filter dropdown.
  useEffect(() => {
    api.friendStatus.listOptions().then((res) => {
      if (res.success) setStatusOptions(res.data.map((o) => ({ id: o.id, name: o.name, color: o.color, source: o.source })))
    }).catch(() => { /* non-blocking */ })
  }, [])

  // 友だち一覧「個別チャットを開く」からの deep-link: /chats?friendId=... を
  // friendId → chatId(find-or-create) で解決して選択する。useSearchParams は Suspense 境界が
  // 必要になるため、mount 時に一度だけ window.location から読む。
  const deepLinkResolvedRef = useRef(false)
  useEffect(() => {
    if (deepLinkResolvedRef.current) return
    deepLinkResolvedRef.current = true
    const friendId = new URLSearchParams(window.location.search).get('friendId')
    if (!friendId) return
    api.chats.create({ friendId }).then((res) => {
      if (res.success && res.data?.id) setSelectedChatId(res.data.id)
    }).catch(() => { /* non-blocking */ })
  }, [])

  const loadChatDetail = useCallback(async (chatId: string, opts?: { silent?: boolean }) => {
    if (!opts?.silent) setDetailLoading(true)
    try {
      const res = await api.chats.get(chatId)
      if (res.success) {
        const next = res.data as unknown as ChatDetail
        // ポーリング(silent)時は内容に変化が無ければ同一参照を返して再描画を抑止する。
        // → ちらつき防止 + スクロール位置（最新=最下部）を維持。新着があれば更新され、
        //   length 変化で下部スクロール effect が発火する。
        setChatDetail((prev) =>
          opts?.silent && prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next,
        )
      }
    } catch {
      if (!opts?.silent) setError('チャット詳細の読み込みに失敗しました。')
    } finally {
      if (!opts?.silent) setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    loadChats()
  }, [loadChats])

  useEffect(() => {
    if (selectedChatId) {
      loadChatDetail(selectedChatId)
    } else {
      setChatDetail(null)
    }
  }, [selectedChatId, loadChatDetail])

  // BOXIV: 5s polling — auto-refresh the open chat detail so automation /
  // booking / auto-reply sends and incoming messages appear without manual reload.
  // Polling pauses when the tab is hidden to avoid background quota burn.
  useEffect(() => {
    if (!selectedChatId) return
    let cancelled = false
    const tick = () => {
      if (cancelled || document.hidden) return
      loadChatDetail(selectedChatId, { silent: true })
    }
    const interval = window.setInterval(tick, 5000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [selectedChatId, loadChatDetail])

  // Auto-scroll the messages container to the latest (bottom) whenever a new
  // chat is opened or new messages arrive. Multiple attempts catch late layout
  // changes from async-loading images/Flex bubbles so the initial-open case
  // doesn't get stuck at the oldest message.
  useEffect(() => {
    const el = messagesContainerRef.current
    if (!el) return
    const scroll = () => { el.scrollTop = el.scrollHeight }
    scroll()
    requestAnimationFrame(scroll)
    const t1 = window.setTimeout(scroll, 100)
    const t2 = window.setTimeout(scroll, 400)
    const t3 = window.setTimeout(scroll, 1000)
    return () => { window.clearTimeout(t1); window.clearTimeout(t2); window.clearTimeout(t3) }
  }, [chatDetail?.id, chatDetail?.messages?.length])

  const handleSelectChat = (chatId: string) => {
    setSelectedChatId(chatId)
    setMessageContent('')
  }

  const triggerLoadingAnimation = useCallback(async (chatId: string) => {
    if (!showLoadingIndicator) return

    const now = Date.now()
    const last = lastLoadingTriggerAtRef.current[chatId] ?? 0
    if (now - last < LOADING_REFRESH_INTERVAL_MS) return
    lastLoadingTriggerAtRef.current[chatId] = now

    try {
      await fetchApi<{ success: boolean }>(`/api/chats/${chatId}/loading`, {
        method: 'POST',
        body: JSON.stringify({ loadingSeconds }),
      })
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown'
      setError(`ローディング表示の開始に失敗しました: ${detail}`)
    }
  }, [showLoadingIndicator, loadingSeconds])

  const handleSendMessage = async () => {
    if (!selectedChatId || !messageContent.trim()) return
    setSending(true)
    try {
      await api.chats.send(selectedChatId, {
        content: messageContent.trim(),
      })
      setMessageContent('')
      loadChatDetail(selectedChatId)
      loadChats()
    } catch {
      setError('メッセージの送信に失敗しました。')
    } finally {
      setSending(false)
    }
  }

  const handleAttachFile = async (file: File) => {
    if (!selectedChatId) return
    setUploading(true)
    setError('')
    try {
      const upload = await api.media.upload(file)
      if (!upload.success) {
        setError(`アップロード失敗: ${upload.error}`)
        return
      }
      const { url, kind, filename, size, mimeType } = upload.data
      let messageType: 'image' | 'video' | 'file'
      let content: string
      if (kind === 'image') {
        messageType = 'image'
        content = JSON.stringify({ originalContentUrl: url, previewImageUrl: url })
      } else if (kind === 'video') {
        messageType = 'video'
        // LINE requires both. Use the same URL as preview (LINE will frame-extract).
        content = JSON.stringify({ originalContentUrl: url, previewImageUrl: url })
      } else {
        // file (PDF) — sent as Flex bubble with download button (worker side)
        messageType = 'file'
        content = JSON.stringify({ url, filename, size, mimeType })
      }
      await api.chats.send(selectedChatId, { content, messageType })
      loadChatDetail(selectedChatId)
      loadChats()
    } catch (e) {
      const detail = e instanceof Error ? e.message : 'unknown'
      setError(`添付の送信に失敗: ${detail}`)
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleSendTemplate = async (payload: { content: string; messageType: string }) => {
    if (!selectedChatId) return
    const trimmed = payload.content.trim()
    if (!trimmed) return
    setSending(true)
    try {
      await api.chats.send(selectedChatId, {
        content: trimmed,
        messageType: payload.messageType,
      })
      loadChatDetail(selectedChatId)
      loadChats()
    } catch {
      setError('テンプレートの送信に失敗しました。')
    } finally {
      setSending(false)
    }
  }

  const openEditName = () => {
    if (!chatDetail) return
    // 現在表示されている文字列（管理名があればそれ、無ければ Notion 合成名）をプリフィル
    setEditName(chatDetail.managedName?.trim() || composeDisplayLabel(chatDetail))
    setEditError('')
    setEditOpen(true)
  }

  const saveEditName = async () => {
    if (!chatDetail) return
    setEditSaving(true)
    setEditError('')
    try {
      const res = await api.friends.update(chatDetail.friendId, { managedName: editName.trim() || null })
      if (res.success) {
        setEditOpen(false)
        loadChatDetail(chatDetail.id)
        loadChats()
      } else {
        setEditError(res.error ?? '表示名の更新に失敗しました')
      }
    } catch {
      setEditError('表示名の更新に失敗しました')
    } finally {
      setEditSaving(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      handleSendMessage()
    }
  }

  return (
    <div>
      <Header
        title="オペレーターチャット"
        action={
          <div className="flex items-center gap-2">
            {lastRefreshedAt && (
              <span className="text-[11px] text-gray-400 leading-tight">
                最終更新<br />
                {lastRefreshedAt.toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            )}
            <button
              onClick={() => {
                loadChats()
                if (selectedChatId) loadChatDetail(selectedChatId)
              }}
              disabled={loading}
              className="px-3 py-2 min-h-[44px] text-sm font-medium text-gray-700 border border-gray-300 rounded-lg bg-white hover:bg-gray-50 disabled:opacity-50 transition-colors"
              aria-label="チャットを更新"
              title="チャットを更新"
            >
              {loading ? '⏳' : '🔄'} 更新
            </button>
          </div>
        }
      />

      {/* Error */}
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      <div className="flex gap-4 h-[calc(100vh-120px)] lg:h-[calc(100vh-180px)]">
        {/* Left Panel: Chat List */}
        <div className={`w-full lg:w-96 lg:flex-shrink-0 bg-white rounded-lg shadow-sm border border-gray-200 flex-col overflow-hidden ${selectedChatId ? 'hidden lg:flex' : 'flex'}`}>
          {/* Customer status filter (Notion-synced) */}
          <div className="px-3 py-2 border-b border-gray-200">
            <select
              value={customerStatusFilter}
              onChange={(e) => { setCustomerStatusFilter(e.target.value); setSelectedChatId(null) }}
              className="w-full text-xs border border-gray-300 rounded-lg px-2 py-2 min-h-[36px] bg-white focus:outline-none focus:border-slate-900"
            >
              <option value="all">すべての顧客ステータス</option>
              <optgroup label="出品者">
                {statusOptions.filter((o) => o.source === 'seller').map((o) => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </optgroup>
              <optgroup label="購入者">
                {statusOptions.filter((o) => o.source === 'buyer').map((o) => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </optgroup>
            </select>
          </div>

          {/* 名前で検索 */}
          <div className="px-3 py-2 border-b border-gray-200">
            <input
              type="text"
              value={nameQuery}
              onChange={(e) => setNameQuery(e.target.value)}
              placeholder="名前で検索..."
              className="w-full text-xs border border-gray-300 rounded-lg px-2 py-2 min-h-[36px] bg-white focus:outline-none focus:border-slate-900"
            />
          </div>

          {/* Chat List */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div>
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="px-4 py-3 border-b border-gray-100 animate-pulse">
                    <div className="flex items-center gap-3">
                      <div className="flex-1 space-y-2">
                        <div className="h-3 bg-gray-200 rounded w-32" />
                        <div className="h-2 bg-gray-100 rounded w-20" />
                      </div>
                      <div className="h-5 bg-gray-100 rounded-full w-12" />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <>
                {chats
                  .filter((chat) => {
                    const q = nameQuery.trim().toLowerCase()
                    if (!q) return true
                    return formatChatLabel(chat).toLowerCase().includes(q)
                  })
                  .map((chat) => {
                  const isSelected = selectedChatId === chat.id
                  const label = formatChatLabel(chat)
                  return (
                    <button
                      key={chat.id}
                      onClick={() => { setSelectedFriendId(null); handleSelectChat(chat.id); }}
                      className={`w-full text-left px-4 py-3 border-b border-gray-100 transition-colors ${
                        isSelected && !selectedFriendId ? 'bg-green-50' : 'hover:bg-gray-50'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        {chat.friendPictureUrl ? (
                          <img src={chat.friendPictureUrl} alt="" className="w-10 h-10 rounded-full flex-shrink-0" />
                        ) : (
                          <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0">
                            <span className="text-gray-500 text-sm">{(chat.friendName || '?').charAt(0)}</span>
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-gray-900 truncate">{label}</p>
                          <p className="text-xs text-gray-400 mt-0.5">{formatDatetime(chat.lastMessageAt)}</p>
                        </div>
                        {chat.customerStatus && (
                          <span className={`ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0 ${notionPillClass(chat.customerStatus.color)}`}>
                            {chat.customerStatus.name}
                          </span>
                        )}
                        {chat.notion?.label && (
                          <span className="ml-1 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0 bg-slate-100 text-slate-600 max-w-[7rem] truncate">
                            {chat.notion.source === 'seller' ? '掲載' : '取引'} {chat.notion.label}
                          </span>
                        )}
                      </div>
                    </button>
                  )
                })}
              </>
            )}
          </div>
        </div>

        {/* Right Panel: Chat Detail */}
        <div className={`flex-1 bg-white rounded-lg shadow-sm border border-gray-200 flex-col overflow-hidden ${selectedChatId || selectedFriendId ? 'flex' : 'hidden lg:flex'}`}>
          {selectedFriendId && !selectedChatId ? (
            /* Direct message to friend without existing chat */
            <DirectMessagePanel
              friendId={selectedFriendId}
              friend={allFriends.find((f) => f.id === selectedFriendId) || null}
              onBack={() => setSelectedFriendId(null)}
              onSent={() => { setSelectedFriendId(null); loadChats(); }}
            />
          ) : !selectedChatId ? (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-gray-400 text-sm">チャットを選択してください</p>
            </div>
          ) : detailLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-gray-400 text-sm">読み込み中...</p>
            </div>
          ) : chatDetail ? (
            <>
              {/* Chat Header */}
              <div className="px-4 py-3 border-b border-gray-200 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <button
                    onClick={() => setSelectedChatId(null)}
                    className="lg:hidden flex-shrink-0 p-1 -ml-1 text-gray-500 hover:text-gray-700"
                    aria-label="戻る"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                  {chatDetail.friendPictureUrl && (
                    <img src={chatDetail.friendPictureUrl} alt="" className="w-8 h-8 rounded-full flex-shrink-0" />
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {formatChatLabel(chatDetail)}
                      </p>
                      <button
                        onClick={openEditName}
                        className="flex-shrink-0 text-gray-400 hover:text-slate-700 transition-colors"
                        title="表示名を編集"
                        aria-label="表示名を編集"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                    </div>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      <StatusPicker
                        friendId={chatDetail.friendId}
                        preferredSource={detectFriendSource(allFriends.find((f) => f.id === chatDetail.friendId)?.tags)}
                        compact
                      />
                      {chatDetail.notion?.label && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600">
                          {chatDetail.notion.source === 'seller' ? '掲載' : '取引'} {chatDetail.notion.label}
                        </span>
                      )}
                      <RichMenuPicker friendId={chatDetail.friendId} />
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={async () => {
                      if (!chatDetail) return
                      setLinkingNotion(true)
                      setNotionMessage('')
                      try {
                        const res = await api.chats.notionLink(chatDetail.friendId)
                        if (res.success) {
                          if (res.data.linked) {
                            setNotionMessage(`✓ 連携完了: ${res.data.link?.realName ?? ''}`)
                            loadChatDetail(chatDetail.id)
                            loadChats()
                          } else {
                            setNotionMessage(res.data.message ?? '該当レコードが見つかりませんでした')
                          }
                        } else {
                          setNotionMessage(`連携失敗: ${res.error}`)
                        }
                      } catch (e) {
                        setNotionMessage(`連携失敗: ${e instanceof Error ? e.message : 'unknown'}`)
                      } finally {
                        setLinkingNotion(false)
                        setTimeout(() => setNotionMessage(''), 5000)
                      }
                    }}
                    disabled={linkingNotion}
                    className="px-3 py-1 min-h-[44px] lg:min-h-0 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 rounded-md transition-colors"
                    title="Notion 出品者DB と連携"
                  >
                    {linkingNotion ? '⏳' : '🔗'} Notion連携
                  </button>
                  <button
                    onClick={() => setShowSchedulePanel(true)}
                    className="px-3 py-1 min-h-[44px] lg:min-h-0 text-xs font-medium text-purple-700 bg-purple-50 hover:bg-purple-100 rounded-md transition-colors"
                  >
                    📅 送信予約
                  </button>
                </div>
              </div>
              {notionMessage && (
                <div className="px-4 py-1 text-xs text-slate-600 bg-slate-50 border-b border-slate-200">{notionMessage}</div>
              )}

              {/* Messages — LINE-style chat bubbles */}
              <div ref={messagesContainerRef} className="flex-1 overflow-y-auto p-4 space-y-2" style={{ backgroundColor: '#7494C0' }}>
                {(!chatDetail.messages || chatDetail.messages.length === 0) ? (
                  <div className="text-center py-8">
                    <p className="text-white/60 text-sm">メッセージはまだありません。</p>
                  </div>
                ) : (
                  (chatDetail.messages ?? []).map((msg) => (
                    <MessageBubble
                      key={msg.id}
                      message={msg}
                      friendPictureUrl={chatDetail.friendPictureUrl}
                    />
                  ))
                )}
              </div>

              {/* Send Message Form */}
              <div className="px-4 py-3 border-t border-gray-200">
                <div className="mb-2 flex items-center gap-3 text-xs text-gray-600">
                  <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={showLoadingIndicator}
                      onChange={(e) => setShowLoadingIndicator(e.target.checked)}
                      className="h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
                    />
                    入力中ローディングを表示
                  </label>
                  <select
                    value={loadingSeconds}
                    onChange={(e) => setLoadingSeconds(Number.parseInt(e.target.value, 10))}
                    disabled={!showLoadingIndicator}
                    className="border border-gray-300 rounded-md px-2 py-1 bg-white disabled:bg-gray-100 disabled:text-gray-400"
                  >
                    {[5, 10, 15, 20, 30, 45, 60].map((sec) => (
                      <option key={sec} value={sec}>{sec}秒</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-stretch gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime,application/pdf"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) void handleAttachFile(file)
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={sending || uploading}
                    className="px-3 text-sm border border-gray-300 rounded-lg bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
                    aria-label="ファイルを添付"
                    title="画像・動画・PDF を添付"
                  >
                    {uploading ? '⏳' : '📎'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowTemplatePicker(true)}
                    disabled={sending}
                    className="px-3 text-sm border border-gray-300 rounded-lg bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
                    aria-label="テンプレートから挿入"
                    title="テンプレートから挿入"
                  >
                    📋
                  </button>
                  <textarea
                    value={messageContent}
                    onChange={(e) => {
                      const value = e.target.value
                      setMessageContent(value)
                      if (selectedChatId && isMessageInputFocused && value.trim()) {
                        void triggerLoadingAnimation(selectedChatId)
                      }
                    }}
                    onFocus={() => {
                      setIsMessageInputFocused(true)
                      if (selectedChatId) {
                        void triggerLoadingAnimation(selectedChatId)
                      }
                    }}
                    onBlur={() => setIsMessageInputFocused(false)}
                    onKeyDown={handleKeyDown}
                    placeholder="メッセージを入力... (Shift+Enter で送信)"
                    rows={2}
                    className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-green-500 resize-none"
                  />
                  <button
                    onClick={handleSendMessage}
                    disabled={sending || !messageContent.trim()}
                    className="px-4 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ backgroundColor: '#0f172a' }}
                  >
                    {sending ? '送信中...' : '送信'}
                  </button>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>

      <TemplatePickerModal
        isOpen={showTemplatePicker}
        onClose={() => setShowTemplatePicker(false)}
        onSubmit={handleSendTemplate}
      />

      {chatDetail && (
        <ScheduledMessagePanel
          isOpen={showSchedulePanel}
          onClose={() => setShowSchedulePanel(false)}
          friendId={chatDetail.friendId}
          friendName={chatDetail.friendName}
        />
      )}

      {/* 表示名編集モーダル（管理名 managedName を「表示中の文字列」としてフル編集） */}
      {editOpen && chatDetail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={() => setEditOpen(false)}>
          <div className="w-full max-w-sm bg-white rounded-lg shadow-lg p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-gray-900 mb-1">表示名を編集</h3>
            <p className="text-[11px] text-gray-500 mb-3">表示中の文字列をそのまま編集できます。空にすると LINE プロフィール名に戻ります。</p>
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') saveEditName() }}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
            />
            {editError && <p className="mt-2 text-xs text-red-600">{editError}</p>}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                onClick={() => setEditOpen(false)}
                className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                キャンセル
              </button>
              <button
                onClick={saveEditName}
                disabled={editSaving}
                className="px-3 py-1.5 text-xs font-medium text-white rounded-lg disabled:opacity-50 transition-opacity hover:opacity-90"
                style={{ backgroundColor: '#0f172a' }}
              >
                {editSaving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
