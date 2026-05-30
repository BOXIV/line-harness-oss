// BOXIV-only: 友だちの LINE userId を Notion 出品者DB の LINE User ID プロパティで
// 照合し、一致したページの 名前 / 掲載ID を friend.metadata.notion に書き込む。
//
// 購入者DB は LINE User ID プロパティを持たないので現時点では出品者のみ自動連携。
// 購入者連携は出品者リレーション経由で別途実装予定。

import { jstNow } from '@line-crm/db';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export interface NotionLinkEnv {
  NOTION_API_KEY?: string;
  NOTION_SELLER_DB_ID?: string;
  NOTION_PROP_LINE_USER_ID?: string;       // default: 'LINE User ID'
  NOTION_PROP_NAME?: string;               // default: '名前'
  NOTION_SELLER_LISTING_ID_PROP?: string;  // default: '掲載ID'
}

export interface NotionFriendLink {
  source: 'seller';
  pageId: string;
  label: string | null;     // 掲載ID
  realName: string | null;  // 名前
  linkedAt: string;
}

function plainText(rich: unknown[]): string | null {
  if (!Array.isArray(rich) || rich.length === 0) return null;
  const first = rich[0] as { plain_text?: string };
  return first.plain_text ?? null;
}

export async function findSellerByLineUserId(
  env: NotionLinkEnv,
  lineUserId: string,
): Promise<NotionFriendLink | null> {
  if (!env.NOTION_API_KEY || !env.NOTION_SELLER_DB_ID) return null;
  const lineUserIdProp = env.NOTION_PROP_LINE_USER_ID || 'LINE User ID';
  const nameProp = env.NOTION_PROP_NAME || '名前';
  const listingIdProp = env.NOTION_SELLER_LISTING_ID_PROP || '掲載ID';

  const res = await fetch(`${NOTION_API}/databases/${env.NOTION_SELLER_DB_ID}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.NOTION_API_KEY}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filter: { property: lineUserIdProp, rich_text: { equals: lineUserId } },
      page_size: 1,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Notion seller query failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { results?: Array<{ id: string; properties: Record<string, unknown> }> };
  const page = data.results?.[0];
  if (!page) return null;

  const props = page.properties as Record<string, { type: string; rich_text?: unknown[]; title?: unknown[] }>;
  const titleProp = props[nameProp];
  const realName = titleProp?.type === 'title'
    ? plainText(titleProp.title ?? [])
    : titleProp?.type === 'rich_text'
      ? plainText(titleProp.rich_text ?? [])
      : null;

  const listingProp = props[listingIdProp];
  const label = listingProp?.type === 'rich_text' ? plainText(listingProp.rich_text ?? []) : null;

  return {
    source: 'seller',
    pageId: page.id,
    label,
    realName,
    linkedAt: jstNow(),
  };
}

/**
 * Look up by LINE userId, store result in friend.metadata.notion, return the link
 * (or null if nothing matched). Idempotent — overwrites existing notion link.
 */
export async function linkFriendToNotion(
  db: D1Database,
  env: NotionLinkEnv,
  friendId: string,
  lineUserId: string,
): Promise<NotionFriendLink | null> {
  const link = await findSellerByLineUserId(env, lineUserId);
  if (!link) return null;

  // Merge into metadata (preserve other keys)
  const row = await db.prepare('SELECT metadata FROM friends WHERE id = ?').bind(friendId).first<{ metadata: string | null }>();
  const existing = row?.metadata ? JSON.parse(row.metadata) : {};
  const merged = { ...existing, notion: link };
  await db
    .prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(merged), jstNow(), friendId)
    .run();
  return link;
}
