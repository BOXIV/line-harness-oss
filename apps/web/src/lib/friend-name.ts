// BOXIV: canonical friend display name format.
// Used by both Friends 管理画面 (friend-table.tsx) and Chats 個別チャット (chats/page.tsx)
// so the same person shows with the same label in both places.

export interface NotionFriendLink {
  source?: 'seller' | 'buyer' | string
  pageId?: string
  label?: string | null
  realName?: string | null
}

/** BOXIV: 出品者/購入者それぞれの連携（metadata.notionLinks）。 */
interface NotionMeta {
  notion?: NotionFriendLink
  notionLinks?: Partial<Record<'seller' | 'buyer', NotionFriendLink>>
}

/** 表示に使う 1 件を選ぶ。metadata.notion（primary の写し）が無い場合の保険。 */
function pickFromMeta(meta: NotionMeta | null | undefined): NotionFriendLink | null {
  if (!meta) return null
  if (meta.notion) return meta.notion
  return meta.notionLinks?.seller ?? meta.notionLinks?.buyer ?? null
}

/** Pull the Notion link out of either:
 *  - a Friend object with metadata: { notion: ... } (parsed JSON object, friends API)
 *  - a Chat object with notion: { ... } (already extracted, chats API)
 *  - a string metadata field (legacy / raw) — parsed lazily
 */
function pickNotion(input: unknown): NotionFriendLink | null {
  if (!input || typeof input !== 'object') return null
  const obj = input as Record<string, unknown>
  // Chat shape: { notion: {...} }
  if (obj.notion && typeof obj.notion === 'object') {
    return obj.notion as NotionFriendLink
  }
  // Friend shape: { metadata: {...} } (object after JSON.parse)
  if (obj.metadata && typeof obj.metadata === 'object') {
    const hit = pickFromMeta(obj.metadata as NotionMeta)
    if (hit) return hit
  }
  // Legacy: metadata is a JSON string
  if (typeof obj.metadata === 'string') {
    try {
      const hit = pickFromMeta(JSON.parse(obj.metadata) as NotionMeta)
      if (hit) return hit
    } catch { /* ignore */ }
  }
  return null
}

/** Returns "{label} {realName} ({nickname})" if Notion data is linked, else just nickname. */
export function formatFriendLabel(
  input: { managedName?: string | null; displayName?: string | null; friendName?: string | null; metadata?: unknown; notion?: NotionFriendLink | null } | null | undefined,
): string {
  if (!input) return '名前なし'
  // 管理名（管理画面で編集する表示名）が設定されていれば最優先で表示する
  const managed = (input.managedName ?? '').trim()
  if (managed) return managed
  const nickname = (input.displayName ?? input.friendName ?? '') || '名前なし'
  const notion = input.notion ?? pickNotion(input)
  if (!notion) return nickname
  const parts: string[] = []
  if (notion.label) parts.push(notion.label)
  if (notion.realName) parts.push(notion.realName)
  if (parts.length === 0) return nickname
  return `${parts.join(' ')} (${nickname})`
}

/** managedName を無視して「Notion 合成名（label realName (nickname)）or LINE名」を返す。
 *  表示名編集モーダルの初期値（＝現在表示されている文字列）に使う。 */
export function composeDisplayLabel(
  input: { displayName?: string | null; friendName?: string | null; metadata?: unknown; notion?: NotionFriendLink | null } | null | undefined,
): string {
  if (!input) return ''
  const nickname = (input.displayName ?? input.friendName ?? '') || '名前なし'
  const notion = input.notion ?? pickNotion(input)
  if (!notion) return nickname
  const parts: string[] = []
  if (notion.label) parts.push(notion.label)
  if (notion.realName) parts.push(notion.realName)
  if (parts.length === 0) return nickname
  return `${parts.join(' ')} (${nickname})`
}
