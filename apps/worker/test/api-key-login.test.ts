/**
 * API キー認証の終了（BOXIV / 2026-09-02）。
 *
 * 移行期間中は staff_members.api_key を貼れば誰でも管理画面に入れたが、
 * キーは配布時点でしか本人性を確認できず、失効も再発行という手作業しかない。
 * 人間の入口はメールログイン（`lhs_` セッション。毎リクエスト staff_members を
 * 引き直すので無効化が即効く）に一本化した。
 *
 * ここで固定するのは 3 つ:
 *  1. **オーナー以外のキーは管理 API を一切通らない**（ロールで漏れが出ないよう全ロール試す）
 *  2. **オーナーの入口は残る** — env API_KEY はメール配信が止まったときの最後の入口で、
 *     env-owner にはメールアドレスが無いため、ここを塞ぐと復旧経路ごと消える
 *  3. **ログイン画面（POST /api/auth/password）も同じ判定** — 認証だけ塞いでログインが
 *     通ると「入れたのに次の操作から全部 401」になり、原因不明の不具合に見える
 */
import { describe, expect, it } from 'vitest';
import {
  ENV_API_KEY,
  INACTIVE_STAFF,
  STAFF_FIXTURES,
  request,
  requestAs,
  requestWithApiKey,
} from './support/fixtures.js';

const PROBE = '/api/staff/me';
const NON_OWNER = ['admin', 'manager', 'staff'] as const;

function passwordLogin(email: string, password: string) {
  return request('/api/auth/password', null, {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

describe('API キー認証 — オーナー以外は拒否', () => {
  for (const role of NON_OWNER) {
    it(`${role} の API キーは管理 API を通らない`, async () => {
      const res = await requestWithApiKey(role, PROBE);
      expect(res.status).toBe(401);
    });
  }

  it('拒否の文言は次の行動を書く（締め出しに見えると問い合わせになる）', async () => {
    const res = await requestWithApiKey('manager', PROBE);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain('メールアドレス');
    expect(body.error).toContain('6桁コード');
  });

  it('読み取りだけの GET でも通らない（メソッドで抜けない）', async () => {
    for (const path of ['/api/chats', '/api/friends', '/api/templates']) {
      const res = await requestWithApiKey('manager', path);
      expect(res.status, path).toBe(401);
    }
  });

  it('ログイン画面（/api/auth/password）でも同じ判定で弾く', async () => {
    const res = await passwordLogin(
      `${STAFF_FIXTURES.manager.id}@example.test`,
      STAFF_FIXTURES.manager.apiKey,
    );
    expect(res.status).toBe(401);
  });
});

describe('オーナーの入口は残る', () => {
  it('owner ロールの API キーは通る', async () => {
    const res = await requestWithApiKey('owner', PROBE);
    expect(res.status).toBe(200);
  });

  it('env API_KEY は env-owner として通る（メール不達時の最後の入口）', async () => {
    const res = await request(PROBE, ENV_API_KEY);
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { id: string; role: string } }>();
    expect(body.data).toMatchObject({ id: 'env-owner', role: 'owner' });
  });

  it('無効化されたスタッフのキーは owner でなくても owner でも通らない', async () => {
    // INACTIVE_STAFF は role=staff。在籍していない人はどちらの理由でも入れない。
    expect((await request(PROBE, INACTIVE_STAFF.apiKey)).status).toBe(401);
  });
});

describe('人間の入口＝メールログインのセッション', () => {
  for (const role of ['owner', 'admin', 'manager', 'staff'] as const) {
    it(`${role} はセッションで通る`, async () => {
      const res = await requestAs(role, PROBE);
      expect(res.status).toBe(200);
      const body = await res.json<{ data: { id: string; role: string } }>();
      expect(body.data).toMatchObject({ id: STAFF_FIXTURES[role].id, role });
    });
  }
});
