// BOXIV: 監査ログ閲覧 API。owner/admin/manager のみ（撮影スタッフは除外）。
// 記録は middleware/audit-log.boxiv.ts が行う。ここは読み取り専用。
import { Hono } from 'hono';
import { queryAuditLogs, getAuditLogFilterOptions } from '@line-crm/db';
import { requireRole } from '../middleware/role-guard.js';
import type { Env } from '../index.js';

const auditLogs = new Hono<Env>();

// 日付のみ(YYYY-MM-DD)が来たら JST の境界に正規化して inclusive にする。
function normalizeFrom(v?: string): string | undefined {
  if (!v) return undefined;
  return v.length === 10 ? `${v}T00:00:00.000+09:00` : v;
}
function normalizeTo(v?: string): string | undefined {
  if (!v) return undefined;
  return v.length === 10 ? `${v}T23:59:59.999+09:00` : v;
}

auditLogs.get('/api/audit-logs', requireRole('owner', 'admin', 'manager'), async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId') || undefined;
    const actor = c.req.query('actor') || undefined;
    const action = c.req.query('action') || undefined;
    const targetType = c.req.query('targetType') || undefined;
    const from = normalizeFrom(c.req.query('from'));
    const to = normalizeTo(c.req.query('to'));
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '30', 10) || 30, 1), 100);
    const offset = Math.max(parseInt(c.req.query('offset') || '0', 10) || 0, 0);

    const { items, total } = await queryAuditLogs(c.env.DB, {
      lineAccountId,
      actor,
      action,
      targetType,
      from,
      to,
      limit,
      offset,
    });
    const page = Math.floor(offset / limit) + 1;
    return c.json({
      success: true,
      data: { items, total, page, limit, hasNextPage: offset + items.length < total },
    });
  } catch (err) {
    console.error('GET /api/audit-logs error:', err);
    return c.json({ success: false, error: '変更ログの取得に失敗しました' }, 500);
  }
});

auditLogs.get('/api/audit-logs/filters', requireRole('owner', 'admin', 'manager'), async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId') || undefined;
    const opts = await getAuditLogFilterOptions(c.env.DB, lineAccountId);
    return c.json({ success: true, data: opts });
  } catch (err) {
    console.error('GET /api/audit-logs/filters error:', err);
    return c.json({ success: false, error: 'フィルタ候補の取得に失敗しました' }, 500);
  }
});

export { auditLogs };
