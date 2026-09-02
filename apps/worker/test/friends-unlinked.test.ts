/**
 * 友だち一覧の「未連携」絞り込み（BOXIV / GET /api/friends?linkState=unlinked）。
 *
 * 「未連携」= 出品者にも購入者にも紐づいていない友だち。連携の根拠は 2 つあり、
 * **どちらも無い**ものだけが未連携になることを固定する:
 *
 *   - 分類タグ（出品者/購入者）… 連携確定時にコードが付ける（source-tag.boxiv.ts）
 *   - Notion 連携（metadata.notionLinks / 旧 metadata.notion）
 *
 * タグだけで判定すると、**オペレーターがチャット画面で手動連携した友だち**
 * （手動連携は分類タグを付けない）が未連携に出てしまい、催促の対象を取り違える。
 * 逆に Notion 連携だけで判定すると、Notion に行が無いまま LINE 連携だけ済んだ人が
 * 未連携に出る。だから両方を見る。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { requestAs, testDb } from './support/fixtures.js';

interface SeedFriend {
  id: string;
  /** 付ける分類タグ（未指定 = タグ無し） */
  tag?: '出品者' | '購入者' | '診断';
  /** friends.metadata（未指定 = 列の既定値 '{}'。NOT NULL 列なので NULL は入らない） */
  metadata?: unknown;
}

const TAG_IDS: Record<string, string> = { 出品者: 'tag-seller', 購入者: 'tag-buyer', 診断: 'tag-other' };

async function seedFriends(rows: SeedFriend[]): Promise<void> {
  for (const [name, id] of Object.entries(TAG_IDS)) {
    await testDb
      .prepare(`INSERT OR IGNORE INTO tags (id, name, color) VALUES (?, ?, '#16A34A')`)
      .bind(id, name)
      .run();
  }
  for (const r of rows) {
    if (r.metadata === undefined) {
      await testDb
        .prepare(
          `INSERT INTO friends (id, line_user_id, display_name, created_at, updated_at)
           VALUES (?, ?, ?, '2026-01-01T00:00:00.000', '2026-01-01T00:00:00.000')`,
        )
        .bind(r.id, `U-${r.id}`, r.id)
        .run();
    } else {
      await testDb
        .prepare(
          `INSERT INTO friends (id, line_user_id, display_name, metadata, created_at, updated_at)
           VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000', '2026-01-01T00:00:00.000')`,
        )
        .bind(r.id, `U-${r.id}`, r.id, JSON.stringify(r.metadata))
        .run();
    }
    if (r.tag) {
      await testDb
        .prepare(`INSERT INTO friend_tags (friend_id, tag_id) VALUES (?, ?)`)
        .bind(r.id, TAG_IDS[r.tag])
        .run();
    }
  }
}

const notionLink = (source: 'seller' | 'buyer') => ({
  source,
  pageId: `page-${source}`,
  label: '10394',
  realName: 'テスト太郎',
  linkedAt: '2026-01-01T00:00:00.000',
});

async function listIds(query: string): Promise<{ ids: string[]; total: number }> {
  const res = await requestAs('owner', `/api/friends${query}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { items: Array<{ id: string }>; total: number } };
  return { ids: body.data.items.map((f) => f.id).sort(), total: body.data.total };
}

beforeEach(async () => {
  // ファイル内でテスト間の状態は共有されるので、毎回まっさらにしてから seed する。
  await testDb.prepare('DELETE FROM friend_tags').run();
  await testDb.prepare('DELETE FROM friends').run();
  await seedFriends([
    // 連携済み — 未連携に出てはいけない
    { id: 'tagged-seller', tag: '出品者' },
    { id: 'tagged-buyer', tag: '購入者' },
    { id: 'manual-notion-buyer', metadata: { notionLinks: { buyer: notionLink('buyer') } } },
    { id: 'legacy-notion', metadata: { notion: notionLink('seller') } },
    // 未連携
    { id: 'default-metadata' },
    { id: 'empty-metadata', metadata: {} },
    { id: 'other-tag-only', tag: '診断', metadata: { ref: 'campaign' } },
    // 連携の残骸（pageId が無い）は連携とみなさない
    { id: 'links-without-pageid', metadata: { notionLinks: {} } },
  ]);
});

describe('GET /api/friends?linkState=unlinked', () => {
  it('分類タグも Notion 連携も無い友だちだけを返す', async () => {
    const { ids, total } = await listIds('?linkState=unlinked');
    expect(ids).toEqual(['default-metadata', 'empty-metadata', 'links-without-pageid', 'other-tag-only']);
    // 件数（ページャの母数）も絞り込み後の値になっていること
    expect(total).toBe(4);
  });

  it('手動 Notion 連携（分類タグは付かない）は未連携に出ない', async () => {
    const { ids } = await listIds('?linkState=unlinked');
    expect(ids).not.toContain('manual-notion-buyer');
    // 旧形式 metadata.notion しか持たない行も同じ
    expect(ids).not.toContain('legacy-notion');
  });

  it('linkState を付けなければ全員返る（既定の挙動を変えない）', async () => {
    const { total } = await listIds('');
    expect(total).toBe(8);
  });

  it('未知の linkState は無視して全員返す', async () => {
    const { total } = await listIds('?linkState=whatever');
    expect(total).toBe(8);
  });

  it('タグ絞り込みと併用できる（AND になる）', async () => {
    const { ids } = await listIds(`?linkState=unlinked&tagId=${TAG_IDS['診断']}`);
    expect(ids).toEqual(['other-tag-only']);
  });
});
