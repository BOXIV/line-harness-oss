#!/usr/bin/env node
/**
 * Deploy the admin web app to the "test" Cloudflare Pages project.
 *
 * Architecture mirror of production:
 *   - Worker (API)        : line-harness-test.toshiki-o.workers.dev
 *   - Pages (Admin UI)    : line-harness-admin-test.pages.dev
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

const TEST_API_URL = 'https://line-harness-test.toshiki-o.workers.dev';
const PAGES_PROJECT = 'line-harness-admin-test';

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
execSync(
  `pnpm exec wrangler pages deploy out --project-name ${PAGES_PROJECT} --branch main --commit-dirty=true`,
  { cwd: webDir, stdio: 'inherit' }
);
