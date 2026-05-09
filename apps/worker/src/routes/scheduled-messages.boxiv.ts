// BOXIV-only: 個別チャット送信予約 (scheduled_messages) の CRUD。
// cron は services/scheduled-message-delivery.boxiv.ts が担当。

import { Hono } from 'hono';
import type { Env } from '../index.js';
import { jstNow } from '@line-crm/db';

const scheduledMessages = new Hono<Env>();

interface ScheduledMessageRow {
  id: string;
  friend_id: string;
  scheduled_at: string;
  message_type: 'text' | 'image' | 'flex';
  content: string;
  status: 'scheduled' | 'sent' | 'cancelled' | 'failed';
  sent_at: string | null;
  error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function serialize(r: ScheduledMessageRow) {
  return {
    id: r.id,
    friendId: r.friend_id,
    scheduledAt: r.scheduled_at,
    messageType: r.message_type,
    content: r.content,
    status: r.status,
    sentAt: r.sent_at,
    error: r.error,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// GET /api/friends/:friendId/scheduled-messages
scheduledMessages.get('/api/friends/:friendId/scheduled-messages', async (c) => {
  try {
    const friendId = c.req.param('friendId');
    const status = c.req.query('status');
    const conditions: string[] = ['friend_id = ?'];
    const binds: unknown[] = [friendId];
    if (status === 'scheduled' || status === 'sent' || status === 'cancelled' || status === 'failed') {
      conditions.push('status = ?');
      binds.push(status);
    }
    const result = await c.env.DB
      .prepare(
        `SELECT * FROM scheduled_messages WHERE ${conditions.join(' AND ')}
         ORDER BY scheduled_at DESC LIMIT 200`,
      )
      .bind(...binds)
      .all<ScheduledMessageRow>();
    return c.json({ success: true, data: result.results.map(serialize) });
  } catch (err) {
    console.error('GET /api/friends/:friendId/scheduled-messages error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/friends/:friendId/scheduled-messages — body: { scheduledAt, messageType, content }
scheduledMessages.post('/api/friends/:friendId/scheduled-messages', async (c) => {
  try {
    const friendId = c.req.param('friendId');
    const body = await c.req.json<{ scheduledAt: string; messageType: 'text' | 'image' | 'flex'; content: string }>();
    if (!body.scheduledAt || !body.messageType || !body.content) {
      return c.json({ success: false, error: 'scheduledAt, messageType, content are required' }, 400);
    }
    if (!['text', 'image', 'flex'].includes(body.messageType)) {
      return c.json({ success: false, error: 'messageType must be text|image|flex' }, 400);
    }
    // Past time check: allow up to 5 min in the past for clock skew
    const scheduledMs = new Date(body.scheduledAt).getTime();
    if (!Number.isFinite(scheduledMs)) {
      return c.json({ success: false, error: 'scheduledAt must be a valid datetime' }, 400);
    }
    if (scheduledMs < Date.now() - 5 * 60 * 1000) {
      return c.json({ success: false, error: 'scheduledAt must be in the future' }, 400);
    }
    const friend = await c.env.DB
      .prepare('SELECT id FROM friends WHERE id = ?')
      .bind(friendId)
      .first();
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }
    const id = crypto.randomUUID();
    const staffId = c.var.staff?.id ?? null;
    const now = jstNow();
    await c.env.DB
      .prepare(
        `INSERT INTO scheduled_messages
           (id, friend_id, scheduled_at, message_type, content, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, ?)`,
      )
      .bind(id, friendId, body.scheduledAt, body.messageType, body.content, staffId, now, now)
      .run();
    const created = await c.env.DB
      .prepare('SELECT * FROM scheduled_messages WHERE id = ?')
      .bind(id)
      .first<ScheduledMessageRow>();
    return c.json({ success: true, data: serialize(created!) }, 201);
  } catch (err) {
    console.error('POST /api/friends/:friendId/scheduled-messages error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/scheduled-messages/:id — キャンセル (sent / failed は変更不可)
scheduledMessages.delete('/api/scheduled-messages/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const row = await c.env.DB
      .prepare('SELECT status FROM scheduled_messages WHERE id = ?')
      .bind(id)
      .first<{ status: string }>();
    if (!row) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    if (row.status !== 'scheduled') {
      return c.json({ success: false, error: `cannot cancel — current status: ${row.status}` }, 400);
    }
    await c.env.DB
      .prepare(`UPDATE scheduled_messages SET status='cancelled', updated_at=? WHERE id=?`)
      .bind(jstNow(), id)
      .run();
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/scheduled-messages/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { scheduledMessages };
