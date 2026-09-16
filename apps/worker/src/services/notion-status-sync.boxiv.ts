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
//   memo    : Notion「取引メモ」(rich_text) → friend_notion_memos へ upsert（migration 927）。
//             空にされたらローカルも空にする（Notion がマスターなので消えたら消える）。
//
// 行の多重化ガード（重要）:
//   1人が同じDB内に複数行を持つ場合（出品者: プレミアム出品 → アプリ出品へ変更 /
//   購入者: 1人が複数の商談行）、friends.metadata の連携先に選ばれている行以外の
//   ステータス変更は反映しない。これが無いと「旧プレミアム出品行を取引停止にすると
//   LINE Connect 側も取引停止になる」（さらに 12h reconcile で行間のステータスが交互に
//   上書きされる）。判定は source ごとに独立（出品者リンクは購入者DBの行を縛らない）。
//   その source の連携が無い友だちは従来どおり LINE User ID 一致だけで反映する。

import { jstNow } from '@line-crm/db';
import { readNotionLinks } from './notion-friend-link.boxiv.js';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export interface NotionStatusSyncEnv {
  NOTION_API_KEY?: string;
  NOTION_SELLER_DB_ID?: string;
  NOTION_BUYER_DB_ID?: string;
  NOTION_SELLER_STATUS_PROP?: string;   // default: ステータス
  NOTION_BUYER_STATUS_PROP?: string;    // default: ステータス
  NOTION_PROP_LINE_USER_ID?: string;    // default: 'LINE User ID'
  // 取引メモ（migration 927）。⚠️ 既存の NOTION_*_MEMO_PROP（既定「その他詳細備考」）は
  // フォーム台帳の書き込み先で別物。混ぜると本来書くべきでない欄を上書きするので名前を分ける。
  NOTION_SELLER_DEAL_MEMO_PROP?: string; // default: 取引メモ
  NOTION_BUYER_DEAL_MEMO_PROP?: string;  // default: 取引メモ
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

function dealMemoPropName(env: NotionStatusSyncEnv, source: StatusSource): string {
  return (source === 'seller' ? env.NOTION_SELLER_DEAL_MEMO_PROP : env.NOTION_BUYER_DEAL_MEMO_PROP) || '取引メモ';
}

// Notion property 名は前後空白を含むことがあるので trim 一致で探す。
function findProp(props: NotionPage['properties'], name: string) {
  const target = name.trim();
  const key = Object.keys(props).find((k) => k.trim() === target);
  return key ? props[key] : undefined;
}

/** ページから取り込む値。プロパティが無い DB でも memo は null になるだけで害はない。 */
interface ExtractedPage {
  lineUserId: string | null;
  optionId: string | null;
  optionName: string | null;
  /** 取引メモ。プロパティ自体が無い / 空なら null。 */
  memo: string | null;
}

// ページから { lineUserId, optionId(Notion option id|null), optionName, memo } を取り出す。
function extractFromPage(
  env: NotionStatusSyncEnv,
  source: StatusSource,
  page: NotionPage,
): ExtractedPage {
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
  const memoProp = findProp(page.properties, dealMemoPropName(env, source));
  const memo = memoProp?.type === 'rich_text' ? plainText(memoProp.rich_text) : null;

  return { lineUserId, optionId, optionName, memo };
}

// friend_status_assignments / friend_notion_memos を Notion 値で upsert。
// 友だちの特定と「連携先の行か」の判定は 1 回で済ませ、ステータスとメモの両方に効かせる。
async function applyPage(
  db: D1Database,
  source: StatusSource,
  lineUserId: string,
  extracted: ExtractedPage,
  sourcePageId: string | null,
): Promise<string> {
  const friend = await db
    .prepare('SELECT id, metadata FROM friends WHERE line_user_id = ?')
    .bind(lineUserId)
    .first<{ id: string; metadata: string | null }>();
  if (!friend) return 'skip-no-friend';

  // その source の連携先行が決まっているなら、同じDBの他の行の変更は無視する。
  // 出品者リンクと購入者リンクは独立に持てるので、比較は必ず同 source 同士で行う。
  if (sourcePageId) {
    const linked = readNotionLinks(friend.metadata)[source];
    if (linked?.pageId && normalizeId(linked.pageId) !== normalizeId(sourcePageId)) {
      return 'skip-other-listing';
    }
  }

  await applyMemo(db, source, friend.id, extracted.memo, sourcePageId);
  return applyStatus(db, source, friend.id, extracted.optionId, extracted.optionName);
}

/**
 * 取引メモを friend_notion_memos へ upsert（migration 927）。
 * Notion で空にされたらローカルも空にする — Notion がマスターなので、
 * 消したはずのメモが管理画面に残り続ける方が事故になる。
 */
async function applyMemo(
  db: D1Database,
  source: StatusSource,
  friendId: string,
  memo: string | null,
  sourcePageId: string | null,
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO friend_notion_memos (friend_id, source, memo, page_id, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(friend_id, source) DO UPDATE SET
           memo = excluded.memo,
           page_id = excluded.page_id,
           updated_at = excluded.updated_at`,
      )
      .bind(friendId, source, memo, sourcePageId, jstNow())
      .run();
  } catch (err) {
    // メモの取り込み失敗でステータス同期まで巻き添えにしない（メモは表示用）。
    console.error('applyMemo: failed', source, friendId, err);
  }
}

async function applyStatus(
  db: D1Database,
  source: StatusSource,
  friendId: string,
  optionId: string | null,
  optionName: string | null,
): Promise<string> {
  if (!optionId) {
    await db.prepare('DELETE FROM friend_status_assignments WHERE friend_id = ?').bind(friendId).run();
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
    .bind(friendId, opt.id, jstNow())
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
  const extracted = extractFromPage(env, source, page);
  if (!extracted.lineUserId) return 'skip-no-lineuserid';
  return applyPage(db, source, extracted.lineUserId, extracted, page.id || pageId);
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
          const extracted = extractFromPage(env, source, page);
          if (!extracted.lineUserId) continue;
          await applyPage(db, source, extracted.lineUserId, extracted, page.id);
        } catch (err) {
          console.error('reconcileNotionStatuses: row failed', err);
        }
      }
      cursor = data.has_more ? data.next_cursor ?? undefined : undefined;
      pages++;
    } while (cursor && pages < MAX_PAGES);
  }
}
