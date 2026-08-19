/**
 * テストファイル間で D1 の状態が漏れないことを **実挙動で** 確かめる（BOXIV）。
 *
 * なぜ設定の文字列検査では足りないか:
 * 一度 `isolatedStorage: true` を書いて「塞いだ」と判断し、
 * 「その文字列が config にあること」をテストで固定した。しかし実測すると
 * このオプションは pool 0.21.3 の型にも runtime にも存在せず（出現 0 回）、
 * オプションスキーマが zod の $strip なので **黙って捨てられていた**。
 * つまり「緑のテストが、何も保証していない設定を守っていた」。
 *
 * 設定ではなく**結果**を見る。分離が壊れたらここが落ちる。
 */
import { describe, expect, it } from 'vitest';
import { testDb } from './support/fixtures.js';

const PROBE = 'ISOLATION_PROBE_FROM_isolation_test';

describe('テストファイル間のストレージ分離', () => {
  it('他ファイルが入れた行が見えない（＝分離が効いている）', async () => {
    // 他のどのファイルも auth_throttle に自由に書き、beforeEach で DELETE している。
    // それらがこのファイルへ漏れないことが、全テストの前提になっている。
    const leaked = await testDb
      .prepare("SELECT COUNT(*) AS n FROM auth_throttle WHERE bucket LIKE 'ISOLATION_PROBE%'")
      .first<{ n: number }>();
    expect(leaked!.n, '他ファイルの行が見えている＝分離が壊れた').toBe(0);
  });

  it('このファイルで書いた行は、このファイル内では見える', async () => {
    // 分離が「常に空を返す」わけではないことの対照確認。
    await testDb
      .prepare(
        "INSERT OR REPLACE INTO auth_throttle (bucket, count, window_started_at, updated_at) VALUES (?, 1, '2026-01-01', '2026-01-01')",
      )
      .bind(PROBE)
      .run();
    const row = await testDb
      .prepare('SELECT count FROM auth_throttle WHERE bucket = ?')
      .bind(PROBE)
      .first<{ count: number }>();
    expect(row?.count).toBe(1);
  });

  it('seed されたスタッフは各ファイルで見える（setupFiles がファイルごとに走る）', async () => {
    const row = await testDb
      .prepare('SELECT COUNT(*) AS n FROM staff_members')
      .first<{ n: number }>();
    expect(row!.n).toBeGreaterThanOrEqual(5);
  });
});
