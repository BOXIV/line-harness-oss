/**
 * vitest の include 設定そのものを検査する（BOXIV）。
 *
 * **なぜテストで設定を見るのか**: include から漏れたスイートは「落ちる」のではなく
 * **静かに実行されなくなる**。テストが 0 件でも vitest は緑を返すので、
 * デプロイゲートは通ってしまう。「ゲートが動いているのに何も検査していない」は
 * ゲートが無いより危険で、実際この案件で一度起きている
 * （外枠のテストが別レイヤーの制限を測っていて、対象を無効化しても緑のままだった）。
 *
 * ガード用の空ファイルを置く手もあるが、それは**消えたことに気づけない**。
 * 必ず実行される側（test/）から設定を読んで assert すれば、壊した瞬間に赤くなる。
 */
import { describe, expect, it } from 'vitest';
import configSource from '../vitest.config.ts?raw';

describe('vitest.config.ts', () => {
  it('test/ と tests/ の両方を include する', () => {
    const include = /include:\s*\[([^\]]*)\]/.exec(configSource)?.[1] ?? '';
    // 別ワークツリー（PR #91）が apps/worker/tests/ を使っている。
    // 片方だけにするとマージ後にそのスイートが静かに実行されなくなる。
    expect(include, 'test/**/*.test.ts が include に無い').toContain("'test/**/*.test.ts'");
    expect(include, 'tests/**/*.test.ts が include に無い（PR #91 のスイートが実行されなくなる）')
      .toContain("'tests/**/*.test.ts'");
  });

  it('テストファイル間の並行実行を切っている', () => {
    // 全ファイルが同じ D1 を共有しているため。並行だと
    // beforeEach の DELETE や ALTER TABLE が他ファイルの計測を壊し、
    // 再現性のない失敗（＝ゲートの信頼低下）になる。
    expect(configSource).toMatch(/fileParallelism:\s*false/);
  });

  it('テストファイル間で D1 の状態を分離している', () => {
    // fileParallelism: false は「順番に走る」だけで、状態は分離されない。
    // 順番に走ることと状態が分離されていることは別。
    expect(configSource).toMatch(/isolatedStorage:\s*true/);
  });

  it('workers ランタイムのプールを使っている（environment 指定と同居させない）', () => {
    // cloudflareTest() がランタイムを提供するので、environment: 'node' とは同居できない。
    // マージ時に「両方の設定を併記」しようとして壊れかけたので固定する。
    expect(configSource).toContain('cloudflareTest(');
    expect(configSource).not.toMatch(/environment:\s*'node'/);
  });
});
