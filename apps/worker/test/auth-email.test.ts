/**
 * メール認証コードによるログイン（BOXIV / Phase 3）。
 *
 * 「誰が入れるか」を決める経路なので、通る条件より **通らない条件** を厚く固定する。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { STAFF_FIXTURES, ENV_API_KEY, request, requestAs, testDb } from './support/fixtures.js';

const STAFF = STAFF_FIXTURES.staff;
const MANAGER = STAFF_FIXTURES.manager;
const emailOf = (id: string) => `${id}@example.test`;

beforeEach(async () => {
  await testDb.prepare('DELETE FROM staff_login_challenges').run();
  await testDb.prepare('DELETE FROM staff_sessions').run();
});

async function start(email: string): Promise<Response> {
  return request('/api/auth/email/start', null, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
}

async function verify(email: string, code: string): Promise<Response> {
  return request('/api/auth/email/verify', null, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code }),
  });
}

/** テスト内では平文コードを取れないので、発行された行の id からコードを逆算できない。
 *  代わりに db ヘルパーで直接発行して平文を得る（送信経路のテストは start 側で行う）。 */
async function issueCode(staffId: string): Promise<string> {
  const { createLoginChallenge } = await import('@line-crm/db');
  const { code } = await createLoginChallenge(testDb, {
    staffId,
    email: emailOf(staffId),
  });
  return code;
}

async function challengeCount(staffId: string): Promise<number> {
  const row = await testDb
    .prepare('SELECT COUNT(*) AS n FROM staff_login_challenges WHERE staff_id = ?')
    .bind(staffId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe('POST /api/auth/email/start', () => {
  it('認証不要で叩ける（401 にならない）', async () => {
    const res = await start(emailOf(STAFF.id));
    expect(res.status).toBe(200);
  });

  it('登録済みアドレスならチャレンジが 1 件できる', async () => {
    await start(emailOf(STAFF.id));
    expect(await challengeCount(STAFF.id)).toBe(1);
  });

  it('大文字小文字が違っても同じスタッフに届く', async () => {
    await start(emailOf(STAFF.id).toUpperCase());
    expect(await challengeCount(STAFF.id)).toBe(1);
  });

  it('未登録アドレスでも同じ 200 と同じ本文を返す（アドレスの存在を漏らさない）', async () => {
    const known = await start(emailOf(STAFF.id));
    const unknown = await start('nobody-here@example.test');
    expect(unknown.status).toBe(known.status);
    expect(await unknown.json()).toEqual(await known.json());
  });

  // ── 「送ったつもりで届かない」を作らないための 400 ──────────────────────────
  // 汎用 200 を返してよいのは「構文として妥当なアドレスが来た」ときだけ。
  // 空文字や not-an-email が登録済みアドレスであることはあり得ないので、
  // 隠して得るものが無い。一方で隠すと、フロントがフィールド名を間違えたときに
  // 画面が「メールを送りました」に化けて、利用者は永遠に来ないメールを待つ。
  // 403 が「APIキーが正しくありません」に化けた 3 日間の締め出しと同じ型。
  it('本文が JSON でなければ 400', async () => {
    const res = await request('/api/auth/email/start', null, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('email が無ければ 400', async () => {
    const res = await request('/api/auth/email/start', null, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });

  it('email が空文字なら 400', async () => {
    expect((await start('   ')).status).toBe(400);
  });

  it('メール形式が不正なら 400', async () => {
    for (const email of ['not-an-email', 'a@b', 'a b@example.com', 'a@b.com,c@d.com']) {
      expect((await start(email)).status, email).toBe(400);
    }
  });

  it('無効化されたスタッフにはコードを出さない', async () => {
    await start('test-inactive@example.test');
    expect(await challengeCount('test-inactive')).toBe(0);
  });

  it('発行を連打しても上限で止まる（総当たりの試行枠を稼がせない）', async () => {
    for (let i = 0; i < 10; i++) await start(emailOf(STAFF.id));
    // 既定 ADMIN_LOGIN_ISSUE_MAX = 5
    expect(await challengeCount(STAFF.id)).toBe(5);
  });
});

describe('POST /api/auth/email/verify', () => {
  it('正しいコードで lhs_ セッションが返る', async () => {
    const code = await issueCode(STAFF.id);
    const res = await verify(emailOf(STAFF.id), code);
    expect(res.status).toBe(200);

    const body = await res.json<{
      data: { token: string; expiresAt: string; staff: { id: string; role: string } };
    }>();
    expect(body.data.token).toMatch(/^lhs_[0-9a-f]{32}\.[0-9a-f]{64}$/);
    expect(body.data.staff).toMatchObject({ id: STAFF.id, role: 'staff' });
  });

  it('返ったセッションで API を叩ける（ロールは元のまま）', async () => {
    const code = await issueCode(STAFF.id);
    const body = await (await verify(emailOf(STAFF.id), code)).json<{ data: { token: string } }>();
    const token = body.data.token;

    const me = await request('/api/staff/me', token);
    expect(me.status).toBe(200);
    expect((await me.json<{ data: { id: string; role: string } }>()).data).toMatchObject({
      id: STAFF.id,
      role: 'staff',
    });

    // 撮影スタッフの権限のまま。セッションになってもロールが上がったりしない。
    expect((await request('/api/friends/count', token)).status).toBe(403);
    expect((await request('/api/staff-availability', token)).status).toBe(200);
  });

  it('コードは 1 回しか使えない', async () => {
    const code = await issueCode(STAFF.id);
    expect((await verify(emailOf(STAFF.id), code)).status).toBe(200);
    expect((await verify(emailOf(STAFF.id), code)).status).toBe(401);
  });

  it('ログイン成功で他の未使用コードも無効になる', async () => {
    const first = await issueCode(STAFF.id);
    const second = await issueCode(STAFF.id);
    expect((await verify(emailOf(STAFF.id), first)).status).toBe(200);
    expect((await verify(emailOf(STAFF.id), second)).status).toBe(401);
  });

  it('間違ったコードは 401', async () => {
    const code = await issueCode(STAFF.id);
    const wrong = code === '000000' ? '111111' : '000000';
    expect((await verify(emailOf(STAFF.id), wrong)).status).toBe(401);
  });

  it('他人のアドレス + 自分のコードでは通らない', async () => {
    const code = await issueCode(STAFF.id);
    expect((await verify(emailOf(MANAGER.id), code)).status).toBe(401);
  });

  it('未登録アドレスと間違ったコードのレスポンスが区別できない', async () => {
    const code = await issueCode(STAFF.id);
    const wrong = code === '000000' ? '111111' : '000000';
    const a = await verify('nobody-here@example.test', '123456');
    const b = await verify(emailOf(STAFF.id), wrong);
    expect(a.status).toBe(b.status);
    expect(await a.json()).toEqual(await b.json());
  });

  it('入力の「形」が違うときは 401 ではなく 400（コード間違いに化けさせない）', async () => {
    for (const code of ['', '12345', '1234567', 'abcdef']) {
      expect((await verify(emailOf(STAFF.id), code)).status, code).toBe(400);
    }
    expect((await verify('not-an-email', '123456')).status).toBe(400);

    const nonJson = await request('/api/auth/email/verify', null, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(nonJson.status).toBe(400);
  });

  it('ハイフンや空白入りのコードは正規化して受け付ける', async () => {
    const code = await issueCode(STAFF.id);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect((await verify(emailOf(STAFF.id), spaced)).status).toBe(200);
  });

  it('ログイン成功が監査ログに残る', async () => {
    const code = await issueCode(STAFF.id);
    await verify(emailOf(STAFF.id), code);
    const row = await testDb
      .prepare("SELECT * FROM audit_log WHERE action = 'auth.login' ORDER BY created_at DESC LIMIT 1")
      .first<{ actor_id: string; actor_via: string; detail: string }>();
    expect(row?.actor_id).toBe(STAFF.id);
    expect(row?.actor_via).toBe('session');
    // メールアドレスは生で残さない
    expect(row?.detail).not.toContain(emailOf(STAFF.id));
    expect(row?.detail).toContain('***');
  });

  it('ログイン失敗も監査ログに残る', async () => {
    await issueCode(STAFF.id);
    await verify(emailOf(STAFF.id), '000000');
    const row = await testDb
      .prepare(
        "SELECT * FROM audit_log WHERE action = 'auth.login_failed' ORDER BY created_at DESC LIMIT 1",
      )
      .first<{ actor_id: string; status: number }>();
    expect(row?.actor_id).toBe(STAFF.id);
    expect(row?.status).toBe(401);
  });
});

describe('セッションの失効が次のリクエストで効く', () => {
  async function login(staffId: string): Promise<string> {
    const code = await issueCode(staffId);
    const body = await (await verify(emailOf(staffId), code)).json<{ data: { token: string } }>();
    return body.data.token;
  }

  it('スタッフを無効化すると即 401', async () => {
    const token = await login(STAFF.id);
    expect((await request('/api/staff/me', token)).status).toBe(200);

    await request(`/api/staff/${STAFF.id}`, ENV_API_KEY, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: false }),
    });
    try {
      expect((await request('/api/staff/me', token)).status).toBe(401);
    } finally {
      await testDb.prepare('UPDATE staff_members SET is_active = 1 WHERE id = ?').bind(STAFF.id).run();
    }
  });

  it('ロールを上げると次のリクエストから新しいロールで判定される', async () => {
    const token = await login(STAFF.id);
    expect((await request('/api/friends/count', token)).status).toBe(403);

    await testDb.prepare("UPDATE staff_members SET role = 'manager' WHERE id = ?").bind(STAFF.id).run();
    try {
      expect((await request('/api/friends/count', token)).status).toBe(200);
    } finally {
      await testDb.prepare("UPDATE staff_members SET role = 'staff' WHERE id = ?").bind(STAFF.id).run();
    }
  });

  it('ログアウトでそのセッションだけ失効する', async () => {
    const a = await login(STAFF.id);
    const b = await login(STAFF.id);

    const out = await request('/api/auth/logout', a, { method: 'POST', body: '{}' });
    expect(out.status).toBe(200);
    expect((await request('/api/staff/me', a)).status).toBe(401);
    expect((await request('/api/staff/me', b)).status).toBe(200);
  });

  it('API キーでのログアウトは何も壊さない（旧経路の互換）', async () => {
    const out = await requestAs('manager', '/api/auth/logout', { method: 'POST', body: '{}' });
    expect(out.status).toBe(200);
    expect((await requestAs('manager', '/api/staff/me')).status).toBe(200);
  });
});

describe('GET /api/auth/session', () => {
  it('認証が要る（start/verify のスキップが前方一致で広がっていない）', async () => {
    expect((await request('/api/auth/session')).status).toBe(401);
    expect((await request('/api/auth/logout', null, { method: 'POST', body: '{}' })).status).toBe(401);
  });

  it('セッションで叩くと authVia = session と自分のセッション一覧が返る', async () => {
    const code = await issueCode(STAFF.id);
    const token = (await (await verify(emailOf(STAFF.id), code)).json<{ data: { token: string } }>())
      .data.token;

    const res = await request('/api/auth/session', token);
    expect(res.status).toBe(200);
    const body = await res.json<{
      data: { authVia: string; sessionId: string; sessions: Array<{ id: string }> };
    }>();
    expect(body.data.authVia).toBe('session');
    expect(body.data.sessions.map((s) => s.id)).toContain(body.data.sessionId);
  });

  it('API キーで叩くと authVia = api_key・セッション一覧は空', async () => {
    const res = await requestAs('manager', '/api/auth/session');
    const body = await res.json<{ data: { authVia: string; sessions: unknown[] } }>();
    expect(body.data.authVia).toBe('api_key');
    expect(body.data.sessions).toEqual([]);
  });
});

describe('POST /api/staff/:id/login-code — 管理者による救済発行', () => {
  it('manager は撮影スタッフに発行でき、そのコードでログインできる', async () => {
    const res = await requestAs('manager', `/api/staff/${STAFF.id}/login-code`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { code: string } }>();
    expect(body.data.code).toMatch(/^\d{6}$/);

    const login = await verify(emailOf(STAFF.id), body.data.code);
    expect(login.status).toBe(200);
  });

  it('発行者名が監査ログに残る（唯一の抑止力）', async () => {
    await requestAs('manager', `/api/staff/${STAFF.id}/login-code`, { method: 'POST', body: '{}' });
    const row = await testDb
      .prepare(
        "SELECT * FROM audit_log WHERE action = 'auth.login_code_issued' ORDER BY created_at DESC LIMIT 1",
      )
      .first<{ actor_id: string; actor_name: string; target_id: string }>();
    expect(row?.actor_id).toBe(MANAGER.id);
    expect(row?.actor_name).toBe(STAFF_FIXTURES.manager.name);
    expect(row?.target_id).toBe(STAFF.id);
  });

  it('manager が発行できるのは撮影スタッフのみ（他 manager / admin / owner は 403）', async () => {
    // routes/staff.ts の作成 / 編集 / 削除 / キー再生成が全て「manager は staff のみ」で
    // 揃っているので、ここだけ広げない。特に他 manager のキー再生成は禁止されているのに
    // 救済コードだけ許すと、より強くて（なりすませる）より静かな（本人が気づかない）経路を
    // 既存が禁じている相手に開くことになる。
    // 「別の manager」を実際に作って試す。自分自身を対象にするだけでは
    // 「同格へのなりすまし」を試したことにならない。
    const other = await request('/api/staff', ENV_API_KEY, {
      method: 'POST',
      body: JSON.stringify({
        name: '別マネージャー',
        email: 'phase3-other-manager@example.test',
        role: 'manager',
      }),
    });
    const otherId = (await other.json<{ data: { id: string } }>()).data.id;

    try {
      const targets = [
        { id: otherId, label: '別の manager' },
        { id: STAFF_FIXTURES.manager.id, label: '自分自身(manager)' },
        { id: STAFF_FIXTURES.admin.id, label: 'admin' },
        { id: STAFF_FIXTURES.owner.id, label: 'owner' },
      ];
      for (const target of targets) {
        const res = await requestAs('manager', `/api/staff/${target.id}/login-code`, {
          method: 'POST',
          body: '{}',
        });
        expect(res.status, target.label).toBe(403);
      }
    } finally {
      await request(`/api/staff/${otherId}`, ENV_API_KEY, { method: 'DELETE' });
    }
  });

  it('参考: manager は他 manager のキー再生成もできない（既存の権限境界と揃っていること）', async () => {
    // この 403 と上のテストが揃っていることが要点。片方だけ開いていると、
    // より強くて静かな経路（救済コード）が既存の禁止（キー再生成）を迂回する。
    const res = await requestAs('manager', `/api/staff/${STAFF_FIXTURES.admin.id}/regenerate-key`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('撮影スタッフ自身は誰にも発行できない', async () => {
    const res = await requestAs('staff', `/api/staff/${MANAGER.id}/login-code`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('owner は誰にでも発行できる', async () => {
    for (const target of [STAFF_FIXTURES.admin, STAFF_FIXTURES.manager, STAFF_FIXTURES.staff]) {
      const res = await request(`/api/staff/${target.id}/login-code`, ENV_API_KEY, {
        method: 'POST',
        body: '{}',
      });
      expect(res.status, target.id).toBe(200);
    }
  });

  it('無効化されたスタッフには発行できない', async () => {
    const res = await request('/api/staff/test-inactive/login-code', ENV_API_KEY, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(400);
  });

  it('存在しないスタッフは 404', async () => {
    const res = await request('/api/staff/does-not-exist/login-code', ENV_API_KEY, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(404);
  });
});
