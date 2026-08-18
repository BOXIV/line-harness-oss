/**
 * ログインコードメールの送信ペイロード（BOXIV）。
 *
 * 実受信したメールで、本文のログインリンクが
 *   https://u########.ct.sendgrid.net/ls/click?upn=…
 * に書き換えられていた（SendGrid のクリックトラッキングがアカウント既定で有効）。
 * 認証メールでこれが起きると:
 *   1. 認証メールがフィッシングそのものの見た目になる
 *   2. 送信ドメインと違うドメインへのリンクが迷惑メール判定の材料になる
 *   3. **6 桁コード入りの URL** が第三者(SendGrid)のクリック計測に記録される
 * 送信単位で切っていることをここで固定する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendLoginCodeEmail, notifyStaffEmailChanged } from '../src/services/staff-auth-email.boxiv.js';

const ENV = {
  SENDGRID_API_KEY: 'SG.test-key',
  SENDGRID_FROM_EMAIL: 'noreply-lightning@example.test',
  SENDGRID_FROM_NAME: 'BOXIV Lightning',
};

let sent: Array<{ url: string; body: any }> = [];

beforeEach(() => {
  sent = [];
  vi.stubGlobal('fetch', async (input: any, init: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('api.sendgrid.com')) {
      sent.push({ url, body: JSON.parse(init.body) });
      return new Response('', { status: 202 });
    }
    return new Response('', { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ログインコードメール', () => {
  it('トラッキングを送信単位で無効化している（リンクが ct.sendgrid.net へ書き換わらない）', async () => {
    const res = await sendLoginCodeEmail(ENV, {
      to: 'someone@example.test',
      staffName: 'テスト',
      code: '123456',
      ttlMinutes: 10,
      loginUrl: 'https://admin.example.test/login?email=someone%40example.test&code=123456',
    });
    expect(res.ok).toBe(true);
    expect(sent).toHaveLength(1);

    const t = sent[0]!.body.tracking_settings;
    expect(t, 'tracking_settings が付いていない＝アカウント既定でリンクが書き換わる').toBeDefined();
    // enable だけでは足りない。テキスト本文の URL は enable_text 側で書き換えられる。
    expect(t.click_tracking).toEqual({ enable: false, enable_text: false });
    expect(t.open_tracking).toEqual({ enable: false });
  });

  it('本文はコードが主・リンクが従（リンクは開くだけでは消費されない旨を明記）', async () => {
    await sendLoginCodeEmail(ENV, {
      to: 'someone@example.test',
      staffName: 'テスト',
      code: '123456',
      ttlMinutes: 10,
      loginUrl: 'https://admin.example.test/login?email=x&code=123456',
    });
    const text: string = sent[0]!.body.content.find((c: any) => c.type === 'text/plain').value;
    // コードが本文の先頭側、リンクはその後
    expect(text.indexOf('123456')).toBeLessThan(text.indexOf('https://admin.example.test'));
    expect(text).toContain('開くだけでは');
    expect(sent[0]!.body.subject).toContain('123456');
  });

  it('リンクが無い構成（ADMIN_BASE_URL 未設定）でも送れる', async () => {
    await sendLoginCodeEmail(ENV, {
      to: 'someone@example.test',
      staffName: 'テスト',
      code: '123456',
      ttlMinutes: 10,
      loginUrl: null,
    });
    const text: string = sent[0]!.body.content.find((c: any) => c.type === 'text/plain').value;
    expect(text).toContain('123456');
    expect(text).not.toContain('http');
  });
});

describe('メールアドレス変更の通知', () => {
  it('旧アドレス宛に送り、トラッキングは無効', async () => {
    await notifyStaffEmailChanged(ENV, {
      oldEmail: 'old@example.test',
      newEmail: 'new@example.test',
      staffName: 'テスト',
      actorName: 'オーナー',
    });
    expect(sent[0]!.body.personalizations[0].to[0].email).toBe('old@example.test');
    expect(sent[0]!.body.tracking_settings.click_tracking.enable).toBe(false);
  });
});
