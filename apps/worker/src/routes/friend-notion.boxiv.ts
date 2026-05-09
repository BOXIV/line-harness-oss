// BOXIV-only: 友だちの LINE userId を Notion 出品者DB と照合して
// 名前 / 掲載ID を friend.metadata.notion にキャッシュする。
//
// 自動連携は chats.ts / friends.ts の send 後にバックグラウンド (ctx.waitUntil)
// で発火する。手動連携はこの POST エンドポイント経由。

import { Hono } from 'hono';
import type { Env } from '../index.js';
import { linkFriendToNotion } from '../services/notion-friend-link.boxiv.js';

const friendNotion = new Hono<Env>();

friendNotion.post('/api/friends/:id/notion-link', async (c) => {
  try {
    const friendId = c.req.param('id');
    const friend = await c.env.DB
      .prepare('SELECT id, line_user_id FROM friends WHERE id = ?')
      .bind(friendId)
      .first<{ id: string; line_user_id: string }>();
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }
    const link = await linkFriendToNotion(c.env.DB, c.env, friend.id, friend.line_user_id);
    if (!link) {
      return c.json({
        success: true,
        data: { linked: false, message: 'Notion 出品者DB に該当する LINE User ID のレコードが見つかりませんでした' },
      });
    }
    return c.json({ success: true, data: { linked: true, link } });
  } catch (err) {
    console.error('POST /api/friends/:id/notion-link error:', err);
    return c.json({
      success: false,
      error: err instanceof Error ? err.message : 'Internal server error',
    }, 500);
  }
});

export { friendNotion };
