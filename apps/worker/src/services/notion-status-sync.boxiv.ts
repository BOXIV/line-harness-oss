// BOXIV-only: Notion をマスターとして顧客ステータスを D1 に取り込む（PR6）。
// 反映経路は2つ:
//   (a) Notion DB オートメーション(Send webhook) → notion-webhook.boxiv.ts → syncNotionPageStatus（即時）
//   (b) 12時間ごとの reconcile cron → reconcileNotionStatuses（取りこぼし自己修復）
// LINE Connect 側からの変更は不可（read-only。PUT は 405 封鎖済み・UI も表示専用）。
//
// マッピング:
//   friend  : friends.line_user_id == Notion「LINE User ID」プロパティ（rich_text/title）
//   status  : Notion select/status の option id == status_options.notion_id（source 一致）
//             → friend_status_assignments.status_option_id へ upsert（assigned_by='notion'）
//   Notion 側でステータス未設定 → ローカル割当を解除（delete）。
//
// 掲載ID の多重化ガード（重要）:
//   1人の出品者が複数の掲載ID行を持つ場合（プレミアム出品 → アプリ出品へ変更 等）、
//   friends.metadata.notion.pageId で選ばれている行以外のステータス変更は反映しない。
//   これが無いと「旧プレミアム出品行を取引停止にすると LINE Connect 側も取引停止になる」
//   （さらに 12h reconcile で行間のステータスが交互に上書きされる）。
//   連携が無い友だちは従来どおり LINE User ID 一致だけで反映する。

import { jstNow } from '@line-crm/db';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export interface NotionStatusSyncEnv {
  NOTION_API_KEY?: string;
  NOTION_SELLER_DB_ID?: string;
  NOTION_BUYER_DB_ID?: string;
  NOTION_SELLER_STATUS_PROP?: string;   // default: ステータス
  NOTION_BUYER_STATUS_PROP?: string;    // default: ステータス
  NOTION_PROP_LINE_USER_ID?: string;    // default: 'LINE User ID'
}

type StatusSource = 'seller' | 'buyer';

interface NotionSelectValue { id: string; name: string; color?: string }
interface NotionPage {
  id: string;
  parent?: { type?: string; database_id?: string };
  properties: Record<string, {
    type: string;
    rich_text?: Array<{ plain_text?: string }>;
    title?: Array<{ plain_text?: string }>;
    select?: NotionSelectValue | null;
    status?: NotionSelectValue | null;
  }>;
}

function notionHeaders(env: NotionStatusSyncEnv): Record<string, string> {
  return {
    Authorization: `Bearer ${env.NOTION_API_KEY}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

function normalizeId(id: string | undefined | null): string {
  return (id || '').replace(/-/g, '').toLowerCase();
}

function plainText(rich: Array<{ plain_text?: string }> | undefined): string | null {
  if (!Array.isArray(rich) || rich.length === 0) return null;
  return rich.map((r) => r.plain_text || '').join('').trim() || null;
}

function statusPropName(env: NotionStatusSyncEnv, source: StatusSource): string {
  return (source === 'seller' ? env.NOTION_SELLER_STATUS_PROP : env.NOTION_BUYER_STATUS_PROP) || 'ステータス';
}

// Notion property 名は前後空白を含むことがあるので trim 一致で探す。
function findProp(props: NotionPage['properties'], name: string) {
  const target = name.trim();
  const key = Object.keys(props).find((k) => k.trim() === target);
  return key ? props[key] : undefined;
}

// ページから { lineUserId, optionId(Notion option id|null), optionName } を取り出す。
function extractFromPage(
  env: NotionStatusSyncEnv,
  source: StatusSource,
  page: NotionPage,
): { lineUserId: string | null; optionId: string | null; optionName: string | null } {
  const luidProp = findProp(page.properties, env.NOTION_PROP_LINE_USER_ID || 'LINE User ID');
  let lineUserId: string | null = null;
  if (luidProp) {
    if (luidProp.type === 'rich_text') lineUserId = plainText(luidProp.rich_text);
    else if (luidProp.type === 'title') lineUserId = plainText(luidProp.title);
  }
  const sProp = findProp(page.properties, statusPropName(env, source));
  let optionId: string | null = null;
  let optionName: string | null = null;
  if (sProp) {
    const val = sProp.type === 'status' ? sProp.status : sProp.type === 'select' ? sProp.select : null;
    optionId = val?.id ?? null;
    optionName = val?.name ?? null;
  }
  return { lineUserId, optionId, optionName };
}

// friends.metadata.notion（連携先の掲載ID行）を読む。
function parseLinkedNotion(metadataJson: string | null): { source?: string; pageId?: string } | null {
  if (!metadataJson) return null;
  try {
    const meta = JSON.parse(metadataJson) as { notion?: { source?: string; pageId?: string } };
    return meta.notion ?? null;
  } catch {
    return null;
  }
}

// friend_status_assignments を Notion 値で upsert（未設定なら delete）。
async function applyStatus(
  db: D1Database,
  source: StatusSource,
  lineUserId: string,
  optionId: string | null,
  optionName: string | null,
  sourcePageId: string | null,
): Promise<string> {
  const friend = await db
    .prepare('SELECT id, metadata FROM friends WHERE line_user_id = ?')
    .bind(lineUserId)
    .first<{ id: string; metadata: string | null }>();
  if (!friend) return 'skip-no-friend';

  // 連携先の掲載ID行が決まっているなら、その行以外のステータス変更は無視する。
  // source 違い（購入者DB由来）は連携情報が出品者行なので比較しない。
  if (sourcePageId) {
    const linked = parseLinkedNotion(friend.metadata);
    if (
      linked?.pageId &&
      (linked.source ?? 'seller') === source &&
      normalizeId(linked.pageId) !== normalizeId(sourcePageId)
    ) {
      return 'skip-other-listing';
    }
  }

  if (!optionId) {
    await db.prepare('DELETE FROM friend_status_assignments WHERE friend_id = ?').bind(friend.id).run();
    return 'cleared';
  }

  // status_options を (source, notion_id) で照合。無ければ name で fallback。
  let opt = await db
    .prepare('SELECT id FROM status_options WHERE source = ? AND notion_id = ?')
    .bind(source, optionId)
    .first<{ id: string }>();
  if (!opt && optionName) {
    opt = await db
      .prepare('SELECT id FROM status_options WHERE source = ? AND name = ? AND is_archived = 0')
      .bind(source, optionName)
      .first<{ id: string }>();
  }
  if (!opt) return 'skip-no-option'; // status_options 未同期。/api/status-options/sync 後に reconcile で解消。

  await db
    .prepare(
      `INSERT INTO friend_status_assignments (friend_id, status_option_id, assigned_by, assigned_at)
       VALUES (?, ?, 'notion', ?)
       ON CONFLICT(friend_id) DO UPDATE SET
         status_option_id = excluded.status_option_id,
         assigned_by = 'notion',
         assigned_at = excluded.assigned_at`,
    )
    .bind(friend.id, opt.id, jstNow())
    .run();
  return 'updated';
}

function sourceOfDb(env: NotionStatusSyncEnv, dbId: string | undefined): StatusSource | null {
  const n = normalizeId(dbId);
  if (n && n === normalizeId(env.NOTION_SELLER_DB_ID)) return 'seller';
  if (n && n === normalizeId(env.NOTION_BUYER_DB_ID)) return 'buyer';
  return null;
}

// 単一 Notion ページ（GET /pages/{id}）からステータスを取り込む。webhook 経由で使う。
export async function syncNotionPageStatus(
  db: D1Database,
  env: NotionStatusSyncEnv,
  pageId: string,
): Promise<string> {
  if (!env.NOTION_API_KEY) return 'no-api-key';
  const res = await fetch(`${NOTION_API}/pages/${pageId}`, { headers: notionHeaders(env) });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Notion get page failed: ${res.status} ${t}`);
  }
  const page = (await res.json()) as NotionPage;
  const source = sourceOfDb(env, page.parent?.database_id);
  if (!source) return 'skip-unknown-db';
  const { lineUserId, optionId, optionName } = extractFromPage(env, source, page);
  if (!lineUserId) return 'skip-no-lineuserid';
  return applyStatus(db, source, lineUserId, optionId, optionName, page.id || pageId);
}

// 12h reconcile: 出品者/購入者DB を走査し、全ページのステータスを取り込む（自己修復）。
export async function reconcileNotionStatuses(db: D1Database, env: NotionStatusSyncEnv): Promise<void> {
  if (!env.NOTION_API_KEY) return;
  const sources: Array<{ source: StatusSource; dbId?: string }> = [
    { source: 'seller', dbId: env.NOTION_SELLER_DB_ID },
    { source: 'buyer', dbId: env.NOTION_BUYER_DB_ID },
  ];
  for (const { source, dbId } of sources) {
    if (!dbId) continue;
    let cursor: string | undefined;
    let pages = 0;
    const MAX_PAGES = 50; // 100件/page × 50 = 5000行 上限（暴走防止）
    do {
      const body: Record<string, unknown> = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const res = await fetch(`${NOTION_API}/databases/${dbId}/query`, {
        method: 'POST',
        headers: notionHeaders(env),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.error(`reconcileNotionStatuses: ${source} query failed ${res.status}`);
        break;
      }
      const data = (await res.json()) as { results?: NotionPage[]; has_more?: boolean; next_cursor?: string | null };
      for (const page of data.results ?? []) {
        try {
          const { lineUserId, optionId, optionName } = extractFromPage(env, source, page);
          if (!lineUserId) continue;
          await applyStatus(db, source, lineUserId, optionId, optionName, page.id);
        } catch (err) {
          console.error('reconcileNotionStatuses: row failed', err);
        }
      }
      cursor = data.has_more ? data.next_cursor ?? undefined : undefined;
      pages++;
    } while (cursor && pages < MAX_PAGES);
  }
}
