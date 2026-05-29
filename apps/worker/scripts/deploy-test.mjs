#!/usr/bin/env node
/**
 * Deploy the Worker to the "test" environment.
 *
 * Why this script exists:
 *   @cloudflare/vite-plugin generates dist/line_harness/wrangler.json at build
 *   time and ignores [env.*] sections in wrangler.toml. To deploy a separate
 *   test Worker (line-harness-test) we patch the generated config in-place
 *   and call `wrangler deploy --config <patched>`.
 *
 * Test resources (BOXIV; separate from production line-connect):
 *   - Worker name : line-connect-test
 *   - D1 database : line-connect-test (id 37bf4b77-536b-418a-ab48-45c8950524c1)
 *   - R2 bucket   : line-connect-images-test
 *
 * Secrets are managed separately via:
 *   wrangler secret bulk <file.json> --name line-connect-test
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(__dirname, '..');
const generated = resolve(workerDir, 'dist/line_harness/wrangler.json');
const patched = resolve(workerDir, 'dist/line_harness/wrangler.test.json');

const TEST_CONFIG = {
  name: 'line-connect-test',
  topLevelName: 'line-connect-test',
  d1_databases: [{
    binding: 'DB',
    database_name: 'line-connect-test',
    database_id: '37bf4b77-536b-418a-ab48-45c8950524c1',
  }],
  r2_buckets: [{
    binding: 'IMAGES',
    bucket_name: 'line-connect-images-test',
  }],
};

// LIFF ID is baked into the SPA bundle at build time via Vite's import.meta.env.
// The SPA at apps/worker/src/client/main.ts reads VITE_LIFF_ID and crashes at
// module load if it's missing — leaving the user stuck on the loading spinner.
const VITE_LIFF_ID = '2009711299-7Q3ADQuZ';

console.log('▶ vite build (VITE_LIFF_ID=' + VITE_LIFF_ID + ')');
execSync('pnpm exec vite build', {
  cwd: workerDir,
  stdio: 'inherit',
  env: { ...process.env, VITE_LIFF_ID },
});

console.log('▶ patching wrangler.json → wrangler.test.json');
copyFileSync(generated, patched);
const config = JSON.parse(readFileSync(patched, 'utf8'));
Object.assign(config, TEST_CONFIG);
writeFileSync(patched, JSON.stringify(config));

console.log('▶ wrangler deploy (test)');
execSync(`pnpm exec wrangler deploy --config ${patched}`, {
  cwd: workerDir,
  stdio: 'inherit',
});
