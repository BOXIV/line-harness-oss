// BOXIV-only: 友だちの LINE userId を Notion の 出品者DB / 購入者DB と照合して
// 名前 / 掲載ID(商談ID) を friends.metadata にキャッシュする。
//
// 自動連携（出品者のみ）は chats.ts / friends.ts の send 後にバックグラウンド (ctx.waitUntil)
// で発火する。手動連携はこの POST エンドポイント経由。
//
// 1人が複数行を持つ（出品者: プレミアム出品 → アプリ出品へ変更 / 購入者: 複数の商談行）ため、
// GET /notion-candidates で **両DBの候補を常に併記** して返し、POST /notion-link に
// pageId(+source) を渡してどの行と連携するかをオペレーターが選ぶ。
//
// レスポンスは worker/web の独立デプロイによるスキューに耐えるよう、新形式 `groups` と
// 旧形式 `candidates / linkedPageId / pinned`（出品者分）を両方返す。

import { Hono } from 'hono';
import type { Env } from '../index.js';
import {
  linkFriendToNotion,
  listAllCandidates,
  readNotionLinks,
  NotionCandidateNotFoundError,
  type LinkSource,
} from '../services/notion-friend-link.boxiv.js';
import { requireRole } from '../middleware/role-guard.js';

const friendNotion = new Hono<Env>();

// 連携先の候補（この友だちに紐付け得る 出品者DB / 購入者DB の行）を列挙する。
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
    const links = readNotionLinks(friend.metadata);
    const groups = await listAllCandidates(c.env, friend.line_user_id, links);
    const seller = groups.find((g) => g.source === 'seller');
    return c.json({
      success: true,
      data: {
        groups,
        // 旧 web（出品者のみ対応）向けの互換フィールド
        candidates: seller?.candidates ?? [],
        linkedPageId: seller?.linkedPageId ?? null,
        pinned: seller?.pinned ?? false,
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
    // body 無し = 出品者の自動判定（従来の挙動）。pageId 指定 = その行に固定。
    // source は Notion への問い合わせを片方に絞るためのヒントで、
    // pageId が本当にその候補に含まれるかは linkFriendToNotion 側で必ず検証する。
    let pageId: string | undefined;
    let source: LinkSource | undefined;
    try {
      const body = await c.req.json<{ pageId?: unknown; source?: unknown }>();
      if (typeof body?.pageId === 'string' && body.pageId.trim()) pageId = body.pageId.trim();
      if (body?.source === 'seller' || body?.source === 'buyer') source = body.source;
    } catch {
      pageId = undefined;
    }
    const link = await linkFriendToNotion(c.env.DB, c.env, friend.id, friend.line_user_id, { pageId, source });
    if (!link) {
      const dbLabel = source === 'buyer' ? '購入者リスト' : '出品者リスト';
      return c.json({
        success: true,
        data: { linked: false, message: `Notion ${dbLabel} に該当する LINE User ID のレコードが見つかりませんでした` },
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
