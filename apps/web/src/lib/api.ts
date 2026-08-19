import type {
  Friend,
  Tag,
  Scenario,
  ScenarioStep,
  ApiResponse,
  PaginatedResponse,
  User,
  LineAccount,
  ConversionPoint,
  Affiliate,
  Template,
  Automation,
  AutomationLog,
  Chat,
  Reminder,
  ReminderStep,
  ScoringRule,
  IncomingWebhook,
  OutgoingWebhook,
  NotificationRule,
  Notification,
  AccountHealthLog,
  AccountMigration,
  StaffMember,
} from '@line-crm/shared'

import type { Broadcast } from '@line-crm/shared'
import type { RichMenu, CreateRichMenuInput } from '@line-crm/shared'

/** Broadcast type from API (now camelCase after worker serialization) */
export type ApiBroadcast = Broadcast

/** BOXIV: 連携先の Notion DB。出品者リスト / 購入者リスト。 */
export type NotionLinkSource = 'seller' | 'buyer'

/** BOXIV: friend.metadata の Notion 連携（出品者DB or 購入者DB の1行） */
export interface NotionSellerLink {
  source: NotionLinkSource
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

/** BOXIV: 出品者/購入者それぞれの連携（1人が両方を持ち得る） */
export type NotionFriendLinks = Partial<Record<NotionLinkSource, NotionSellerLink>>

/** BOXIV: 連携先の候補（Notion 出品者DB / 購入者DB の行） */
export interface NotionSellerCandidate {
  source: NotionLinkSource
  pageId: string
  /** 出品者: 掲載ID / 購入者: 商談ID */
  label: string | null
  realName: string | null
  /** 出品タイプ（出品者のみ） */
  listingType: string | null
  /** 車両（購入者のみ） */
  vehicle: string | null
  status: string | null
  /** 'name' は LINE User ID 未記入の行を名前で拾った弱い一致 */
  matchedBy: 'lineUserId' | 'name'
  createdTime: string | null
  lastEditedTime: string | null
  url: string | null
}

/** BOXIV: DB 1つ分の候補。出品者/購入者を常に併記するため group 単位で返る。 */
export interface NotionCandidateGroup {
  source: NotionLinkSource
  candidates: NotionSellerCandidate[]
  /** そのDBだけ取得に失敗したときの理由（もう片方は表示できる） */
  error: string | null
  linkedPageId: string | null
  pinned: boolean
}

const API_URL = process.env.NEXT_PUBLIC_API_URL
if (!API_URL) {
  throw new Error(
    'NEXT_PUBLIC_API_URL is not set. Build cannot proceed without a valid API URL. ' +
    'Set it in .env.production (local) or GitHub Secrets (CI).'
  )
}

/**
 * 認証トークンは lib/auth.ts が唯一の出所（メールログインのセッション →
 * 無ければ旧 API キー）。秘密情報を NEXT_PUBLIC_* でバンドルに焼かないこと。
 *
 * ⚠️ このファイルで生の fetch を書くときも必ず authHeaders() を通すこと。
 *    以前は Authorization を直書きした fetch が 3 箇所あり、方式を変えるたびに
 *    そこだけ古い読み方のまま取り残される構造になっていた。
 */
export { getAuthToken, authHeaders } from './auth'
import { authHeaders, handleUnauthorized } from './auth'

/**
 * 401 の共通処理。セッションは Worker 側で失効させられる（無効化 / ロール変更 /
 * メール変更 / ログアウト）ので 401 は通常の遷移として起きる。死んだトークンのまま
 * 叩き続けないよう、ここで破棄してログイン画面へ送る。
 */
function onUnauthorized(): void {
  handleUnauthorized()
}

export type FetchApiOptions = RequestInit & {
  /**
   * 401 を共通処理（トークン破棄 → /login）に流さない。
   *
   * ログイン API のように 401 が「資格情報の不一致」を意味するだけの口で使う。
   * これを付けないと、6 桁の打ち間違いが「保存済みトークンの破棄」に化ける。
   * handleUnauthorized 側でも /login では破棄しないようにしてあるが、
   * ログイン API がログイン画面以外から呼ばれても壊れないよう二重に防いでいる。
   */
  skipUnauthorizedHandling?: boolean
}

export async function fetchApi<T>(path: string, options?: FetchApiOptions): Promise<T> {
  const { skipUnauthorizedHandling, ...init } = options ?? {}
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...init.headers,
    },
  })
  if (!res.ok) {
    if (res.status === 401 && !skipUnauthorizedHandling) onUnauthorized()
    // API の { error } 本文を拾って原因を出す（従来は status のみで「API error: 400」と原因不明だった）
    let detail = ''
    try {
      const body = (await res.json()) as { error?: string }
      if (body?.error) detail = `: ${body.error}`
    } catch { /* non-JSON body */ }
    throw new Error(`API error: ${res.status}${detail}`)
  }
  return res.json() as Promise<T>
}

export type FriendListParams = {
  offset?: string
  limit?: string
  tagId?: string
  accountId?: string
  statusOptionId?: string
  search?: string
}

export type FriendWithTags = Friend & { tags: Tag[] }

export const api = {
  friends: {
    list: (params?: FriendListParams) => {
      const query: Record<string, string> = {}
      if (params?.offset) query.offset = params.offset
      if (params?.limit) query.limit = params.limit
      if (params?.tagId) query.tagId = params.tagId
      if (params?.accountId) query.lineAccountId = params.accountId
      if (params?.statusOptionId) query.statusOptionId = params.statusOptionId
      if (params?.search) query.search = params.search
      return fetchApi<ApiResponse<PaginatedResponse<FriendWithTags>>>(
        '/api/friends?' + new URLSearchParams(query)
      )
    },
    get: (id: string) =>
      fetchApi<ApiResponse<FriendWithTags>>(`/api/friends/${id}`),
    sendMessage: (id: string, data: { content: string; messageType?: string; altText?: string }) =>
      fetchApi<ApiResponse<{ messageId: string }>>(`/api/friends/${id}/messages`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: { managedName?: string | null }) =>
      fetchApi<ApiResponse<FriendWithTags>>(`/api/friends/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    count: (params?: { accountId?: string }) => {
      const query = params?.accountId ? '?lineAccountId=' + params.accountId : ''
      return fetchApi<ApiResponse<{ count: number }>>('/api/friends/count' + query)
    },
    addTag: (friendId: string, tagId: string) =>
      fetchApi<ApiResponse<null>>(`/api/friends/${friendId}/tags`, {
        method: 'POST',
        body: JSON.stringify({ tagId }),
      }),
    removeTag: (friendId: string, tagId: string) =>
      fetchApi<ApiResponse<null>>(`/api/friends/${friendId}/tags/${tagId}`, {
        method: 'DELETE',
      }),
  },
  tags: {
    list: () =>
      fetchApi<ApiResponse<Tag[]>>('/api/tags'),
    create: (data: { name: string; color: string }) =>
      fetchApi<ApiResponse<Tag>>('/api/tags', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/tags/${id}`, { method: 'DELETE' }),
  },
  scenarios: {
    list: (params?: { accountId?: string }) => {
      const query = params?.accountId ? '?lineAccountId=' + params.accountId : ''
      return fetchApi<ApiResponse<(Scenario & { stepCount?: number })[]>>('/api/scenarios' + query)
    },
    get: (id: string) =>
      fetchApi<ApiResponse<Scenario & { steps: ScenarioStep[] }>>(`/api/scenarios/${id}`),
    create: (data: Omit<Scenario, 'id' | 'createdAt' | 'updatedAt'> & { lineAccountId?: string }) =>
      fetchApi<ApiResponse<Scenario>>('/api/scenarios', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<Omit<Scenario, 'id' | 'createdAt' | 'updatedAt'>>) =>
      fetchApi<ApiResponse<Scenario>>(`/api/scenarios/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/scenarios/${id}`, { method: 'DELETE' }),
    addStep: (id: string, data: Omit<ScenarioStep, 'id' | 'scenarioId' | 'createdAt'>) =>
      fetchApi<ApiResponse<ScenarioStep>>(`/api/scenarios/${id}/steps`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    updateStep: (
      id: string,
      stepId: string,
      data: Partial<Omit<ScenarioStep, 'id' | 'scenarioId' | 'createdAt'>>
    ) =>
      fetchApi<ApiResponse<ScenarioStep>>(`/api/scenarios/${id}/steps/${stepId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    deleteStep: (id: string, stepId: string) =>
      fetchApi<ApiResponse<null>>(`/api/scenarios/${id}/steps/${stepId}`, {
        method: 'DELETE',
      }),
  },
  broadcasts: {
    list: (params?: { accountId?: string }) => {
      const query = params?.accountId ? '?lineAccountId=' + params.accountId : ''
      return fetchApi<ApiResponse<ApiBroadcast[]>>('/api/broadcasts' + query)
    },
    get: (id: string) =>
      fetchApi<ApiResponse<ApiBroadcast>>(`/api/broadcasts/${id}`),
    create: (data: {
      title: string
      messageType: ApiBroadcast['messageType']
      messageContent: string
      targetType: ApiBroadcast['targetType']
      targetTagId?: string | null
      scheduledAt?: string | null
      status?: ApiBroadcast['status']
    }) =>
      fetchApi<ApiResponse<ApiBroadcast>>('/api/broadcasts', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (
      id: string,
      data: {
        title?: string
        messageType?: ApiBroadcast['messageType']
        messageContent?: string
        targetType?: ApiBroadcast['targetType']
        targetTagId?: string | null
        scheduledAt?: string | null
      }
    ) =>
      fetchApi<ApiResponse<ApiBroadcast>>(`/api/broadcasts/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/broadcasts/${id}`, { method: 'DELETE' }),
    send: (id: string) =>
      fetchApi<ApiResponse<ApiBroadcast>>(`/api/broadcasts/${id}/send`, { method: 'POST' }),
  },

  // ── Round 2 APIs ─────────────────────────────────────────────────────────
  users: {
    list: () =>
      fetchApi<ApiResponse<User[]>>('/api/users'),
    get: (id: string) =>
      fetchApi<ApiResponse<User>>(`/api/users/${id}`),
    create: (data: { email?: string | null; phone?: string | null; externalId?: string | null; displayName?: string | null }) =>
      fetchApi<ApiResponse<User>>('/api/users', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<Pick<User, 'email' | 'phone' | 'externalId' | 'displayName'>>) =>
      fetchApi<ApiResponse<User>>(`/api/users/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/users/${id}`, { method: 'DELETE' }),
    link: (userId: string, friendId: string) =>
      fetchApi<ApiResponse<null>>(`/api/users/${userId}/link`, {
        method: 'POST',
        body: JSON.stringify({ friendId }),
      }),
    accounts: (userId: string) =>
      fetchApi<ApiResponse<{ id: string; lineUserId: string; displayName: string | null; isFollowing: boolean }[]>>(
        `/api/users/${userId}/accounts`,
      ),
  },
  lineAccounts: {
    list: () =>
      fetchApi<ApiResponse<LineAccount[]>>('/api/line-accounts'),
    get: (id: string) =>
      fetchApi<ApiResponse<LineAccount>>(`/api/line-accounts/${id}`),
    create: (data: { channelId: string; name: string; channelAccessToken: string; channelSecret: string }) =>
      fetchApi<ApiResponse<LineAccount>>('/api/line-accounts', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<Pick<LineAccount, 'name' | 'channelAccessToken' | 'channelSecret' | 'isActive'>>) =>
      fetchApi<ApiResponse<LineAccount>>(`/api/line-accounts/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/line-accounts/${id}`, { method: 'DELETE' }),
  },
  conversions: {
    points: () =>
      fetchApi<ApiResponse<ConversionPoint[]>>('/api/conversions/points'),
    createPoint: (data: { name: string; eventType: string; value?: number | null }) =>
      fetchApi<ApiResponse<ConversionPoint>>('/api/conversions/points', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    deletePoint: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/conversions/points/${id}`, { method: 'DELETE' }),
    track: (data: { conversionPointId: string; friendId: string; userId?: string | null; affiliateCode?: string | null; metadata?: Record<string, unknown> | null }) =>
      fetchApi<ApiResponse<unknown>>('/api/conversions/track', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    report: (params?: { startDate?: string; endDate?: string }) =>
      fetchApi<ApiResponse<{ conversionPointId: string; conversionPointName: string; eventType: string; totalCount: number; totalValue: number }[]>>(
        '/api/conversions/report?' + new URLSearchParams(params as Record<string, string>),
      ),
  },
  affiliates: {
    list: () =>
      fetchApi<ApiResponse<Affiliate[]>>('/api/affiliates'),
    get: (id: string) =>
      fetchApi<ApiResponse<Affiliate>>(`/api/affiliates/${id}`),
    create: (data: { name: string; code: string; commissionRate?: number }) =>
      fetchApi<ApiResponse<Affiliate>>('/api/affiliates', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<Pick<Affiliate, 'name' | 'commissionRate' | 'isActive'>>) =>
      fetchApi<ApiResponse<Affiliate>>(`/api/affiliates/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/affiliates/${id}`, { method: 'DELETE' }),
    report: (id: string, params?: { startDate?: string; endDate?: string }) =>
      fetchApi<ApiResponse<{ affiliateId: string; affiliateName: string; code: string; commissionRate: number; totalClicks: number; totalConversions: number; totalRevenue: number }>>(
        `/api/affiliates/${id}/report?` + new URLSearchParams(params as Record<string, string>),
      ),
  },
  templates: {
    list: (category?: string) =>
      fetchApi<ApiResponse<{ id: string; name: string; category: string; messageType: string; messageContent: string; createdAt: string; updatedAt: string }[]>>(
        '/api/templates' + (category ? '?' + new URLSearchParams({ category }) : ''),
      ),
    get: (id: string) =>
      fetchApi<ApiResponse<{ id: string; name: string; category: string; messageType: string; messageContent: string; createdAt: string; updatedAt: string }>>(
        `/api/templates/${id}`,
      ),
    create: (data: { name: string; category: string; messageType: string; messageContent: string }) =>
      fetchApi<ApiResponse<{ id: string; name: string; category: string; messageType: string; messageContent: string; createdAt: string; updatedAt: string }>>(
        '/api/templates',
        { method: 'POST', body: JSON.stringify(data) },
      ),
    update: (id: string, data: Partial<{ name: string; category: string; messageType: string; messageContent: string }>) =>
      fetchApi<ApiResponse<{ id: string; name: string; category: string; messageType: string; messageContent: string; createdAt: string; updatedAt: string }>>(
        `/api/templates/${id}`,
        { method: 'PUT', body: JSON.stringify(data) },
      ),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/templates/${id}`, { method: 'DELETE' }),
    reorder: (ids: string[]) =>
      fetchApi<ApiResponse<null>>('/api/templates/reorder', {
        method: 'PUT',
        body: JSON.stringify({ ids }),
      }),
  },
  templateCategories: {
    list: () =>
      fetchApi<ApiResponse<{ id: string | null; name: string; sortOrder: number }[]>>('/api/template-categories'),
    reorder: (names: string[]) =>
      fetchApi<ApiResponse<{ id: string | null; name: string; sortOrder: number }[]>>('/api/template-categories/reorder', {
        method: 'PUT',
        body: JSON.stringify({ names }),
      }),
  },
  automations: {
    list: (params?: { accountId?: string }) => {
      const query = params?.accountId ? '?lineAccountId=' + params.accountId : ''
      return fetchApi<ApiResponse<Automation[]>>('/api/automations' + query)
    },
    get: (id: string) =>
      fetchApi<ApiResponse<Automation & { logs?: AutomationLog[] }>>(`/api/automations/${id}`),
    create: (data: {
      name: string
      eventType: Automation['eventType']
      actions: Automation['actions']
      description?: string | null
      conditions?: Record<string, unknown>
      priority?: number
    }) =>
      fetchApi<ApiResponse<Automation>>('/api/automations', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<Pick<Automation, 'name' | 'description' | 'eventType' | 'conditions' | 'actions' | 'isActive' | 'priority'>>) =>
      fetchApi<ApiResponse<Automation>>(`/api/automations/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/automations/${id}`, { method: 'DELETE' }),
    logs: (id: string, limit?: number) =>
      fetchApi<ApiResponse<AutomationLog[]>>(
        `/api/automations/${id}/logs` + (limit ? `?limit=${limit}` : ''),
      ),
  },
  chats: {
    list: (params?: { status?: string; operatorId?: string; accountId?: string; statusOptionId?: string }) => {
      const query: Record<string, string> = {}
      if (params?.status) query.status = params.status
      if (params?.operatorId) query.operatorId = params.operatorId
      if (params?.accountId) query.lineAccountId = params.accountId
      if (params?.statusOptionId) query.statusOptionId = params.statusOptionId
      return fetchApi<ApiResponse<Chat[]>>(
        '/api/chats?' + new URLSearchParams(query),
      )
    },
    get: (id: string) =>
      fetchApi<ApiResponse<Chat & { messages?: { id: string; content: string; senderType: string; createdAt: string }[] }>>(
        `/api/chats/${id}`,
      ),
    create: (data: { friendId: string; operatorId?: string | null }) =>
      fetchApi<ApiResponse<Chat>>('/api/chats', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: { operatorId?: string | null; status?: Chat['status']; notes?: string | null }) =>
      fetchApi<ApiResponse<Chat>>(`/api/chats/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    send: (id: string, data: { content: string; messageType?: string }) =>
      fetchApi<ApiResponse<unknown>>(`/api/chats/${id}/send`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    /** チャットを既読にする（未読数を 0 に戻す） */
    markRead: (id: string) =>
      fetchApi<ApiResponse<{ id: string; lastReadAt: string }>>(`/api/chats/${id}/read`, {
        method: 'POST',
      }),
    /**
     * Notion 出品者DB / 購入者DB との連携。pageId を渡すとその行に固定する（pinned）。
     * source は問い合わせ先DBのヒント（省略時は pageId から判定、pageId も無ければ出品者の自動判定）。
     */
    notionLink: (friendId: string, pageId?: string, source?: NotionLinkSource) =>
      fetchApi<ApiResponse<{
        linked: boolean
        message?: string
        link?: NotionSellerLink
      }>>(`/api/friends/${friendId}/notion-link`, {
        method: 'POST',
        ...(pageId ? { body: JSON.stringify({ pageId, ...(source ? { source } : {}) }) } : {}),
      }),
    /**
     * 連携先の候補。出品者リスト / 購入者リストの両方を groups で常に併記して返す。
     * candidates / linkedPageId / pinned は旧 web 互換の出品者分（worker 先行デプロイ時の保険）。
     */
    notionCandidates: (friendId: string) =>
      fetchApi<ApiResponse<{
        groups?: NotionCandidateGroup[]
        candidates: NotionSellerCandidate[]
        linkedPageId: string | null
        pinned: boolean
      }>>(`/api/friends/${friendId}/notion-candidates`),
  },
  reminders: {
    list: (params?: { accountId?: string }) => {
      const query = params?.accountId ? '?lineAccountId=' + params.accountId : ''
      return fetchApi<ApiResponse<Reminder[]>>('/api/reminders' + query)
    },
    get: (id: string) =>
      fetchApi<ApiResponse<Reminder & { steps: ReminderStep[] }>>(`/api/reminders/${id}`),
    create: (data: { name: string; description?: string | null }) =>
      fetchApi<ApiResponse<Reminder>>('/api/reminders', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<Pick<Reminder, 'name' | 'description' | 'isActive'>>) =>
      fetchApi<ApiResponse<Reminder>>(`/api/reminders/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/reminders/${id}`, { method: 'DELETE' }),
    addStep: (id: string, data: { offsetMinutes: number; messageType: string; messageContent: string }) =>
      fetchApi<ApiResponse<ReminderStep>>(`/api/reminders/${id}/steps`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    deleteStep: (reminderId: string, stepId: string) =>
      fetchApi<ApiResponse<null>>(`/api/reminders/${reminderId}/steps/${stepId}`, {
        method: 'DELETE',
      }),
    enrollFriend: (reminderId: string, friendId: string, data: { targetDate: string }) =>
      fetchApi<ApiResponse<{ id: string; friendId: string; reminderId: string; targetDate: string; status: string }>>(
        `/api/reminders/${reminderId}/enroll/${friendId}`,
        { method: 'POST', body: JSON.stringify(data) },
      ),
    listFriendReminders: (friendId: string) =>
      fetchApi<ApiResponse<Array<{
        friendReminderId: string
        reminderId: string
        reminderName: string
        reminderIsActive: boolean
        targetDate: string
        status: string
        totalSteps: number
        deliveredSteps: number
      }>>>(`/api/friends/${friendId}/reminders?expand=steps`),
    cancelFriendReminder: (friendReminderId: string) =>
      fetchApi<ApiResponse<null>>(`/api/friend-reminders/${friendReminderId}`, { method: 'DELETE' }),
    listReminderFriends: (reminderId: string, status?: 'active' | 'completed' | 'cancelled') => {
      const q = status ? `?status=${status}` : ''
      return fetchApi<ApiResponse<Array<{
        friendReminderId: string
        friendId: string
        friendDisplayName: string | null
        targetDate: string
        status: string
        totalSteps: number
        deliveredSteps: number
      }>>>(`/api/reminders/${reminderId}/friends${q}`)
    },
  },
  scoring: {
    rules: () =>
      fetchApi<ApiResponse<ScoringRule[]>>('/api/scoring-rules'),
    getRule: (id: string) =>
      fetchApi<ApiResponse<ScoringRule>>(`/api/scoring-rules/${id}`),
    createRule: (data: { name: string; eventType: string; scoreValue: number }) =>
      fetchApi<ApiResponse<ScoringRule>>('/api/scoring-rules', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    updateRule: (id: string, data: Partial<Pick<ScoringRule, 'name' | 'eventType' | 'scoreValue' | 'isActive'>>) =>
      fetchApi<ApiResponse<ScoringRule>>(`/api/scoring-rules/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    deleteRule: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/scoring-rules/${id}`, { method: 'DELETE' }),
    friendScore: (friendId: string) =>
      fetchApi<ApiResponse<{ totalScore: number; history: { id: string; scoreChange: number; reason: string | null; createdAt: string }[] }>>(
        `/api/friends/${friendId}/score`,
      ),
  },
  webhooks: {
    incoming: {
      list: () =>
        fetchApi<ApiResponse<IncomingWebhook[]>>('/api/webhooks/incoming'),
      create: (data: { name: string; sourceType?: string; secret?: string | null }) =>
        fetchApi<ApiResponse<IncomingWebhook>>('/api/webhooks/incoming', {
          method: 'POST',
          body: JSON.stringify(data),
        }),
      update: (id: string, data: Partial<Pick<IncomingWebhook, 'name' | 'sourceType' | 'isActive'>>) =>
        fetchApi<ApiResponse<IncomingWebhook>>(`/api/webhooks/incoming/${id}`, {
          method: 'PUT',
          body: JSON.stringify(data),
        }),
      delete: (id: string) =>
        fetchApi<ApiResponse<null>>(`/api/webhooks/incoming/${id}`, { method: 'DELETE' }),
    },
    outgoing: {
      list: () =>
        fetchApi<ApiResponse<OutgoingWebhook[]>>('/api/webhooks/outgoing'),
      create: (data: { name: string; url: string; eventTypes: string[]; secret?: string | null }) =>
        fetchApi<ApiResponse<OutgoingWebhook>>('/api/webhooks/outgoing', {
          method: 'POST',
          body: JSON.stringify(data),
        }),
      update: (id: string, data: Partial<Pick<OutgoingWebhook, 'name' | 'url' | 'eventTypes' | 'isActive'>>) =>
        fetchApi<ApiResponse<OutgoingWebhook>>(`/api/webhooks/outgoing/${id}`, {
          method: 'PUT',
          body: JSON.stringify(data),
        }),
      delete: (id: string) =>
        fetchApi<ApiResponse<null>>(`/api/webhooks/outgoing/${id}`, { method: 'DELETE' }),
    },
  },
  notifications: {
    rules: {
      list: () =>
        fetchApi<ApiResponse<NotificationRule[]>>('/api/notifications/rules'),
      get: (id: string) =>
        fetchApi<ApiResponse<NotificationRule>>(`/api/notifications/rules/${id}`),
      create: (data: { name: string; eventType: string; conditions?: Record<string, unknown>; channels?: string[] }) =>
        fetchApi<ApiResponse<NotificationRule>>('/api/notifications/rules', {
          method: 'POST',
          body: JSON.stringify(data),
        }),
      update: (id: string, data: Partial<Pick<NotificationRule, 'name' | 'eventType' | 'conditions' | 'channels' | 'isActive'>>) =>
        fetchApi<ApiResponse<NotificationRule>>(`/api/notifications/rules/${id}`, {
          method: 'PUT',
          body: JSON.stringify(data),
        }),
      delete: (id: string) =>
        fetchApi<ApiResponse<null>>(`/api/notifications/rules/${id}`, { method: 'DELETE' }),
    },
    list: (params?: { status?: string; limit?: string }) =>
      fetchApi<ApiResponse<Notification[]>>(
        '/api/notifications?' + new URLSearchParams(params as Record<string, string>),
      ),
  },
  health: {
    accounts: () =>
      fetchApi<ApiResponse<LineAccount[]>>('/api/line-accounts'),
    getHealth: (accountId: string) =>
      fetchApi<ApiResponse<{ riskLevel: string; logs: AccountHealthLog[] }>>(
        `/api/accounts/${accountId}/health`,
      ),
    migrations: () =>
      fetchApi<ApiResponse<AccountMigration[]>>('/api/accounts/migrations'),
    migrate: (fromAccountId: string, data: { toAccountId: string }) =>
      fetchApi<ApiResponse<AccountMigration>>(`/api/accounts/${fromAccountId}/migrate`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    getMigration: (migrationId: string) =>
      fetchApi<ApiResponse<AccountMigration>>(`/api/accounts/migrations/${migrationId}`),
  },
  staff: {
    list: () =>
      fetchApi<ApiResponse<StaffMember[]>>('/api/staff'),
    get: (id: string) =>
      fetchApi<ApiResponse<StaffMember>>(`/api/staff/${id}`),
    me: () =>
      fetchApi<ApiResponse<{ id: string; name: string; role: string; email: string | null; workArea: string | null }>>('/api/staff/me'),
    create: (data: { name: string; email?: string; role: 'admin' | 'staff' }) =>
      fetchApi<ApiResponse<StaffMember>>('/api/staff', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: { name?: string; email?: string | null; role?: string; isActive?: boolean }) =>
      fetchApi<ApiResponse<StaffMember>>(`/api/staff/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/staff/${id}`, { method: 'DELETE' }),
    regenerateKey: (id: string) =>
      fetchApi<ApiResponse<{ apiKey: string }>>(`/api/staff/${id}/regenerate-key`, { method: 'POST' }),
    /**
     * 管理者による救済コード発行（BOXIV）。メールが届かない人を口頭 / LINE で入れるための経路。
     * 発行者名は必ず変更ログと Slack に残る。上位ロールは対象にできない。
     */
    issueLoginCode: (id: string) =>
      fetchApi<ApiResponse<{
        code: string
        expiresAt: string
        staff: { id: string; name: string; email: string | null; role: string }
      }>>(`/api/staff/${id}/login-code`, { method: 'POST' }),
  },
  /** 管理画面のログイン（メール6桁コード・BOXIV） */
  auth: {
    /**
     * コードを送る。宛先の存在にかかわらず常に同じ成功応答が返る
     * （誰が管理画面に入れるかを外から列挙させないため）。
     */
    start: (email: string) =>
      fetchApi<ApiResponse<{ message: string }>>('/api/auth/email/start', {
        method: 'POST',
        body: JSON.stringify({ email }),
        skipUnauthorizedHandling: true,
      }),
    /** コードを検証してセッションを受け取る。失敗理由は区別せず 401 のみ。 */
    verify: (email: string, code: string) =>
      fetchApi<ApiResponse<{
        token: string
        expiresAt: string
        staff: { id: string; name: string; role: string; email: string | null; workArea: string | null }
      }>>('/api/auth/email/verify', {
        method: 'POST',
        body: JSON.stringify({ email, code }),
        // 401 = コードが合わない、というだけ。ここを共通処理に流すと
        // 打ち間違い 1 回で保存済みの旧 API キーまで消える。
        skipUnauthorizedHandling: true,
      }),
    session: () =>
      fetchApi<ApiResponse<{
        staff: { id: string; name: string; role: string }
        authVia: 'session' | 'api_key' | 'env_key' | null
        sessionId: string | null
        sessions: Array<{
          id: string
          issuedVia: string
          userAgent: string | null
          ip: string | null
          createdAt: string
          lastUsedAt: string | null
          expiresAt: string
        }>
      }>>('/api/auth/session'),
    /**
     * メールアドレス + パスワード（＝APIキー）でログインする。
     *
     * ⚠️ セキュリティ上の 2 要素ではない。authMiddleware は従来どおりキー単体で認証を通す
     *    （機械クライアントがその経路を使うため変えられない）。メールアドレスの一致確認は
     *    ログイン画面の入口を揃えるための UI 上の確認。
     */
    password: (email: string, password: string) =>
      fetchApi<ApiResponse<{
        staff: { id: string; name: string; role: string; email: string | null; workArea: string | null }
      }>>('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
        // 401 = 資格情報が合わない、というだけ。共通処理に流すと保存済みトークンが消える。
        skipUnauthorizedHandling: true,
      }),
    logout: () =>
      fetchApi<ApiResponse<{ revoked: number }>>('/api/auth/logout', { method: 'POST', body: '{}' }),
  },
  staffAvailability: {
    list: (params?: { staffId?: string; date?: string; dateFrom?: string; dateTo?: string; area?: string; includeBooked?: boolean }) => {
      const query: Record<string, string> = {}
      if (params?.staffId) query.staffId = params.staffId
      if (params?.date) query.date = params.date
      if (params?.dateFrom) query.dateFrom = params.dateFrom
      if (params?.dateTo) query.dateTo = params.dateTo
      if (params?.area) query.area = params.area
      if (params?.includeBooked) query.includeBooked = 'true'
      const qs = new URLSearchParams(query).toString()
      return fetchApi<ApiResponse<Array<{
        id: string; staffId: string; staffName: string | null; date: string;
        startTime: string; endTime: string; area: string; isBooked: boolean; createdAt: string;
      }>>>('/api/staff-availability' + (qs ? '?' + qs : ''))
    },
    create: (data: { staffId: string; date: string; startTime: string; endTime: string; area: string }) =>
      fetchApi<ApiResponse<unknown>>('/api/staff-availability', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    bulkCreate: (data: { staffId: string; area: string; dates: string[]; slots: { startTime: string; endTime: string }[] }) =>
      fetchApi<ApiResponse<{ count: number }>>('/api/staff-availability/bulk', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<{ staffId: string; date: string; startTime: string; endTime: string; area: string }>) =>
      fetchApi<ApiResponse<unknown>>(`/api/staff-availability/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/staff-availability/${id}`, { method: 'DELETE' }),
  },
  bookingRequests: {
    list: (params?: { status?: string; area?: string; staffId?: string; dateFrom?: string; dateTo?: string }) => {
      const query: Record<string, string> = {}
      if (params?.status) query.status = params.status
      if (params?.area) query.area = params.area
      if (params?.staffId) query.staffId = params.staffId
      if (params?.dateFrom) query.dateFrom = params.dateFrom
      if (params?.dateTo) query.dateTo = params.dateTo
      const qs = new URLSearchParams(query).toString()
      return fetchApi<ApiResponse<Array<{
        id: string; friendId: string | null; friendName: string | null;
        staffId: string | null; staffName: string | null;
        inviteToken: string; customerName: string | null; prefecture: string; area: string;
        vehicleInfo: string | null;
        slot: { id: string; date: string; startTime: string; endTime: string; area: string } | null;
        plateNumber: string | null; status: string; notes: string | null;
        approvedBy: string | null; approvedAt: string | null;
        createdAt: string; updatedAt: string;
      }>>>('/api/booking-requests' + (qs ? '?' + qs : ''))
    },
    /** 承認待ち件数（サイドバーの赤バッジ用）。件数だけを軽量に取得する。 */
    pendingCount: () =>
      fetchApi<ApiResponse<{ count: number }>>('/api/booking-requests/pending-count'),
    get: (id: string) =>
      fetchApi<ApiResponse<{
        id: string; status: string; plate_number: string | null; customer_name: string | null;
        prefecture: string; area: string; vehicle_info: string | null; notes: string | null;
        friend_id: string | null; staff_id: string | null; friend_name: string | null; staff_name: string | null;
        candidate_1_date: string | null; candidate_1_start: string | null; candidate_1_end: string | null;
        candidate_2_date: string | null; candidate_2_start: string | null; candidate_2_end: string | null;
        candidate_3_date: string | null; candidate_3_start: string | null; candidate_3_end: string | null;
        selected_candidate: number | null;
        slot: { id: string; date: string; start_time: string; end_time: string; area: string } | null;
        alternativeStaff: Array<{ availabilityId: string; staffId: string; staffName: string | null }>;
      }>>(`/api/booking-requests/${id}`),
    update: (id: string, data: { staffId?: string; slotId?: string; plateNumber?: string; notes?: string; status?: string }) =>
      fetchApi<ApiResponse<unknown>>(`/api/booking-requests/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    approve: (id: string, selectedCandidate?: 1 | 2 | 3) =>
      fetchApi<ApiResponse<unknown>>(`/api/booking-requests/${id}/approve`, {
        method: 'PUT',
        body: JSON.stringify(selectedCandidate ? { selectedCandidate } : {}),
      }),
    reject: (id: string, notes?: string) =>
      fetchApi<ApiResponse<unknown>>(`/api/booking-requests/${id}/reject`, {
        method: 'PUT',
        body: JSON.stringify({ notes }),
      }),
    /** 承認済み日程のキャンセル（雨天中止など）。owner/admin/manager のみ。出品者にキャンセル通知を送信。 */
    cancel: (id: string, reason?: string) =>
      fetchApi<ApiResponse<unknown>>(`/api/booking-requests/${id}/cancel`, {
        method: 'PUT',
        body: JSON.stringify({ reason }),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/booking-requests/${id}`, { method: 'DELETE' }),
  },
  bookingInvites: {
    create: (data: { lineUserId?: string; friendId?: string; customerName?: string; prefecture: string; vehicleInfo?: string | Record<string, unknown>; sendLineMessage?: boolean }) =>
      fetchApi<ApiResponse<{ id: string; token: string; url: string; area: string; customerName: string | null; prefecture: string; friendId: string }>>(
        '/api/booking-invites',
        { method: 'POST', body: JSON.stringify(data) },
      ),
    /** friendId だけで送信（顧客名/都道府県は Notion から補完）。オペレーターチャットの日程調整フロー開始用。 */
    send: (friendId: string) =>
      fetchApi<ApiResponse<{ id: string; token: string; url: string; area: string; customerName: string | null; prefecture: string | null; friendId: string }>>(
        '/api/booking-invites',
        { method: 'POST', body: JSON.stringify({ friendId, sendLineMessage: true }) },
      ),
  },
  // チャット用メディアアップロード (BOXIV — image / video / PDF)
  media: {
    async upload(file: File): Promise<ApiResponse<{
      id: string
      key: string
      url: string
      kind: 'image' | 'video' | 'file'
      mimeType: string
      filename: string | null
      size: number
    }>> {
      const form = new FormData()
      form.append('file', file)
      // multipart は Content-Type をブラウザに決めさせる（boundary が要る）ので
      // fetchApi は通さない。認証ヘッダだけは共通の authHeaders() から取る。
      const res = await fetch(`${API_URL}/api/media`, {
        method: 'POST',
        headers: authHeaders(),
        body: form,
      })
      if (res.status === 401) onUnauthorized()
      return res.json()
    },
  },
  // 個別チャット送信予約 (BOXIV)
  scheduledMessages: {
    list: (friendId: string, status?: 'scheduled' | 'sent' | 'cancelled' | 'failed') => {
      const q = status ? `?status=${status}` : ''
      return fetchApi<ApiResponse<Array<{
        id: string
        friendId: string
        scheduledAt: string
        messageType: 'text' | 'image' | 'flex'
        content: string
        status: 'scheduled' | 'sent' | 'cancelled' | 'failed'
        sentAt: string | null
        error: string | null
        createdBy: string | null
        createdAt: string
        updatedAt: string
      }>>>(`/api/friends/${friendId}/scheduled-messages${q}`)
    },
    create: (friendId: string, data: { scheduledAt: string; messageType: 'text' | 'image' | 'flex'; content: string }) =>
      fetchApi<ApiResponse<{
        id: string
        friendId: string
        scheduledAt: string
        messageType: string
        content: string
        status: string
      }>>(`/api/friends/${friendId}/scheduled-messages`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    cancel: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/scheduled-messages/${id}`, { method: 'DELETE' }),
  },
  // リッチメニュー (LINE Platform 管理 — D1 永続化なし)
  richMenus: {
    list: () =>
      fetchApi<ApiResponse<RichMenu[]>>('/api/rich-menus'),
    create: (data: CreateRichMenuInput) =>
      fetchApi<ApiResponse<{ richMenuId: string }>>('/api/rich-menus', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/rich-menus/${id}`, { method: 'DELETE' }),
    setDefault: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/rich-menus/${id}/default`, { method: 'POST' }),
    uploadImage: (id: string, image: string, contentType: 'image/png' | 'image/jpeg' = 'image/png') =>
      fetchApi<ApiResponse<null>>(`/api/rich-menus/${id}/image`, {
        method: 'POST',
        body: JSON.stringify({ image, contentType }),
      }),
    // BOXIV: LINE がホストしている画像本体を Blob で取得（プレビュー / 編集キャンバス背景用）。
    // 画像未登録なら 404 → null。Bearer 認証が必要なので fetchApi ではなく素の fetch を使う。
    fetchImage: async (id: string): Promise<Blob | null> => {
      const res = await fetch(`${API_URL}/api/rich-menus/${id}/image-content`, {
        headers: authHeaders(),
      })
      if (res.status === 401) { onUnauthorized(); return null }
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`fetchImage failed: ${res.status}`)
      return res.blob()
    },
    // BOXIV: LINE Platform 上で現在アカウント既定になっている richMenuId（無ければ null）。
    getDefault: () =>
      fetchApi<ApiResponse<{ richMenuId: string | null }>>('/api/rich-menus/default'),
    getAssignedTo: (friendId: string) =>
      fetchApi<ApiResponse<{ richMenuId: string } | null>>(`/api/friends/${friendId}/rich-menu`),
    assignToFriend: (friendId: string, richMenuId: string) =>
      fetchApi<ApiResponse<null>>(`/api/friends/${friendId}/rich-menu`, {
        method: 'POST',
        body: JSON.stringify({ richMenuId }),
      }),
    unassignFromFriend: (friendId: string) =>
      fetchApi<ApiResponse<null>>(`/api/friends/${friendId}/rich-menu`, {
        method: 'DELETE',
      }),
    // ステータス連動マッピング (BOXIV カスタム)
    autoSwitch: {
      list: () =>
        fetchApi<ApiResponse<Array<{
          id: string
          statusOptionId: string
          statusOptionName?: string
          statusOptionSource?: 'seller' | 'buyer'
          richMenuId: string
          richMenuName: string | null
          lineAccountId: string | null
          isActive: boolean
          createdAt: string
          updatedAt: string
        }>>>('/api/rich-menus/auto-switch'),
      upsert: (
        statusOptionId: string,
        data: { richMenuId: string; richMenuName?: string | null; lineAccountId?: string | null; isActive?: boolean },
      ) =>
        fetchApi<ApiResponse<unknown>>(`/api/rich-menus/auto-switch/${encodeURIComponent(statusOptionId)}`, {
          method: 'PUT',
          body: JSON.stringify(data),
        }),
      delete: (statusOptionId: string, lineAccountId?: string | null) => {
        const q = lineAccountId ? `?lineAccountId=${encodeURIComponent(lineAccountId)}` : ''
        return fetchApi<ApiResponse<null>>(`/api/rich-menus/auto-switch/${encodeURIComponent(statusOptionId)}${q}`, {
          method: 'DELETE',
        })
      },
      // BOXIV: リッチメニュー差し替え時に、旧 ID を指す全マッピングを新 ID へ付け替える。
      // fetchApi は非2xxで本文を捨てて throw するため、Worker のエラー文言を拾えるよう生 fetch で本文を読む。
      rebind: async (data: {
        fromRichMenuId: string
        toRichMenuId: string
        toRichMenuName?: string | null
      }): Promise<ApiResponse<{ rebound: number }>> => {
        const res = await fetch(`${API_URL}/api/rich-menus/auto-switch/rebind`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify(data),
        })
        if (res.status === 401) onUnauthorized()
        return res
          .json()
          .catch(() => ({ success: false, error: `API error: ${res.status}` })) as Promise<
          ApiResponse<{ rebound: number }>
        >
      },
    },
  },
  // 顧客ステータス (BOXIV — Notion 出品者DB / 購入者DB の Status 同期)
  friendStatus: {
    listOptions: (params?: { source?: 'seller' | 'buyer'; includeArchived?: boolean }) => {
      const q = new URLSearchParams()
      if (params?.source) q.set('source', params.source)
      if (params?.includeArchived) q.set('includeArchived', '1')
      const qs = q.toString()
      return fetchApi<ApiResponse<Array<{
        id: string
        source: 'seller' | 'buyer'
        notionId: string
        name: string
        color: string | null
        sortOrder: number
        isArchived: boolean
        syncedAt: string
      }>>>('/api/status-options' + (qs ? '?' + qs : ''))
    },
    sync: (sources?: Array<'seller' | 'buyer'>) =>
      fetchApi<ApiResponse<Array<{
        source: 'seller' | 'buyer'
        success: boolean
        inserted?: number
        updated?: number
        archived?: number
        total?: number
        error?: string
      }>>>('/api/status-options/sync', {
        method: 'POST',
        body: JSON.stringify(sources ? { sources } : {}),
      }),
    getFriend: (friendId: string) =>
      fetchApi<ApiResponse<{
        friendId: string
        option: {
          id: string
          source: 'seller' | 'buyer'
          notionId: string
          name: string
          color: string | null
        }
        assignedAt: string
        assignedBy: string | null
      } | null>>(`/api/friends/${friendId}/status`),
    setFriend: (friendId: string, statusOptionId: string | null) =>
      fetchApi<ApiResponse<{ friendId: string; statusOptionId: string } | null>>(
        `/api/friends/${friendId}/status`,
        { method: 'PUT', body: JSON.stringify({ statusOptionId }) },
      ),
  },
}
