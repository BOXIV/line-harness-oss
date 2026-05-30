'use client'

import { useState } from 'react'
import type { Tag } from '@line-crm/shared'
import type { FriendWithTags } from '@/lib/api'
import { api } from '@/lib/api'
import TagBadge from './tag-badge'
import StatusPicker from './status-picker'
import { detectFriendSource } from '@/lib/friend-source'

/** BOXIV: friend-name format matches Chats page (formatChatLabel):
 *  "{notion.label} {notion.realName} ({displayName})" if Notion-linked, else just displayName. */
function formatFriendLabel(f: { displayName?: string | null; metadata?: unknown }): string {
  const nick = f.displayName || '名前なし'
  let notion: { label?: string | null; realName?: string | null } | null = null
  const meta = f.metadata
  if (meta && typeof meta === 'object') {
    const n = (meta as { notion?: unknown }).notion
    if (n && typeof n === 'object') notion = n as { label?: string | null; realName?: string | null }
  } else if (typeof meta === 'string') {
    try {
      const parsed = JSON.parse(meta) as { notion?: { label?: string | null; realName?: string | null } }
      if (parsed.notion) notion = parsed.notion
    } catch { /* ignore */ }
  }
  if (!notion) return nick
  const parts: string[] = []
  if (notion.label) parts.push(notion.label)
  if (notion.realName) parts.push(notion.realName)
  if (parts.length === 0) return nick
  return `${parts.join(' ')} (${nick})`
}

interface FriendTableProps {
  friends: FriendWithTags[]
  allTags: Tag[]
  onRefresh: () => void
}

export default function FriendTable({ friends, allTags, onRefresh }: FriendTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [addingTagForFriend, setAddingTagForFriend] = useState<string | null>(null)
  const [selectedTagId, setSelectedTagId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [messageFriend, setMessageFriend] = useState<FriendWithTags | null>(null)
  const [messageContent, setMessageContent] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const [sendSuccess, setSendSuccess] = useState(false)

  async function handleSendMessage() {
    if (!messageFriend || !messageContent.trim()) return
    setSending(true)
    setSendError('')
    setSendSuccess(false)
    try {
      const res = await api.friends.sendMessage(messageFriend.id, {
        content: messageContent,
        messageType: 'text',
      })
      if (res.success) {
        setSendSuccess(true)
        setMessageContent('')
        setTimeout(() => { setMessageFriend(null); setSendSuccess(false) }, 1200)
      } else {
        setSendError(res.error || '送信に失敗しました')
      }
    } catch (e) {
      setSendError(e instanceof Error ? e.message : '送信に失敗しました')
    } finally {
      setSending(false)
    }
  }

  const toggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id)
    setAddingTagForFriend(null)
    setSelectedTagId('')
    setError('')
  }

  const handleAddTag = async (friendId: string) => {
    if (!selectedTagId) return
    setLoading(true)
    setError('')
    try {
      await api.friends.addTag(friendId, selectedTagId)
      setAddingTagForFriend(null)
      setSelectedTagId('')
      onRefresh()
    } catch {
      setError('タグの追加に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const handleRemoveTag = async (friendId: string, tagId: string) => {
    setLoading(true)
    setError('')
    try {
      await api.friends.removeTag(friendId, tagId)
      onRefresh()
    } catch {
      setError('タグの削除に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const formatDate = (iso: string) => {
    return new Date(iso).toLocaleDateString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
  }

  if (friends.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
        <p className="text-gray-500">友だちが見つかりません</p>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      {error && (
        <div className="px-4 py-3 bg-red-50 border-b border-red-100 text-red-700 text-sm">
          {error}
        </div>
      )}
      <div className="overflow-x-auto">
      <table className="w-full min-w-[640px]">
        <thead>
          <tr className="bg-gray-50 border-b border-gray-200">
            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
              アイコン / 表示名
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
              フォロー
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
              顧客ステータス
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
              タグ / 流入
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
              登録日
            </th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {friends.map((friend) => {
            const isExpanded = expandedId === friend.id
            const isAddingTag = addingTagForFriend === friend.id
            const availableTags = allTags.filter(
              (t) => !friend.tags.some((ft) => ft.id === t.id)
            )

            return (
              <>
                <tr
                  key={friend.id}
                  className="hover:bg-gray-50 cursor-pointer transition-colors"
                  onClick={() => toggleExpand(friend.id)}
                >
                  {/* Avatar + Name */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {friend.pictureUrl ? (
                        <img
                          src={friend.pictureUrl}
                          alt={friend.displayName}
                          className="w-9 h-9 rounded-full object-cover bg-gray-100"
                        />
                      ) : (
                        <div className="w-9 h-9 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 text-sm font-medium">
                          {friend.displayName?.charAt(0) ?? '?'}
                        </div>
                      )}
                      <div>
                        <p className="text-sm font-medium text-gray-900">{formatFriendLabel(friend)}</p>
                        {friend.statusMessage && (
                          <p className="text-xs text-gray-400 truncate max-w-[160px]">{friend.statusMessage}</p>
                        )}
                      </div>
                    </div>
                  </td>

                  {/* Following status */}
                  <td className="px-4 py-3">
                    {friend.isFollowing ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
                        フォロー中
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">
                        ブロック/退会
                      </span>
                    )}
                  </td>

                  {/* Customer status (Notion-synced) */}
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <StatusPicker
                      friendId={friend.id}
                      preferredSource={detectFriendSource(friend.tags)}
                      compact
                    />
                  </td>

                  {/* Tags + Ref */}
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(friend as unknown as { refCode?: string }).refCode && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
                          {(friend as unknown as { refCode: string }).refCode}
                        </span>
                      )}
                      {friend.tags.length > 0 ? (
                        friend.tags.map((tag) => <TagBadge key={tag.id} tag={tag} />)
                      ) : !((friend as unknown as { refCode?: string }).refCode) ? (
                        <span className="text-xs text-gray-400">なし</span>
                      ) : null}
                    </div>
                  </td>

                  {/* Registered date */}
                  <td className="px-4 py-3 text-sm text-gray-500">
                    {formatDate(friend.createdAt)}
                  </td>

                  {/* Expand indicator */}
                  <td className="px-4 py-3 text-right">
                    <svg
                      className={`w-4 h-4 text-gray-400 transition-transform inline-block ${isExpanded ? 'rotate-180' : ''}`}
                      fill="none" stroke="currentColor" viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </td>
                </tr>

                {/* Expanded detail row */}
                {isExpanded && (
                  <tr key={`${friend.id}-detail`} className="bg-gray-50">
                    <td colSpan={6} className="px-6 py-4">
                      <div className="space-y-3">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-semibold text-gray-500 mb-1">LINE ユーザーID</p>
                            <p className="text-xs text-gray-600 font-mono break-all">{friend.lineUserId}</p>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setMessageFriend(friend)
                              setMessageContent('')
                              setSendError('')
                              setSendSuccess(false)
                            }}
                            className="shrink-0 px-3 py-2 text-xs font-medium text-white rounded-lg hover:opacity-90 transition-opacity"
                            style={{ backgroundColor: '#0f172a' }}
                          >
                            💬 メッセージ送信
                          </button>
                        </div>

                        {/* Tag management */}
                        <div>
                          <p className="text-xs font-semibold text-gray-500 mb-2">タグ管理</p>
                          <div className="flex flex-wrap gap-1.5 mb-2">
                            {friend.tags.map((tag) => (
                              <TagBadge
                                key={tag.id}
                                tag={tag}
                                onRemove={() => handleRemoveTag(friend.id, tag.id)}
                              />
                            ))}
                          </div>

                          {isAddingTag ? (
                            <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                              <select
                                className="text-sm border border-gray-300 rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-green-500"
                                value={selectedTagId}
                                onChange={(e) => setSelectedTagId(e.target.value)}
                              >
                                <option value="">タグを選択...</option>
                                {availableTags.map((tag) => (
                                  <option key={tag.id} value={tag.id}>{tag.name}</option>
                                ))}
                              </select>
                              <button
                                onClick={() => handleAddTag(friend.id)}
                                disabled={!selectedTagId || loading}
                                className="px-3 py-1 text-xs font-medium rounded-md text-white disabled:opacity-50 transition-opacity"
                                style={{ backgroundColor: '#0f172a' }}
                              >
                                追加
                              </button>
                              <button
                                onClick={() => { setAddingTagForFriend(null); setSelectedTagId('') }}
                                className="px-3 py-1 text-xs font-medium rounded-md text-gray-600 bg-gray-200 hover:bg-gray-300 transition-colors"
                              >
                                キャンセル
                              </button>
                            </div>
                          ) : (
                            availableTags.length > 0 && (
                              <button
                                onClick={(e) => { e.stopPropagation(); setAddingTagForFriend(friend.id) }}
                                className="text-xs font-medium text-green-600 hover:text-green-700 flex items-center gap-1 transition-colors"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                                </svg>
                                タグを追加
                              </button>
                            )
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            )
          })}
        </tbody>
      </table>
      </div>

      {/* メッセージ送信モーダル */}
      {messageFriend && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onClick={() => !sending && setMessageFriend(null)}
        >
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h2 className="text-base font-bold text-gray-900">💬 メッセージを送信</h2>
              <button
                onClick={() => !sending && setMessageFriend(null)}
                className="text-gray-400 hover:text-gray-600"
                disabled={sending}
              >
                ✕
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div className="flex items-center gap-3 pb-3 border-b border-gray-100">
                {messageFriend.pictureUrl ? (
                  <img src={messageFriend.pictureUrl} alt="" className="w-10 h-10 rounded-full object-cover" />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 font-medium">
                    {messageFriend.displayName?.charAt(0) ?? '?'}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-gray-900 text-sm">{formatFriendLabel(messageFriend)}</div>
                  <div className="text-[11px] text-gray-500 font-mono break-all">{messageFriend.lineUserId}</div>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">メッセージ</label>
                <textarea
                  value={messageContent}
                  onChange={(e) => setMessageContent(e.target.value)}
                  rows={5}
                  placeholder="送信するメッセージを入力してください"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-slate-900"
                  disabled={sending}
                />
                <div className="text-[11px] text-gray-500 mt-1">
                  ※ LINE Push Message として送信されます（配信枠を消費します）
                </div>
              </div>
              {sendError && (
                <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800">
                  ⚠️ {sendError}
                </div>
              )}
              {sendSuccess && (
                <div className="px-3 py-2 bg-green-50 border border-green-200 rounded-lg text-xs text-green-800">
                  ✅ 送信完了
                </div>
              )}
              <div className="flex gap-2 pt-2">
                <button
                  onClick={() => !sending && setMessageFriend(null)}
                  disabled={sending}
                  className="flex-1 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium rounded-lg disabled:opacity-50"
                >
                  キャンセル
                </button>
                <button
                  onClick={handleSendMessage}
                  disabled={sending || !messageContent.trim()}
                  className="flex-1 px-4 py-2 text-white text-sm font-medium rounded-lg hover:opacity-90 disabled:opacity-50"
                  style={{ backgroundColor: '#0f172a' }}
                >
                  {sending ? '送信中...' : '送信'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
