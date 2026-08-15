// BOXIV-only: 友だちの LINE userId を Notion 出品者DB と照合して
// 名前 / 掲載ID を friend.metadata.notion にキャッシュする。
//
// 自動連携は chats.ts / friends.ts の send 後にバックグラウンド (ctx.waitUntil)
// で発火する。手動連携はこの POST エンドポイント経由。
//
// 1人の出品者が複数の掲載ID行を持つ場合（プレミアム出品 → アプリ出品へ変更 等）は
// GET /notion-candidates で候補を出し、POST /notion-link に pageId を渡して
// どの掲載IDと連携するかをオペレーターが選ぶ。

import { Hono } from 'hono';
import type { Env } from '../index.js';
import {
  linkFriendToNotion,
  listSellerCandidates,
  NotionCandidateNotFoundError,
  type NotionFriendLink,
} from '../services/notion-friend-link.boxiv.js';
import { requireRole } from '../middleware/role-guard.js';

const friendNotion = new Hono<Env>();

function parseLink(metadataJson: string | null): NotionFriendLink | null {
  if (!metadataJson) return null;
  try {
    const meta = JSON.parse(metadataJson) as { notion?: NotionFriendLink };
    return meta.notion ?? null;
  } catch {
    return null;
  }
}

// 連携先の候補（この友だちに紐付け得る Notion 出品者DB の行）を列挙する。
friendNotion.get('/api/friends/:id/notion-candidates', async (c) => {
  try {
    const friendId = c.req.param('id');
    const friend = await c.env.DB
      .prepare('SELECT id, line_user_id, metadata FROM friends WHERE id = ?')
      .bind(friendId)
      .first<{ id: string; line_user_id: string; metadata: string | null }>();
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }
    const link = parseLink(friend.metadata);
    const candidates = await listSellerCandidates(c.env, friend.line_user_id, {
      knownName: link?.realName ?? null,
    });
    return c.json({
      success: true,
      data: {
        candidates,
        linkedPageId: link?.pageId ?? null,
        pinned: Boolean(link?.pinned),
      },
    });
  } catch (err) {
    console.error('GET /api/friends/:id/notion-candidates error:', err);
    return c.json({
      success: false,
      error: err instanceof Error ? err.message : 'Internal server error',
    }, 500);
  }
});

friendNotion.post('/api/friends/:id/notion-link', requireRole('owner','admin','manager'), async (c) => {
  try {
    const friendId = c.req.param('id');
    const friend = await c.env.DB
      .prepare('SELECT id, line_user_id FROM friends WHERE id = ?')
      .bind(friendId)
      .first<{ id: string; line_user_id: string }>();
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }
    // body 無し = 自動判定（従来の挙動）。pageId 指定 = その掲載ID行に固定。
    let pageId: string | undefined;
    try {
      const body = await c.req.json<{ pageId?: unknown }>();
      if (typeof body?.pageId === 'string' && body.pageId.trim()) pageId = body.pageId.trim();
    } catch {
      pageId = undefined;
    }
    const link = await linkFriendToNotion(c.env.DB, c.env, friend.id, friend.line_user_id, { pageId });
    if (!link) {
      return c.json({
        success: true,
        data: { linked: false, message: 'Notion 出品者DB に該当する LINE User ID のレコードが見つかりませんでした' },
      });
    }
    return c.json({ success: true, data: { linked: true, link } });
  } catch (err) {
    if (err instanceof NotionCandidateNotFoundError) {
      return c.json({ success: false, error: err.message }, 400);
    }
    console.error('POST /api/friends/:id/notion-link error:', err);
    return c.json({
      success: false,
      error: err instanceof Error ? err.message : 'Internal server error',
    }, 500);
  }
});

export { friendNotion };
