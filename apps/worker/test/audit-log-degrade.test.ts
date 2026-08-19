/**
 * migration 919 未適用の DB に worker だけデプロイしたときの挙動（BOXIV）。
 *
 * recordAuditLog は actor_via / actor_session_id を書く。列が無いと INSERT が毎回落ちるが、
 * 呼び出し側（middleware/audit-log.boxiv.ts）は waitUntil + catch なので
 * **監査ログが全件・無言で欠落**する。証跡が丸ごと消えるより「2列欠けるが残る」ほうが
 * 常にましなので、列が無い環境では落として続行し、劣化したことをログに出す。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { recordAuditLog } from '@line-crm/db';
import { testDb } from './support/fixtures.js';

async function columns(): Promise<string[]> {
  const info = await testDb.prepare('PRAGMA table_info(audit_log)').all<{ name: string }>();
  return info.results.map((r) => r.name);
}

afterEach(async () => {
  // 列とインデックスを戻す（他のテストが actor_via を見ている）
  const cols = await columns();
  if (!cols.includes('actor_via')) {
    await testDb.prepare('ALTER TABLE audit_log ADD COLUMN actor_via TEXT').run();
  }
  if (!cols.includes('actor_session_id')) {
    await testDb.prepare('ALTER TABLE audit_log ADD COLUMN actor_session_id TEXT').run();
  }
  await testDb
    .prepare('CREATE INDEX IF NOT EXISTS idx_audit_log_actor_via ON audit_log (actor_via, created_at DESC)')
    .run();
});

describe('919 未適用でも監査ログが全件消えないこと', () => {
  it('actor_via が無い DB でも記録が残る（2列だけ欠ける）', async () => {
    await testDb.prepare('DELETE FROM audit_log').run();
    // 919 は actor_via にインデックスを張っているので、先に落とさないと列を消せない
    await testDb.prepare('DROP INDEX IF EXISTS idx_audit_log_actor_via').run();
    await testDb.prepare('ALTER TABLE audit_log DROP COLUMN actor_via').run();
    expect(await columns()).not.toContain('actor_via');

    await recordAuditLog(testDb, {
      actorId: 'test-owner',
      actorName: 'テストオーナー',
      actorRole: 'owner',
      action: 'probe.degrade',
      summary: '劣化確認',
      method: 'POST',
      path: '/probe',
      status: 200,
      actorVia: 'session',
    });

    const row = await testDb
      .prepare("SELECT action, actor_id FROM audit_log WHERE action = 'probe.degrade'")
      .first<{ action: string; actor_id: string }>();
    // 列が無くても行は残る。ここが null だと、証跡が丸ごと消えている。
    expect(row?.action).toBe('probe.degrade');
    expect(row?.actor_id).toBe('test-owner');
  });

  it('列が揃っていれば actor_via が入る', async () => {
    await testDb.prepare('DELETE FROM audit_log').run();
    await recordAuditLog(testDb, {
      actorId: 'test-owner',
      actorName: 'テストオーナー',
      actorRole: 'owner',
      action: 'probe.normal',
      summary: '通常',
      method: 'POST',
      path: '/probe',
      status: 200,
      actorVia: 'session',
    });
    const row = await testDb
      .prepare("SELECT actor_via FROM audit_log WHERE action = 'probe.normal'")
      .first<{ actor_via: string }>();
    expect(row?.actor_via).toBe('session');
  });
});
