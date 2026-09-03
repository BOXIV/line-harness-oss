/**
 * チャットの直近ウィンドウ（BOXIV / 2026-09-03 の実障害）。
 *
 * 障害: `ORDER BY created_at ASC LIMIT 200` は **古い方から** 200 件を返す。
 * 200 件を超えたスレッド（実際に 204 件になった出品者トーク）では、いま送った
 * メッセージも相手の返信も画面に出ない。LINE には届いていて Slack 通知も出るので
 * 「送れているのに見えない」という形になり、原因が送信側にあるように見えてしまう。
 *
 * ここで固定するのは 3 点:
 *   1. ウィンドウは **新しい方から** 切り出される（最新が必ず入る）
 *   2. 表示順は古い順のまま（チャットは上から下へ時系列）
 *   3. 溢れた分は hasMore + ?before= でさかのぼれる（履歴は消えない）
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { requestAs, testDb } from './support/fixtures.js';

const FRIEND = { id: 'mw-friend', lineUserId: 'U-message-window' };
const CHAT_ID = 'mw-chat';
const TOTAL = 204; // 実障害と同じ件数（ウィンドウ 200 を 4 件超える）

/** i 番目のメッセージ ID。時系列＝番号順。 */
const msgId = (i: number) => `mw-msg-${String(i).padStart(4, '0')}`;

beforeEach(async () => {
  await testDb
    .prepare(
      `INSERT OR REPLACE INTO friends (id, line_user_id, display_name, is_following, created_at, updated_at)
       VALUES (?, ?, 'ウィンドウ検証', 1, '2026-01-01T00:00:00.000', '2026-01-01T00:00:00.000')`,
    )
    .bind(FRIEND.id, FRIEND.lineUserId)
    .run();
  await testDb
    .prepare(
      `INSERT OR REPLACE INTO chats (id, friend_id, status, last_message_at, created_at, updated_at)
       VALUES (?, ?, 'unread', '2026-01-01T00:00:00.000', '2026-01-01T00:00:00.000', '2026-01-01T00:00:00.000')`,
    )
    .bind(CHAT_ID, FRIEND.id)
    .run();
  await testDb.prepare(`DELETE FROM messages_log WHERE friend_id = ?`).bind(FRIEND.id).run();

  // 1 分刻みで TOTAL 件。本番と同じ「+09:00 付き」の文字列で入れる。
  const base = Date.UTC(2026, 8, 1, 0, 0, 0);
  for (let i = 0; i < TOTAL; i++) {
    const at = new Date(base + i * 60_000).toISOString().replace('Z', '+09:00');
    await testDb
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, created_at)
         VALUES (?, ?, ?, 'text', ?, ?)`,
      )
      .bind(msgId(i), FRIEND.id, i % 2 === 0 ? 'incoming' : 'outgoing', `本文${i}`, at)
      .run();
  }
});

describe('チャット詳細の直近ウィンドウ', () => {
  it('200 件を超えても最新のメッセージが返る（古い方から切らない）', async () => {
    const res = await requestAs('manager', `/api/chats/${CHAT_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { messages: Array<{ id: string }>; hasMoreMessages: boolean } }>();

    const ids = body.data.messages.map((m) => m.id);
    expect(ids).toHaveLength(200);
    // 最新（TOTAL-1）が入っていること = 障害の再発検知そのもの
    expect(ids.at(-1)).toBe(msgId(TOTAL - 1));
    expect(ids[0]).toBe(msgId(TOTAL - 200));
    expect(body.data.hasMoreMessages).toBe(true);
  });

  it('表示順は古い順（昇順）のまま', async () => {
    const res = await requestAs('manager', `/api/chats/${CHAT_ID}`);
    const body = await res.json<{ data: { messages: Array<{ createdAt: string }> } }>();
    const times = body.data.messages.map((m) => m.createdAt);
    expect([...times].sort()).toEqual(times);
  });

  it('溢れた分は ?before= でさかのぼれる', async () => {
    const first = await requestAs('manager', `/api/friends/${FRIEND.id}/messages`);
    const firstBody = await first.json<{ data: Array<{ id: string; createdAt: string }>; hasMore: boolean }>();
    expect(firstBody.hasMore).toBe(true);
    expect(firstBody.data.at(-1)!.id).toBe(msgId(TOTAL - 1));

    const older = await requestAs(
      'manager',
      `/api/friends/${FRIEND.id}/messages?before=${encodeURIComponent(firstBody.data[0]!.createdAt)}`,
    );
    const olderBody = await older.json<{ data: Array<{ id: string }>; hasMore: boolean }>();
    // 残り 4 件がちょうど返り、これ以上は無い
    expect(olderBody.data.map((m) => m.id)).toEqual([msgId(0), msgId(1), msgId(2), msgId(3)]);
    expect(olderBody.hasMore).toBe(false);
  });

  it('200 件以下のスレッドは全件返り hasMore は false', async () => {
    await testDb
      .prepare(`DELETE FROM messages_log WHERE friend_id = ? AND id > ?`)
      .bind(FRIEND.id, msgId(9))
      .run();
    const res = await requestAs('manager', `/api/chats/${CHAT_ID}`);
    const body = await res.json<{ data: { messages: Array<{ id: string }>; hasMoreMessages: boolean } }>();
    expect(body.data.messages).toHaveLength(10);
    expect(body.data.hasMoreMessages).toBe(false);
  });
});
