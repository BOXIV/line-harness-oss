// vite.config.ts（@cloudflare/vite-plugin 入り）を vitest に継承させない専用設定。
// プラグインは wrangler 環境の検証を行うため、Node 上の vitest 起動時に落ちる。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
