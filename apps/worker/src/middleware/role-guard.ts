import { createMiddleware } from 'hono/factory';
import type { Env } from '../index.js';

type Role = 'owner' | 'admin' | 'manager' | 'staff';

// createMiddleware で生成することで、`.post(path, requireRole(...), handler)` に挟んでも
// Hono のパスパラメータ推論（c.req.param('id') が string）を壊さない。
export function requireRole(...allowed: Role[]) {
  return createMiddleware<Env>(async (c, next) => {
    const staff = c.get('staff');
    if (!staff || !allowed.includes(staff.role)) {
      return c.json(
        { success: false, error: `この操作には${allowed[0]}権限が必要です` },
        403,
      );
    }
    return next();
  });
}
