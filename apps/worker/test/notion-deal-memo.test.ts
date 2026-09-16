/**
 * Notion「取引メモ」の取り込み（BOXIV / migration 927）。
 *
 * Notion がマスターで、LINE Connect は表示するだけ。反映経路は顧客ステータスと同じ
 * （オートメーション webhook + 12h reconcile）ので、同じ取り込み関数に相乗りしている。
 *
 * ここで固定するのは 4 点:
 *   1. メモが friend_notion_memos に入る
 *   2. Notion で空にしたらローカルも空になる（消したメモが残り続けない）
 *   3. 連携先に選ばれていない行の変更は無視する（1人が同じDBに複数行を持つケース）
 *   4. プロパティ名は env で上書きでき、既定は「取引メモ」
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb } from './support/fixtures.js';
import { syncNotionPageStatus, type NotionStatusSyncEnv } from '../src/services/notion-status-sync.boxiv.js';

const SELLER_DB = '1a6bb10a-ac1a-809e-8d69-f69d485e0257';
const LINKED_PAGE = '11111111-1111-1111-1111-111111111111';
const OTHER_PAGE = '22222222-2222-2222-2222-222222222222';
const FRIEND = { id: 'memo-friend-1', lineUserId: 'U-memo-1' };

const ENV: NotionStatusSyncEnv = {
  NOTION_API_KEY: 'test-notion-key',
  NOTION_SELLER_DB_ID: SELLER_DB,
  NOTION_PROP_LINE_USER_ID: 'LINE User ID',
};

/** Notion の GET /v1/pages/{id} 応答を組み立てる。 */
function pageBody(pageId: string, memo: string | null, memoPropName = '取引メモ') {
  return {
    id: pageId,
    parent: { type: 'database_id', database_id: SELLER_DB },
    properties: {
      'LINE User ID': { type: 'rich_text', rich_text: [{ plain_text: FRIEND.lineUserId }] },
      ステータス: { type: 'status', status: null },
      [memoPropName]: {
        type: 'rich_text',
        rich_text: memo === null ? [] : [{ plain_text: memo }],
      },
    },
  };
}

function stubNotion(body: unknown) {
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('api.notion.com/v1/pages/')) {
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

async function seedFriend(metadata: string | null): Promise<void> {
  await testDb
    .prepare(
      `INSERT OR REPLACE INTO friends (id, line_user_id, display_name, is_following, metadata, created_at, updated_at)
       VALUES (?, ?, 'メモ太郎', 1, ?, '2026-01-01T00:00:00.000', '2026-01-01T00:00:00.000')`,
    )
    .bind(FRIEND.id, FRIEND.lineUserId, metadata)
    .run();
  await testDb.prepare(`DELETE FROM friend_notion_memos WHERE friend_id = ?`).bind(FRIEND.id).run();
}

function memoRow() {
  return testDb
    .prepare(`SELECT memo, page_id FROM friend_notion_memos WHERE friend_id = ? AND source = 'seller'`)
    .bind(FRIEND.id)
    .first<{ memo: string | null; page_id: string | null }>();
}

/** この友だちは LINKED_PAGE の行と連携済み、という metadata。 */
const LINKED_META = JSON.stringify({ notionLinks: { seller: { source: 'seller', pageId: LINKED_PAGE } } });

beforeEach(() => {
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 200 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Notion 取引メモの取り込み', () => {
  it('メモが friend_notion_memos に入る', async () => {
    await seedFriend(null);
    stubNotion(pageBody(LINKED_PAGE, '9/20 納車予定。書類は郵送済み。'));

    await syncNotionPageStatus(testDb, ENV, LINKED_PAGE);

    const row = await memoRow();
    expect(row?.memo).toBe('9/20 納車予定。書類は郵送済み。');
    expect(row?.page_id).toBe(LINKED_PAGE);
  });

  it('Notion で空にしたらローカルも空になる', async () => {
    await seedFriend(null);
    stubNotion(pageBody(LINKED_PAGE, '一時的なメモ'));
    await syncNotionPageStatus(testDb, ENV, LINKED_PAGE);
    expect((await memoRow())?.memo).toBe('一時的なメモ');

    stubNotion(pageBody(LINKED_PAGE, null));
    await syncNotionPageStatus(testDb, ENV, LINKED_PAGE);
    expect((await memoRow())?.memo).toBeNull();
  });

  it('連携先に選ばれていない行のメモは反映しない', async () => {
    await seedFriend(LINKED_META);
    stubNotion(pageBody(LINKED_PAGE, '連携先の行のメモ'));
    await syncNotionPageStatus(testDb, ENV, LINKED_PAGE);

    // 同じ人の別行（旧掲載など）を編集しても、連携先の行のメモは書き換わらない
    stubNotion(pageBody(OTHER_PAGE, '別行のメモ'));
    const result = await syncNotionPageStatus(testDb, ENV, OTHER_PAGE);

    expect(result).toBe('skip-other-listing');
    expect((await memoRow())?.memo).toBe('連携先の行のメモ');
  });

  it('プロパティ名は env で上書きできる', async () => {
    await seedFriend(null);
    stubNotion(pageBody(LINKED_PAGE, '別名プロパティのメモ', '取引ノート'));

    // 既定（取引メモ）では見つからないので null
    await syncNotionPageStatus(testDb, ENV, LINKED_PAGE);
    expect((await memoRow())?.memo).toBeNull();

    await syncNotionPageStatus(testDb, { ...ENV, NOTION_SELLER_DEAL_MEMO_PROP: '取引ノート' }, LINKED_PAGE);
    expect((await memoRow())?.memo).toBe('別名プロパティのメモ');
  });
});
