import type { Context, Next } from 'hono';
import {
  getStaffByApiKey,
  resolveStaffSession,
  touchStaffSession,
  SESSION_TOKEN_PREFIX,
} from '@line-crm/db';
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
    path.startsWith('/rb/') || // 購入者催促 SMS の短縮リンク
    path.startsWith('/images/') ||
    path.startsWith('/media/') ||
    path.startsWith('/api/liff/') ||
    path.startsWith('/auth/') ||
    path.startsWith('/booking') ||
    path.startsWith('/listing-form/') ||
    path.startsWith('/buyer-form/') || // 購入エントリー連携の入口（署名 state / 共有トークンで検証）
    path.startsWith('/app-listing/') || // アプリ出品連携の入口（署名 state で検証・認証ヘッダは付かない）
    path === '/link/callback' || // LINE Login 共有コールバック（署名 state で検証・認証ヘッダは付かない）
    path.startsWith('/diagnosis-form') ||
    // 管理画面のメールログイン（BOXIV）。
    // ⚠️ 完全一致で 2 本だけ。前方一致(startsWith('/api/auth/'))にすると
    //    /api/auth/session と /api/auth/logout まで無認証で素通りする。
    path === '/api/auth/email/start' ||
    path === '/api/auth/email/verify' ||
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

  // ── 管理画面のセッション（BOXIV / メールログイン）────────────────────────────
  // 必ず最初に判定し、失敗したら **即 401**。旧 API キー経路へフォールスルーさせない。
  // フォールスルーさせると、失効済みセッション文字列が
  // getStaffByApiKey → env API_KEY 比較まで流れて挙動が読めなくなる。
  if (token.startsWith(SESSION_TOKEN_PREFIX)) {
    const resolved = await resolveStaffSession(c.env.DB, token);
    if (!resolved) {
      return c.json({ success: false, error: 'Unauthorized' }, 401);
    }
    c.set('staff', {
      id: resolved.staff.id,
      name: resolved.staff.name,
      role: resolved.staff.role,
    });
    c.set('authVia', 'session');
    c.set('authSessionId', resolved.session.id);
    // last_used_at はレスポンスを待たせずに更新する（5分間隔で間引く）。
    c.executionCtx.waitUntil(
      touchStaffSession(c.env.DB, resolved.session.id, resolved.session.last_used_at).catch(
        (err) => console.error('touchStaffSession failed:', err),
      ),
    );
    return next();
  }

  // Check staff_members table first
  const staff = await getStaffByApiKey(c.env.DB, token);
  if (staff) {
    c.set('staff', { id: staff.id, name: staff.name, role: staff.role });
    c.set('authVia', 'api_key');
    return next();
  }

  // Fallback: env API_KEY acts as owner
  if (token === c.env.API_KEY) {
    c.set('staff', { id: 'env-owner', name: 'Owner', role: 'owner' as const });
    c.set('authVia', 'env_key');
    return next();
  }

  return c.json({ success: false, error: 'Unauthorized' }, 401);
}
