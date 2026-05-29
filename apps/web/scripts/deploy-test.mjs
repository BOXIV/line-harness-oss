#!/usr/bin/env node
/**
 * Deploy the admin web app to the "test" Cloudflare Pages project.
 *
 * Architecture mirror of production (BOXIV):
 *   - Worker (API)        : line-connect-test.boxiv.workers.dev
 *   - Pages (Admin UI)    : line-connect-admin-test.pages.dev
 *
 * What this does:
 *   1. Builds Next.js with NEXT_PUBLIC_API_URL pointed at the test Worker
 *      (ignores .env.production which points at the prod Worker)
 *   2. Ensures the Pages project exists (creates it idempotently)
 *   3. Uploads out/ to Pages
 *
 * Why a custom script: `.env.production` is baked into the bundle at build
 * time, so we must override NEXT_PUBLIC_API_URL via process env before
 * running `next build`. A dedicated script keeps the prod deploy path
 * untouched.
 */
import { execSync, spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(__dirname, '..');

const TEST_API_URL = 'https://line-connect-test.boxiv.workers.dev';
const PAGES_PROJECT = 'line-connect-admin-test';

console.log('▶ next build (NEXT_PUBLIC_API_URL=' + TEST_API_URL + ')');
execSync('pnpm exec next build', {
  cwd: webDir,
  stdio: 'inherit',
  env: { ...process.env, NEXT_PUBLIC_API_URL: TEST_API_URL },
});

console.log('▶ ensuring Pages project exists: ' + PAGES_PROJECT);
const createRes = spawnSync(
  'pnpm',
  ['exec', 'wrangler', 'pages', 'project', 'create', PAGES_PROJECT, '--production-branch', 'main'],
  { cwd: webDir, encoding: 'utf8' }
);
if (createRes.status !== 0) {
  const stderr = createRes.stderr || '';
  if (/already exists/i.test(stderr) || /already in use/i.test(stderr)) {
    console.log('  (project already exists, continuing)');
  } else {
    console.error(stderr);
    process.exit(createRes.status || 1);
  }
} else {
  console.log(createRes.stdout);
}

console.log('▶ wrangler pages deploy');
// --commit-message を明示しないと、wrangler が git の直近コミットメッセージを推定して読み、
// 非 ASCII（日本語/絵文字）混在時に Cloudflare API が "Invalid commit message ... UTF-8" を返すことがある。
execSync(
  `pnpm exec wrangler pages deploy out --project-name ${PAGES_PROJECT} --branch main --commit-dirty=true --commit-message "boxiv test deploy"`,
  { cwd: webDir, stdio: 'inherit' }
);
