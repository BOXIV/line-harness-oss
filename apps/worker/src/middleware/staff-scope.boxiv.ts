import { createMiddleware } from 'hono/factory';
import type { Env } from '../index.js';

/**
 * 撮影スタッフ（role=staff）の到達範囲を **許可リスト方式** で閉じる（BOXIV）。
 *
 * なぜ requireRole を 1 本ずつ足す方式にしなかったか:
 *   2026-08-15 の監査（H2）で 40 本ほどに requireRole を足したが、2026-08-29 の再監査で
 *   scenarios / templates / reminders / forms / chats(GET) / webhooks(GET) / ad-platforms /
 *   booking-invites など **60 本超が依然ガード無し**だった。staff の API キーで
 *   全顧客のチャット履歴・LINE userId・Notion 連携情報を読め、任意の顧客へ
 *   シナリオ配信を起動でき、automation が送る本文を書き換えられる状態だった。
 *   「足し忘れ」で穴が開く方式は、ルートが増えるたびに同じ事故を繰り返す。
 *   ここでは逆に **staff が触ってよい口だけを列挙**し、それ以外は 403 にする。
 *   新しいルートは既定で staff から見えない（fail closed）。
 *
 * 許可リストの根拠は管理画面の staff 向け画面（/bookings と /staff-availability）が
 * 実際に叩く API（apps/web/src/lib/api.ts の bookingRequests / staffAvailability / staff.me /
 * staff.list / auth.logout）と、全画面共通で走る AccountSwitcher（GET /api/line-accounts）、
 * CurrentStaffProvider（GET /api/staff/me）だけ。
 *
 * ⚠️ /api/staff/me と /api/auth/session はログイン検証に使う。ここから外すと
 *    2026-08-15 の「撮影スタッフ 5 名が 3 日間ログイン不能」を再発させる。
 *
 * owner / admin / manager はこのミドルウェアの対象外（従来どおり各ルートの requireRole）。
 * 認証をスキップする公開パス（/webhook, /liff, /booking, /listing-form 等）は
 * c.get('staff') が無いので素通り＝影響しない。
 */
type Rule = { method: '*' | 'GET' | 'POST' | 'PUT' | 'DELETE'; path: RegExp };

const STAFF_ALLOWED: Rule[] = [
  // ログイン検証・自分の情報
  { method: 'GET', path: /^\/api\/staff\/me$/ },
  { method: 'GET', path: /^\/api\/auth\/session$/ },
  { method: 'POST', path: /^\/api\/auth\/logout$/ },
  // シフト画面が「自分の行」を描画するため（ハンドラ側で自分 1 件に絞られる）
  { method: 'GET', path: /^\/api\/staff$/ },
  // アカウント切替（全画面共通）。チャネルシークレット等は owner/admin にしか返らない
  { method: 'GET', path: /^\/api\/line-accounts$/ },
  // 撮影予約（ハンドラ内で staffId=自分に絞られる／承認系も自担当のみ）
  { method: 'GET', path: /^\/api\/booking-requests$/ },
  { method: 'GET', path: /^\/api\/booking-requests\/pending-count$/ },
  { method: 'GET', path: /^\/api\/booking-requests\/[^/]+$/ },
  { method: 'PUT', path: /^\/api\/booking-requests\/[^/]+$/ },
  { method: 'PUT', path: /^\/api\/booking-requests\/[^/]+\/(approve|reject|cancel)$/ },
  { method: 'DELETE', path: /^\/api\/booking-requests\/[^/]+$/ },
  // シフト登録（PUT は staff 画面が使わないので載せない。area/staff_id の付け替え経路を閉じる）
  { method: 'GET', path: /^\/api\/staff-availability$/ },
  { method: 'POST', path: /^\/api\/staff-availability$/ },
  { method: 'POST', path: /^\/api\/staff-availability\/bulk$/ },
  { method: 'DELETE', path: /^\/api\/staff-availability\/[^/]+$/ },
];

export function isStaffAllowed(method: string, path: string): boolean {
  return STAFF_ALLOWED.some(
    (r) => (r.method === '*' || r.method === method) && r.path.test(path),
  );
}

export const staffScopeMiddleware = createMiddleware<Env>(async (c, next) => {
  const staff = c.get('staff');
  if (!staff || staff.role !== 'staff') return next();
  const path = new URL(c.req.url).pathname;
  // 対象は管理 API だけ。公開パスは認証をスキップしていてここへ staff 付きで来ない。
  if (!path.startsWith('/api/')) return next();
  if (isStaffAllowed(c.req.method, path)) return next();
  return c.json({ success: false, error: 'この操作にはmanager権限が必要です' }, 403);
});
