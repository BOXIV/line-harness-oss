/**
 * 撮影スタッフ(role=staff)の到達範囲 — 許可リスト方式の固定（BOXIV / 2026-08-29 監査）。
 *
 * role-matrix.test.ts が「現在の挙動」を固定する特性テストなのに対し、これは
 * **あるべき境界**を固定する。staff の API キー 1 本で
 *   - 全顧客のチャット履歴・LINE userId・Notion 連携情報を読む（GET /api/chats）
 *   - 任意の顧客へシナリオ/リマインダー配信を起動する（POST …/enroll/:friendId）
 *   - automation が送る本文（テンプレート）を書き換える（PUT /api/templates/:id）
 *   - 受信 webhook の secret / 広告プラットフォームの資格情報を読む
 * ができてはいけない。許可リストに無い管理 API は **メソッドに関係なく** 403 になること、
 * 逆に staff 画面が実際に使う口は通ることを両方向から固定する。
 *
 * ⚠️ 許可リストを広げるときは、staff 画面（/bookings, /staff-availability）が本当に
 *    その API を叩いているか（apps/web/src/lib/api.ts）を確認してから。
 */
import { describe, expect, it } from 'vitest';
import { ENV_API_KEY, STAFF_FIXTURES, request, requestAs } from './support/fixtures.js';
import { isStaffAllowed } from '../src/middleware/staff-scope.boxiv.js';

/** staff が触ってはいけない管理 API の代表（D1 だけで完結するもの。LINE/Notion は叩かない） */
const DENIED_FOR_STAFF: Array<{ method: string; path: string; body?: unknown; why: string }> = [
  { method: 'GET', path: '/api/chats', why: '全顧客のチャット履歴と PII' },
  { method: 'GET', path: '/api/chats/does-not-exist', why: '個別チャット（IDOR 経路）' },
  { method: 'GET', path: '/api/templates', why: '自動配信の本文' },
  { method: 'PUT', path: '/api/templates/does-not-exist', body: { name: 'x' }, why: 'テンプレ改変' },
  { method: 'GET', path: '/api/scenarios', why: 'シナリオ' },
  { method: 'POST', path: '/api/scenarios/does-not-exist/enroll/does-not-exist', why: '任意顧客へのシナリオ配信起動' },
  { method: 'POST', path: '/api/reminders/does-not-exist/enroll/does-not-exist', why: '任意顧客へのリマインダー起動' },
  { method: 'GET', path: '/api/webhooks/incoming', why: '受信 webhook の secret' },
  { method: 'GET', path: '/api/webhooks/outgoing', why: '送信 webhook の署名 secret' },
  { method: 'GET', path: '/api/ad-platforms', why: '広告プラットフォームの資格情報' },
  { method: 'POST', path: '/api/booking-invites', body: { lineUserId: 'Uxxxx' }, why: '任意 lineUserId で Notion PII を引く口' },
  { method: 'GET', path: '/api/forms', why: 'フォーム定義（送信先タグ/シナリオ）' },
  { method: 'GET', path: '/api/tracked-links', why: 'トラッキングリンク（タグ/シナリオ付与）' },
  { method: 'GET', path: '/api/users', why: 'ユーザー一覧' },
  { method: 'GET', path: '/api/status-options', why: '顧客ステータス定義' },
  { method: 'POST', path: '/api/admin/refresh-cheapest', why: '外部クロールの起動' },
  { method: 'POST', path: '/api/accounts/does-not-exist/migrate', body: { toAccountId: 'x' }, why: 'アカウント移行' },
  { method: 'DELETE', path: '/api/images/does-not-exist.png', why: 'R2 の削除' },
  { method: 'PUT', path: '/api/staff-availability/does-not-exist', body: {}, why: 'シフトの付け替え（staff 画面は使わない）' },
  { method: 'GET', path: `/api/friends/${STAFF_FIXTURES.staff.id}/notion-candidates`, why: 'Notion 候補（PII）' },
];

/** staff 画面が実際に使う口（許可リスト）。403 になってはいけない。 */
const ALLOWED_FOR_STAFF: Array<{ method: string; path: string; body?: unknown }> = [
  { method: 'GET', path: '/api/staff/me' },
  { method: 'GET', path: '/api/auth/session' },
  { method: 'GET', path: '/api/staff' },
  { method: 'GET', path: '/api/line-accounts' },
  { method: 'GET', path: '/api/booking-requests' },
  { method: 'GET', path: '/api/booking-requests/pending-count' },
  { method: 'GET', path: '/api/booking-requests/does-not-exist' },
  { method: 'GET', path: '/api/staff-availability' },
  { method: 'DELETE', path: '/api/staff-availability/does-not-exist' },
];

describe('staff 許可リスト — 拒否側', () => {
  for (const c of DENIED_FOR_STAFF) {
    it(`staff → 403  ${c.method} ${c.path}  (${c.why})`, async () => {
      const res = await requestAs('staff', c.path, {
        method: c.method,
        body: c.body !== undefined ? JSON.stringify(c.body) : undefined,
      });
      expect(res.status).toBe(403);
    });
  }

  it('manager は同じ GET に到達できる（staff だけを閉じている）', async () => {
    for (const path of ['/api/chats', '/api/templates', '/api/scenarios', '/api/webhooks/incoming', '/api/ad-platforms']) {
      const res = await requestAs('manager', path);
      expect(res.status, path).toBe(200);
    }
  });

  it('env API_KEY（機械用 owner）は影響を受けない', async () => {
    const res = await request('/api/chats', ENV_API_KEY);
    expect(res.status).toBe(200);
  });
});

describe('staff 許可リスト — 許可側', () => {
  for (const c of ALLOWED_FOR_STAFF) {
    it(`staff → not 403  ${c.method} ${c.path}`, async () => {
      const res = await requestAs('staff', c.path, {
        method: c.method,
        body: c.body !== undefined ? JSON.stringify(c.body) : undefined,
      });
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    });
  }
});

describe('isStaffAllowed（純粋関数）', () => {
  it('公開パス（/api/ 以外）は対象外', () => {
    // ミドルウェアは /api/ 以外へ来ないが、関数単体でも staff 許可の誤判定をしないこと
    expect(isStaffAllowed('GET', '/api/staff/me')).toBe(true);
    expect(isStaffAllowed('GET', '/api/staff/me/extra')).toBe(false);
  });

  it('メソッドまで見て判定する（GET が許可でも PUT/DELETE は別）', () => {
    expect(isStaffAllowed('GET', '/api/staff-availability')).toBe(true);
    expect(isStaffAllowed('POST', '/api/staff-availability')).toBe(true);
    expect(isStaffAllowed('PUT', '/api/staff-availability/abc')).toBe(false);
    expect(isStaffAllowed('DELETE', '/api/staff-availability/abc')).toBe(true);
    expect(isStaffAllowed('GET', '/api/staff')).toBe(true);
    expect(isStaffAllowed('POST', '/api/staff')).toBe(false);
    expect(isStaffAllowed('GET', '/api/line-accounts')).toBe(true);
    expect(isStaffAllowed('PUT', '/api/line-accounts/abc')).toBe(false);
  });

  it('前方一致で広がらない（/api/booking-requests-foo 等）', () => {
    expect(isStaffAllowed('GET', '/api/booking-requests')).toBe(true);
    expect(isStaffAllowed('GET', '/api/booking-requestsX')).toBe(false);
    expect(isStaffAllowed('GET', '/api/booking-requests/a/b')).toBe(false);
  });
});
