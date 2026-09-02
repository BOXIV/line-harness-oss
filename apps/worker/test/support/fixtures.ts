/**
 * テスト用スタッフの seed とリクエストヘルパー（BOXIV）。
 *
 * 本番のキーは一切使わない。ここで作るのは owner/admin/manager/staff の
 * 4 ロール + 無効化済みスタッフの合計 5 行。
 */
import { SELF, env } from 'cloudflare:test';
import { createStaffSession } from '@line-crm/db';

export type Role = 'owner' | 'admin' | 'manager' | 'staff';

/**
 * テスト用 D1。
 *
 * `cloudflare:test` の `env` は `Cloudflare.Env`（宣言マージ前提の空 interface）型で、
 * ここへ Worker の Bindings を宣言マージしようとしても解決されなかったため、
 * 参照はこの 1 箇所のキャストに閉じ込める。バインド名 DB は vitest.config.ts が正。
 */
export const testDb = (env as unknown as { DB: D1Database }).DB;

export const ROLES: Role[] = ['owner', 'admin', 'manager', 'staff'];

/** 既存キーの形式は `lh_` + 32 hex。Phase 3 で追加する新セッション形式 `lhs_` と衝突しないことを固定する。 */
export const STAFF_FIXTURES: Record<Role, { id: string; name: string; apiKey: string }> = {
  owner: { id: 'test-owner', name: 'テストオーナー', apiKey: 'lh_00000000000000000000000000000001' },
  admin: { id: 'test-admin', name: 'テスト管理者', apiKey: 'lh_00000000000000000000000000000002' },
  manager: { id: 'test-manager', name: 'テストマネージャー', apiKey: 'lh_00000000000000000000000000000003' },
  staff: { id: 'test-staff', name: 'テスト撮影スタッフ', apiKey: 'lh_00000000000000000000000000000004' },
};

/** is_active = 0。認証が「在籍していること」を毎回引き直しているかの確認用。 */
export const INACTIVE_STAFF = {
  id: 'test-inactive',
  name: 'テスト退職者',
  apiKey: 'lh_00000000000000000000000000000005',
};

/** vitest.config.ts の bindings.API_KEY と同じ値。env-owner 経路の確認用。 */
export const ENV_API_KEY = 'test-env-owner-key';

/**
 * ロールごとのログイン済みセッション（`lhs_<id>.<secret>`）。
 *
 * 2026-09-02 に **オーナー以外の API キー認証を禁止**したので、人間の入口は
 * メールログインのセッションだけになった。テストも同じ経路で叩く
 * （API キーの可否そのものは api-key-login.test.ts が固定する）。
 */
const sessionTokens = new Map<Role, string>();

export function sessionTokenFor(role: Role): string {
  const token = sessionTokens.get(role);
  if (!token) throw new Error(`session for ${role} is not seeded (seedStaff を先に呼ぶこと)`);
  return token;
}

export async function seedStaff(db: D1Database): Promise<void> {
  const rows = [
    ...ROLES.map((role) => ({ ...STAFF_FIXTURES[role], role, isActive: 1 })),
    { ...INACTIVE_STAFF, role: 'staff' as const, isActive: 0 },
  ];

  for (const row of rows) {
    await db
      .prepare(
        `INSERT OR REPLACE INTO staff_members
           (id, name, email, role, api_key, is_active, work_area, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, '2026-01-01T00:00:00.000', '2026-01-01T00:00:00.000')`,
      )
      .bind(row.id, row.name, `${row.id}@example.test`, row.role, row.apiKey, row.isActive)
      .run();
  }

  await issueSessions(db);
}

/**
 * 各ロールのセッションを 1 本ずつ発行し直す。
 *
 * `DELETE FROM staff_sessions` で掃除するテスト（auth-email / staff-auth）は、
 * 掃除のあとにこれを呼ぶこと。呼ばないと requestAs のトークンごと消えて、
 * 本題と関係ない 401 で落ちる。
 */
export async function issueSessions(db: D1Database): Promise<void> {
  sessionTokens.clear();
  for (const role of ROLES) {
    const session = await createStaffSession(db, {
      staffId: STAFF_FIXTURES[role].id,
      issuedVia: 'admin_issued',
    });
    sessionTokens.set(role, session.token);
  }
}

const ORIGIN = 'https://worker.example.test';

/**
 * 既定のテスト用クライアント IP（TEST-NET-3 / RFC 5737）。
 *
 * ログインの試行元スロットル（migration 920）は IP 単位で数えるので、
 * 付けないと全テストが同じ bucket を共有して互いを落とす。
 * IP 単位の挙動を試すテストは init.headers で個別の IP を渡すこと。
 */
export const TEST_IP = '203.0.113.10';

/** Bearer 付きでワーカーを叩く。token を省略すると Authorization ヘッダ自体を付けない。 */
export function request(path: string, token?: string | null, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token !== undefined && token !== null) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', TEST_IP);
  return SELF.fetch(`${ORIGIN}${path}`, { ...init, headers });
}

/** ロール名で叩く糖衣。人間の入口＝メールログインのセッションで叩く。 */
export function requestAs(role: Role, path: string, init: RequestInit = {}): Promise<Response> {
  return request(path, sessionTokenFor(role), init);
}

/** API キーで叩く（キーの可否そのものを試すテスト用）。 */
export function requestWithApiKey(role: Role, path: string, init: RequestInit = {}): Promise<Response> {
  return request(path, STAFF_FIXTURES[role].apiKey, init);
}
