// BOXIV: 監査ログ・ミドルウェア。認証(authMiddleware)直後に全リクエストへ適用する。
// 成功した admin 変更操作(POST/PUT/PATCH/DELETE × 2xx)だけを 1 行記録する。
// - 「だれが」は authMiddleware が context にセット済みの c.get('staff') から取得。
// - actor が無いリクエスト(public/inbound webhook 等)は対象外。
// - 記録は executionCtx.waitUntil で非同期化し、リクエスト本体には影響させない。
import type { Context, Next } from 'hono';
import type { Env } from '../index.js';
import { recordAuditLog } from '@line-crm/db';
import { resolveAuditAction } from '../lib/audit-action.boxiv.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function auditLogMiddleware(c: Context<Env>, next: Next): Promise<Response | void> {
  const method = c.req.method.toUpperCase();
  // authMiddleware は既に実行済みなので staff はこの時点で解決済み。
  // 認証済み(admin) かつ 変更系のときだけ本文を読む（public/inbound webhook の
  // 本文 clone/parse オーバーヘッドを避ける）。
  const staff = c.get('staff');
  const shouldLog = Boolean(staff) && MUTATING.has(method);

  // 本文はハンドラ実行前に clone して読む（元ストリームを消費しないため）。
  let body: unknown = undefined;
  if (shouldLog) {
    try {
      const cloned = c.req.raw.clone();
      const ct = cloned.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        body = await cloned.json();
      }
    } catch {
      /* 本文なし / 非 JSON は無視 */
    }
  }

  await next();

  try {
    if (!shouldLog || !staff) return;

    const status = c.res?.status ?? 0;
    if (status < 200 || status >= 300) return; // 成功した変更(2xx)のみ

    const path = new URL(c.req.url).pathname;
    const resolved = resolveAuditAction(method, path, body);
    if (resolved.skip) return;

    const bodyAccount =
      body && typeof body === 'object'
        ? (body as Record<string, unknown>).lineAccountId
        : undefined;
    const lineAccountId =
      c.req.query('lineAccountId') ||
      (typeof bodyAccount === 'string' ? bodyAccount : undefined) ||
      null;

    c.executionCtx.waitUntil(
      recordAuditLog(c.env.DB, {
        lineAccountId,
        actorId: staff.id,
        actorName: staff.name,
        actorRole: staff.role,
        action: resolved.action,
        summary: resolved.summary,
        targetType: resolved.targetType ?? null,
        targetId: resolved.targetId ?? null,
        targetLabel: resolved.targetLabel ?? null,
        method,
        path,
        status,
        detail: { body: resolved.detail },
      }).catch((err) => console.error('audit log write failed:', err)),
    );
  } catch (err) {
    console.error('audit log middleware error:', err);
  }
}
