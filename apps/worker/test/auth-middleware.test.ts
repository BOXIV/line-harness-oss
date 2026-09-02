/**
 * 認証ミドルウェアの現状固定（BOXIV / Phase 1）。
 *
 * Phase 3 で `lhs_` セッションを authMiddleware の先頭に足すため、
 * 「既存 `lh_` キーが新分岐に吸い込まれないこと」「未知の `lhs_` が
 * 旧経路へフォールスルーしないこと」をここで先に固定しておく。
 */
import { describe, expect, it } from 'vitest';
import { createStaffSession } from '@line-crm/db';
import { ENV_API_KEY, INACTIVE_STAFF, STAFF_FIXTURES, request, testDb } from './support/fixtures.js';

const PROBE = '/api/staff/me';

describe('authMiddleware', () => {
  it('Authorization ヘッダが無ければ 401', async () => {
    const res = await request(PROBE);
    expect(res.status).toBe(401);
  });

  it('"Bearer " だけ（空トークン）は 401 — env API_KEY が空のときの env-owner 誤許可を塞ぐ', async () => {
    const res = await request(PROBE, '');
    expect(res.status).toBe(401);
  });

  it('未知のトークンは 401', async () => {
    const res = await request(PROBE, 'lh_ffffffffffffffffffffffffffffffff');
    expect(res.status).toBe(401);
  });

  it('未知の lhs_ トークンも 401（Phase 3 の新分岐が旧経路へフォールスルーしないこと）', async () => {
    const res = await request(PROBE, 'lhs_deadbeef.cafebabe');
    expect(res.status).toBe(401);
  });

  it('owner ロールの lh_ キーは staff_members として認証される', async () => {
    const res = await request(PROBE, STAFF_FIXTURES.owner.apiKey);
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { id: string; role: string } }>();
    expect(body.data.id).toBe(STAFF_FIXTURES.owner.id);
    expect(body.data.role).toBe('owner');
  });

  it('オーナー以外の lh_ キーは 401（2026-09-02 に移行期間を終了）', async () => {
    // 詳細と境界は api-key-login.test.ts。ここでは「認証の入口で落ちる」ことだけ固定する。
    const res = await request(PROBE, STAFF_FIXTURES.manager.apiKey);
    expect(res.status).toBe(401);
  });

  it('env API_KEY は env-owner として通る', async () => {
    const res = await request(PROBE, ENV_API_KEY);
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { id: string; role: string } }>();
    expect(body.data.id).toBe('env-owner');
    expect(body.data.role).toBe('owner');
  });

  it('is_active = 0 のスタッフのキーは 401', async () => {
    const res = await request(PROBE, INACTIVE_STAFF.apiKey);
    expect(res.status).toBe(401);
  });

  it('is_active を戻すとセッションで再び通る（在籍状態を毎回引き直している）', async () => {
    // 退職者の API キーは在籍を戻しても通らない（owner 以外は禁止）。
    // 「在籍状態を毎回引き直している」ことは、人間の入口＝セッションで確かめる。
    await testDb.prepare('UPDATE staff_members SET is_active = 1 WHERE id = ?')
      .bind(INACTIVE_STAFF.id)
      .run();
    try {
      const session = await createStaffSession(testDb, { staffId: INACTIVE_STAFF.id });
      expect((await request(PROBE, session.token)).status).toBe(200);
      await testDb.prepare('UPDATE staff_members SET is_active = 0 WHERE id = ?')
        .bind(INACTIVE_STAFF.id)
        .run();
      expect((await request(PROBE, session.token)).status).toBe(401);
    } finally {
      await testDb.prepare('UPDATE staff_members SET is_active = 0 WHERE id = ?')
        .bind(INACTIVE_STAFF.id)
        .run();
    }
  });

  it('認証をスキップする公開パスは 401 にならない（skip リストの現状固定）', async () => {
    for (const path of ['/openapi.json', '/docs']) {
      const res = await request(path);
      expect(res.status, path).toBe(200);
    }
  });

  it('管理 API は無認証だと 401（skip リストが前方一致で広がっていないこと）', async () => {
    for (const path of ['/api/friends/count', '/api/staff', '/api/templates']) {
      const res = await request(path);
      expect(res.status, path).toBe(401);
    }
  });
});
