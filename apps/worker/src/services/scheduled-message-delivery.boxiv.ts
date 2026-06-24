// BOXIV-only: 個別チャット送信予約 (scheduled_messages) の cron 処理。
// 5 分 cron で `scheduled_at <= now AND status='scheduled'` の行を拾って push。

import type { LineClient, Message } from '@line-crm/line-sdk';
import { getFriendById, getLineAccountById, jstNow } from '@line-crm/db';
import { extractFlexAltText } from '../utils/flex-alt-text.js';
import { addJitter, sleep } from './stealth.js';
import { firstSentMessageId } from '../utils/quote.js';

interface ScheduledMessageRow {
  id: string;
  friend_id: string;
  scheduled_at: string;
  message_type: 'text' | 'image' | 'flex';
  content: string;
  status: string;
  created_by: string | null;
}

function buildMessage(messageType: string, content: string): Message {
  if (messageType === 'text') {
    return { type: 'text', text: content };
  }
  if (messageType === 'image') {
    try {
      const parsed = JSON.parse(content) as { originalContentUrl: string; previewImageUrl: string };
      return { type: 'image', originalContentUrl: parsed.originalContentUrl, previewImageUrl: parsed.previewImageUrl };
    } catch {
      return { type: 'text', text: content };
    }
  }
  if (messageType === 'flex') {
    try {
      const contents = JSON.parse(content);
      return { type: 'flex', altText: extractFlexAltText(contents), contents };
    } catch {
      return { type: 'text', text: content };
    }
  }
  return { type: 'text', text: content };
}

export async function processScheduledMessages(
  db: D1Database,
  defaultAccessToken: string,
  LineClientCtor: typeof LineClient,
): Promise<void> {
  const now = jstNow();
  const due = await db
    .prepare(
      `SELECT id, friend_id, scheduled_at, message_type, content, status, created_by
       FROM scheduled_messages
       WHERE status = 'scheduled' AND scheduled_at <= ?
       ORDER BY scheduled_at ASC
       LIMIT 100`,
    )
    .bind(now)
    .all<ScheduledMessageRow>();

  for (let i = 0; i < due.results.length; i++) {
    const sm = due.results[i];
    if (i > 0) await sleep(addJitter(50, 200));
    try {
      const friend = await getFriendById(db, sm.friend_id);
      if (!friend || !friend.is_following) {
        // skip (フォロー解除済み)
        await db
          .prepare(`UPDATE scheduled_messages SET status='cancelled', error=?, updated_at=? WHERE id=?`)
          .bind('friend not following', jstNow(), sm.id)
          .run();
        continue;
      }

      // Resolve access token (multi-account support)
      let accessToken = defaultAccessToken;
      const lineAccountId = (friend as unknown as Record<string, unknown>).line_account_id as string | undefined;
      if (lineAccountId) {
        const account = await getLineAccountById(db, lineAccountId);
        if (account) accessToken = account.channel_access_token;
      }

      const lineClient = new LineClientCtor(accessToken);
      const message = buildMessage(sm.message_type, sm.content);
      const sentLineId = firstSentMessageId(await lineClient.pushMessage(friend.line_user_id, [message]));

      // ログ + ステータス更新を1ターンで。line_message_id=友だちの引用解決用。
      const sentAt = jstNow();
      await db.batch([
        db
          .prepare(
            `INSERT INTO messages_log (id, friend_id, direction, message_type, content, line_message_id, created_at)
             VALUES (?, ?, 'outgoing', ?, ?, ?, ?)`,
          )
          .bind(crypto.randomUUID(), friend.id, sm.message_type, sm.content, sentLineId, sentAt),
        db
          .prepare(
            `UPDATE scheduled_messages SET status='sent', sent_at=?, updated_at=? WHERE id=?`,
          )
          .bind(sentAt, sentAt, sm.id),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`scheduled_messages delivery error (${sm.id}):`, msg);
      await db
        .prepare(`UPDATE scheduled_messages SET status='failed', error=?, updated_at=? WHERE id=?`)
        .bind(msg.slice(0, 500), jstNow(), sm.id)
        .run();
    }
  }
}
