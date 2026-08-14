// BOXIV-only: friend status (出品者DB / 購入者DB の Notion ステータスをマスタとする)

import { Hono } from 'hono';
import type { Env } from '../index.js';
import { syncStatusOptionsFromNotion, type StatusSource } from '../services/notion-status.boxiv.js';
import { requireRole } from '../middleware/role-guard.js';

const friendStatus = new Hono<Env>();

interface StatusOptionRow {
  id: string;
  source: string;
  notion_id: string;
  name: string;
  color: string | null;
  sort_order: number;
  is_archived: number;
  synced_at: string;
}

function serializeOption(r: StatusOptionRow) {
  return {
    id: r.id,
    source: r.source,
    notionId: r.notion_id,
    name: r.name,
    color: r.color,
    sortOrder: r.sort_order,
    isArchived: Boolean(r.is_archived),
    syncedAt: r.synced_at,
  };
}

// GET /api/status-options?source=seller|buyer&includeArchived=1
friendStatus.get('/api/status-options', async (c) => {
  try {
    const source = c.req.query('source');
    const includeArchived = c.req.query('includeArchived') === '1';
    const conditions: string[] = [];
    const binds: unknown[] = [];
    if (source === 'seller' || source === 'buyer') {
      conditions.push('source = ?');
      binds.push(source);
    }
    if (!includeArchived) {
      conditions.push('is_archived = 0');
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const stmt = c.env.DB.prepare(
      `SELECT * FROM status_options ${where} ORDER BY source, sort_order ASC`,
    );
    const result = await (binds.length ? stmt.bind(...binds) : stmt).all<StatusOptionRow>();
    return c.json({ success: true, data: result.results.map(serializeOption) });
  } catch (err) {
    console.error('GET /api/status-options error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/status-options/sync — body: { sources?: ('seller'|'buyer')[] }
friendStatus.post('/api/status-options/sync', requireRole('owner','admin','manager'), async (c) => {
  try {
    let body: { sources?: StatusSource[] } = {};
    try { body = await c.req.json(); } catch { /* body optional */ }
    const targets: StatusSource[] = body.sources && body.sources.length > 0
      ? body.sources
      : ['seller', 'buyer'];
    const results = [];
    for (const source of targets) {
      try {
        const r = await syncStatusOptionsFromNotion(c.env.DB, c.env, source);
        results.push({ ...r, success: true });
      } catch (err) {
        results.push({ source, success: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return c.json({ success: true, data: results });
  } catch (err) {
    console.error('POST /api/status-options/sync error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/friends/:id/status — 現在のステータス
friendStatus.get('/api/friends/:id/status', async (c) => {
  try {
    const friendId = c.req.param('id');
    const row = await c.env.DB
      .prepare(
        `SELECT fsa.friend_id, fsa.status_option_id, fsa.assigned_at, fsa.assigned_by,
                so.id AS option_id, so.source, so.notion_id, so.name, so.color, so.sort_order, so.is_archived, so.synced_at
         FROM friend_status_assignments fsa
         INNER JOIN status_options so ON so.id = fsa.status_option_id
         WHERE fsa.friend_id = ?`,
      )
      .bind(friendId)
      .first<StatusOptionRow & {
        friend_id: string;
        status_option_id: string;
        assigned_at: string;
        assigned_by: string | null;
        option_id: string;
      }>();
    if (!row) {
      return c.json({ success: true, data: null });
    }
    return c.json({
      success: true,
      data: {
        friendId: row.friend_id,
        option: {
          id: row.option_id,
          source: row.source,
          notionId: row.notion_id,
          name: row.name,
          color: row.color,
          sortOrder: row.sort_order,
          isArchived: Boolean(row.is_archived),
          syncedAt: row.synced_at,
        },
        assignedAt: row.assigned_at,
        assignedBy: row.assigned_by,
      },
    });
  } catch (err) {
    console.error('GET /api/friends/:id/status error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/friends/:id/status — 封鎖（read-only 化）。
// 顧客ステータスは Notion をマスターとし、LINE Connect 側からは変更できない。
// Notion → D1 の取り込みで表示のみ反映する（UI=StatusPicker も表示専用化済み）。
// ※ 旧実装ではここで friend_status_assignments を upsert し、ステータス連動の
//    リッチメニュー自動切替(applyRichMenuForStatus)も発火していた。read-only 化に伴い停止。
friendStatus.put('/api/friends/:id/status', async (c) => {
  return c.json(
    { success: false, error: '顧客ステータスは Notion がマスターのため、ここからは変更できません' },
    405,
  );
});

export { friendStatus };
