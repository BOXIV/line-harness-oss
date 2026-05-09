// BOXIV-only: 出品者DB / 購入者DB の Status プロパティから select options を
// 取得して D1 の status_options テーブルに upsert する。

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export interface NotionStatusEnv {
  NOTION_API_KEY?: string;
  NOTION_SELLER_DB_ID?: string;
  NOTION_BUYER_DB_ID?: string;
  NOTION_SELLER_STATUS_PROP?: string;  // default: ステータス
  NOTION_BUYER_STATUS_PROP?: string;   // default: ステータス
}

interface NotionOption {
  id: string;
  name: string;
  color?: string;
}

interface NotionDatabaseResponse {
  object: 'database' | 'error';
  properties?: Record<string, {
    type: string;
    select?: { options: NotionOption[] };
    status?: { options: NotionOption[] };
  }>;
}

export type StatusSource = 'seller' | 'buyer';

export interface SyncResult {
  source: StatusSource;
  inserted: number;
  updated: number;
  archived: number;
  total: number;
}

async function fetchNotionDatabase(env: NotionStatusEnv, dbId: string): Promise<NotionDatabaseResponse> {
  if (!env.NOTION_API_KEY) throw new Error('NOTION_API_KEY not configured');
  const res = await fetch(`${NOTION_API}/databases/${dbId}`, {
    headers: {
      Authorization: `Bearer ${env.NOTION_API_KEY}`,
      'Notion-Version': NOTION_VERSION,
    },
  });
  return (await res.json()) as NotionDatabaseResponse;
}

function getSourceConfig(env: NotionStatusEnv, source: StatusSource) {
  if (source === 'seller') {
    return {
      dbId: env.NOTION_SELLER_DB_ID,
      propName: env.NOTION_SELLER_STATUS_PROP || 'ステータス',
    };
  }
  return {
    dbId: env.NOTION_BUYER_DB_ID,
    propName: env.NOTION_BUYER_STATUS_PROP || 'ステータス',
  };
}

/**
 * Notion DB から Status options を取得して status_options に upsert する。
 * - 既存レコードと一致 (source, notion_id) → name/color/sort_order/synced_at を更新
 * - Notion から消えた option → is_archived = 1 マーク
 * - 新規 → INSERT
 */
export async function syncStatusOptionsFromNotion(
  db: D1Database,
  env: NotionStatusEnv,
  source: StatusSource,
): Promise<SyncResult> {
  const { dbId, propName } = getSourceConfig(env, source);
  if (!dbId) {
    throw new Error(`${source === 'seller' ? 'NOTION_SELLER_DB_ID' : 'NOTION_BUYER_DB_ID'} not configured`);
  }

  const notionDb = await fetchNotionDatabase(env, dbId);
  if (notionDb.object === 'error' || !notionDb.properties) {
    throw new Error(`Notion API error or no properties on DB ${dbId}`);
  }
  // Notion property names sometimes have trailing/leading whitespace — match by trim.
  const trimmedTarget = propName.trim();
  const matchedKey = Object.keys(notionDb.properties).find(
    (k) => k.trim() === trimmedTarget,
  );
  const prop = matchedKey ? notionDb.properties[matchedKey] : undefined;
  if (!prop) {
    const available = Object.keys(notionDb.properties).join(', ');
    throw new Error(
      `property "${propName}" not found in Notion DB ${dbId}. Available: ${available}`,
    );
  }
  const options =
    prop.type === 'status'
      ? prop.status?.options ?? []
      : prop.type === 'select'
        ? prop.select?.options ?? []
        : [];
  if (options.length === 0) {
    throw new Error(`no options found on property "${propName}" (type=${prop.type})`);
  }

  const now = new Date().toISOString();
  // 既存レコード一覧
  const existing = await db
    .prepare('SELECT id, notion_id FROM status_options WHERE source = ?')
    .bind(source)
    .all<{ id: string; notion_id: string }>();
  const existingByNotionId = new Map(existing.results.map((r) => [r.notion_id, r.id]));

  let inserted = 0;
  let updated = 0;
  const seenNotionIds = new Set<string>();

  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    seenNotionIds.add(opt.id);
    const existingId = existingByNotionId.get(opt.id);
    if (existingId) {
      await db
        .prepare(
          'UPDATE status_options SET name = ?, color = ?, sort_order = ?, is_archived = 0, synced_at = ? WHERE id = ?',
        )
        .bind(opt.name, opt.color ?? null, i, now, existingId)
        .run();
      updated++;
    } else {
      const newId = crypto.randomUUID();
      await db
        .prepare(
          'INSERT INTO status_options (id, source, notion_id, name, color, sort_order, is_archived, synced_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
        )
        .bind(newId, source, opt.id, opt.name, opt.color ?? null, i, now)
        .run();
      inserted++;
    }
  }

  // Notion から消えた option を archive
  let archived = 0;
  for (const r of existing.results) {
    if (!seenNotionIds.has(r.notion_id)) {
      await db
        .prepare('UPDATE status_options SET is_archived = 1, synced_at = ? WHERE id = ?')
        .bind(now, r.id)
        .run();
      archived++;
    }
  }

  return { source, inserted, updated, archived, total: options.length };
}
