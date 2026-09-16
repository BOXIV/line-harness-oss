/**
 * 送信失敗の「理由」（BOXIV / migration 926）。
 *
 * これまで失敗は一律「送信失敗（未達）」だった。現場では理由で打つ手が変わる:
 *   ブロック   → LINE では二度と届かない。電話・メールへ切り替える
 *   友だち未追加 → 友だち追加を案内すれば届くようになる
 *   API エラー → 時間をおいて再送で通ることがある
 *
 * LINE はブロックと未追加を区別してくれない（どちらも is_following=0）。
 * **過去に届いた実績があるか**（受信 or 成功した送信）で切り分けるのがこの実装の肝なので、
 * ここで固定する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestAs, testDb } from './support/fixtures.js';

const BLOCKED = { id: 'fr-friend-blocked', lineUserId: 'U-failreason-blocked' };
const NEVER_ADDED = { id: 'fr-friend-never', lineUserId: 'U-failreason-never' };
const FOLLOWING = { id: 'fr-friend-following', lineUserId: 'U-failreason-following' };

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

/** 「過去に届いていた」痕跡＝受信メッセージを 1 件置く。 */
async function seedIncoming(friendId: string): Promise<void> {
  await testDb
    .prepare(
      `INSERT INTO messages_log (id, friend_id, direction, message_type, content, created_at)
       VALUES (?, ?, 'incoming', 'text', 'よろしくお願いします', '2026-01-02T00:00:00.000')`,
    )
    .bind(`${friendId}-in`, friendId)
    .run();
}

async function failureRowOf(friendId: string) {
  return testDb
    .prepare(
      `SELECT status, failure_reason FROM messages_log
        WHERE friend_id = ? AND direction = 'outgoing' AND status = 'failed'`,
    )
    .bind(friendId)
    .first<{ status: string | null; failure_reason: string | null }>();
}

let pushShouldFail = false;

beforeEach(() => {
  pushShouldFail = false;
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('api.line.me') && url.includes('/message/push')) {
      if (pushShouldFail) return new Response('{"message":"boom"}', { status: 500 });
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

describe('messages_log.failure_reason', () => {
  it('過去に届いた実績がある未フォローは blocked（ブロックされた、と言い切ってよい）', async () => {
    const chatId = await seedFriendAndChat(BLOCKED, 0);
    await seedIncoming(BLOCKED.id);

    const res = await requestAs('admin', `/api/chats/${chatId}/send`, {
      method: 'POST',
      body: JSON.stringify({ content: '届かないメッセージ' }),
    });
    expect(res.status).toBe(422);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain('ブロック');

    const row = await failureRowOf(BLOCKED.id);
    expect(row?.status).toBe('failed');
    expect(row?.failure_reason).toBe('blocked');
  });

  it('届いた実績がゼロの未フォローは not_added（ブロック扱いで断定しない）', async () => {
    const chatId = await seedFriendAndChat(NEVER_ADDED, 0);

    const res = await requestAs('admin', `/api/chats/${chatId}/send`, {
      method: 'POST',
      body: JSON.stringify({ content: '届かないメッセージ' }),
    });
    expect(res.status).toBe(422);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain('友だち追加');
    expect(body.error).not.toContain('ブロック');

    const row = await failureRowOf(NEVER_ADDED.id);
    expect(row?.failure_reason).toBe('not_added');
  });

  it('過去の失敗記録だけでは blocked にしない（失敗は「届いた実績」ではない）', async () => {
    const chatId = await seedFriendAndChat(NEVER_ADDED, 0);
    await testDb
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, status, created_at)
         VALUES ('fr-old-failed', ?, 'outgoing', 'text', '前回も届かなかった', 'failed', '2026-01-02T00:00:00.000')`,
      )
      .bind(NEVER_ADDED.id)
      .run();

    const res = await requestAs('admin', `/api/chats/${chatId}/send`, {
      method: 'POST',
      body: JSON.stringify({ content: '届かないメッセージ' }),
    });
    expect(res.status).toBe(422);

    const row = await testDb
      .prepare(
        `SELECT failure_reason FROM messages_log
          WHERE friend_id = ? AND id != 'fr-old-failed' AND status = 'failed'`,
      )
      .bind(NEVER_ADDED.id)
      .first<{ failure_reason: string | null }>();
    expect(row?.failure_reason).toBe('not_added');
  });

  it('LINE API のエラーは api_error（未フォローと混ぜない）', async () => {
    const chatId = await seedFriendAndChat(FOLLOWING, 1);
    pushShouldFail = true;

    const res = await requestAs('admin', `/api/chats/${chatId}/send`, {
      method: 'POST',
      body: JSON.stringify({ content: '送れないメッセージ' }),
    });
    expect(res.status).toBe(502);

    const row = await failureRowOf(FOLLOWING.id);
    expect(row?.failure_reason).toBe('api_error');
  });

  it('チャット詳細 API が failureReason を返す（管理画面の文言の出し分けに使う）', async () => {
    const chatId = await seedFriendAndChat(BLOCKED, 0);
    await seedIncoming(BLOCKED.id);
    await requestAs('admin', `/api/chats/${chatId}/send`, {
      method: 'POST',
      body: JSON.stringify({ content: '届かないメッセージ' }),
    });

    const detail = await requestAs('admin', `/api/chats/${chatId}`);
    const body = await detail.json<{
      data: { messages: Array<{ direction: string; status: string | null; failureReason: string | null }> };
    }>();
    const failed = body.data.messages.find((m) => m.status === 'failed');
    expect(failed?.failureReason).toBe('blocked');
  });
});
