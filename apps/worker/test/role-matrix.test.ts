/**
 * ロール × エンドポイント 到達性マトリクス（BOXIV / Phase 1）
 *
 * ⚠️ これは「あるべき認可」ではなく「現在の挙動」を固定する特性テスト。
 *    認可を意図的に変えるときは、実装より先にこの表を書き換えること。
 *    表を書き換えずに緑にする（= 期待値を実装に合わせて後追いする）のは禁止。
 *
 * 背景: 2026-08-15 に /api/friends/count へ requireRole を足した結果、
 *       そこでログイン検証していた撮影スタッフ(role=staff) 5 名が
 *       3 日間ログインできなくなった。表に載っていれば赤で止まった。
 *
 * 対象は D1 だけで完結する GET のみ（LINE / Notion / Slack を叩くルートは
 * ネットワーク依存になるため入れない）。
 */
import { describe, expect, it } from 'vitest';
import { ROLES, STAFF_FIXTURES, ENV_API_KEY, request, requestAs, type Role } from './support/fixtures.js';

type Expectations = Record<Role, number>;

const ALL = (status: number): Expectations => ({
  owner: status,
  admin: status,
  manager: status,
  staff: status,
});

/** requireRole('owner','admin','manager') 相当 — staff だけ 403 */
const NOT_STAFF: Expectations = { owner: 200, admin: 200, manager: 200, staff: 403 };

/** requireRole('owner','manager') 相当 — admin と staff が 403 */
const OWNER_MANAGER: Expectations = { owner: 200, admin: 403, manager: 200, staff: 403 };

interface Case {
  path: string;
  expect: Expectations;
  /** なぜこの期待値なのか（ガードの出所） */
  why: string;
}

const MATRIX: Case[] = [
  // ── 認可ガード無し: 認証さえ通れば全ロール到達 ────────────────────────────
  {
    path: '/api/staff/me',
    expect: ALL(200),
    why: '管理画面のログイン検証に使う唯一のロール非依存の口。requireRole を付けてはいけない',
  },
  {
    path: '/api/auth/session',
    expect: ALL(200),
    why: '自分のログイン状態を返す口。ロール非依存（認証は必要＝認証スキップ一覧には入れない）',
  },
  {
    path: '/api/staff-availability',
    expect: ALL(200),
    why: '撮影スタッフが自分のシフトを登録する画面。staff は自分の行に絞られる（ハンドラ内で強制）',
  },
  {
    path: '/api/booking-requests',
    expect: ALL(200),
    why: '撮影スタッフが自分の担当予約を見る画面。staff は staffId=自分に絞られる',
  },
  {
    path: '/api/booking-requests/pending-count',
    expect: ALL(200),
    why: 'サイドバーの承認待ちバッジ。staff は自分担当のみカウント',
  },
  { path: '/api/tags', expect: ALL(200), why: 'GET はガード無し（POST/DELETE のみ owner/admin/manager）' },
  { path: '/api/templates', expect: ALL(200), why: 'ルート全体にガードが1件も無い（Phase 6 の対象）' },
  { path: '/api/scenarios', expect: ALL(200), why: '同上' },
  { path: '/api/forms', expect: ALL(200), why: '同上' },
  { path: '/api/scoring-rules', expect: ALL(200), why: '同上' },
  { path: '/api/reminders', expect: ALL(200), why: '同上' },
  { path: '/api/notifications/rules', expect: ALL(200), why: '同上' },
  { path: '/api/webhooks/incoming', expect: ALL(200), why: 'GET はガード無し（変更系のみ owner/admin/manager）' },
  { path: '/api/conversions/points', expect: ALL(200), why: 'ルート全体にガードが1件も無い' },
  { path: '/api/affiliates', expect: ALL(200), why: '同上' },
  { path: '/api/tracked-links', expect: ALL(200), why: '同上' },
  { path: '/api/ad-platforms', expect: ALL(200), why: '同上' },
  { path: '/api/status-options', expect: ALL(200), why: '同上' },
  { path: '/api/broadcasts', expect: ALL(200), why: 'GET はガード無し（変更系のみ owner/admin/manager）' },
  { path: '/api/users', expect: ALL(200), why: '同上' },
  { path: '/api/line-accounts', expect: ALL(200), why: 'GET はガード無し（変更系のみ owner）' },
  { path: '/api/chats', expect: ALL(200), why: 'GET はガード無し（変更系のみ owner/admin/manager）' },
  { path: '/api/operators', expect: ALL(200), why: '同上（POST/PUT/DELETE のみ owner/admin）' },

  // ── requireRole('owner','admin','manager') ────────────────────────────────
  {
    path: '/api/friends/count',
    expect: NOT_STAFF,
    why: '2026-08-15 にここへ認可を足したのが撮影スタッフ締め出しの直接原因。挙動自体は現状維持',
  },
  { path: '/api/friends?limit=1', expect: NOT_STAFF, why: "requireRole('owner','admin','manager')" },
  { path: '/api/friends/ref-stats', expect: NOT_STAFF, why: "requireRole('owner','admin','manager')" },
  { path: '/api/audit-logs', expect: NOT_STAFF, why: "requireRole('owner','admin','manager')" },
  { path: '/api/audit-logs/filters', expect: NOT_STAFF, why: "requireRole('owner','admin','manager')" },
  { path: '/api/automations', expect: NOT_STAFF, why: "requireRole('owner','admin','manager')" },

  // ── requireRole('owner','manager') ────────────────────────────────────────
  {
    path: `/api/staff/${STAFF_FIXTURES.staff.id}`,
    expect: OWNER_MANAGER,
    why: "requireRole('owner','manager') — admin は 403 になる（現状の仕様）",
  },
];

describe('ロール × エンドポイント 到達性マトリクス', () => {
  for (const testCase of MATRIX) {
    describe(testCase.path, () => {
      for (const role of ROLES) {
        it(`${role} → ${testCase.expect[role]}  (${testCase.why})`, async () => {
          const res = await requestAs(role, testCase.path);
          expect(res.status).toBe(testCase.expect[role]);
        });
      }
    });
  }
});

describe('GET /api/staff の分岐（ハンドラ内で判定・requireRole ではない）', () => {
  it('owner は全件見える', async () => {
    const res = await requestAs('owner', '/api/staff');
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Array<{ id: string }> }>();
    expect(body.data.length).toBeGreaterThan(1);
  });

  it('manager も全件見える', async () => {
    const res = await requestAs('manager', '/api/staff');
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Array<{ id: string }> }>();
    expect(body.data.length).toBeGreaterThan(1);
  });

  it('staff は自分 1 件だけ（シフト画面で自分の行を描画するため）', async () => {
    const res = await requestAs('staff', '/api/staff');
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Array<{ id: string }> }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe(STAFF_FIXTURES.staff.id);
  });

  it('admin は 403（owner/manager 以外を弾く現状の実装）', async () => {
    const res = await requestAs('admin', '/api/staff');
    expect(res.status).toBe(403);
  });
});

describe('env API_KEY（機械用の入口）', () => {
  it('env-owner として owner 相当に到達できる', async () => {
    for (const path of ['/api/staff/me', '/api/friends/count', '/api/audit-logs', '/api/staff']) {
      const res = await request(path, ENV_API_KEY);
      expect(res.status, path).toBe(200);
    }
  });

  it('/api/staff/me は D1 を引かず合成プロフィールを返す', async () => {
    const res = await request('/api/staff/me', ENV_API_KEY);
    const body = await res.json<{ data: { id: string; role: string; email: string | null } }>();
    expect(body.data).toMatchObject({ id: 'env-owner', role: 'owner', email: null });
  });
});
