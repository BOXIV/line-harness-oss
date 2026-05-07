import type { Context, Next } from 'hono';
import { verifySessionToken, readSessionCookie, type BookingSession } from '../utils/session.js';
import type { Env } from '../index.js';

/**
 * 予約ページ用 認証ミドルウェア
 *
 * セッションCookieがあれば検証し、context にセット。
 * 無効でも次へ通す（ページ側でLIFF自動認証 or LINE Loginへ分岐）。
 */
export async function bookingAuthMiddleware(c: Context<Env>, next: Next): Promise<Response | void> {
  const cookieHeader = c.req.header('Cookie') ?? null;
  const token = readSessionCookie(cookieHeader);

  if (token && c.env.SESSION_SECRET) {
    const session = await verifySessionToken(token, c.env.SESSION_SECRET);
    if (session) {
      c.set('bookingUser', session);
    }
  }

  return next();
}

declare module 'hono' {
  interface ContextVariableMap {
    bookingUser?: BookingSession;
  }
}
