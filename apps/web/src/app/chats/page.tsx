'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { api, fetchApi } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import Header from '@/components/layout/header'
import MessageBubble from '@/components/chats/message-bubble'
import TemplatePickerModal from '@/components/chats/template-picker-modal'
import ScheduledMessagePanel from '@/components/chats/scheduled-message-panel'
import DraftPanel from '@/components/chats/draft-panel'
import StatusPicker from '@/components/friends/status-picker'
import RichMenuPicker from '@/components/rich-menus/rich-menu-picker'
import NotionLinkPicker from '@/components/chats/notion-link-picker'
import {
  detectFriendSource,
  isUnlinkedFriend,
  SOURCE_LABELS,
  UNLINKED_LABEL,
  type FriendSource,
  type FriendTabKey,
} from '@/lib/friend-source'
import { sortChatsByRecency, filterUnreadChats } from '@/lib/chat-list'
import { trackUsedDraft } from '@/lib/chat-draft'
import { notionPillClass } from '@/lib/notion-color'
import { formatFriendLabel, composeDisplayLabel } from '@/lib/friend-name'

interface NotionFriendLink {
  source: 'seller' | 'buyer'
  pageId: string
  /** 出品者: 掲載ID / 購入者: 商談ID */
  label: string | null
  realName: string | null
  /** 出品タイプ（出品者のみ） */
  listingType?: string | null
  /** 車両（購入者のみ） */
  vehicle?: string | null
  /** オペレーターが行を明示選択した連携（同じDBの他の行のステータスは反映されない） */
  pinned?: boolean
  candidateCount?: number
  linkedAt?: string
}

/** 出品者/購入者それぞれの連携。1人が両方を持ち得る。 */
type NotionFriendLinks = Partial<Record<'seller' | 'buyer', NotionFriendLink>>

/** ヘッダのピル表示。出品者は掲載ID、購入者は商談ID。 */
const NOTION_PILL_PREFIX: Record<'seller' | 'buyer', string> = {
  seller: '掲載',
  buyer: '取引',
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
  /** 分類タグ（出品者/購入者）から worker が解決した source。どちらのタグも無ければ null。 */
  source: FriendSource
  customerStatus: CustomerStatus | null
  operatorId: string | null
  status: 'unread' | 'in_progress' | 'resolved'
  notes: string | null
  lastMessageAt: string | null
  unreadCount?: number
  /** 未送信の下書き件数（message_drafts）。✏️ バッジに出す。 */
  draftCount?: number
  createdAt: string
  updatedAt: string
}

interface QuotedMessagePreview {
  id: string
  direction: 'incoming' | 'outgoing'
  messageType: string
  content: string
}

interface ChatMessage {
  id: string
  direction: 'incoming' | 'outgoing'
  messageType: string
  content: string
  status?: string | null
  /** 送信したオペレーター名（送信のみ / 自動送信は null）。顧客側には出ない。 */
  sentByName?: string | null
  createdAt: string
  quotedMessageId?: string | null
  quotedMessage?: QuotedMessagePreview | null
}

interface ChatDetail extends Chat {
  friendName: string
  lineUserId: string | null
  friendPictureUrl: string | null
  /** 出品者/購入者それぞれの連携。旧 worker と繋がったときは undefined。 */
  notionLinks?: NotionFriendLinks
  /** 直近ウィンドウのメッセージ（古い順）。これより前は before= でさかのぼる。 */
  messages?: ChatMessage[]
  /** ウィンドウより前にまだメッセージがある。旧 worker と繋がったときは undefined。 */
  hasMoreMessages?: boolean
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
  /** 送信したオペレーター名（送信のみ / 自動送信は null）。顧客側には出ない。 */
  sentByName?: string | null
  createdAt: string
  quotedMessageId?: string | null
  quotedMessage?: QuotedMessagePreview | null
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
  const [notionMessage, setNotionMessage] = useState('')
  const [sendingSchedule, setSendingSchedule] = useState(false)
  // 下書きパネル（✏️）と、入力欄に挿入した下書き。
  // 送信できたら挿入元を消すので「どの下書きから書き始めたか」を覚えておく。
  const [showDraftPanel, setShowDraftPanel] = useState(false)
  const [usedDraftId, setUsedDraftId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState('')
  const [messageContent, setMessageContent] = useState('')
  const [sending, setSending] = useState(false)
  const [nameQuery, setNameQuery] = useState('')
  // 出品者/購入者/未連携タブ。判定は分類タグ（chat.source）と Notion 連携（chat.notion）。
  // 'all' は未連携も含めた全員。
  // 並びはどのタブでも「最後にメッセージがあった順」だけ（連携の有無で沈めない）。
  const [sourceTab, setSourceTab] = useState<FriendTabKey>('all')
  // 「未読」チェックボックス。ON で未読メッセージがあるチャットだけに絞る。
  const [unreadOnly, setUnreadOnly] = useState(false)
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
  const [markingRead, setMarkingRead] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement | null>(null)
  // メッセージ欄がマウント／再マウントされた時点で最下部（最新）に寄せる保険。
  // 下のスクロール effect は chatDetail.id / messages.length に依存するため、
  // 内容が同じまま要素だけ作り直されると発火せず、最上部（最古）で止まってしまう。
  const attachMessagesContainer = useCallback((el: HTMLDivElement | null) => {
    messagesContainerRef.current = el
    if (el) el.scrollTop = el.scrollHeight
  }, [])
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null)
  // さかのぼり読み込み（直近ウィンドウより前）。チャットを切り替えたら捨てる。
  const [olderMessages, setOlderMessages] = useState<ChatMessage[]>([])
  const [hasMoreOlder, setHasMoreOlder] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)

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

  // opts.silent: 「読み込み中...」に差し替えず（=メッセージ欄を unmount させず）に再取得する。
  //   スピナー表示は要素を作り直すため、戻ってきた時にスクロールが最上部（最古）へ飛ぶ。
  //   ポーリングと手動更新の両方で silent を使い、表示中の位置を保つ。
  // opts.reportError: 手動操作起点のときだけ失敗を画面に出す（ポーリングは黙って次回に任せる）。
  const loadChatDetail = useCallback(async (chatId: string, opts?: { silent?: boolean; reportError?: boolean }) => {
    if (!opts?.silent) setDetailLoading(true)
    try {
      const res = await api.chats.get(chatId)
      if (res.success) {
        const next = res.data as unknown as ChatDetail
        // silent 時は内容に変化が無ければ同一参照を返して再描画を抑止する。
        // → ちらつき防止 + スクロール位置（最新=最下部）を維持。新着があれば更新され、
        //   length 変化で下部スクロール effect が発火する。
        setChatDetail((prev) =>
          opts?.silent && prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next,
        )
      }
    } catch {
      if (!opts?.silent || opts?.reportError) setError('チャット詳細の読み込みに失敗しました。')
    } finally {
      if (!opts?.silent) setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    loadChats()
  }, [loadChats])

  useEffect(() => {
    setOlderMessages([])
    setHasMoreOlder(false)
    if (selectedChatId) {
      loadChatDetail(selectedChatId)
    } else {
      setChatDetail(null)
    }
  }, [selectedChatId, loadChatDetail])

  // サーバが「まだ前がある」と言ったら遡りボタンを出す。
  // 遡り済みのぶんは olderMessages 側の hasMore が正なので、そちらが false になったら畳む。
  useEffect(() => {
    if (olderMessages.length === 0) setHasMoreOlder(Boolean(chatDetail?.hasMoreMessages))
  }, [chatDetail?.hasMoreMessages, chatDetail?.id, olderMessages.length])

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

  // 遡って読んだぶん + 直近ウィンドウ。表示は常に古い順。
  const visibleMessages = useMemo(
    () => [...olderMessages, ...(chatDetail?.messages ?? [])],
    [olderMessages, chatDetail?.messages],
  )

  // 「以前のメッセージを読み込む」。直近ウィンドウの先頭より前を 1 ページ足す。
  // 読み込み後もユーザーが見ている行が動かないよう、増えた高さぶんだけ scrollTop を戻す。
  const loadOlderMessages = useCallback(async () => {
    if (loadingOlder || !chatDetail?.friendId) return
    const oldest = (olderMessages[0] ?? chatDetail.messages?.[0])?.createdAt
    if (!oldest) return
    setLoadingOlder(true)
    const el = messagesContainerRef.current
    const prevHeight = el?.scrollHeight ?? 0
    const prevTop = el?.scrollTop ?? 0
    try {
      const res = await fetchApi<{ success: boolean; data: ChatMessage[]; hasMore?: boolean }>(
        `/api/friends/${chatDetail.friendId}/messages?before=${encodeURIComponent(oldest)}`,
      )
      if (res.success) {
        const seen = new Set(olderMessages.map((m) => m.id))
        const fresh = (res.data ?? []).filter((m) => !seen.has(m.id))
        setOlderMessages((prev) => [...fresh, ...prev])
        setHasMoreOlder(Boolean(res.hasMore))
        requestAnimationFrame(() => {
          const node = messagesContainerRef.current
          if (node) node.scrollTop = prevTop + (node.scrollHeight - prevHeight)
        })
      }
    } catch {
      // 失敗時はボタンを残して再試行できるようにするだけ
    }
    setLoadingOlder(false)
  }, [chatDetail?.friendId, chatDetail?.messages, loadingOlder, olderMessages])

  // 引用プレビューのクリック → 引用元メッセージへスクロール＋一瞬ハイライト。
  // 引用元が読み込み済み（直近200件）にあれば DOM に存在しジャンプできる。範囲外なら何もしない。
  const scrollToMessage = useCallback((originalMessageId: string) => {
    const el = document.getElementById(`chat-msg-${originalMessageId}`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.remove('quote-flash')
    // reflow してアニメーションを再起動（連続クリック対応）
    void el.offsetWidth
    el.classList.add('quote-flash')
    window.setTimeout(() => el.classList.remove('quote-flash'), 1600)
  }, [])

  const handleSelectChat = (chatId: string) => {
    setSelectedChatId(chatId)
    setMessageContent('')
    // 相手が変われば下書きの追跡もリセットする（別の相手の下書きを消さない）。
    setUsedDraftId(null)
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
      // 送れた下書きは役目を終えたので消す（残すと「未送信の下書き」と見分けが付かない）。
      // 消せなくても送信は成立しているので、失敗はログだけにして操作は止めない。
      if (usedDraftId) {
        await api.drafts.delete(usedDraftId).catch((err) => console.error('draft delete failed', err))
        setUsedDraftId(null)
      }
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

  const handleMarkRead = async () => {
    if (!selectedChatId || markingRead) return
    setMarkingRead(true)
    try {
      await api.chats.markRead(selectedChatId)
      // 赤い未読バッジ（①②）だけを消す。loadChats/loadChatDetail で再フェッチすると
      // トーク画面がトップへスクロールし、一覧のフォーカスも外れるため使わず、
      // 該当チャットの unreadCount をローカルで 0 にするだけにする（他は一切動かさない）。
      setChats((prev) => prev.map((c) => (c.id === selectedChatId ? { ...c, unreadCount: 0 } : c)))
    } catch {
      setError('既読への更新に失敗しました。')
    } finally {
      setMarkingRead(false)
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

  // 名前検索を適用したチャット。タブのバッジもこれを集計するので、
  // 検索中はバッジと一覧の中身が一致する。
  const searchedChats = useMemo(() => {
    const q = nameQuery.trim().toLowerCase()
    if (!q) return chats
    return chats.filter((chat) => formatChatLabel(chat).toLowerCase().includes(q))
  }, [chats, nameQuery])

  // タブのバッジは「その区分の未読メッセージ数」。チャット行の赤バッジと同じ意味にして、
  // 総件数と取り違えられないようにする（0 のときは出さない）。
  const unreadCounts = useMemo(() => {
    const sum = (list: Chat[]) => list.reduce((n, c) => n + (c.unreadCount ?? 0), 0)
    return {
      all: sum(searchedChats),
      seller: sum(searchedChats.filter((c) => c.source === 'seller')),
      buyer: sum(searchedChats.filter((c) => c.source === 'buyer')),
      unlinked: sum(searchedChats.filter(isUnlinkedFriend)),
    }
  }, [searchedChats])

  // 開いているチャットの出品者/購入者。一覧の source（worker がタグから解決・全件分ある）を
  // 優先し、一覧に無いチャットだけ友だち一覧のタグから判定する。ステータス選択が
  // 出品者DB/購入者DB のどちらの options を出すかに使う。
  const detailSource = useMemo<FriendSource>(() => {
    if (!chatDetail) return null
    return (
      chats.find((c) => c.id === chatDetail.id)?.source
      ?? detectFriendSource(allFriends.find((f) => f.id === chatDetail.friendId)?.tags)
    )
  }, [chatDetail, chats, allFriends])

  // 開いているチャットの未送信の下書き件数（✏️ のバッジ）。一覧の値をそのまま使う。
  const selectedChatDraftCount = useMemo(
    () => chats.find((c) => c.id === selectedChatId)?.draftCount ?? 0,
    [chats, selectedChatId],
  )

  // 表示するチャット。タブ選択時はそのグループだけ、「全て」は未連携も含む。
  // 並びは常に最終メッセージの新しい順 — 連携の有無で下に沈めない。
  // 「未読」ON のときは未読があるものだけ（開いているチャットは既読にしても残す）。
  const visibleChats = useMemo(() => {
    const inTab =
      sourceTab === 'all' ? searchedChats
      : sourceTab === 'unlinked' ? searchedChats.filter(isUnlinkedFriend)
      : searchedChats.filter((c) => c.source === sourceTab)
    return filterUnreadChats(sortChatsByRecency(inTab), { enabled: unreadOnly, keepId: selectedChatId })
  }, [searchedChats, sourceTab, unreadOnly, selectedChatId])

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
                // silent = メッセージ欄を作り直さない → 表示中のスクロール位置を保つ。
                // 新着があれば messages.length 変化で最下部へ自動スクロールする。
                if (selectedChatId) loadChatDetail(selectedChatId, { silent: true, reportError: true })
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

          {/* 出品者 / 購入者 / 未連携タブ（分類タグ＋Notion 連携で判別。「全て」は全部混ぜて出す） */}
          <div className="px-3 py-2 border-b border-gray-200" role="tablist" aria-label="友だちの区分">
            <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
              {([
                { key: 'all', label: '全て' },
                { key: 'seller', label: SOURCE_LABELS.seller },
                { key: 'buyer', label: SOURCE_LABELS.buyer },
                { key: 'unlinked', label: UNLINKED_LABEL },
              ] as const).map((tab) => {
                const active = sourceTab === tab.key
                const unread = unreadCounts[tab.key]
                return (
                  <button
                    key={tab.key}
                    role="tab"
                    aria-selected={active}
                    onClick={() => { setSourceTab(tab.key); setSelectedChatId(null) }}
                    className={`flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 min-h-[32px] rounded-md text-xs font-medium transition-colors ${
                      active ? 'bg-white text-slate-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
                    }`}
                  >
                    {tab.label}
                    {unread > 0 && (
                      <span
                        className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold leading-none"
                        title={`未読 ${unread} 件`}
                        aria-label={`未読 ${unread} 件`}
                      >
                        {unread > 99 ? '99+' : unread}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          {/* 名前で検索 ＋ 未読だけに絞るチェックボックス */}
          <div className="px-3 py-2 border-b border-gray-200 flex items-center gap-2">
            <input
              type="text"
              value={nameQuery}
              onChange={(e) => setNameQuery(e.target.value)}
              placeholder="名前で検索..."
              className="flex-1 min-w-0 text-xs border border-gray-300 rounded-lg px-2 py-2 min-h-[36px] bg-white focus:outline-none focus:border-slate-900"
            />
            <label
              className="flex-shrink-0 inline-flex items-center gap-1.5 px-1 min-h-[36px] text-xs text-gray-700 whitespace-nowrap cursor-pointer select-none"
              title="未読メッセージがあるチャットだけを表示"
            >
              <input
                type="checkbox"
                checked={unreadOnly}
                onChange={(e) => setUnreadOnly(e.target.checked)}
                className="w-4 h-4 accent-red-500 cursor-pointer"
              />
              未読
            </label>
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
                {visibleChats.length === 0 && (
                  <p className="px-4 py-6 text-xs text-gray-400 text-center">
                    該当するチャットはありません
                  </p>
                )}
                {visibleChats.map((chat) => {
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
                          <p className="text-xs text-gray-400 mt-0.5 flex items-center gap-1.5">
                            {/* 出品者/購入者/未連携は「全て」タブでも一目で分かるよう行内にも出す */}
                            {chat.source ? (
                              <span
                                className={`inline-flex items-center px-1.5 rounded text-[10px] font-medium leading-4 ${
                                  chat.source === 'seller'
                                    ? 'bg-emerald-100 text-emerald-700'
                                    : 'bg-blue-100 text-blue-700'
                                }`}
                              >
                                {SOURCE_LABELS[chat.source]}
                              </span>
                            ) : isUnlinkedFriend(chat) ? (
                              <span className="inline-flex items-center px-1.5 rounded text-[10px] font-medium leading-4 bg-gray-100 text-gray-600">
                                {UNLINKED_LABEL}
                              </span>
                            ) : null}
                            {(chat.draftCount ?? 0) > 0 && (
                              <span
                                className="inline-flex items-center px-1.5 rounded text-[10px] font-medium leading-4 bg-amber-100 text-amber-700"
                                title={`未送信の下書き ${chat.draftCount} 件`}
                              >
                                ✏️{chat.draftCount}
                              </span>
                            )}
                            {formatDatetime(chat.lastMessageAt)}
                          </p>
                        </div>
                        {chat.customerStatus && (
                          <span className={`ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0 ${notionPillClass(chat.customerStatus.color)}`}>
                            {chat.customerStatus.name}
                          </span>
                        )}
                        {!!chat.unreadCount && chat.unreadCount > 0 && (
                          <span
                            className="ml-1 flex-shrink-0 inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-red-500 text-white text-xs font-bold leading-none"
                            title={`未読 ${chat.unreadCount} 件`}
                            aria-label={`未読 ${chat.unreadCount} 件`}
                          >
                            {chat.unreadCount > 99 ? '99+' : chat.unreadCount}
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
                      {chatDetail.lineUserId && (
                        <span
                          className="text-xs font-normal text-gray-400 truncate select-all"
                          title={chatDetail.lineUserId}
                        >
                          [{chatDetail.lineUserId}]
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      <StatusPicker
                        friendId={chatDetail.friendId}
                        preferredSource={detailSource}
                        compact
                      />
                      {/* 出品者リンクと購入者リンクは両方持ち得るので、あるものを全て出す。
                          旧 worker（notionLinks 無し）と繋がったときは notion 1件にフォールバック。 */}
                      {(chatDetail.notionLinks
                        ? (['seller', 'buyer'] as const).map((s) => chatDetail.notionLinks?.[s]).filter(Boolean)
                        : [chatDetail.notion].filter(Boolean)
                      ).map((link) => link && link.label && (
                        <span
                          key={link.source}
                          className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600"
                          title={[
                            link.source === 'seller' ? link.listingType : link.vehicle,
                            link.pinned ? '行を選択して固定済み（同じDBの他の行のステータスは反映されません）' : '自動判定で連携中',
                            (link.candidateCount ?? 0) > 1 ? `候補 ${link.candidateCount} 件` : null,
                          ].filter(Boolean).join(' / ')}
                        >
                          {NOTION_PILL_PREFIX[link.source]} {link.label}
                          {link.pinned && <span className="ml-1">📌</span>}
                        </span>
                      ))}
                      <RichMenuPicker friendId={chatDetail.friendId} />
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={async () => {
                      if (!chatDetail) return
                      if (!window.confirm('この友だちに撮影日程調整の招待を送信し、日程調整フローを開始しますか？')) return
                      const friendId = chatDetail.friendId
                      setSendingSchedule(true)
                      setNotionMessage('')
                      try {
                        let res
                        try {
                          // まずは friendId のみ（顧客名・都道府県は Notion から補完）
                          res = await api.bookingInvites.send(friendId)
                        } catch (e1) {
                          const msg = e1 instanceof Error ? e1.message : ''
                          // Notion に都道府県が無い場合は手入力で続行（エリア判定に必須）
                          if (!/prefecture/i.test(msg)) throw e1
                          const pref = window.prompt('Notion に都道府県が見つかりません。\n相手の都道府県を入力してください（例: 東京都）', '')
                          if (!pref || !pref.trim()) {
                            setNotionMessage('日程調整送信をキャンセルしました（都道府県が未入力）')
                            return
                          }
                          res = await api.bookingInvites.create({ friendId, prefecture: pref.trim(), sendLineMessage: true })
                        }
                        if (res.success) {
                          const d = res.data
                          setNotionMessage(`✓ 日程調整の招待を送信しました${d?.customerName ? `: ${d.customerName} 様` : ''}${d?.area ? `（エリア: ${d.area}）` : ''}`)
                          loadChatDetail(chatDetail.id)
                        } else {
                          setNotionMessage(`日程調整送信に失敗: ${res.error}`)
                        }
                      } catch (e) {
                        setNotionMessage(`日程調整送信に失敗: ${e instanceof Error ? e.message : 'unknown'}`)
                      } finally {
                        setSendingSchedule(false)
                        setTimeout(() => setNotionMessage(''), 8000)
                      }
                    }}
                    disabled={sendingSchedule}
                    className="px-3 py-1 min-h-[44px] lg:min-h-0 text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 disabled:opacity-50 rounded-md transition-colors"
                    title="撮影日程調整の招待を LINE で送信（日程調整フロー開始）。住所/都道府県は Notion から補完"
                  >
                    {sendingSchedule ? '⏳' : '🗓️'} 日程調整送信
                  </button>
                  <NotionLinkPicker
                    friendId={chatDetail.friendId}
                    onLinked={(message, linked) => {
                      setNotionMessage(message)
                      if (linked) {
                        loadChatDetail(chatDetail.id)
                        loadChats()
                      }
                      setTimeout(() => setNotionMessage(''), 6000)
                    }}
                  />
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
              <div ref={attachMessagesContainer} className="flex-1 overflow-y-auto p-4 space-y-2" style={{ backgroundColor: '#7494C0' }}>
                {hasMoreOlder && (
                  <div className="text-center pb-2">
                    <button
                      onClick={loadOlderMessages}
                      disabled={loadingOlder}
                      className="px-3 py-1 text-xs font-medium text-white/90 bg-white/15 hover:bg-white/25 disabled:opacity-50 rounded-full transition-colors"
                    >
                      {loadingOlder ? '読み込み中…' : '以前のメッセージを読み込む'}
                    </button>
                  </div>
                )}
                {visibleMessages.length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-white/60 text-sm">メッセージはまだありません。</p>
                  </div>
                ) : (
                  visibleMessages.map((msg) => (
                    <MessageBubble
                      key={msg.id}
                      message={msg}
                      friendPictureUrl={chatDetail.friendPictureUrl}
                      domId={`chat-msg-${msg.id}`}
                      onQuoteJump={scrollToMessage}
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
                  <button
                    type="button"
                    onClick={handleMarkRead}
                    disabled={markingRead}
                    className="ml-auto px-3 py-1 min-h-[32px] text-xs font-medium text-white bg-slate-700 hover:bg-slate-800 disabled:opacity-50 rounded-md transition-colors flex-shrink-0"
                    title="このチャットを既読にする（未読数を 0 に戻す）"
                  >
                    {markingRead ? '...' : '✓ 既読にする'}
                  </button>
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
                  {/* 下書き。テンプレート（全員共通の定型文）と違い、この相手のために
                      あらかじめ用意しておいた文面を出す。件数は未送信の下書き数。 */}
                  <button
                    type="button"
                    onClick={() => setShowDraftPanel(true)}
                    disabled={sending}
                    className="relative px-3 text-sm border border-gray-300 rounded-lg bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
                    aria-label={selectedChatDraftCount > 0 ? `下書き（${selectedChatDraftCount} 件）` : '下書き'}
                    title="この相手の下書き（Claude の MCP / API からも置ける）"
                  >
                    ✏️
                    {selectedChatDraftCount > 0 && (
                      <span className="absolute -top-1.5 -right-1.5 inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold leading-none">
                        {selectedChatDraftCount > 9 ? '9+' : selectedChatDraftCount}
                      </span>
                    )}
                  </button>
                  <textarea
                    value={messageContent}
                    onChange={(e) => {
                      const value = e.target.value
                      setMessageContent(value)
                      // 入力欄を空にしたら「下書きから書き始めた」扱いをやめる。
                      setUsedDraftId((prev) => trackUsedDraft(prev, value))
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
        friendSource={detailSource}
      />

      {chatDetail && (
        <DraftPanel
          isOpen={showDraftPanel}
          onClose={() => setShowDraftPanel(false)}
          friendId={chatDetail.friendId}
          friendName={chatDetail.friendName}
          currentInput={messageContent}
          onInsert={(draft) => {
            setMessageContent(draft.content)
            setUsedDraftId(draft.id)
            setShowDraftPanel(false)
          }}
          onChanged={loadChats}
        />
      )}

      {chatDetail && (
        <ScheduledMessagePanel
          isOpen={showSchedulePanel}
          onClose={() => setShowSchedulePanel(false)}
          friendId={chatDetail.friendId}
          friendName={chatDetail.friendName}
          friendSource={detailSource}
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
