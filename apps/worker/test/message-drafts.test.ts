/**
 * 送信相手ごとの下書き（BOXIV / message_drafts・migration 924）。
 *
 * 下書きは「用意しておいた文面」であって送信予約ではない。ここで固定するのは:
 *
 *  1. **相手ごとに閉じていること。** 一覧が他人の下書きを混ぜたら、隣の顧客宛ての
 *     文面をそのまま送る事故になる。
 *  2. **作成元（created_via）が認証コンテキストから決まること。** 本文の自己申告では
 *     「Claude が置いた」「人が書いた」を偽れてしまう。
 *  3. **送れない下書きを作らせないこと。** 空文字や LINE のテキスト上限超えを弾く。
 *  4. **一覧 API（GET /api/chats）が未送信の下書き件数を返すこと。** ✏️ バッジが
 *     出ないと、用意した下書きは誰にも気づかれない。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { requestAs, testDb } from './support/fixtures.js';

const FRIEND_A = 'friend-draft-a';
const FRIEND_B = 'friend-draft-b';

async function seedFriend(id: string): Promise<void> {
  await testDb
    .prepare(
      `INSERT INTO friends (id, line_user_id, display_name, created_at, updated_at)
       VALUES (?, ?, ?, '2026-01-01T00:00:00.000', '2026-01-01T00:00:00.000')`,
    )
    .bind(id, `U-${id}`, id)
    .run();
}

async function createDraft(friendId: string, body: unknown): Promise<Response> {
  return requestAs('owner', `/api/friends/${friendId}/drafts`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function listDrafts(friendId: string): Promise<Array<Record<string, unknown>>> {
  const res = await requestAs('owner', `/api/friends/${friendId}/drafts`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  return body.data;
}

beforeEach(async () => {
  await testDb.prepare('DELETE FROM message_drafts').run();
  await testDb.prepare('DELETE FROM chats').run();
  await testDb.prepare('DELETE FROM friends').run();
  await seedFriend(FRIEND_A);
  await seedFriend(FRIEND_B);
});

describe('下書きの CRUD', () => {
  it('作成 → 一覧 → 更新 → 削除', async () => {
    const created = await createDraft(FRIEND_A, { content: '明日の10時はいかがでしょうか', title: '日程の返信案' });
    expect(created.status).toBe(201);
    const draft = ((await created.json()) as { data: Record<string, unknown> }).data;
    expect(draft.content).toBe('明日の10時はいかがでしょうか');
    expect(draft.title).toBe('日程の返信案');

    expect(await listDrafts(FRIEND_A)).toHaveLength(1);

    const updated = await requestAs('owner', `/api/drafts/${draft.id}`, {
      method: 'PUT',
      body: JSON.stringify({ content: '明日の14時はいかがでしょうか' }),
    });
    expect(updated.status).toBe(200);
    expect((await listDrafts(FRIEND_A))[0].content).toBe('明日の14時はいかがでしょうか');

    const deleted = await requestAs('owner', `/api/drafts/${draft.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(await listDrafts(FRIEND_A)).toHaveLength(0);
  });

  it('1人の相手に複数の下書きを持てる（新しい順）', async () => {
    await createDraft(FRIEND_A, { content: '案1' });
    await testDb
      .prepare(`UPDATE message_drafts SET created_at = '2026-01-01T00:00:00.000' WHERE content = '案1'`)
      .run();
    await createDraft(FRIEND_A, { content: '案2' });
    const drafts = await listDrafts(FRIEND_A);
    expect(drafts.map((d) => d.content)).toEqual(['案2', '案1']);
  });

  it('一覧は相手ごとに閉じている（他人の下書きが混ざらない）', async () => {
    await createDraft(FRIEND_A, { content: 'Aさん宛て' });
    await createDraft(FRIEND_B, { content: 'Bさん宛て' });
    expect((await listDrafts(FRIEND_A)).map((d) => d.content)).toEqual(['Aさん宛て']);
    expect((await listDrafts(FRIEND_B)).map((d) => d.content)).toEqual(['Bさん宛て']);
  });

  it('存在しない相手・下書きは 404', async () => {
    expect((await createDraft('does-not-exist', { content: 'x' })).status).toBe(404);
    expect((await requestAs('owner', '/api/drafts/does-not-exist', { method: 'DELETE' })).status).toBe(404);
    expect(
      (await requestAs('owner', '/api/drafts/does-not-exist', { method: 'PUT', body: JSON.stringify({ content: 'x' }) })).status,
    ).toBe(404);
  });
});

describe('送れない下書きは作らせない', () => {
  it('空文字・空白だけは 400', async () => {
    expect((await createDraft(FRIEND_A, { content: '' })).status).toBe(400);
    expect((await createDraft(FRIEND_A, { content: '   \n ' })).status).toBe(400);
    expect((await createDraft(FRIEND_A, {})).status).toBe(400);
    expect(await listDrafts(FRIEND_A)).toHaveLength(0);
  });

  it('LINE のテキスト上限（5000字）を超えたら 400', async () => {
    expect((await createDraft(FRIEND_A, { content: 'あ'.repeat(5001) })).status).toBe(400);
    expect((await createDraft(FRIEND_A, { content: 'あ'.repeat(5000) })).status).toBe(201);
  });

  it('更新でも同じ検証がかかる', async () => {
    const created = await createDraft(FRIEND_A, { content: '元の文面' });
    const draft = ((await created.json()) as { data: { id: string } }).data;
    const res = await requestAs('owner', `/api/drafts/${draft.id}`, {
      method: 'PUT',
      body: JSON.stringify({ content: '  ' }),
    });
    expect(res.status).toBe(400);
    expect((await listDrafts(FRIEND_A))[0].content).toBe('元の文面');
  });
});

describe('作成元は認証コンテキストで決まる', () => {
  it('API キー（MCP / スクリプト）経由は created_via=api で、本文の自己申告では偽れない', async () => {
    // createdVia を body で送っても無視されること（人が書いたように見せかけられない）
    await createDraft(FRIEND_A, { content: 'Claude が用意した返信案', createdVia: 'admin' } as unknown);
    const drafts = await listDrafts(FRIEND_A);
    expect(drafts[0].createdVia).toBe('api');
  });
});

describe('チャット一覧の下書き件数', () => {
  it('GET /api/chats が未送信の下書き件数を返す', async () => {
    await testDb
      .prepare(
        `INSERT INTO chats (id, friend_id, status, last_message_at, created_at, updated_at)
         VALUES ('chat-a', ?, 'unread', '2026-01-02T00:00:00.000', '2026-01-01T00:00:00.000', '2026-01-01T00:00:00.000')`,
      )
      .bind(FRIEND_A)
      .run();
    await createDraft(FRIEND_A, { content: '案1' });
    await createDraft(FRIEND_A, { content: '案2' });

    const res = await requestAs('owner', '/api/chats');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; draftCount: number }> };
    expect(body.data.find((c) => c.id === 'chat-a')?.draftCount).toBe(2);
  });
});

describe('撮影スタッフからは触れない', () => {
  it('staff は下書きの読み書きができない（顧客宛ての文面は管理ロールに閉じる）', async () => {
    for (const init of [
      { method: 'GET', path: `/api/friends/${FRIEND_A}/drafts` },
      { method: 'POST', path: `/api/friends/${FRIEND_A}/drafts`, body: JSON.stringify({ content: 'x' }) },
      { method: 'PUT', path: '/api/drafts/does-not-exist', body: JSON.stringify({ content: 'x' }) },
      { method: 'DELETE', path: '/api/drafts/does-not-exist' },
    ]) {
      const res = await requestAs('staff', init.path, { method: init.method, body: init.body });
      expect(res.status, `${init.method} ${init.path}`).toBe(403);
    }
  });
});
