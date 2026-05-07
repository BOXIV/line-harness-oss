#!/usr/bin/env node
/**
 * Deploy the admin web app to the BOXIV "test" Cloudflare Pages project.
 *
 * Architecture mirror of BOXIV production:
 *   - Worker (API)        : line-connect-test.boxiv.workers.dev
 *   - Pages (Admin UI)    : line-connect-admin-test.pages.dev
 *
 * Mirrors deploy-test.mjs (OSS line-harness) but targets BOXIV resources;
 * the OSS upstream script is left untouched so upstream merges stay clean.
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
execSync(
  `pnpm exec wrangler pages deploy out --project-name ${PAGES_PROJECT} --branch main --commit-dirty=true --commit-message "deploy: line-connect-admin-test"`,
  { cwd: webDir, stdio: 'inherit' }
);
