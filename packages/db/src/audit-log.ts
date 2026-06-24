// BOXIV: 監査ログ（audit_log）の D1 アクセスヘルパー。
// 書込は worker の audit-log ミドルウェアから recordAuditLog で行い、
// 閲覧は /api/audit-logs ルートから queryAuditLogs / getAuditLogFilterOptions で行う。
import { jstNow } from './utils';

export interface AuditLogRow {
  id: string;
  line_account_id: string | null;
  actor_id: string | null;
  actor_name: string | null;
  actor_role: string | null;
  action: string;
  summary: string;
  target_type: string | null;
  target_id: string | null;
  target_label: string | null;
  method: string;
  path: string;
  status: number | null;
  detail: string;
  created_at: string;
}

export interface AuditLogEntry {
  id: string;
  lineAccountId: string | null;
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
  action: string;
  summary: string;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string | null;
  method: string;
  path: string;
  status: number | null;
  detail: unknown;
  createdAt: string;
}

export interface AuditLogInput {
  lineAccountId?: string | null;
  actorId?: string | null;
  actorName?: string | null;
  actorRole?: string | null;
  action: string;
  summary: string;
  targetType?: string | null;
  targetId?: string | null;
  targetLabel?: string | null;
  method: string;
  path: string;
  status?: number | null;
  detail?: unknown;
}

function serializeAuditLog(row: AuditLogRow): AuditLogEntry {
  let detail: unknown = {};
  try {
    detail = row.detail ? JSON.parse(row.detail) : {};
  } catch {
    detail = { raw: row.detail };
  }
  return {
    id: row.id,
    lineAccountId: row.line_account_id,
    actorId: row.actor_id,
    actorName: row.actor_name,
    actorRole: row.actor_role,
    action: row.action,
    summary: row.summary,
    targetType: row.target_type,
    targetId: row.target_id,
    targetLabel: row.target_label,
    method: row.method,
    path: row.path,
    status: row.status,
    detail,
    createdAt: row.created_at,
  };
}

/** 監査ログを 1 行記録する。失敗してもリクエスト本体には影響させない想定（呼出側で catch）。 */
export async function recordAuditLog(db: D1Database, input: AuditLogInput): Promise<void> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const detailJson =
    typeof input.detail === 'string' ? input.detail : JSON.stringify(input.detail ?? {});
  await db
    .prepare(
      `INSERT INTO audit_log
         (id, line_account_id, actor_id, actor_name, actor_role, action, summary,
          target_type, target_id, target_label, method, path, status, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.lineAccountId ?? null,
      input.actorId ?? null,
      input.actorName ?? null,
      input.actorRole ?? null,
      input.action,
      input.summary,
      input.targetType ?? null,
      input.targetId ?? null,
      input.targetLabel ?? null,
      input.method,
      input.path,
      input.status ?? null,
      detailJson,
      now,
    )
    .run();
}

export interface AuditLogQuery {
  lineAccountId?: string | null;
  actor?: string | null; // actor_id 完全一致
  action?: string | null; // action コード完全一致
  targetType?: string | null;
  from?: string | null; // created_at >= （JST 文字列）
  to?: string | null; // created_at <= （JST 文字列）
  offset?: number;
  limit?: number;
}

export async function queryAuditLogs(
  db: D1Database,
  q: AuditLogQuery,
): Promise<{ items: AuditLogEntry[]; total: number }> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (q.lineAccountId) {
    where.push('line_account_id = ?');
    binds.push(q.lineAccountId);
  }
  if (q.action) {
    where.push('action = ?');
    binds.push(q.action);
  }
  if (q.targetType) {
    where.push('target_type = ?');
    binds.push(q.targetType);
  }
  if (q.actor) {
    // フィルタ UI は actor_id を value に送る。証跡の厳密性のため完全一致のみ
    // （同名スタッフの取り違え・LIKE ワイルドカード誤ヒットを避ける）。
    where.push('actor_id = ?');
    binds.push(q.actor);
  }
  if (q.from) {
    where.push('created_at >= ?');
    binds.push(q.from);
  }
  if (q.to) {
    where.push('created_at <= ?');
    binds.push(q.to);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const limit = Math.min(Math.max(q.limit ?? 30, 1), 100);
  const offset = Math.max(q.offset ?? 0, 0);

  const countRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM audit_log ${whereSql}`)
    .bind(...binds)
    .first<{ n: number }>();
  const total = countRow?.n ?? 0;

  const rows = await db
    .prepare(`SELECT * FROM audit_log ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...binds, limit, offset)
    .all<AuditLogRow>();

  return { items: (rows.results ?? []).map(serializeAuditLog), total };
}

export interface AuditLogFilterOptions {
  actions: Array<{ action: string; summary: string; count: number }>;
  actors: Array<{ actorId: string | null; actorName: string | null; count: number }>;
}

/** フィルタ UI 用に、既存ログから distinct な action / actor を件数つきで返す。 */
export async function getAuditLogFilterOptions(
  db: D1Database,
  lineAccountId?: string | null,
): Promise<AuditLogFilterOptions> {
  const where = lineAccountId ? 'WHERE line_account_id = ?' : '';
  const binds = lineAccountId ? [lineAccountId] : [];
  const actionsRes = await db
    .prepare(
      `SELECT action, MAX(summary) AS summary, COUNT(*) AS count
       FROM audit_log ${where} GROUP BY action ORDER BY count DESC`,
    )
    .bind(...binds)
    .all<{ action: string; summary: string; count: number }>();
  const actorsRes = await db
    .prepare(
      `SELECT actor_id AS actorId, MAX(actor_name) AS actorName, COUNT(*) AS count
       FROM audit_log ${where} GROUP BY actor_id ORDER BY count DESC`,
    )
    .bind(...binds)
    .all<{ actorId: string | null; actorName: string | null; count: number }>();
  return {
    actions: actionsRes.results ?? [],
    actors: actorsRes.results ?? [],
  };
}
