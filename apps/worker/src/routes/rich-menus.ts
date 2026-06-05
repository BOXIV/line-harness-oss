import { Hono } from 'hono';
import { LineClient } from '@line-crm/line-sdk';
import { getFriendById } from '@line-crm/db';
import type { Env } from '../index.js';

const richMenus = new Hono<Env>();

// BOXIV: GET /api/rich-menus/:id/image-content — download the image LINE has stored for this rich menu (debug)
richMenus.get('/api/rich-menus/:id/image-content', async (c) => {
  try {
    const richMenuId = c.req.param('id');
    const res = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
      headers: { Authorization: `Bearer ${c.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    });
    if (!res.ok) {
      const t = await res.text();
      return c.json({ success: false, error: t }, res.status as 500);
    }
    const buf = await res.arrayBuffer();
    return new Response(buf, { headers: { 'Content-Type': res.headers.get('content-type') ?? 'image/png' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ success: false, error: `Failed to fetch rich menu image: ${message}` }, 500);
  }
});

// BOXIV: GET /api/rich-menus/default — return the LINE platform's currently configured default rich menu ID
richMenus.get('/api/rich-menus/default', async (c) => {
  try {
    const res = await fetch('https://api.line.me/v2/bot/user/all/richmenu', {
      headers: { Authorization: `Bearer ${c.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    });
    if (res.status === 404) return c.json({ success: true, data: { richMenuId: null } });
    const json = await res.json();
    if (!res.ok) return c.json({ success: false, error: json }, res.status as 500);
    return c.json({ success: true, data: json });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ success: false, error: `Failed to fetch default rich menu: ${message}` }, 500);
  }
});

// GET /api/rich-menus — list all rich menus from LINE API
richMenus.get('/api/rich-menus', async (c) => {
  try {
    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    const result = await lineClient.getRichMenuList();
    return c.json({ success: true, data: result.richmenus ?? [] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('GET /api/rich-menus error:', message);
    return c.json({ success: false, error: `Failed to fetch rich menus: ${message}` }, 500);
  }
});

// BOXIV: GET /api/rich-menus/:id/image-content — proxy the image LINE stores for this rich menu.
// 管理 UI のプレビュー/編集キャンバスに「実際のクリエイティブ」を表示するため。
// LINE Data API は Bearer 認証が必要なので Worker 経由で取得し、バイナリをそのまま返す。
richMenus.get('/api/rich-menus/:id/image-content', async (c) => {
  try {
    const richMenuId = c.req.param('id');
    const res = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
      headers: { Authorization: `Bearer ${c.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    });
    if (!res.ok) {
      const t = await res.text();
      return c.json({ success: false, error: t }, res.status as 500);
    }
    const buf = await res.arrayBuffer();
    // リッチメニューは作成後不変なので、画像も richMenuId 単位で実質不変 → 長期キャッシュ可。
    return new Response(buf, {
      headers: {
        'Content-Type': res.headers.get('content-type') ?? 'image/png',
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('GET /api/rich-menus/:id/image-content error:', message);
    return c.json({ success: false, error: `Failed to fetch rich menu image: ${message}` }, 500);
  }
});

// BOXIV: GET /api/rich-menus/default — LINE Platform で現在アカウント既定に設定されている richMenuId を返す。
// 編集=差し替え時に「旧メニューが本当にアカウント既定か」を判定するため（menu.selected は別概念で当てにならない）。
richMenus.get('/api/rich-menus/default', async (c) => {
  try {
    const res = await fetch('https://api.line.me/v2/bot/user/all/richmenu', {
      headers: { Authorization: `Bearer ${c.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    });
    // 既定未設定なら 404 → richMenuId: null で正常レスポンス
    if (res.status === 404) return c.json({ success: true, data: { richMenuId: null } });
    const json = await res.json<{ richMenuId?: string }>();
    if (!res.ok) return c.json({ success: false, error: JSON.stringify(json) }, res.status as 500);
    return c.json({ success: true, data: { richMenuId: json.richMenuId ?? null } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('GET /api/rich-menus/default error:', message);
    return c.json({ success: false, error: `Failed to fetch default rich menu: ${message}` }, 500);
  }
});

// POST /api/rich-menus — create a rich menu via LINE API
richMenus.post('/api/rich-menus', async (c) => {
  try {
    const body = await c.req.json();
    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    const result = await lineClient.createRichMenu(body);
    return c.json({ success: true, data: result }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('POST /api/rich-menus error:', message);
    return c.json({ success: false, error: `Failed to create rich menu: ${message}` }, 500);
  }
});

// DELETE /api/rich-menus/:id — delete a rich menu
richMenus.delete('/api/rich-menus/:id', async (c) => {
  try {
    const richMenuId = c.req.param('id');
    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    await lineClient.deleteRichMenu(richMenuId);
    return c.json({ success: true, data: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('DELETE /api/rich-menus/:id error:', message);
    return c.json({ success: false, error: `Failed to delete rich menu: ${message}` }, 500);
  }
});

// POST /api/rich-menus/:id/default — set rich menu as default for all users
richMenus.post('/api/rich-menus/:id/default', async (c) => {
  try {
    const richMenuId = c.req.param('id');
    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    await lineClient.setDefaultRichMenu(richMenuId);
    return c.json({ success: true, data: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('POST /api/rich-menus/:id/default error:', message);
    return c.json({ success: false, error: `Failed to set default rich menu: ${message}` }, 500);
  }
});

// GET /api/friends/:friendId/rich-menu — get rich menu currently assigned to a friend
richMenus.get('/api/friends/:friendId/rich-menu', async (c) => {
  try {
    const friendId = c.req.param('friendId');
    const db = c.env.DB;

    const friend = await getFriendById(db, friendId);
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    try {
      const result = await lineClient.getRichMenuIdOfUser(friend.line_user_id);
      return c.json({ success: true, data: { richMenuId: result.richMenuId } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // LINE API は個別アサインが無いユーザーには 404 を返す → null で正常レスポンス
      if (message.includes('404')) {
        return c.json({ success: true, data: null });
      }
      throw err;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('GET /api/friends/:friendId/rich-menu error:', message);
    return c.json({ success: false, error: `Failed to get rich menu of friend: ${message}` }, 500);
  }
});

// POST /api/friends/:friendId/rich-menu — link rich menu to a specific friend
richMenus.post('/api/friends/:friendId/rich-menu', async (c) => {
  try {
    const friendId = c.req.param('friendId');
    const body = await c.req.json<{ richMenuId: string }>();

    if (!body.richMenuId) {
      return c.json({ success: false, error: 'richMenuId is required' }, 400);
    }

    const db = c.env.DB;
    const friend = await getFriendById(db, friendId);
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    await lineClient.linkRichMenuToUser(friend.line_user_id, body.richMenuId);

    return c.json({ success: true, data: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('POST /api/friends/:friendId/rich-menu error:', message);
    return c.json({ success: false, error: `Failed to link rich menu to friend: ${message}` }, 500);
  }
});

// DELETE /api/friends/:friendId/rich-menu — unlink rich menu from a specific friend
richMenus.delete('/api/friends/:friendId/rich-menu', async (c) => {
  try {
    const friendId = c.req.param('friendId');
    const db = c.env.DB;

    const friend = await getFriendById(db, friendId);
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    await lineClient.unlinkRichMenuFromUser(friend.line_user_id);

    return c.json({ success: true, data: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('DELETE /api/friends/:friendId/rich-menu error:', message);
    return c.json({ success: false, error: `Failed to unlink rich menu from friend: ${message}` }, 500);
  }
});

export { richMenus };

// POST /api/rich-menus/:id/image — upload rich menu image (accepts base64 body or binary)
richMenus.post('/api/rich-menus/:id/image', async (c) => {
  try {
    const richMenuId = c.req.param('id');
    const contentType = c.req.header('content-type') ?? '';

    let imageData: ArrayBuffer;
    let imageContentType: 'image/png' | 'image/jpeg' = 'image/png';

    if (contentType.includes('application/json')) {
      // Accept base64 encoded image in JSON body
      const body = await c.req.json<{ image: string; contentType?: string }>();
      if (!body.image) {
        return c.json({ success: false, error: 'image (base64) is required' }, 400);
      }
      // Strip data URI prefix if present
      const base64 = body.image.replace(/^data:image\/\w+;base64,/, '');
      const binaryString = atob(base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      imageData = bytes.buffer;
      if (body.contentType === 'image/jpeg') imageContentType = 'image/jpeg';
    } else if (contentType.includes('image/')) {
      // Accept raw binary upload
      imageData = await c.req.arrayBuffer();
      imageContentType = contentType.includes('jpeg') || contentType.includes('jpg') ? 'image/jpeg' : 'image/png';
    } else {
      return c.json({ success: false, error: 'Content-Type must be application/json (with base64) or image/png or image/jpeg' }, 400);
    }

    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    await lineClient.uploadRichMenuImage(richMenuId, imageData, imageContentType);

    return c.json({ success: true, data: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('POST /api/rich-menus/:id/image error:', message);
    return c.json({ success: false, error: `Failed to upload rich menu image: ${message}` }, 500);
  }
});
