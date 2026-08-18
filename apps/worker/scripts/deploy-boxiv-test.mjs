#!/usr/bin/env node
/**
 * Deploy the Worker to BOXIV test env (line-connect-test on boxiv.workers.dev).
 *
 * Mirrors deploy-test.mjs (OSS line-harness-test) but for BOXIV's
 * line-connect-test resources. The OSS upstream script is left untouched so
 * upstream merges stay clean.
 *
 * Steps:
 *   1. Swap wrangler.toml ↔ wrangler.boxiv.toml (so vite build + the
 *      generated dist/<name>/wrangler.json carry BOXIV resource bindings)
 *   2. vite build
 *   3. Patch dist/line_connect/wrangler.json with the line-connect-test
 *      D1/R2/Worker name
 *   4. wrangler deploy --config <patched>
 *   5. Restore wrangler.toml
 *
 * Test resources (separate from production):
 *   - Worker name : line-connect-test
 *   - D1 database : line-connect-test (id: 37bf4b77-536b-418a-ab48-45c8950524c1)
 *   - R2 bucket   : line-connect-images-test
 *
 * Secrets are managed separately via:
 *   wrangler secret bulk <file.json> --name line-connect-test
 *
 * デプロイ前ゲート（BOXIV / 2026-08-18 追加）:
 *   wrangler deploy の前に必ず `vitest run` を通す。ロール × エンドポイントの
 *   到達性マトリクス（apps/worker/test/role-matrix.test.ts）が赤ならデプロイしない。
 *   2026-08-15 に /api/friends/count へ認可を足した変更が、そこでログイン検証して
 *   いた撮影スタッフ 5 名を 3 日間締め出した。あの変更はこのゲートで止まる。
 *   ⚠️ 緊急時にゲートを外す手段は「下の runWorkerTests() 呼び出しを消す」だけ。
 *      環境変数によるバイパスは意図的に用意していない。
 */
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotenv, requireEnv, parseEnvFile, REPO_ROOT } from '../../../../../scripts/dotenv.mjs';

loadDotenv();
requireEnv('VITE_LIFF_ID', 'LINE_CONNECT_TEST_D1_ID');

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(__dirname, '..');
const wranglerToml = resolve(workerDir, 'wrangler.toml');
const wranglerBoxiv = resolve(workerDir, 'wrangler.boxiv.toml');
const backup = resolve(workerDir, 'wrangler.toml.bak');

// vite-plugin generates dist/<name_with_underscores>/wrangler.json.
// Since wrangler.boxiv.toml has name="line-connect", the dir is line_connect.
const generated = resolve(workerDir, 'dist/line_connect/wrangler.json');
const patched = resolve(workerDir, 'dist/line_connect/wrangler.test.json');

const TEST_CONFIG = {
  name: 'line-connect-test',
  topLevelName: 'line-connect-test',
  d1_databases: [{
    binding: 'DB',
    database_name: 'line-connect-test',
    database_id: process.env.LINE_CONNECT_TEST_D1_ID,
  }],
  r2_buckets: [{
    binding: 'IMAGES',
    bucket_name: 'line-connect-images-test',
  }],
};

// テスト用 LIFF は .env.dev を優先して読む。.env の VITE_LIFF_ID は本番 LIFF
// （prod デプロイ用）なので、これを test ビルドに焼くと test が壊れる。
// .env.dev に無ければ process.env / .env へフォールバック。
const devEnv = parseEnvFile(resolve(REPO_ROOT, '.env.dev'));
const VITE_LIFF_ID = devEnv.VITE_LIFF_ID || process.env.VITE_LIFF_ID;

if (!existsSync(wranglerBoxiv)) {
  console.error('✗ wrangler.boxiv.toml not found at ' + wranglerBoxiv);
  process.exit(1);
}

// ── デプロイ前ゲート ──────────────────────────────────────────────────────────
// テストは wrangler.toml の swap より前に実行する。vitest は wrangler.toml を
// 読まない（vitest.config.ts が miniflare のバインディングを直接持つ）ので、
// swap の途中状態に左右されない。
function runWorkerTests() {
  console.log('▶ vitest run (デプロイ前ゲート: ロール × エンドポイント到達性)');
  execSync('pnpm exec vitest run', { cwd: workerDir, stdio: 'inherit' });
}

runWorkerTests();

let swapped = false;
try {
  console.log('▶ swap wrangler.toml → wrangler.boxiv.toml');
  renameSync(wranglerToml, backup);
  copyFileSync(wranglerBoxiv, wranglerToml);
  swapped = true;

  // line-sdk は dist 解決（vite は再ビルドしない）。src 変更を確実に反映するため
  // deploy 前に必ず dist を再ビルドする（怠ると古い dist が bundle される）。
  console.log('▶ build @line-crm/line-sdk (dist 再ビルド)');
  execSync('pnpm --filter @line-crm/line-sdk build', {
    cwd: workerDir,
    stdio: 'inherit',
  });

  console.log('▶ vite build (VITE_LIFF_ID=' + VITE_LIFF_ID + ')');
  execSync('pnpm exec vite build', {
    cwd: workerDir,
    stdio: 'inherit',
    env: { ...process.env, VITE_LIFF_ID },
  });

  console.log('▶ patching wrangler.json → wrangler.test.json (line-connect-test)');
  copyFileSync(generated, patched);
  const config = JSON.parse(readFileSync(patched, 'utf8'));
  Object.assign(config, TEST_CONFIG);
  writeFileSync(patched, JSON.stringify(config));

  console.log('▶ wrangler deploy (BOXIV test)');
  execSync(`pnpm exec wrangler deploy --config ${patched}`, {
    cwd: workerDir,
    stdio: 'inherit',
  });
} finally {
  if (swapped && existsSync(backup)) {
    console.log('▶ restore wrangler.toml');
    if (existsSync(wranglerToml)) unlinkSync(wranglerToml);
    renameSync(backup, wranglerToml);
  }
}
