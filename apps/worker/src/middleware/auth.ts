import type { Context, Next } from 'hono';
import { getStaffByApiKey } from '@line-crm/db';
import type { Env } from '../index.js';

export async function authMiddleware(c: Context<Env>, next: Next): Promise<Response | void> {
  // Skip auth for the LINE webhook endpoint — it uses signature verification instead
  // Skip auth for OpenAPI docs — public documentation
  const path = new URL(c.req.url).pathname;
  const method = c.req.method;
  if (
    path === '/webhook' ||
    path === '/docs' ||
    path === '/openapi.json' ||
    path === '/api/affiliates/click' ||
    path.startsWith('/t/') ||
    path.startsWith('/r/') ||
    path.startsWith('/images/') ||
    path.startsWith('/media/') ||
    path.startsWith('/api/liff/') ||
    path.startsWith('/auth/') ||
    path.startsWith('/booking') ||
    path.startsWith('/listing-form/') ||
    path === '/link/callback' || // LINE Login 共有コールバック（署名 state で検証・認証ヘッダは付かない）
    path.startsWith('/diagnosis-form') ||
    path === '/api/integrations/stripe/webhook' ||
    path === '/api/notion/automation' ||
    path.match(/^\/api\/webhooks\/incoming\/[^/]+\/receive$/) ||
    path.match(/^\/api\/forms\/[^/]+\/submit$/) ||
    // GET/HEAD form definition is public for LIFF; PUT/DELETE must stay authenticated.
    // （この bypass はメソッド非依存だと PUT/DELETE /api/forms/:id まで素通りするため method でガード）
    ((method === 'GET' || method === 'HEAD') && /^\/api\/forms\/[^/]+$/.test(path))
  ) {
    return next();
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const token = authHeader.slice('Bearer '.length);
  // 空トークン（"Bearer " のみ）は即拒否。API_KEY が空文字で投入された場合の
  // '' === c.env.API_KEY による env-owner 誤許可（footgun）を塞ぐ。
  if (token.length === 0) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  // Check staff_members table first
  const staff = await getStaffByApiKey(c.env.DB, token);
  if (staff) {
    c.set('staff', { id: staff.id, name: staff.name, role: staff.role });
    return next();
  }

  // Fallback: env API_KEY acts as owner
  if (token === c.env.API_KEY) {
    c.set('staff', { id: 'env-owner', name: 'Owner', role: 'owner' as const });
    return next();
  }

  return c.json({ success: false, error: 'Unauthorized' }, 401);
}
