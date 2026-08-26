/**
 * 送信メッセージの「誰が送ったか」（BOXIV / migration 923）。
 *
 * オペレーターチャットは送信バブルの日時の左に送信者名を出す。名前の出どころは
 * messages_log.sent_by_name で、**送信した時点の名前を焼き付けて持つ**
 * （スタッフが改名・退職しても、当時だれが送ったかの記録は変わってはいけない）。
 *
 * ここで固定するのは 3 点:
 *   1. 送信が成功したら送信者が記録され、チャット詳細 API が sentByName として返す
 *   2. 未フォロー宛で失敗した記録にも送信者が残る（誰の送信が届かなかったか追える）
 *   3. 自動送信（シナリオ / 一斉配信）は NULL のまま＝管理画面に名前を出さない
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestAs, testDb, STAFF_FIXTURES } from './support/fixtures.js';

const FOLLOWING = { id: 'sb-friend-following', lineUserId: 'U-sentby-following' };
const BLOCKED = { id: 'sb-friend-blocked', lineUserId: 'U-sentby-blocked' };

async function seedFriendAndChat(friend: { id: string; lineUserId: string }, isFollowing: number): Promise<string> {
  await testDb
    .prepare(
      `INSERT OR REPLACE INTO friends (id, line_user_id, display_name, is_following, created_at, updated_at)
       VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000', '2026-01-01T00:00:00.000')`,
    )
    .bind(friend.id, friend.lineUserId, 'テスト友だち', isFollowing)
    .run();
  const chatId = `${friend.id}-chat`;
  await testDb
    .prepare(
      `INSERT OR REPLACE INTO chats (id, friend_id, status, last_message_at, created_at, updated_at)
       VALUES (?, ?, 'unread', '2026-01-01T00:00:00.000', '2026-01-01T00:00:00.000', '2026-01-01T00:00:00.000')`,
    )
    .bind(chatId, friend.id)
    .run();
  await testDb.prepare(`DELETE FROM messages_log WHERE friend_id = ?`).bind(friend.id).run();
  return chatId;
}

beforeEach(() => {
  // LINE への push だけ差し替える。他（Notion 自動連携など waitUntil 側）は 200 空応答で無害化。
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('api.line.me') && url.includes('/message/push')) {
      return new Response(JSON.stringify({ sentMessages: [{ id: 'line-msg-1' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    void init;
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('messages_log.sent_by_*', () => {
  it('オペレーターの送信に送信者が記録され、チャット詳細が sentByName で返す', async () => {
    const chatId = await seedFriendAndChat(FOLLOWING, 1);

    const res = await requestAs('manager', `/api/chats/${chatId}/send`, {
      method: 'POST',
      body: JSON.stringify({ content: 'こんにちは' }),
    });
    expect(res.status).toBe(200);

    const row = await testDb
      .prepare(`SELECT sent_by_id, sent_by_name, status FROM messages_log WHERE friend_id = ? AND direction = 'outgoing'`)
      .bind(FOLLOWING.id)
      .first<{ sent_by_id: string | null; sent_by_name: string | null; status: string | null }>();
    expect(row?.sent_by_id).toBe(STAFF_FIXTURES.manager.id);
    expect(row?.sent_by_name).toBe(STAFF_FIXTURES.manager.name);

    const detail = await requestAs('manager', `/api/chats/${chatId}`);
    const body = await detail.json<{ data: { messages: Array<{ direction: string; sentByName: string | null }> } }>();
    const outgoing = body.data.messages.filter((m) => m.direction === 'outgoing');
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0]!.sentByName).toBe(STAFF_FIXTURES.manager.name);
  });

  it('未フォロー宛で届かなかった記録にも送信者が残る', async () => {
    const chatId = await seedFriendAndChat(BLOCKED, 0);

    const res = await requestAs('admin', `/api/chats/${chatId}/send`, {
      method: 'POST',
      body: JSON.stringify({ content: '届かないメッセージ' }),
    });
    expect(res.status).toBe(422);

    const row = await testDb
      .prepare(`SELECT sent_by_name, status FROM messages_log WHERE friend_id = ?`)
      .bind(BLOCKED.id)
      .first<{ sent_by_name: string | null; status: string | null }>();
    expect(row?.status).toBe('failed');
    expect(row?.sent_by_name).toBe(STAFF_FIXTURES.admin.name);
  });

  it('自動送信は送信者 NULL のまま（管理画面に名前を出さない）', async () => {
    const chatId = await seedFriendAndChat(FOLLOWING, 1);
    await testDb
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, created_at)
         VALUES ('sb-auto-1', ?, 'outgoing', 'text', '自動配信', '2026-01-02T00:00:00.000')`,
      )
      .bind(FOLLOWING.id)
      .run();

    const detail = await requestAs('manager', `/api/chats/${chatId}`);
    const body = await detail.json<{ data: { messages: Array<{ id: string; sentByName: string | null }> } }>();
    const auto = body.data.messages.find((m) => m.id === 'sb-auto-1');
    expect(auto?.sentByName).toBeNull();
  });
});
