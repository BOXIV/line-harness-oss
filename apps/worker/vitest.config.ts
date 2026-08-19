import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

/**
 * Worker のテスト設定（BOXIV）。
 *
 * 目的は「ロール × エンドポイント」の到達性を現在の挙動のまま固定すること。
 * 2026-08-15 に /api/friends/count へ認可を足した結果、それをログイン検証に
 * 使っていた撮影スタッフ 5 名が 3 日間ログイン不能になった。同種の事故を
 * デプロイ前に落とすためのゲートなので、実行は速さより網羅性を優先する。
 *
 * wrangler.toml は OSS upstream 名（line-harness）を持ち、deploy スクリプトが
 * BOXIV 版と swap する運用のため、ここでは configPath を参照せず
 * miniflare のバインディングを直接与える（swap の途中状態に影響されない）。
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './src/index.ts',
      // ⚠️ isolatedStorage オプションは **書かないこと**（@cloudflare/vitest-pool-workers 0.21.3）。
      //
      // 一度「状態共有を塞ぐ」つもりで書いたが、実測すると:
      //   - このバージョンの型・runtime のどちらにも isolatedStorage は**存在しない**
      //     （dist/pool/index.mjs / index.d.mts への出現が 0 回）。
      //     オプションスキーマは zod の $strip なので、書いても**黙って捨てられる**
      //   - `tsc -p tsconfig.test.json` は TS2353 で**赤になる**
      //   - そして **per-test/per-file のストレージ分離はプール組み込みで既に効いている**
      //     （test/vitest-config.test.ts の「ファイル間で D1 状態が漏れない」で実証済み）
      // 旧 `defineWorkersConfig` API の poolOptions.workers.isolatedStorage と混同したもの。
      // 書いても効果はゼロで、typecheck を壊すだけ。
      miniflare: {
        compatibilityDate: '2024-12-01',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: { DB: 'line-connect-vitest' },
        r2Buckets: ['IMAGES'],
        bindings: {
          // 実キーは一切使わない。env API_KEY 経路（env-owner）の検証用ダミー。
          API_KEY: 'test-env-owner-key',
          LINE_CHANNEL_SECRET: 'test-channel-secret',
          LINE_CHANNEL_ACCESS_TOKEN: 'test-channel-access-token',
          LIFF_URL: 'https://liff.example.test/0000-0000',
          LINE_CHANNEL_ID: '0000000000',
          LINE_LOGIN_CHANNEL_ID: '0000000001',
          LINE_LOGIN_CHANNEL_SECRET: 'test-login-secret',
          WORKER_URL: 'https://worker.example.test',
          // 発行の外枠上限をテスト用に下げる。既定 100 のままだと、先に
          // middleware/rate-limit.ts の無認証枠（100 req/60s・IP 単位）が 429 を返し、
          // 「外枠が効いた」ように見えて実際は別の層を測ってしまう
          // （実際に一度そのテストを書いてしまい、外枠を無効化しても緑のままだった）。
          ADMIN_LOGIN_ISSUE_MAX_PER_IP_TOTAL: '10',
          // パスワードの外枠は **本番と同じ既定値（50）で検証する**。
          // 一度テスト用に 12 へ下げたが、タイムアウトを 30 秒にした今は下げる必要が無い。
          // 上限を下げるほど「本番設定で本当に止まるか」の検証から離れるので、戻した。
        },
      },
    }),
  ],
  test: {
    // ⚠️ `test/` と `tests/` の**両方**を拾う。別ワークツリー（PR #91）が
    //    `apps/worker/tests/` を使っており、片方だけにするとマージ後に
    //    **そのスイートが静かに実行されなくなる**（緑に見えてゲートをすり抜ける）。
    //    ディレクトリを寄せる案もあるが、include を広げる方がマージ時の事故が少ない。
    include: ['test/**/*.test.ts', 'tests/**/*.test.ts'],
    setupFiles: ['./test/support/setup.ts'],
    // ⚠️ 既定の 5 秒では足りない。**スロットルのテストは 20〜40 回の直列リクエスト**を
    //    投げる（上限に達するまで叩く、という性質上どうしても回数が要る）。
    //    実 workerd + 実 D1 なので 1 往復が数十〜百 ms かかり、5 秒に間欠的に当たっていた。
    //
    //    これが「原因未特定のフレーク」の正体だった。当初は状態共有を疑って
    //    存在しないオプション（isolatedStorage）を足すという的外れな対応をしている。
    //    失敗メッセージ（`Test timed out in 5000ms`）を取るまで分からなかった。
    //
    //    上限をテスト用に下げる手もあるが、**下げるほど「本当にその上限で止まるか」の
    //    検証が本番設定から離れる**。時間を伸ばす方が素直。
    //    それでも足りなくなったら、まずテストの設計（毎回上限まで叩く必要があるか）を疑うこと。
    testTimeout: 30_000,
    hookTimeout: 30_000,

    // ⚠️ テストファイル間の並行実行を切る。**全ファイルが同じ D1 を共有している**ため。
    //
    // 具体的な衝突:
    //   - auth-email.test.ts と staff-auth.test.ts が beforeEach で
    //     `DELETE FROM auth_throttle` する。並行だと片方の掃除が
    //     もう片方の計測中カウンタを消し、スロットルのテストが偽の緑/赤になる
    //   - audit-log-degrade.test.ts は `ALTER TABLE audit_log DROP COLUMN actor_via` を
    //     一時的に実行する。並行だと他ファイルの監査ログ書き込みが劣化パスに落ちる
    //
    // 実際に「宛先を変え続けても外枠で頭打ちになる」が 1 回だけ落ち、
    // 直後の 5 回は緑という再現性のない失敗が出た。
    // **デプロイゲートが不安定なのは、ゲートが無いより悪い** —
    // 「落ちたら再実行」を学習させると、本物の失敗まで再実行で流される。
    // 実行時間は数秒なので、決定性を優先する。
    fileParallelism: false,
  },
});
