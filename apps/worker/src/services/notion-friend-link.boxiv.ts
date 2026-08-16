// BOXIV-only: 友だちの LINE userId を Notion の 出品者DB / 購入者DB と照合し、
// 一致したページの 名前 / 掲載ID(商談ID) を friends.metadata に書き込む。
//
// 1人の顧客が複数行を持つのは両DBに共通する運用:
//   - 出品者リスト: プレミアム出品 → アプリ出品に変更した人は掲載ID行が増える
//   - 購入者リスト: 取引管理DBなので 1人が複数の商談行（商談ID = {掲載ID}-T{n}）を持つ
// どの行と連携するかはオペレーターがチャット画面で選択でき、選択された連携は pinned=true。
// pinned な連携は
//   - 自動再連携で別の行に付け替えられない
//   - その source の他の行のステータス変更を LINE 側に反映しない（notion-status-sync.boxiv.ts）
// ため、旧プレミアム出品行や終了した商談行を「取引停止」にしても LINE Connect 側は停止しない。
//
// ── metadata スキーマ ──────────────────────────────────────────
//   metadata.notionLinks = { seller?: NotionFriendLink, buyer?: NotionFriendLink }  ← 正
//   metadata.notion      = notionLinks.seller ?? notionLinks.buyer                  ← 写し
// `notion` は既存 reader（chats API / friends 検索 / Slack通知 / web の表示名）のための
// 後方互換フィールド。出品者を優先しつつ、購入者のみの友だちでも表示名・検索が効くよう
// 「primary（seller 優先・無ければ buyer）」の写しにしている。**新規 reader は
// readNotionLinks() を使うこと。** 既存データ（`notion` だけを持つ行）は
// readNotionLinks() が source を見て notionLinks 側へ読み替える。
//
// ⚠️ 自動連携は出品者のみ。購入者は1人が複数の商談行を持ち、自動選択を誤ると
// ステータス反映が古い商談に固定されるため、オペレーターの明示選択だけで連携する。

import { jstNow } from '@line-crm/db';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

/** 名前一致（弱い一致）で候補に足す上限。同姓同名の他人でドロップダウンが埋まるのを防ぐ。 */
const NAME_MATCH_LIMIT = 10;

/** 連携先DB。listing_entries.source / status_options.source と同じ語彙。 */
export type LinkSource = 'seller' | 'buyer';

export const LINK_SOURCES: LinkSource[] = ['seller', 'buyer'];

/** UI に出すDB名。 */
export const LINK_SOURCE_LABELS: Record<LinkSource, string> = {
  seller: '出品者リスト',
  buyer: '購入者リスト',
};

export interface NotionLinkEnv {
  NOTION_API_KEY?: string;
  NOTION_SELLER_DB_ID?: string;
  NOTION_BUYER_DB_ID?: string;
  NOTION_PROP_LINE_USER_ID?: string;         // default: 'LINE User ID'（出品者）
  NOTION_PROP_NAME?: string;                 // default: '名前'（出品者）
  NOTION_SELLER_LISTING_ID_PROP?: string;    // default: '掲載ID'
  NOTION_SELLER_STATUS_PROP?: string;        // default: 'ステータス'
  NOTION_SELLER_LISTING_TYPE_PROP?: string;  // default: '出品タイプ'
  NOTION_BUYER_LINE_USER_ID_PROP?: string;   // default: 'LINE User ID'
  NOTION_BUYER_TITLE_PROP?: string;          // default: '名前'
  NOTION_BUYER_DEAL_ID_PROP?: string;        // default: '商談ID'
  NOTION_BUYER_STATUS_PROP?: string;         // default: 'ステータス'（実データは末尾スペース付き）
  NOTION_BUYER_VEHICLE_PROP?: string;        // default: '車両'
}

/** 候補の一致根拠。'name' は LINE User ID 未記入の行を名前で拾った弱い一致。 */
export type CandidateMatch = 'lineUserId' | 'name';

export interface NotionCandidate {
  source: LinkSource;
  pageId: string;
  label: string | null;        // 出品者: 掲載ID / 購入者: 商談ID
  realName: string | null;     // 名前
  listingType: string | null;  // 出品タイプ（出品者のみ）
  vehicle: string | null;      // 車両（購入者のみ）
  status: string | null;       // ステータス
  matchedBy: CandidateMatch;
  createdTime: string | null;
  lastEditedTime: string | null;
  url: string | null;
}

/** 旧名（出品者専用だった頃の型名）。web 側の互換のため残す。 */
export type NotionSellerCandidate = NotionCandidate;

/** DB 1つ分の候補。片方のDBだけ失敗しても、もう片方は出せるよう error を持たせる。 */
export interface NotionCandidateGroup {
  source: LinkSource;
  candidates: NotionCandidate[];
  /** そのDBの候補取得に失敗した理由（成功時 null） */
  error: string | null;
  /** 現在このDBと連携中の行 */
  linkedPageId: string | null;
  /** オペレーターが明示選択した連携か */
  pinned: boolean;
}

export interface NotionFriendLink {
  source: LinkSource;
  pageId: string;
  label: string | null;     // 掲載ID / 商談ID
  realName: string | null;  // 名前
  listingType?: string | null;
  vehicle?: string | null;
  /** オペレーターが行を明示選択した連携。自動再連携・他行のステータスで上書きされない。 */
  pinned?: boolean;
  /** 連携時点の候補件数（>1 なら行が複数ある＝要選択） */
  candidateCount?: number;
  linkedAt: string;
}

/** friends.metadata.notionLinks の中身。 */
export type NotionFriendLinks = Partial<Record<LinkSource, NotionFriendLink>>;

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

interface NotionRow {
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

/** DB ごとの「設定名 or 既定名」。実プロパティ名の解決は resolveProps が行う。 */
interface DbSpec {
  source: LinkSource;
  dbId: string;
  lineUserId: string;
  name: string;
  label: string;
  status: string;
  /** 出品者=出品タイプ / 購入者=車両。候補行の補足表示に使う。 */
  detail: string;
}

interface ResolvedProps {
  lineUserId: PropRef | null;
  name: PropRef | null;
  label: PropRef | null;
  status: PropRef | null;
  detail: PropRef | null;
}

/**
 * 対象DBの設定を組み立てる。DB ID が未設定なら null（その source は候補ゼロ扱い）。
 * ⚠️ プロパティ名をハードコードしない: 購入者リストは本リポ外の人手/AI運用で列の追加・改名が
 * 続いており、ステータス列は実測で末尾スペース付き（'ステータス '）だった。
 */
function dbSpec(env: NotionLinkEnv, source: LinkSource): DbSpec | null {
  if (source === 'seller') {
    if (!env.NOTION_SELLER_DB_ID) return null;
    return {
      source,
      dbId: env.NOTION_SELLER_DB_ID,
      lineUserId: env.NOTION_PROP_LINE_USER_ID || 'LINE User ID',
      name: env.NOTION_PROP_NAME || '名前',
      label: env.NOTION_SELLER_LISTING_ID_PROP || '掲載ID',
      status: env.NOTION_SELLER_STATUS_PROP || 'ステータス',
      detail: env.NOTION_SELLER_LISTING_TYPE_PROP || '出品タイプ',
    };
  }
  if (!env.NOTION_BUYER_DB_ID) return null;
  return {
    source,
    dbId: env.NOTION_BUYER_DB_ID,
    lineUserId: env.NOTION_BUYER_LINE_USER_ID_PROP || 'LINE User ID',
    name: env.NOTION_BUYER_TITLE_PROP || '名前',
    label: env.NOTION_BUYER_DEAL_ID_PROP || '商談ID',
    status: env.NOTION_BUYER_STATUS_PROP || 'ステータス',
    detail: env.NOTION_BUYER_VEHICLE_PROP || '車両',
  };
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
async function resolveProps(env: NotionLinkEnv, spec: DbSpec): Promise<ResolvedProps> {
  const res = await fetch(`${NOTION_API}/databases/${spec.dbId}`, { headers: notionHeaders(env) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Notion get database failed (${spec.source}): ${res.status} ${text}`);
  }
  const data = (await res.json()) as { properties?: Record<string, { type: string }> };
  const props = data.properties ?? {};
  const keys = Object.keys(props);
  const pick = (configured: string): PropRef | null => {
    const target = configured.trim();
    const key = keys.find((k) => k.trim() === target);
    return key ? { key, type: props[key].type } : null;
  };
  return {
    lineUserId: pick(spec.lineUserId),
    name: pick(spec.name),
    label: pick(spec.label),
    status: pick(spec.status),
    detail: pick(spec.detail),
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
  spec: DbSpec,
  filter: Record<string, unknown>,
  maxRequests = 3,
): Promise<NotionRow[]> {
  const out: NotionRow[] = [];
  let cursor: string | undefined;
  let requests = 0;
  do {
    const body: Record<string, unknown> = {
      filter,
      page_size: 100,
      sorts: [{ timestamp: 'created_time', direction: 'descending' }],
    };
    if (cursor) body.start_cursor = cursor;
    const res = await fetch(`${NOTION_API}/databases/${spec.dbId}/query`, {
      method: 'POST',
      headers: notionHeaders(env),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Notion query failed (${spec.source}): ${res.status} ${text}`);
    }
    const data = (await res.json()) as {
      results?: NotionRow[];
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
  spec: DbSpec,
  schema: ResolvedProps,
  page: NotionRow,
  matchedBy: CandidateMatch,
): NotionCandidate {
  const detail = propText(findProp(page.properties, schema.detail));
  return {
    source: spec.source,
    pageId: page.id,
    label: propText(findProp(page.properties, schema.label)),
    realName: propText(findProp(page.properties, schema.name)),
    listingType: spec.source === 'seller' ? detail : null,
    vehicle: spec.source === 'buyer' ? detail : null,
    status: propText(findProp(page.properties, schema.status)),
    matchedBy,
    createdTime: page.created_time ?? null,
    lastEditedTime: page.last_edited_time ?? null,
    url: page.url ?? null,
  };
}

/**
 * 表示順 = 自動選択の優先順。
 *   1. 掲載ID / 商談ID が入っている行を優先（フォーム提出だけで未掲載の行を先頭にしない）
 *   2. LINE User ID 一致を名前一致より優先
 *   3. 作成が新しい行を優先（プレミアム出品 → アプリ出品に移った人、新しい商談が現行）
 * last_edited_time ではなく created_time を使う: 旧行を編集（取引停止など）しても順序が変わらないため。
 */
function sortCandidates(list: NotionCandidate[]): NotionCandidate[] {
  const rank = (c: NotionCandidate) => (c.label ? 0 : 1) * 2 + (c.matchedBy === 'lineUserId' ? 0 : 1);
  return [...list].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return (b.createdTime ?? '').localeCompare(a.createdTime ?? '');
  });
}

/**
 * 指定DBについて、この友だちに紐付け得る行を列挙する。
 * - LINE User ID 一致（強い一致）
 * - 上記で判明した名前（+ 既存連携の名前）に一致する行（弱い一致。matchedBy='name'）
 *   … 新しい行が起票されたが LINE User ID 未記入のケースを救う
 */
export async function listCandidates(
  env: NotionLinkEnv,
  source: LinkSource,
  lineUserId: string,
  opts: { knownName?: string | null } = {},
): Promise<NotionCandidate[]> {
  const spec = dbSpec(env, source);
  if (!env.NOTION_API_KEY || !spec) return [];
  const schema = await resolveProps(env, spec);
  if (!schema.lineUserId) {
    throw new Error(
      `Notion ${LINK_SOURCE_LABELS[source]} に "${spec.lineUserId}" プロパティが見つかりません`,
    );
  }

  const byPage = new Map<string, NotionCandidate>();

  const luidFilter = equalsFilter(schema.lineUserId, lineUserId);
  if (luidFilter) {
    for (const page of await queryPages(env, spec, luidFilter)) {
      byPage.set(normalizeId(page.id), toCandidate(spec, schema, page, 'lineUserId'));
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
      for (const page of await queryPages(env, spec, nameFilter, 1)) {
        if (added >= NAME_MATCH_LIMIT) break;
        const key = normalizeId(page.id);
        if (byPage.has(key)) continue; // LINE User ID 一致を優先
        // 別の LINE アカウントが入っている行は同姓同名の別人。候補に出さない
        // （LINE User ID が空の行＝まだ連携されていない行だけを拾う）。
        const rowLineUserId = propText(findProp(page.properties, schema.lineUserId));
        if (rowLineUserId && rowLineUserId !== lineUserId) continue;
        byPage.set(key, toCandidate(spec, schema, page, 'name'));
        added++;
      }
    }
  }

  return sortCandidates(Array.from(byPage.values()));
}

/**
 * 両DBの候補をまとめて取得する（オペレーターが常に両方から選べるよう常に併記する）。
 * 片方のDBが失敗しても、もう片方は出せるよう group.error に落とす。
 */
export async function listAllCandidates(
  env: NotionLinkEnv,
  lineUserId: string,
  links: NotionFriendLinks = {},
): Promise<NotionCandidateGroup[]> {
  const fallbackName = primaryLink(links)?.realName ?? null;
  const results = await Promise.all(
    LINK_SOURCES.map(async (source): Promise<NotionCandidateGroup> => {
      const linked = links[source] ?? null;
      const base = {
        source,
        linkedPageId: linked?.pageId ?? null,
        pinned: Boolean(linked?.pinned),
      };
      try {
        const candidates = await listCandidates(env, source, lineUserId, {
          knownName: linked?.realName ?? fallbackName,
        });
        return { ...base, candidates, error: null };
      } catch (err) {
        console.error(`listAllCandidates: ${source} failed`, err);
        return {
          ...base,
          candidates: [],
          error: err instanceof Error ? err.message : '候補の取得に失敗しました',
        };
      }
    }),
  );
  return results;
}

/**
 * friends.metadata から連携情報を読む。
 * 既存データ（`notion` だけを持つ 500 件弱）は source を見て notionLinks 側へ読み替える。
 */
export function readNotionLinks(metadataJson: string | null | undefined): NotionFriendLinks {
  if (!metadataJson) return {};
  let meta: { notion?: NotionFriendLink; notionLinks?: NotionFriendLinks };
  try {
    meta = JSON.parse(metadataJson) as typeof meta;
  } catch {
    return {};
  }
  const out: NotionFriendLinks = {};
  const raw = meta.notionLinks;
  if (raw && typeof raw === 'object') {
    for (const source of LINK_SOURCES) {
      const link = raw[source];
      if (link && typeof link === 'object' && link.pageId) out[source] = link;
    }
  }
  // 後方互換: notionLinks が無い（or その source がまだ無い）行は `notion` の写しから復元する。
  const legacy = meta.notion;
  if (legacy && typeof legacy === 'object' && legacy.pageId) {
    const source: LinkSource = legacy.source === 'buyer' ? 'buyer' : 'seller';
    if (!out[source]) out[source] = { ...legacy, source };
  }
  return out;
}

/**
 * 後方互換フィールド `metadata.notion` の値。出品者を優先し、無ければ購入者。
 * 表示名・検索・Slack 通知はこれを見る（購入者のみの友だちでも商談IDが出るようにするため）。
 */
export function primaryLink(links: NotionFriendLinks): NotionFriendLink | null {
  return links.seller ?? links.buyer ?? null;
}

/**
 * Look up by LINE userId, store result in friends.metadata, return the link
 * (or null if nothing matched). Idempotent — その source の連携を上書きする。
 *
 * opts.source 省略時は出品者（＝自動連携の既定）。opts.pageId だけ渡された場合は
 * 両DBを引いてどちらの行かを判定する。
 * 候補に無い pageId は NotionCandidateNotFoundError（他人の行を誤って紐付けないためのガード）。
 * opts.pageId 無しでの再連携は、既存が pinned ならその行を維持したまま情報だけ更新する。
 */
export async function linkFriendToNotion(
  db: D1Database,
  env: NotionLinkEnv,
  friendId: string,
  lineUserId: string,
  opts: { pageId?: string; source?: LinkSource } = {},
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
  const links = readNotionLinks(row?.metadata ?? null);
  const fallbackName = primaryLink(links)?.realName ?? null;

  // source が渡されていなければ、pageId がどちらのDBの候補かで判定する（既定は出品者）。
  let source = opts.source ?? null;
  let candidates: NotionCandidate[];
  if (!source && opts.pageId) {
    const groups = await listAllCandidates(env, lineUserId, links);
    const target = normalizeId(opts.pageId);
    const hit = groups.find((g) => g.candidates.some((c) => normalizeId(c.pageId) === target));
    if (!hit) throw new NotionCandidateNotFoundError();
    source = hit.source;
    candidates = hit.candidates;
  } else {
    source = source ?? 'seller';
    candidates = await listCandidates(env, source, lineUserId, {
      knownName: links[source]?.realName ?? fallbackName,
    });
  }
  if (candidates.length === 0) return null;

  const prev = links[source] ?? null;
  let chosen: NotionCandidate;
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
    source,
    pageId: chosen.pageId,
    label: chosen.label,
    realName: chosen.realName,
    listingType: chosen.listingType,
    vehicle: chosen.vehicle,
    pinned,
    candidateCount: candidates.length,
    linkedAt: jstNow(),
  };

  // Merge into metadata (preserve other keys). `notion` は後方互換の写し。
  const nextLinks: NotionFriendLinks = { ...links, [source]: link };
  const merged = { ...existing, notionLinks: nextLinks, notion: primaryLink(nextLinks) };
  await db
    .prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(merged), jstNow(), friendId)
    .run();
  return link;
}
