/**
 * メール認証コードによるログイン（BOXIV / Phase 3）。
 *
 * 「誰が入れるか」を決める経路なので、通る条件より **通らない条件** を厚く固定する。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { STAFF_FIXTURES, ENV_API_KEY, TEST_IP, request, requestAs, testDb } from './support/fixtures.js';

const STAFF = STAFF_FIXTURES.staff;
const MANAGER = STAFF_FIXTURES.manager;
const emailOf = (id: string) => `${id}@example.test`;

beforeEach(async () => {
  await testDb.prepare('DELETE FROM staff_login_challenges').run();
  await testDb.prepare('DELETE FROM staff_sessions').run();
  // 試行元スロットル（migration 920）はテスト間で持ち越さない。
  // 消さないと、前のテストの失敗回数で後のテストが 401 に落ちる。
  await testDb.prepare('DELETE FROM auth_throttle').run();
});

async function start(email: string, ip: string = TEST_IP): Promise<Response> {
  return request('/api/auth/email/start', null, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email }),
  });
}

async function verify(email: string, code: string, ip: string = TEST_IP): Promise<Response> {
  return request('/api/auth/email/verify', null, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip },
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

/**
 * 一時スタッフを作って id を返し、コールバック終了後に必ず削除する。
 * 「別の manager」を対象にするテストが複数あるので、生成と後片付けを 1 箇所に閉じる
 * （2 箇所に書くと片方だけ直って、テスト名と実際の対象がズレる）。
 */
async function withTempStaff<T>(
  input: { name: string; email: string; role: 'owner' | 'admin' | 'manager' | 'staff' },
  fn: (id: string) => Promise<T>,
): Promise<T> {
  const created = await request('/api/staff', ENV_API_KEY, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  expect(created.status, `一時スタッフの作成に失敗: ${input.email}`).toBe(201);
  const id = (await created.json<{ data: { id: string } }>()).data.id;
  try {
    return await fn(id);
  } finally {
    await request(`/api/staff/${id}`, ENV_API_KEY, { method: 'DELETE' });
  }
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
    await withTempStaff(
      { name: '別マネージャー', email: 'phase3-other-manager@example.test', role: 'manager' },
      async (otherId) => {
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
      },
    );
  });

  it('参考: manager は他 manager のキー再生成もできない（2つの境界が揃っていること）', async () => {
    // この 403 と上のテストが揃っていることが要点。片方だけ開いていると、
    // より強くて静かな経路（救済コード）が既存の禁止（キー再生成）を迂回する。
    // ⚠️ 対象は必ず **別の manager**。admin を対象にすると同じ条件で弾かれるので緑にはなるが、
    //    「manager → manager」という要点のペアが固定されないまま通ってしまう。
    await withTempStaff(
      { name: '別マネージャー（キー再生成用）', email: 'phase3-other-manager2@example.test', role: 'manager' },
      async (otherId) => {
        for (const target of [
          { id: otherId, label: '別の manager' },
          { id: STAFF_FIXTURES.admin.id, label: 'admin' },
          { id: STAFF_FIXTURES.owner.id, label: 'owner' },
        ]) {
          const res = await requestAs('manager', `/api/staff/${target.id}/regenerate-key`, {
            method: 'POST',
            body: '{}',
          });
          expect(res.status, target.label).toBe(403);
        }
      },
    );
  });

  it('メール未登録のスタッフには発行できない（構造上使えないコードを成功として返さない）', async () => {
    // verify は必ず findActiveStaffByEmail で解決するので、メールが無い行に発行しても
    // そのコードはどのアドレスを打っても消費できない。発行前に落とすこと。
    await withTempStaff(
      { name: 'メール消去予定', email: 'phase3-will-clear@example.test', role: 'staff' },
      async (id) => {
        // API はメール必須なので、直接 D1 を空にして「過去に作られた欠損行」を再現する。
        await testDb.prepare('UPDATE staff_members SET email = NULL WHERE id = ?').bind(id).run();
        const res = await request(`/api/staff/${id}/login-code`, ENV_API_KEY, {
          method: 'POST',
          body: '{}',
        });
        expect(res.status).toBe(400);
      },
    );
  });

  it('メールが重複しているスタッフには発行できない', async () => {
    await withTempStaff(
      { name: '重複予定A', email: 'phase3-dup-x@example.test', role: 'staff' },
      async (idA) => {
        await withTempStaff(
          { name: '重複予定B', email: 'phase3-dup-y@example.test', role: 'staff' },
          async (idB) => {
            // API は重複を弾くので、直接 D1 で重複状態を作る。
            await testDb
              .prepare('UPDATE staff_members SET email = ? WHERE id = ?')
              .bind('phase3-dup-x@example.test', idB)
              .run();
            const res = await request(`/api/staff/${idA}/login-code`, ENV_API_KEY, {
              method: 'POST',
              body: '{}',
            });
            expect(res.status).toBe(409);
          },
        );
      },
    );
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

describe('第三者がメールアドレスだけでログインを封じられないこと（migration 920）', () => {
  const ATTACKER = '198.51.100.7'; // TEST-NET-2
  const VICTIM = '203.0.113.55';   // TEST-NET-3

  async function codeFor(staffId: string): Promise<string> {
    const { createLoginChallenge } = await import('@line-crm/db');
    const { code } = await createLoginChallenge(testDb, { staffId, email: emailOf(staffId) });
    return code;
  }

  it('攻撃者が失敗を続けても、本人が取り直したコードは焼かれない', async () => {
    // 本人がコードを受け取っている状態。
    const victimCode = await codeFor(STAFF.id);

    // 攻撃者はメールアドレスだけ知っている。無効コードを投げて本人のコードを焼く。
    // max_attempts 5 なので 5 回で焼き切れる。ここまでは防げない（防ぐ必要も無い）。
    for (let i = 0; i < 5; i++) {
      expect((await verify(emailOf(STAFF.id), '000001', ATTACKER)).status).toBe(401);
    }
    expect((await verify(emailOf(STAFF.id), victimCode, VICTIM)).status).toBe(401);

    // 攻撃者が IP 単位の失敗上限（既定 20）に達するまで投げ続ける。
    for (let i = 0; i < 16; i++) {
      await verify(emailOf(STAFF.id), '000001', ATTACKER);
    }

    // 本人が取り直す。
    const fresh = await codeFor(STAFF.id);

    // ★ここが要点★ 攻撃者はさらに投げてくるが、上限に達しているので
    //   チャレンジに一切触れずに落ちる。本人の新しいコードは無傷のまま。
    //   IP 単位のスロットルが無いと、この 5 回で fresh も焼かれて
    //   「本人は何度取り直してもログインできない」状態になる。
    for (let i = 0; i < 5; i++) {
      await verify(emailOf(STAFF.id), '000001', ATTACKER);
    }

    expect((await verify(emailOf(STAFF.id), fresh, VICTIM)).status).toBe(200);
  });

  it('攻撃者の失敗回数は IP 単位で上限に達し、それ以降はチャレンジに触れない', async () => {
    const code = await codeFor(STAFF.id);

    // 既定 ADMIN_LOGIN_FAIL_MAX_PER_IP = 20。20 回**失敗**した次から上限で落ちる。
    for (let i = 0; i < 20; i++) {
      expect((await verify(emailOf(STAFF.id), '000002', ATTACKER)).status).toBe(401);
    }
    // 上限を超えたら 401 ではなく 429。401 に混ぜると、正しいコードを持っている本人が
    // 「コードが違う」と言われ続け、打ち直すほど状況が悪くなる。
    expect((await verify(emailOf(STAFF.id), '000002', ATTACKER)).status).toBe(429);

    const throttled = await testDb
      .prepare('SELECT count FROM auth_throttle WHERE bucket = ?')
      .bind(`login_fail|${ATTACKER}`)
      .first<{ count: number }>();
    expect(throttled!.count).toBe(20);

    // 別 IP（本人）は巻き添えにならない。上のループで焼かれたコードは通らないが、
    // 取り直した分は通る＝IP 単位で分離できている。
    const fresh = await codeFor(STAFF.id);
    expect((await verify(emailOf(STAFF.id), fresh, VICTIM)).status).toBe(200);
    expect(code).toMatch(/^\d{6}$/);
  });

  it('コード発行は (IP, スタッフ) 単位で上限がかかる（第三者が本人の枠を食い潰せない）', async () => {
    // 攻撃者の IP から既定上限（5）まで発行させる
    for (let i = 0; i < 8; i++) await start(emailOf(STAFF.id), ATTACKER);
    const afterAttacker = await challengeCount(STAFF.id);
    expect(afterAttacker).toBeLessThanOrEqual(5);

    // 本人の IP からはまだ発行できる（別 IP なので別枠）
    await start(emailOf(STAFF.id), VICTIM);
    expect(await challengeCount(STAFF.id)).toBeGreaterThan(afterAttacker);
  });

  it('同じ IP でも宛先スタッフが違えば発行枠を食い合わない（共有 NAT / CGNAT）', async () => {
    const OFFICE = '203.0.113.201';
    // 1 人目が上限まで使い切る
    for (let i = 0; i < 6; i++) await start(emailOf(STAFF.id), OFFICE);
    expect(await challengeCount(STAFF.id)).toBe(5);

    // 同じ出口 IP の別の人は影響を受けない。
    // IP だけで括っていると、ここで 6 人目が無言で締め出される。
    await start(emailOf(MANAGER.id), OFFICE);
    expect(await challengeCount(MANAGER.id)).toBe(1);
  });

  it('成功したログインは失敗枠を消費しない（共有 NAT で互いを締め出さない）', async () => {
    const OFFICE = '203.0.113.202';
    const { createLoginChallenge } = await import('@line-crm/db');

    // 既定の失敗上限（20）を超える回数、同じ IP から**成功**し続ける。
    // 門番と加算を同じ hitThrottle でやっていた頃は、11 人目の成功ログインが 429 になった。
    for (let i = 0; i < 25; i++) {
      const { code } = await createLoginChallenge(testDb, {
        staffId: STAFF.id,
        email: emailOf(STAFF.id),
      });
      const res = await verify(emailOf(STAFF.id), code, OFFICE);
      expect(res.status, `${i + 1} 回目の成功ログイン`).toBe(200);
    }

    const bucket = await testDb
      .prepare('SELECT count FROM auth_throttle WHERE bucket = ?')
      .bind(`login_fail|${OFFICE}`)
      .first<{ count: number }>();
    expect(bucket).toBeNull();
  });
});

describe('スロットルの鍵は詐称できないヘッダだけを使う', () => {
  it('x-forwarded-for を変えても IP 単位の失敗枠はリセットされない', async () => {
    const IP = '198.51.100.99';
    // 上限（既定 20）まで失敗させる
    for (let i = 0; i < 21; i++) {
      await request('/api/auth/email/verify', null, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': IP },
        body: JSON.stringify({ email: emailOf(STAFF.id), code: '000003' }),
      });
    }
    const before = await testDb
      .prepare('SELECT count FROM auth_throttle WHERE bucket = ?')
      .bind(`login_fail|${IP}`)
      .first<{ count: number }>();
    expect(before!.count).toBe(20);

    // 自称 XFF を毎回変えても、同じ cf-connecting-ip の枠が使われ続ける。
    // XFF にフォールバックしていると、ここで新しい bucket が増えて枠が実質無限になる。
    for (const spoof of ['1.2.3.4', '5.6.7.8', '9.10.11.12']) {
      await request('/api/auth/email/verify', null, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'cf-connecting-ip': IP,
          'x-forwarded-for': spoof,
        },
        body: JSON.stringify({ email: emailOf(STAFF.id), code: '000003' }),
      });
    }

    // 自称 XFF の値を含む bucket が 1 つも増えていないこと。
    // （通報ラッチ `login_fail|<ip>|alert` も同じ接頭辞なので、
    //   bucket 一覧の完全一致ではなく「詐称値が鍵に混ざっていないか」で見る）
    const buckets = await testDb
      .prepare("SELECT bucket FROM auth_throttle WHERE bucket LIKE 'login_fail|%'")
      .all<{ bucket: string }>();
    const names = buckets.results.map((b) => b.bucket);
    for (const spoof of ['1.2.3.4', '5.6.7.8', '9.10.11.12']) {
      expect(names.some((n) => n.includes(spoof)), `${spoof} が鍵に混ざっていない`).toBe(false);
    }
    expect(names).toContain(`login_fail|${IP}`);
  });
});

describe('総当たり通報が静かに鳴らなくならないこと', () => {
  it('上限到達の通報はその窓で 1 回だけ（`=== max` の取りこぼしを作らない）', async () => {
    const IP = '198.51.100.150';
    const email = emailOf(STAFF.id);

    // 上限（既定 20）まで失敗させる。20 回目で通報ラッチが立つ。
    for (let i = 0; i < 20; i++) {
      expect((await verify(email, '000004', IP)).status).toBe(401);
    }

    const latch = await testDb
      .prepare('SELECT count FROM auth_throttle WHERE bucket = ?')
      .bind(`login_fail|${IP}|alert`)
      .first<{ count: number }>();
    expect(latch?.count, '上限到達時に通報ラッチが立つ').toBe(1);

    // 以降の試行は門番(peek)で 429 になり、加算にも通報にも到達しない。
    for (let i = 0; i < 5; i++) {
      expect((await verify(email, '000004', IP)).status).toBe(429);
    }

    const after = await testDb
      .prepare('SELECT count FROM auth_throttle WHERE bucket = ?')
      .bind(`login_fail|${IP}|alert`)
      .first<{ count: number }>();
    expect(after?.count, '通報が窓内で繰り返し鳴らない').toBe(1);
  });

  it('通報ラッチは失敗カウンタとは別 bucket（互いを消費しない）', async () => {
    const IP = '198.51.100.151';
    for (let i = 0; i < 3; i++) await verify(emailOf(STAFF.id), '000005', IP);

    const fail = await testDb
      .prepare('SELECT count FROM auth_throttle WHERE bucket = ?')
      .bind(`login_fail|${IP}`)
      .first<{ count: number }>();
    const alert = await testDb
      .prepare('SELECT count FROM auth_throttle WHERE bucket = ?')
      .bind(`login_fail|${IP}|alert`)
      .first<{ count: number }>();

    expect(fail?.count).toBe(3);
    // 上限未満なのでラッチはまだ立っていない
    expect(alert).toBeNull();
  });
});

describe('スロットル bucket の区切り文字', () => {
  it('IPv6 でも scope 付き bucket と衝突しない', async () => {
    // 本番の cf-connecting-ip は IPv6 で届く（実測: 240a:61:...）。
    // 区切りを `:` にすると `login_fail:ip:<ipv6>:<scope>` が
    // 「末尾が <scope> の IPv6」と読めてしまい、scope が 16 進の語のとき衝突する。
    const V6 = '240a:61:30d0:86a1:a9e6:dfbd:23a6:beef';
    const PREFIX = '240a:61:30d0:86a1::/64'; // /64 に丸めた鍵
    for (let i = 0; i < 3; i++) await verify(emailOf(STAFF.id), '000006', V6);

    const rows = await testDb
      .prepare("SELECT bucket FROM auth_throttle WHERE bucket LIKE 'login_fail|%'")
      .all<{ bucket: string }>();
    const names = rows.results.map((r) => r.bucket);

    // 素の失敗カウンタだけが立ち、scope 付き（alert）と混ざっていない
    expect(names).toContain(`login_fail|${PREFIX}`);
    expect(names).not.toContain(`login_fail|${PREFIX}|alert`);
    // 区切りで割ると必ず 2 要素（kind と host）に分かれる。
    // `:` を区切りにしていると、末尾が 16 進として読める語（beef）のとき
    // 「scope 付き bucket」と区別が付かなくなる。
    expect(`login_fail|${PREFIX}`.split('|')).toHaveLength(2);
  });
});

describe('IPv6 でも IP 単位の制御が効くこと（migration 920 / /64 正規化）', () => {
  it('同一 /64 の別アドレスは失敗枠を共有する（アドレスを変えても迂回できない）', async () => {
    const email = emailOf(STAFF.id);
    // 毎回違う IPv6 アドレスを使うが、すべて同じ /64。
    for (let i = 0; i < 20; i++) {
      const v6 = `2001:db8:aaaa:1:0:0:0:${(i + 1).toString(16)}`;
      expect((await verify(email, '000007', v6)).status, v6).toBe(401);
    }
    // 21 個目も同じ /64 なので上限に当たる。
    // 丸めが無いと 2^64 個のアドレスで永久に迂回できていた。
    expect((await verify(email, '000007', '2001:db8:aaaa:1:ffff::ffff')).status).toBe(429);

    const buckets = await testDb
      .prepare("SELECT bucket, count FROM auth_throttle WHERE bucket LIKE 'login_fail|2001:db8:aaaa:1%'")
      .all<{ bucket: string; count: number }>();
    // 失敗カウンタ + 通報ラッチの 2 本だけ（アドレスごとに増えていない）
    expect(buckets.results.map((b) => b.bucket).sort()).toEqual([
      'login_fail|2001:db8:aaaa:1::/64',
      'login_fail|2001:db8:aaaa:1::/64|alert',
    ]);
  });

  it('/64 が違えば別枠（モバイルの端末ごと割り当てで同僚が潰し合わない）', async () => {
    const email = emailOf(STAFF.id);
    for (let i = 0; i < 21; i++) {
      await verify(email, '000008', '2001:db8:bbbb:1::1');
    }
    expect((await verify(email, '000008', '2001:db8:bbbb:1::2')).status).toBe(429);
    // 隣の /64 は無傷
    expect((await verify(email, '000008', '2001:db8:bbbb:2::1')).status).toBe(401);
  });
});

describe('start / verify の応答が登録の有無で変わらないこと（列挙オラクル）', () => {
  const UNKNOWN = 'definitely-not-registered@example.test';

  it('verify: 上限に達するまでの回数と応答が登録済み/未登録で一致する', async () => {
    // 未登録アドレスでも失敗として加算されること。
    // 加算がスタッフ解決の後ろにあると「登録済みなら429・未登録なら401」で判別できてしまう。
    const IP_A = '198.51.100.60';
    const IP_B = '198.51.100.61';

    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 21; i++) known.push((await verify(emailOf(STAFF.id), '000009', IP_A)).status);
    for (let i = 0; i < 21; i++) unknown.push((await verify(UNKNOWN, '000009', IP_B)).status);

    expect(unknown).toEqual(known);
    expect(known[20]).toBe(429);
  });

  it('start: 上限に達するまでの回数と応答が登録済み/未登録で一致する', async () => {
    const IP_A = '198.51.100.70';
    const IP_B = '198.51.100.71';

    const known: number[] = [];
    const unknown: number[] = [];
    // 既定 ADMIN_LOGIN_ISSUE_MAX_PER_IP = 5
    for (let i = 0; i < 6; i++) known.push((await start(emailOf(STAFF.id), IP_A)).status);
    for (let i = 0; i < 6; i++) unknown.push((await start(UNKNOWN, IP_B)).status);

    expect(unknown).toEqual(known);
    expect(known[5]).toBe(429);
    // 未登録アドレスでも bucket は作られる（＝挙動が一致する）
    const row = await testDb
      .prepare("SELECT COUNT(*) AS n FROM auth_throttle WHERE bucket LIKE ?")
      .bind(`login_issue|${IP_B}|%`)
      .first<{ n: number }>();
    expect(row!.n).toBe(1);
  });

  it('start: 外枠（プレフィクスのみ）は宛先を変えても効く', async () => {
    const IP = '198.51.100.80';
    // 宛先を毎回変えると内側 (プレフィクス, 宛先) 枠には当たらないが、外枠には当たる。
    // 外枠が無いと、アドレスを変えるだけで auth_throttle の行を無限に作れる。
    //
    // ⚠️ 外枠はテスト用に 10 へ下げている（vitest.config.ts）。既定 100 のままだと
    //    先に middleware/rate-limit.ts の無認証枠（100 req/60s）が 429 を返し、
    //    外枠を無効化しても緑のままになる＝何も測っていないテストになる。
    let throttledAt: number | null = null;
    for (let i = 0; i < 14; i++) {
      const res = await start(`enum-${i}@example.test`, IP);
      if (res.status === 429) {
        throttledAt = i + 1;
        break;
      }
    }
    expect(throttledAt, '外枠 10 で止まる').toBe(11);

    // 行数が外枠で縛られていること（宛先ごとに 1 行ずつ・上限で打ち止め）。
    // 通報ラッチ（|alert）は宛先由来ではないので除いて数える。
    const rows = await testDb
      .prepare("SELECT COUNT(*) AS n FROM auth_throttle WHERE bucket LIKE ? AND bucket NOT LIKE '%|alert'")
      .bind(`login_issue|${IP}|%`)
      .first<{ n: number }>();
    expect(rows!.n, '宛先ごとの行は外枠で打ち止め').toBeLessThanOrEqual(10);

    // 外枠に当たったことは運用に見えている必要がある（通報ラッチが立つ）
    const latch = await testDb
      .prepare('SELECT count FROM auth_throttle WHERE bucket = ?')
      .bind(`login_issue|${IP}|alert`)
      .first<{ count: number }>();
    expect(latch?.count, '外枠到達は Slack 通報される').toBe(1);
  });
});
