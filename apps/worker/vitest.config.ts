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
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/support/setup.ts'],
  },
});
