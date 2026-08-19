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

  it('タイムアウトを既定の 5 秒より延ばしている', () => {
    // スロットルのテストは上限に達するまで 20〜40 回叩く。実 workerd + 実 D1 では
    // 5 秒に間欠的に当たり、**再現性のない失敗**になる。実際それが起きた。
    const m = /testTimeout:\s*([\d_]+)/.exec(configSource);
    expect(m, 'testTimeout が設定されていない').not.toBeNull();
    expect(Number(m![1].replace(/_/g, '')), '5 秒では足りない').toBeGreaterThanOrEqual(20_000);
  });

  it('isolatedStorage オプションを書いていない（0.21.3 には存在せず typecheck が壊れる）', () => {
    // 「設定文字列があること」を検査するテストは、その設定が**実際に効いているか**を
    // 一切保証しない。実際 isolatedStorage は型にも runtime にも存在せず、
    // 書いても黙って捨てられる一方で typecheck だけが赤くなっていた。
    // 分離が効いているかは下の実挙動テスト（isolation.test.ts）で直接確かめる。
    // コメントで言及するのは可（経緯を残すため）。**設定として書かれていない**ことを見る。
    expect(configSource).not.toMatch(/^\s*isolatedStorage\s*:/m);
  });

  it('workers ランタイムのプールを使っている（environment 指定と同居させない）', () => {
    // cloudflareTest() がランタイムを提供するので、environment: 'node' とは同居できない。
    // マージ時に「両方の設定を併記」しようとして壊れかけたので固定する。
    expect(configSource).toContain('cloudflareTest(');
    expect(configSource).not.toMatch(/environment:\s*'node'/);
  });
});
