// BOXIV: リッチメニュー × 顧客ステータス マッピングの CRUD。
// rich_menu_status_mappings テーブルに対する操作のみ。LINE 側 API は service 経由で呼ぶ。

import { Hono } from 'hono';
import type { Env } from '../index.js';

const richMenuStatus = new Hono<Env>();

interface MappingRow {
  id: string;
  status_option_id: string;
  rich_menu_id: string;
  rich_menu_name: string | null;
  line_account_id: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

interface MappingResponse {
  id: string;
  statusOptionId: string;
  statusOptionName?: string;
  statusOptionSource?: 'seller' | 'buyer';
  richMenuId: string;
  richMenuName: string | null;
  lineAccountId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// GET /api/rich-menus/auto-switch — list mappings (joined with status_options for display)
richMenuStatus.get('/api/rich-menus/auto-switch', async (c) => {
  try {
    const rows = await c.env.DB.prepare(
      `SELECT m.id, m.status_option_id, m.rich_menu_id, m.rich_menu_name,
              m.line_account_id, m.is_active, m.created_at, m.updated_at,
              so.name AS status_option_name, so.source AS status_option_source
       FROM rich_menu_status_mappings m
       LEFT JOIN status_options so ON so.id = m.status_option_id
       ORDER BY so.source ASC, so.sort_order ASC, m.created_at ASC`,
    )
      .all<MappingRow & { status_option_name: string | null; status_option_source: 'seller' | 'buyer' | null }>();

    const data: MappingResponse[] = (rows.results ?? []).map((r) => ({
      id: r.id,
      statusOptionId: r.status_option_id,
      statusOptionName: r.status_option_name ?? undefined,
      statusOptionSource: r.status_option_source ?? undefined,
      richMenuId: r.rich_menu_id,
      richMenuName: r.rich_menu_name,
      lineAccountId: r.line_account_id,
      isActive: r.is_active === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));

    return c.json({ success: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('GET /api/rich-menus/auto-switch error:', message);
    return c.json({ success: false, error: `Failed to list mappings: ${message}` }, 500);
  }
});

// PUT /api/rich-menus/auto-switch/:statusOptionId — upsert mapping
richMenuStatus.put('/api/rich-menus/auto-switch/:statusOptionId', async (c) => {
  try {
    const statusOptionId = c.req.param('statusOptionId');
    const body = await c.req.json<{
      richMenuId: string;
      richMenuName?: string | null;
      lineAccountId?: string | null;
      isActive?: boolean;
    }>();

    if (!body.richMenuId) {
      return c.json({ success: false, error: 'richMenuId is required' }, 400);
    }

    // status_options 存在チェック
    const opt = await c.env.DB
      .prepare('SELECT id FROM status_options WHERE id = ?')
      .bind(statusOptionId)
      .first<{ id: string }>();
    if (!opt) {
      return c.json({ success: false, error: 'status option not found' }, 404);
    }

    const id = crypto.randomUUID();
    const lineAccountId = body.lineAccountId ?? null;
    const isActive = body.isActive === false ? 0 : 1;

    // ON CONFLICT は UNIQUE (status_option_id, line_account_id) に当たる
    await c.env.DB
      .prepare(
        `INSERT INTO rich_menu_status_mappings
           (id, status_option_id, rich_menu_id, rich_menu_name, line_account_id, is_active)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(status_option_id, line_account_id) DO UPDATE SET
           rich_menu_id   = excluded.rich_menu_id,
           rich_menu_name = excluded.rich_menu_name,
           is_active      = excluded.is_active,
           updated_at     = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')`,
      )
      .bind(id, statusOptionId, body.richMenuId, body.richMenuName ?? null, lineAccountId, isActive)
      .run();

    const row = await c.env.DB
      .prepare(
        `SELECT id, status_option_id, rich_menu_id, rich_menu_name, line_account_id,
                is_active, created_at, updated_at
         FROM rich_menu_status_mappings
         WHERE status_option_id = ? AND (line_account_id IS ? OR line_account_id = ?)`,
      )
      .bind(statusOptionId, lineAccountId, lineAccountId)
      .first<MappingRow>();

    return c.json({ success: true, data: row });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('PUT /api/rich-menus/auto-switch error:', message);
    return c.json({ success: false, error: `Failed to upsert mapping: ${message}` }, 500);
  }
});

// POST /api/rich-menus/auto-switch/rebind — リッチメニュー差し替え時に、旧 richMenuId を
// 指す全マッピングを新 richMenuId へ付け替える。LINE のリッチメニューは作成後に編集できず
// 「複製→差し替え」運用になるため、ステータス連動が新メニューに引き継がれるようにする。
richMenuStatus.post('/api/rich-menus/auto-switch/rebind', async (c) => {
  try {
    const body = await c.req.json<{
      fromRichMenuId: string;
      toRichMenuId: string;
      toRichMenuName?: string | null;
    }>();

    if (!body.fromRichMenuId || !body.toRichMenuId) {
      return c.json({ success: false, error: 'fromRichMenuId and toRichMenuId are required' }, 400);
    }

    const result = await c.env.DB
      .prepare(
        `UPDATE rich_menu_status_mappings
            SET rich_menu_id   = ?,
                rich_menu_name = COALESCE(?, rich_menu_name),
                updated_at     = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
          WHERE rich_menu_id = ?`,
      )
      .bind(body.toRichMenuId, body.toRichMenuName ?? null, body.fromRichMenuId)
      .run();

    const rebound = result.meta?.changes ?? 0;
    return c.json({ success: true, data: { rebound } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('POST /api/rich-menus/auto-switch/rebind error:', message);
    return c.json({ success: false, error: `Failed to rebind mappings: ${message}` }, 500);
  }
});

// DELETE /api/rich-menus/auto-switch/:statusOptionId — remove mapping
richMenuStatus.delete('/api/rich-menus/auto-switch/:statusOptionId', async (c) => {
  try {
    const statusOptionId = c.req.param('statusOptionId');
    const lineAccountId = c.req.query('lineAccountId') ?? null;
    await c.env.DB
      .prepare(
        `DELETE FROM rich_menu_status_mappings
         WHERE status_option_id = ? AND (line_account_id IS ? OR line_account_id = ?)`,
      )
      .bind(statusOptionId, lineAccountId, lineAccountId)
      .run();
    return c.json({ success: true, data: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('DELETE /api/rich-menus/auto-switch error:', message);
    return c.json({ success: false, error: `Failed to delete mapping: ${message}` }, 500);
  }
});

export { richMenuStatus };
