/**
 * スタッフ CRUD のログイン資格情報まわり（BOXIV / Phase 2）。
 *
 * メールアドレスが「ログインの本人確認そのもの」になったので、
 *   - 作成時にメール必須・形式検証・重複禁止
 *   - メール変更は owner のみ
 *   - 無効化 / ロール変更 / メール変更で生きているセッションを失効
 *   - 削除でセッションと未使用コードも消える
 * を固定する。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createLoginChallenge,
  createStaffSession,
  listStaffSessions,
} from '@line-crm/db';
import { ENV_API_KEY, STAFF_FIXTURES, request, requestAs, testDb } from './support/fixtures.js';

/** テスト用スタッフを 1 人作って id を返す（後片付けはテスト側で DELETE する）。 */
async function createStaff(
  actor: 'owner' | 'manager',
  body: Record<string, unknown>,
): Promise<Response> {
  return requestAs(actor, '/api/staff', { method: 'POST', body: JSON.stringify(body) });
}

async function liveSessionCount(staffId: string): Promise<number> {
  return (await listStaffSessions(testDb, staffId)).length;
}

async function unusedChallengeCount(staffId: string): Promise<number> {
  const row = await testDb
    .prepare(
      'SELECT COUNT(*) AS n FROM staff_login_challenges WHERE staff_id = ? AND used_at IS NULL',
    )
    .bind(staffId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

let createdIds: string[] = [];

beforeEach(async () => {
  for (const id of createdIds) {
    await request(`/api/staff/${id}`, ENV_API_KEY, { method: 'DELETE' });
  }
  createdIds = [];
});

async function newStaff(email: string, role = 'staff'): Promise<string> {
  const res = await createStaff('owner', { name: `検証用 ${email}`, email, role });
  expect(res.status).toBe(201);
  const body = await res.json<{ data: { id: string } }>();
  createdIds.push(body.data.id);
  return body.data.id;
}

describe('POST /api/staff — メールアドレスの検証', () => {
  it('メール無しは 400（メールコードで永久にログインできない人を作らない）', async () => {
    const res = await createStaff('owner', { name: 'メール無し', role: 'staff' });
    expect(res.status).toBe(400);
  });

  it('空文字のメールも 400', async () => {
    const res = await createStaff('owner', { name: '空メール', email: '   ', role: 'staff' });
    expect(res.status).toBe(400);
  });

  it('形式が不正なメールは 400', async () => {
    for (const email of ['not-an-email', 'a@b', 'a b@example.com', 'a@example']) {
      const res = await createStaff('owner', { name: '不正メール', email, role: 'staff' });
      expect(res.status, email).toBe(400);
    }
  });

  it('既存スタッフと同じメールは 409（大文字小文字は無視）', async () => {
    const res = await createStaff('owner', {
      name: '重複メール',
      email: STAFF_FIXTURES.manager.id.toUpperCase() + '@EXAMPLE.TEST',
      role: 'staff',
    });
    expect(res.status).toBe(409);
  });

  it('正しいメールなら 201 で平文 API キーが 1 度だけ返る', async () => {
    const res = await createStaff('owner', {
      name: '正常系',
      email: 'phase2-ok@example.test',
      role: 'staff',
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ data: { id: string; email: string; apiKey: string } }>();
    createdIds.push(body.data.id);
    expect(body.data.email).toBe('phase2-ok@example.test');
    expect(body.data.apiKey).toMatch(/^lh_[0-9a-f]{32}$/);
  });
});

describe('PATCH /api/staff/:id — メールアドレスの変更権限', () => {
  it('manager は撮影スタッフのメールを変更できない（なりすましになるため）', async () => {
    const id = await newStaff('phase2-target@example.test');
    const res = await requestAs('manager', `/api/staff/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ email: 'attacker@example.test' }),
    });
    expect(res.status).toBe(403);

    const after = await request(`/api/staff/${id}`, ENV_API_KEY);
    const body = await after.json<{ data: { email: string } }>();
    expect(body.data.email).toBe('phase2-target@example.test');
  });

  it('manager でもメール以外（名前）は従来どおり変更できる', async () => {
    const id = await newStaff('phase2-rename@example.test');
    const res = await requestAs('manager', `/api/staff/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: '改名後' }),
    });
    expect(res.status).toBe(200);
  });

  it('同じアドレスを送り直すだけなら「変更」とみなさず manager でも通る', async () => {
    const id = await newStaff('phase2-same@example.test');
    const res = await requestAs('manager', `/api/staff/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: '据え置き', email: 'Phase2-Same@Example.test' }),
    });
    expect(res.status).toBe(200);
  });

  it('owner はメールを変更できる。空にはできない', async () => {
    const id = await newStaff('phase2-owner-edit@example.test');

    const blank = await request(`/api/staff/${id}`, ENV_API_KEY, {
      method: 'PATCH',
      body: JSON.stringify({ email: '' }),
    });
    expect(blank.status).toBe(400);

    const ok = await request(`/api/staff/${id}`, ENV_API_KEY, {
      method: 'PATCH',
      body: JSON.stringify({ email: 'phase2-owner-edit2@example.test' }),
    });
    expect(ok.status).toBe(200);
  });

  it('他人が使っているアドレスへは変更できない', async () => {
    const id = await newStaff('phase2-dup-a@example.test');
    await newStaff('phase2-dup-b@example.test');
    const res = await request(`/api/staff/${id}`, ENV_API_KEY, {
      method: 'PATCH',
      body: JSON.stringify({ email: 'phase2-dup-b@example.test' }),
    });
    expect(res.status).toBe(409);
  });
});

describe('PATCH /api/staff/:id — セッションの失効', () => {
  it('メール変更で生きているセッションと未使用コードが消える', async () => {
    const id = await newStaff('phase2-revoke-mail@example.test');
    await createStaffSession(testDb, { staffId: id });
    await createLoginChallenge(testDb, { staffId: id, email: 'phase2-revoke-mail@example.test' });
    expect(await liveSessionCount(id)).toBe(1);
    expect(await unusedChallengeCount(id)).toBe(1);

    const res = await request(`/api/staff/${id}`, ENV_API_KEY, {
      method: 'PATCH',
      body: JSON.stringify({ email: 'phase2-revoke-mail2@example.test' }),
    });
    expect(res.status).toBe(200);
    expect(await liveSessionCount(id)).toBe(0);
    expect(await unusedChallengeCount(id)).toBe(0);
  });

  it('無効化でセッションが失効し、理由が staff_disabled で残る', async () => {
    const id = await newStaff('phase2-revoke-disable@example.test');
    await createStaffSession(testDb, { staffId: id });

    const res = await request(`/api/staff/${id}`, ENV_API_KEY, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: false }),
    });
    expect(res.status).toBe(200);
    expect(await liveSessionCount(id)).toBe(0);

    const all = await listStaffSessions(testDb, id, { includeRevoked: true });
    expect(all[0]!.revokedReason).toBe('staff_disabled');
  });

  it('ロール変更でセッションが失効し、理由が role_changed で残る', async () => {
    const id = await newStaff('phase2-revoke-role@example.test');
    await createStaffSession(testDb, { staffId: id });

    const res = await request(`/api/staff/${id}`, ENV_API_KEY, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'manager' }),
    });
    expect(res.status).toBe(200);
    expect(await liveSessionCount(id)).toBe(0);

    const all = await listStaffSessions(testDb, id, { includeRevoked: true });
    expect(all[0]!.revokedReason).toBe('role_changed');
  });

  it('名前だけの変更ではセッションを切らない（無関係な再ログインを強いない）', async () => {
    const id = await newStaff('phase2-keep@example.test');
    await createStaffSession(testDb, { staffId: id });

    const res = await request(`/api/staff/${id}`, ENV_API_KEY, {
      method: 'PATCH',
      body: JSON.stringify({ name: '名前だけ変更' }),
    });
    expect(res.status).toBe(200);
    expect(await liveSessionCount(id)).toBe(1);
  });
});

describe('DELETE /api/staff/:id — 認証テーブルの後始末', () => {
  it('セッションと未使用コードの行ごと消える', async () => {
    const id = await newStaff('phase2-delete@example.test');
    await createStaffSession(testDb, { staffId: id });
    await createLoginChallenge(testDb, { staffId: id, email: 'phase2-delete@example.test' });

    const res = await request(`/api/staff/${id}`, ENV_API_KEY, { method: 'DELETE' });
    expect(res.status).toBe(200);
    createdIds = createdIds.filter((x) => x !== id);

    const sessions = await testDb
      .prepare('SELECT COUNT(*) AS n FROM staff_sessions WHERE staff_id = ?')
      .bind(id)
      .first<{ n: number }>();
    const challenges = await testDb
      .prepare('SELECT COUNT(*) AS n FROM staff_login_challenges WHERE staff_id = ?')
      .bind(id)
      .first<{ n: number }>();
    expect(sessions?.n).toBe(0);
    expect(challenges?.n).toBe(0);
  });
});

describe('監査ログに認証経路が残る（migration 919 の actor_via）', () => {
  /** audit_log の書き込みは waitUntil なのでレスポンス後に届く。短時間ポーリングする。 */
  async function waitForAuditRow(path: string): Promise<{ actor_via: string | null } | null> {
    for (let i = 0; i < 40; i++) {
      const row = await testDb
        .prepare('SELECT actor_via FROM audit_log WHERE path = ? ORDER BY created_at DESC LIMIT 1')
        .bind(path)
        .first<{ actor_via: string | null }>();
      if (row) return row;
      await new Promise((r) => setTimeout(r, 25));
    }
    return null;
  }

  it('env API_KEY 経由の変更は env_key として残る', async () => {
    const res = await request('/api/staff', ENV_API_KEY, {
      method: 'POST',
      body: JSON.stringify({ name: '経路検証 env', email: 'phase2-via-env@example.test', role: 'staff' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ data: { id: string } }>();
    createdIds.push(body.data.id);

    const row = await waitForAuditRow('/api/staff');
    expect(row?.actor_via).toBe('env_key');
  });

  it('スタッフの API キー経由の変更は api_key として残る', async () => {
    const id = await newStaff('phase2-via-key@example.test');
    const res = await requestAs('manager', `/api/staff/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: '経路検証 apikey' }),
    });
    expect(res.status).toBe(200);

    const row = await waitForAuditRow(`/api/staff/${id}`);
    expect(row?.actor_via).toBe('api_key');
  });
});
