// BOXIV-only: 送信相手ごとの下書き (message_drafts) の CRUD。
//
// 「あらかじめ用意しておいた文面を、送る直前に人が確認して送る」ための箱。
//   - 書き手は管理画面のオペレーター（authVia=session）と、Claude の MCP / API キー
//     （authVia=api_key|env_key）の 2 通り。どちらで作られたかは created_via に残す
//   - **自動送信は一切しない**。cron も持たない（予約送信 scheduled_messages との違い）
//   - 送信は既存の POST /api/chats/:id/send。挿入した下書きの削除は管理画面が明示的に呼ぶ
//
// ⚠️ 下書きは顧客に向けた文面そのもの（PII を含み得る）。閲覧は管理ロールだけに閉じる
//    （撮影スタッフは staff-scope の許可リストに無いので既定で 403）。

import { Hono } from 'hono';
import type { Env } from '../index.js';
import { jstNow } from '@line-crm/db';
import { requireRole } from '../middleware/role-guard.js';

const messageDrafts = new Hono<Env>();

/** LINE のテキストメッセージ上限に合わせる（送れない下書きを作らせない）。 */
const MAX_CONTENT_LENGTH = 5000;
/** 一覧で見分けるための見出し。長い見出しは一覧を壊すので切る。 */
const MAX_TITLE_LENGTH = 80;

interface MessageDraftRow {
  id: string;
  friend_id: string;
  title: string | null;
  content: string;
  created_via: 'admin' | 'api';
  created_by_id: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

function serialize(r: MessageDraftRow) {
  return {
    id: r.id,
    friendId: r.friend_id,
    title: r.title,
    content: r.content,
    createdVia: r.created_via,
    createdById: r.created_by_id,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** 本文の検証。空文字・空白だけ・長すぎは弾く（送れない下書きは作らせない）。 */
function validateContent(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, error: '下書きの本文を入力してください' };
  }
  if (value.length > MAX_CONTENT_LENGTH) {
    return { ok: false, error: `下書きの本文は ${MAX_CONTENT_LENGTH} 文字以内にしてください` };
  }
  return { ok: true, value };
}

function normalizeTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_TITLE_LENGTH) : null;
}

// GET /api/friends/:friendId/drafts — その友だちの下書き（新しい順）
messageDrafts.get('/api/friends/:friendId/drafts', requireRole('owner','admin','manager'), async (c) => {
  try {
    const result = await c.env.DB
      .prepare(`SELECT * FROM message_drafts WHERE friend_id = ? ORDER BY created_at DESC LIMIT 100`)
      .bind(c.req.param('friendId'))
      .all<MessageDraftRow>();
    return c.json({ success: true, data: result.results.map(serialize) });
  } catch (err) {
    console.error('GET /api/friends/:friendId/drafts error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/friends/:friendId/drafts — 下書きを作る（管理画面 / MCP 共通）
messageDrafts.post('/api/friends/:friendId/drafts', requireRole('owner','admin','manager'), async (c) => {
  try {
    const friendId = c.req.param('friendId');
    const body = await c.req.json<{ content?: unknown; title?: unknown }>();
    const content = validateContent(body.content);
    if (!content.ok) return c.json({ success: false, error: content.error }, 400);

    // 存在しない友だちの下書きは作らせない（FK が無効な環境でも迷子の行を残さない）。
    const friend = await c.env.DB
      .prepare(`SELECT id FROM friends WHERE id = ?`)
      .bind(friendId)
      .first<{ id: string }>();
    if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);

    // 「誰が置いたか」は認証コンテキストから取る（本文の自己申告は信用しない）。
    const actor = c.get('staff');
    const createdVia = c.get('authVia') === 'session' ? 'admin' : 'api';
    const id = crypto.randomUUID();
    const now = jstNow();
    await c.env.DB
      .prepare(
        `INSERT INTO message_drafts
           (id, friend_id, title, content, created_via, created_by_id, created_by_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, friendId, normalizeTitle(body.title), content.value, createdVia, actor?.id ?? null, actor?.name ?? null, now, now)
      .run();

    const row = await c.env.DB
      .prepare(`SELECT * FROM message_drafts WHERE id = ?`)
      .bind(id)
      .first<MessageDraftRow>();
    return c.json({ success: true, data: row ? serialize(row) : null }, 201);
  } catch (err) {
    console.error('POST /api/friends/:friendId/drafts error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/drafts/:id — 本文/見出しの更新
messageDrafts.put('/api/drafts/:id', requireRole('owner','admin','manager'), async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{ content?: unknown; title?: unknown }>();
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (body.content !== undefined) {
      const content = validateContent(body.content);
      if (!content.ok) return c.json({ success: false, error: content.error }, 400);
      sets.push('content = ?');
      binds.push(content.value);
    }
    if (body.title !== undefined) {
      sets.push('title = ?');
      binds.push(normalizeTitle(body.title));
    }
    if (sets.length === 0) return c.json({ success: false, error: '更新する項目がありません' }, 400);

    sets.push('updated_at = ?');
    binds.push(jstNow(), id);
    const res = await c.env.DB
      .prepare(`UPDATE message_drafts SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...binds)
      .run();
    if (!res.meta.changes) return c.json({ success: false, error: 'Draft not found' }, 404);

    const row = await c.env.DB
      .prepare(`SELECT * FROM message_drafts WHERE id = ?`)
      .bind(id)
      .first<MessageDraftRow>();
    return c.json({ success: true, data: row ? serialize(row) : null });
  } catch (err) {
    console.error('PUT /api/drafts/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/drafts/:id — 使い終わった/不要になった下書きを消す
messageDrafts.delete('/api/drafts/:id', requireRole('owner','admin','manager'), async (c) => {
  try {
    const res = await c.env.DB
      .prepare(`DELETE FROM message_drafts WHERE id = ?`)
      .bind(c.req.param('id'))
      .run();
    if (!res.meta.changes) return c.json({ success: false, error: 'Draft not found' }, 404);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/drafts/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { messageDrafts };
