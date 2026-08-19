/**
 * メール認証コード / セッションの中核ロジック（BOXIV / Phase 2）。
 *
 * ここが破れると管理画面が丸ごと開くので、総当たり・使い回し・失効の3点を重点的に固定する。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createLoginChallenge,
  createStaffSession,
  emailTakenByOther,
  findActiveStaffByEmail,
  generateLoginCode,
  invalidateLoginChallenges,
  isValidEmail,
  listStaffSessions,
  normalizeEmail,
  parseSessionToken,
  resolveStaffSession,
  revokeAllStaffSessions,
  revokeStaffSession,
  touchStaffSession,
  verifyAndConsumeLoginCode,
} from '@line-crm/db';
import { STAFF_FIXTURES, testDb } from './support/fixtures.js';

const STAFF_ID = STAFF_FIXTURES.staff.id;
const STAFF_EMAIL = `${STAFF_FIXTURES.staff.id}@example.test`;

beforeEach(async () => {
  await testDb.prepare('DELETE FROM staff_login_challenges').run();
  await testDb.prepare('DELETE FROM staff_sessions').run();
});

describe('generateLoginCode', () => {
  it('常に 6 桁の数字（先頭 0 も許す）', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateLoginCode()).toMatch(/^\d{6}$/);
    }
  });
});

describe('isValidEmail / normalizeEmail', () => {
  it('実在ドメイン 4 種（今回の 9 名が使うもの）を通す', () => {
    for (const e of [
      'a@boxiv.co.jp',
      'a.b+tag@gmail.com',
      'a_b@hiteras.co.jp',
      'a-b@outlook.jp',
    ]) {
      expect(isValidEmail(e), e).toBe(true);
    }
  });

  it('区切り文字を含むものを弾く（ヘッダインジェクション / 複数宛先化の防止）', () => {
    for (const e of ['a@b.com,c@d.com', 'a@b.com;c@d.com', 'a <b@c.com>', 'a b@c.com', 'a@b']) {
      expect(isValidEmail(e), e).toBe(false);
    }
  });

  it('正規化は trim + 小文字化まで。ドットや +タグは潰さない（別人に当たるため）', () => {
    expect(normalizeEmail('  A.B+x@Example.COM ')).toBe('a.b+x@example.com');
  });
});

describe('ログインコードの検証', () => {
  it('正しいコードは 1 回だけ通る（使い回し不可）', async () => {
    const { code } = await createLoginChallenge(testDb, { staffId: STAFF_ID, email: STAFF_EMAIL });

    const first = await verifyAndConsumeLoginCode(testDb, STAFF_ID, code);
    expect(first.ok).toBe(true);

    const second = await verifyAndConsumeLoginCode(testDb, STAFF_ID, code);
    expect(second).toEqual({ ok: false, reason: 'no_challenge' });
  });

  it('コードが無ければ no_challenge', async () => {
    const res = await verifyAndConsumeLoginCode(testDb, STAFF_ID, '000000');
    expect(res).toEqual({ ok: false, reason: 'no_challenge' });
  });

  it('間違いを重ねると max_attempts で locked になり、正しいコードでも通らない', async () => {
    const { code } = await createLoginChallenge(testDb, {
      staffId: STAFF_ID,
      email: STAFF_EMAIL,
      maxAttempts: 3,
    });
    const wrong = code === '999999' ? '111111' : '999999';

    for (let i = 0; i < 3; i++) {
      expect(await verifyAndConsumeLoginCode(testDb, STAFF_ID, wrong)).toEqual({
        ok: false,
        reason: 'invalid',
      });
    }
    expect(await verifyAndConsumeLoginCode(testDb, STAFF_ID, wrong)).toEqual({
      ok: false,
      reason: 'locked',
    });
    expect(await verifyAndConsumeLoginCode(testDb, STAFF_ID, code)).toEqual({
      ok: false,
      reason: 'locked',
    });
  });

  it('コードを発行し直しても試行回数はリセットされない（発行連打で総当たりを稼げない）', async () => {
    const first = await createLoginChallenge(testDb, {
      staffId: STAFF_ID,
      email: STAFF_EMAIL,
      maxAttempts: 3,
    });
    const wrong = first.code === '999999' ? '111111' : '999999';
    await verifyAndConsumeLoginCode(testDb, STAFF_ID, wrong);
    await verifyAndConsumeLoginCode(testDb, STAFF_ID, wrong);

    // ここで再発行。新しい行の attempts は 0 だが、失敗加算は生きている全チャレンジに効く。
    const second = await createLoginChallenge(testDb, {
      staffId: STAFF_ID,
      email: STAFF_EMAIL,
      maxAttempts: 3,
    });
    const wrong2 = second.code === '888888' ? '222222' : '888888';
    expect(await verifyAndConsumeLoginCode(testDb, STAFF_ID, wrong2)).toEqual({
      ok: false,
      reason: 'invalid',
    });

    const rows = await testDb
      .prepare('SELECT id, attempts FROM staff_login_challenges WHERE staff_id = ?')
      .bind(STAFF_ID)
      .all<{ id: string; attempts: number }>();
    // 1 本目は 3 回（=上限）に達し、2 本目も巻き添えで 1 回消費している。
    expect(rows.results.map((r) => r.attempts).sort()).toEqual([1, 3]);
  });

  it('期限切れのコードは no_challenge（試行回数も消費しない）', async () => {
    const { id, code } = await createLoginChallenge(testDb, {
      staffId: STAFF_ID,
      email: STAFF_EMAIL,
    });
    await testDb
      .prepare("UPDATE staff_login_challenges SET expires_at = '2000-01-01T00:00:00.000+09:00' WHERE id = ?")
      .bind(id)
      .run();

    expect(await verifyAndConsumeLoginCode(testDb, STAFF_ID, code)).toEqual({
      ok: false,
      reason: 'no_challenge',
    });
  });

  it('別スタッフのコードでは通らない', async () => {
    const { code } = await createLoginChallenge(testDb, { staffId: STAFF_ID, email: STAFF_EMAIL });
    const res = await verifyAndConsumeLoginCode(testDb, STAFF_FIXTURES.manager.id, code);
    expect(res).toEqual({ ok: false, reason: 'no_challenge' });
  });

  it('平文コードは DB に残らない', async () => {
    const { code } = await createLoginChallenge(testDb, { staffId: STAFF_ID, email: STAFF_EMAIL });
    const row = await testDb
      .prepare('SELECT code_hash FROM staff_login_challenges WHERE staff_id = ?')
      .bind(STAFF_ID)
      .first<{ code_hash: string }>();
    expect(row!.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.code_hash).not.toContain(code);
  });

  it('同じコード文字列でも行が違えばハッシュが違う（総当たり表で全行を逆引きできない）', async () => {
    // 同一コードを 2 行に仕込んで、ハッシュが一致しないことを確認する。
    const a = await createLoginChallenge(testDb, { staffId: STAFF_ID, email: STAFF_EMAIL });
    const b = await createLoginChallenge(testDb, { staffId: STAFF_ID, email: STAFF_EMAIL });
    const rows = await testDb
      .prepare('SELECT id, code_hash FROM staff_login_challenges WHERE id IN (?, ?)')
      .bind(a.id, b.id)
      .all<{ id: string; code_hash: string }>();
    if (a.code === b.code) {
      expect(rows.results[0]!.code_hash).not.toBe(rows.results[1]!.code_hash);
    }
    expect(rows.results).toHaveLength(2);
  });

  it('invalidateLoginChallenges で未使用コードが全て無効になる', async () => {
    const { code } = await createLoginChallenge(testDb, { staffId: STAFF_ID, email: STAFF_EMAIL });
    await invalidateLoginChallenges(testDb, STAFF_ID);
    expect(await verifyAndConsumeLoginCode(testDb, STAFF_ID, code)).toEqual({
      ok: false,
      reason: 'no_challenge',
    });
  });
});

describe('セッション', () => {
  it('lhs_<id>.<secret> の形で発行され、平文は DB に残らない', async () => {
    const { id, token } = await createStaffSession(testDb, { staffId: STAFF_ID });
    expect(token).toMatch(/^lhs_[0-9a-f]{32}\.[0-9a-f]{64}$/);
    expect(parseSessionToken(token)).toMatchObject({ id });

    const row = await testDb
      .prepare('SELECT secret_hash FROM staff_sessions WHERE id = ?')
      .bind(id)
      .first<{ secret_hash: string }>();
    expect(row!.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toContain(row!.secret_hash);
  });

  it('parseSessionToken は形式外を弾く', () => {
    for (const t of [
      'lh_00000000000000000000000000000001', // 既存 API キー
      'lhs_',
      'lhs_abc',
      'lhs_.secret',
      'lhs_abc.',
      'lhs_ZZZ.abc', // hex 以外
      'bearer lhs_a.b',
    ]) {
      expect(parseSessionToken(t), t).toBeNull();
    }
  });

  it('解決すると staff が付いてくる', async () => {
    const { token } = await createStaffSession(testDb, { staffId: STAFF_ID });
    const resolved = await resolveStaffSession(testDb, token);
    expect(resolved?.staff.id).toBe(STAFF_ID);
    expect(resolved?.staff.role).toBe('staff');
  });

  it('secret が 1 文字違うだけで解決しない', async () => {
    const { token } = await createStaffSession(testDb, { staffId: STAFF_ID });
    const broken = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    expect(await resolveStaffSession(testDb, broken)).toBeNull();
  });

  it('ロール変更が次の解決で即座に反映される（毎回引き直している）', async () => {
    const { token } = await createStaffSession(testDb, { staffId: STAFF_ID });
    expect((await resolveStaffSession(testDb, token))?.staff.role).toBe('staff');

    await testDb.prepare("UPDATE staff_members SET role = 'manager' WHERE id = ?").bind(STAFF_ID).run();
    try {
      expect((await resolveStaffSession(testDb, token))?.staff.role).toBe('manager');
    } finally {
      await testDb.prepare("UPDATE staff_members SET role = 'staff' WHERE id = ?").bind(STAFF_ID).run();
    }
  });

  it('is_active = 0 にすると次の解決で落ちる（無効化の即時反映）', async () => {
    const { token } = await createStaffSession(testDb, { staffId: STAFF_ID });
    await testDb.prepare('UPDATE staff_members SET is_active = 0 WHERE id = ?').bind(STAFF_ID).run();
    try {
      expect(await resolveStaffSession(testDb, token)).toBeNull();
    } finally {
      await testDb.prepare('UPDATE staff_members SET is_active = 1 WHERE id = ?').bind(STAFF_ID).run();
    }
  });

  it('失効させると解決しない', async () => {
    const { id, token } = await createStaffSession(testDb, { staffId: STAFF_ID });
    expect(await revokeStaffSession(testDb, id, 'logout')).toBe(1);
    expect(await resolveStaffSession(testDb, token)).toBeNull();
    // 二重失効は 0 件（理由の上書きをしない）
    expect(await revokeStaffSession(testDb, id, 'admin')).toBe(0);
  });

  it('期限切れは解決しない', async () => {
    const { id, token } = await createStaffSession(testDb, { staffId: STAFF_ID });
    await testDb
      .prepare("UPDATE staff_sessions SET expires_at = '2000-01-01T00:00:00.000+09:00' WHERE id = ?")
      .bind(id)
      .run();
    expect(await resolveStaffSession(testDb, token)).toBeNull();
  });

  it('revokeAllStaffSessions は生きている分だけ失効させる', async () => {
    await createStaffSession(testDb, { staffId: STAFF_ID });
    await createStaffSession(testDb, { staffId: STAFF_ID });
    const one = await createStaffSession(testDb, { staffId: STAFF_ID });
    await revokeStaffSession(testDb, one.id, 'logout');

    expect(await revokeAllStaffSessions(testDb, STAFF_ID, 'staff_disabled')).toBe(2);
    expect(await listStaffSessions(testDb, STAFF_ID)).toHaveLength(0);
  });

  it('touchStaffSession は間隔を空けたときだけ書く', async () => {
    const { id } = await createStaffSession(testDb, { staffId: STAFF_ID });

    await touchStaffSession(testDb, id, null);
    const first = await testDb
      .prepare('SELECT last_used_at FROM staff_sessions WHERE id = ?')
      .bind(id)
      .first<{ last_used_at: string }>();
    expect(first!.last_used_at).not.toBeNull();

    // 直近に使ったばかりなら書かない
    await touchStaffSession(testDb, id, first!.last_used_at);
    const second = await testDb
      .prepare('SELECT last_used_at FROM staff_sessions WHERE id = ?')
      .bind(id)
      .first<{ last_used_at: string }>();
    expect(second!.last_used_at).toBe(first!.last_used_at);
  });
});

describe('findActiveStaffByEmail', () => {
  it('大文字小文字と前後空白を無視して引ける', async () => {
    const found = await findActiveStaffByEmail(testDb, `  ${STAFF_EMAIL.toUpperCase()}  `);
    expect(found?.id).toBe(STAFF_ID);
  });

  it('無効化されたスタッフは引けない', async () => {
    expect(await findActiveStaffByEmail(testDb, 'test-inactive@example.test')).toBeNull();
  });

  it('同じアドレスが 2 人にあると null（どちらの権限で通すか決められないので入口を閉じる）', async () => {
    await testDb
      .prepare('UPDATE staff_members SET email = ? WHERE id = ?')
      .bind(STAFF_EMAIL, STAFF_FIXTURES.admin.id)
      .run();
    try {
      expect(await findActiveStaffByEmail(testDb, STAFF_EMAIL)).toBeNull();
    } finally {
      await testDb
        .prepare('UPDATE staff_members SET email = ? WHERE id = ?')
        .bind(`${STAFF_FIXTURES.admin.id}@example.test`, STAFF_FIXTURES.admin.id)
        .run();
    }
  });

  it('存在しないアドレスは null', async () => {
    expect(await findActiveStaffByEmail(testDb, 'nobody@example.test')).toBeNull();
  });
});

describe('emailTakenByOther', () => {
  it('自分自身は重複扱いしない', async () => {
    expect(await emailTakenByOther(testDb, STAFF_EMAIL, STAFF_ID)).toBe(false);
    expect(await emailTakenByOther(testDb, STAFF_EMAIL, null)).toBe(true);
  });
});
