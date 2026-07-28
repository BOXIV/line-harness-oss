// BOXIV-only: 友だちの LINE userId を Notion 出品者DB の LINE User ID プロパティで
// 照合し、一致したページの 名前 / 掲載ID を friend.metadata.notion に書き込む。
//
// ここで扱う「掲載IDの選び直し」は出品者リスト固有の運用（1人が複数掲載を持つ）なので出品者DBのみ。
// 購入者は購入エントリー連携（buyer-form-line.ts）が match_key で1行に確定させるため、
// 候補選択の仕組みは要らない。購入者DBの LINE User ID は notion-status-sync がステータス反映に使う。
//
// 1人の出品者が複数の掲載ID行を持つケースがある（例: プレミアム出品 → アプリ出品に変更、
// 何度も変更する出品者）。どの行と連携するかはオペレーターがチャット画面で選択でき、
// 選択された連携は pinned=true で記録する。pinned な連携は
//   - 自動再連携で別の行に付け替えられない
//   - 他の掲載ID行のステータス変更を LINE 側に反映しない（notion-status-sync.boxiv.ts で判定）
// ため、旧プレミアム出品行を「取引停止」にしても LINE Connect 側は停止しない。

import { jstNow } from '@line-crm/db';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

/** 名前一致（弱い一致）で候補に足す上限。同姓同名の他人でドロップダウンが埋まるのを防ぐ。 */
const NAME_MATCH_LIMIT = 10;

export interface NotionLinkEnv {
  NOTION_API_KEY?: string;
  NOTION_SELLER_DB_ID?: string;
  NOTION_PROP_LINE_USER_ID?: string;         // default: 'LINE User ID'
  NOTION_PROP_NAME?: string;                 // default: '名前'
  NOTION_SELLER_LISTING_ID_PROP?: string;    // default: '掲載ID'
  NOTION_SELLER_STATUS_PROP?: string;        // default: 'ステータス'
  NOTION_SELLER_LISTING_TYPE_PROP?: string;  // default: '出品タイプ'
}

/** 候補の一致根拠。'name' は LINE User ID 未記入の行を名前で拾った弱い一致。 */
export type CandidateMatch = 'lineUserId' | 'name';

export interface NotionSellerCandidate {
  pageId: string;
  label: string | null;        // 掲載ID
  realName: string | null;     // 名前
  listingType: string | null;  // 出品タイプ
  status: string | null;       // ステータス
  matchedBy: CandidateMatch;
  createdTime: string | null;
  lastEditedTime: string | null;
  url: string | null;
}

export interface NotionFriendLink {
  source: 'seller';
  pageId: string;
  label: string | null;     // 掲載ID
  realName: string | null;  // 名前
  listingType?: string | null;
  /** オペレーターが掲載IDを明示選択した連携。自動再連携・他行のステータスで上書きされない。 */
  pinned?: boolean;
  /** 連携時点の候補件数（>1 なら掲載IDが複数ある＝要選択） */
  candidateCount?: number;
  linkedAt: string;
}

/** 指定 pageId がこの友だちの候補に無い（付け替え要求が不正） */
export class NotionCandidateNotFoundError extends Error {
  constructor(message = '指定された Notion ページはこの友だちの候補に含まれていません（候補を再取得してください）') {
    super(message);
    this.name = 'NotionCandidateNotFoundError';
  }
}

interface NotionProp {
  type: string;
  rich_text?: Array<{ plain_text?: string }>;
  title?: Array<{ plain_text?: string }>;
  select?: { name?: string } | null;
  status?: { name?: string } | null;
  number?: number | null;
  formula?: { type?: string; string?: string | null; number?: number | null };
}

interface NotionSellerPage {
  id: string;
  url?: string;
  created_time?: string;
  last_edited_time?: string;
  properties: Record<string, NotionProp>;
}

/** DB スキーマから解決した実プロパティ名と型（Notion のプロパティ名は前後空白を含むことがある） */
interface PropRef {
  key: string;
  type: string;
}

interface SellerProps {
  lineUserId: PropRef | null;
  name: PropRef | null;
  listingId: PropRef | null;
  status: PropRef | null;
  listingType: PropRef | null;
}

function notionHeaders(env: NotionLinkEnv): Record<string, string> {
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

function propText(prop: NotionProp | undefined): string | null {
  if (!prop) return null;
  switch (prop.type) {
    case 'rich_text':
      return plainText(prop.rich_text);
    case 'title':
      return plainText(prop.title);
    case 'select':
      return prop.select?.name ?? null;
    case 'status':
      return prop.status?.name ?? null;
    case 'number':
      return prop.number == null ? null : String(prop.number);
    case 'formula':
      return prop.formula?.string ?? (prop.formula?.number == null ? null : String(prop.formula.number));
    default:
      return null;
  }
}

/**
 * DB スキーマを取得し、設定名（trim 一致）→ 実プロパティ名+型 を解決する。
 * filter は実プロパティ名と型が一致していないと Notion が 400 を返すため必須。
 */
async function resolveSellerProps(env: NotionLinkEnv, dbId: string): Promise<SellerProps> {
  const res = await fetch(`${NOTION_API}/databases/${dbId}`, { headers: notionHeaders(env) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Notion get database failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { properties?: Record<string, { type: string }> };
  const props = data.properties ?? {};
  const keys = Object.keys(props);
  const pick = (configured: string | undefined, fallback: string): PropRef | null => {
    const target = (configured || fallback).trim();
    const key = keys.find((k) => k.trim() === target);
    return key ? { key, type: props[key].type } : null;
  };
  return {
    lineUserId: pick(env.NOTION_PROP_LINE_USER_ID, 'LINE User ID'),
    name: pick(env.NOTION_PROP_NAME, '名前'),
    listingId: pick(env.NOTION_SELLER_LISTING_ID_PROP, '掲載ID'),
    status: pick(env.NOTION_SELLER_STATUS_PROP, 'ステータス'),
    listingType: pick(env.NOTION_SELLER_LISTING_TYPE_PROP, '出品タイプ'),
  };
}

function equalsFilter(prop: PropRef, value: string): Record<string, unknown> | null {
  switch (prop.type) {
    case 'rich_text':
      return { property: prop.key, rich_text: { equals: value } };
    case 'title':
      return { property: prop.key, title: { equals: value } };
    case 'select':
      return { property: prop.key, select: { equals: value } };
    case 'email':
      return { property: prop.key, email: { equals: value } };
    case 'phone_number':
      return { property: prop.key, phone_number: { equals: value } };
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? { property: prop.key, number: { equals: n } } : null;
    }
    default:
      return null;
  }
}

async function queryPages(
  env: NotionLinkEnv,
  dbId: string,
  filter: Record<string, unknown>,
  maxRequests = 3,
): Promise<NotionSellerPage[]> {
  const out: NotionSellerPage[] = [];
  let cursor: string | undefined;
  let requests = 0;
  do {
    const body: Record<string, unknown> = {
      filter,
      page_size: 100,
      sorts: [{ timestamp: 'created_time', direction: 'descending' }],
    };
    if (cursor) body.start_cursor = cursor;
    const res = await fetch(`${NOTION_API}/databases/${dbId}/query`, {
      method: 'POST',
      headers: notionHeaders(env),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Notion seller query failed: ${res.status} ${text}`);
    }
    const data = (await res.json()) as {
      results?: NotionSellerPage[];
      has_more?: boolean;
      next_cursor?: string | null;
    };
    out.push(...(data.results ?? []));
    cursor = data.has_more ? data.next_cursor ?? undefined : undefined;
    requests++;
  } while (cursor && requests < maxRequests);
  return out;
}

function findProp(props: Record<string, NotionProp>, ref: PropRef | null): NotionProp | undefined {
  return ref ? props[ref.key] : undefined;
}

function toCandidate(
  schema: SellerProps,
  page: NotionSellerPage,
  matchedBy: CandidateMatch,
): NotionSellerCandidate {
  return {
    pageId: page.id,
    label: propText(findProp(page.properties, schema.listingId)),
    realName: propText(findProp(page.properties, schema.name)),
    listingType: propText(findProp(page.properties, schema.listingType)),
    status: propText(findProp(page.properties, schema.status)),
    matchedBy,
    createdTime: page.created_time ?? null,
    lastEditedTime: page.last_edited_time ?? null,
    url: page.url ?? null,
  };
}

/**
 * 表示順 = 自動選択の優先順。
 *   1. 掲載IDが入っている行を優先（フォーム提出だけで未掲載の行を先頭にしない）
 *   2. LINE User ID 一致を名前一致より優先
 *   3. 作成が新しい行を優先（プレミアム出品 → アプリ出品に移った人は新しい行が現行）
 * last_edited_time ではなく created_time を使う: 旧行を編集（取引停止など）しても順序が変わらないため。
 */
function sortCandidates(list: NotionSellerCandidate[]): NotionSellerCandidate[] {
  const rank = (c: NotionSellerCandidate) => (c.label ? 0 : 1) * 2 + (c.matchedBy === 'lineUserId' ? 0 : 1);
  return [...list].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return (b.createdTime ?? '').localeCompare(a.createdTime ?? '');
  });
}

/**
 * この友だちに紐付け得る Notion 出品者DB の行を列挙する。
 * - LINE User ID 一致（強い一致）
 * - 上記で判明した名前（+ 既存連携の名前）に一致する行（弱い一致。matchedBy='name'）
 *   … アプリ出品への切り替えで新しい行が起票されたが LINE User ID 未記入のケースを救う
 */
export async function listSellerCandidates(
  env: NotionLinkEnv,
  lineUserId: string,
  opts: { knownName?: string | null } = {},
): Promise<NotionSellerCandidate[]> {
  const dbId = env.NOTION_SELLER_DB_ID;
  if (!env.NOTION_API_KEY || !dbId) return [];
  const schema = await resolveSellerProps(env, dbId);
  if (!schema.lineUserId) {
    throw new Error(`Notion 出品者DB に "${env.NOTION_PROP_LINE_USER_ID || 'LINE User ID'}" プロパティが見つかりません`);
  }

  const byPage = new Map<string, NotionSellerCandidate>();

  const luidFilter = equalsFilter(schema.lineUserId, lineUserId);
  if (luidFilter) {
    for (const page of await queryPages(env, dbId, luidFilter)) {
      byPage.set(normalizeId(page.id), toCandidate(schema, page, 'lineUserId'));
    }
  }

  const names = new Set<string>();
  for (const c of byPage.values()) if (c.realName) names.add(c.realName);
  if (opts.knownName) names.add(opts.knownName);
  if (schema.name) {
    // 同姓同名の他人を大量に並べないよう、名前は最大 3 件・各 1 リクエスト・追加は 10 件までに制限。
    let added = 0;
    for (const name of Array.from(names).slice(0, 3)) {
      if (added >= NAME_MATCH_LIMIT) break;
      const nameFilter = equalsFilter(schema.name, name);
      if (!nameFilter) continue;
      for (const page of await queryPages(env, dbId, nameFilter, 1)) {
        if (added >= NAME_MATCH_LIMIT) break;
        const key = normalizeId(page.id);
        if (byPage.has(key)) continue; // LINE User ID 一致を優先
        // 別の LINE アカウントが入っている行は同姓同名の別人。候補に出さない
        // （LINE User ID が空の行＝まだ連携されていない行だけを拾う）。
        const rowLineUserId = propText(findProp(page.properties, schema.lineUserId));
        if (rowLineUserId && rowLineUserId !== lineUserId) continue;
        byPage.set(key, toCandidate(schema, page, 'name'));
        added++;
      }
    }
  }

  return sortCandidates(Array.from(byPage.values()));
}

export async function findSellerByLineUserId(
  env: NotionLinkEnv,
  lineUserId: string,
): Promise<NotionFriendLink | null> {
  const candidates = await listSellerCandidates(env, lineUserId);
  const best = candidates[0];
  if (!best) return null;
  return {
    source: 'seller',
    pageId: best.pageId,
    label: best.label,
    realName: best.realName,
    listingType: best.listingType,
    pinned: false,
    candidateCount: candidates.length,
    linkedAt: jstNow(),
  };
}

function parseExistingLink(metadataJson: string | null): NotionFriendLink | null {
  if (!metadataJson) return null;
  try {
    const meta = JSON.parse(metadataJson) as { notion?: NotionFriendLink };
    return meta.notion ?? null;
  } catch {
    return null;
  }
}

/**
 * Look up by LINE userId, store result in friend.metadata.notion, return the link
 * (or null if nothing matched). Idempotent — overwrites existing notion link.
 *
 * opts.pageId を渡すとその掲載ID行に固定する（pinned=true）。候補に無い pageId は
 * NotionCandidateNotFoundError（他人の行を誤って紐付けないためのガード）。
 * opts.pageId 無しでの再連携は、既存が pinned ならその行を維持したまま情報だけ更新する。
 */
export async function linkFriendToNotion(
  db: D1Database,
  env: NotionLinkEnv,
  friendId: string,
  lineUserId: string,
  opts: { pageId?: string } = {},
): Promise<NotionFriendLink | null> {
  const row = await db
    .prepare('SELECT metadata FROM friends WHERE id = ?')
    .bind(friendId)
    .first<{ metadata: string | null }>();
  let existing: Record<string, unknown> = {};
  try {
    existing = row?.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
  } catch {
    existing = {};
  }
  const prev = parseExistingLink(row?.metadata ?? null);

  const candidates = await listSellerCandidates(env, lineUserId, { knownName: prev?.realName ?? null });
  if (candidates.length === 0) return null;

  let chosen: NotionSellerCandidate;
  let pinned: boolean;
  if (opts.pageId) {
    const target = normalizeId(opts.pageId);
    const match = candidates.find((c) => normalizeId(c.pageId) === target);
    if (!match) throw new NotionCandidateNotFoundError();
    chosen = match;
    pinned = true;
  } else if (prev?.pinned) {
    // 自動再連携でオペレーターの選択を奪わない（行が消えていた場合のみ自動選択に落ちる）
    const target = normalizeId(prev.pageId);
    const kept = candidates.find((c) => normalizeId(c.pageId) === target);
    chosen = kept ?? candidates[0];
    pinned = Boolean(kept);
  } else {
    chosen = candidates[0];
    pinned = false;
  }

  const link: NotionFriendLink = {
    source: 'seller',
    pageId: chosen.pageId,
    label: chosen.label,
    realName: chosen.realName,
    listingType: chosen.listingType,
    pinned,
    candidateCount: candidates.length,
    linkedAt: jstNow(),
  };

  // Merge into metadata (preserve other keys)
  const merged = { ...existing, notion: link };
  await db
    .prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(merged), jstNow(), friendId)
    .run();
  return link;
}
