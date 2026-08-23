#!/usr/bin/env node
/**
 * Deploy the admin web app to BOXIV PRODUCTION Cloudflare Pages.
 *
 *   - Worker (API)        : line-connect.boxiv.workers.dev
 *   - Pages (Admin UI)    : line-connect-admin.pages.dev
 *
 * Mirrors deploy-boxiv-test.mjs but targets prod resources. The OSS upstream
 * scripts are left untouched so upstream merges stay clean.
 */
import { execSync, spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotenv, requireEnv } from '../../../../../scripts/dotenv.mjs';

// ⚠️ env を明示する（worker 側 deploy-boxiv.mjs と同じ理由）。
loadDotenv({ env: 'prod' });
requireEnv('LINE_HARNESS_API_URL');

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(__dirname, '..');

const PROD_API_URL = process.env.LINE_HARNESS_API_URL;
const PAGES_PROJECT = 'line-connect-admin';

// ── デプロイ前ゲート ──────────────────────────────────────────────────────────
// 認証の戻り先検証（safeNextPath）のように、文字列判定を 1 文字間違えると
// 外部サイトへ飛ばせる種類のロジックが web 側にもある。実際 safeNextPath は
// 2 回続けて穴が開いた（文字列判定 → URL 解決 → 権限部の再解釈）。
// ⚠️ 緊急時にゲートを外す手段は「この呼び出しを消す」だけ。環境変数バイパスは用意しない。
console.log('▶ vitest run (デプロイ前ゲート)');
execSync('pnpm exec vitest run', { cwd: webDir, stdio: 'inherit' });

console.log('▶ next build (NEXT_PUBLIC_API_URL=' + PROD_API_URL + ')');
execSync('pnpm exec next build', {
  cwd: webDir,
  stdio: 'inherit',
  env: { ...process.env, NEXT_PUBLIC_API_URL: PROD_API_URL },
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
  `pnpm exec wrangler pages deploy out --project-name ${PAGES_PROJECT} --branch main --commit-dirty=true --commit-message "deploy: line-connect-admin"`,
  { cwd: webDir, stdio: 'inherit' }
);
