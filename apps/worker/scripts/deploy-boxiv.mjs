#!/usr/bin/env node
/**
 * Deploy the Worker to BOXIV production (line-connect on boxiv.workers.dev).
 *
 * Why this script exists:
 *   The shared apps/worker/wrangler.toml uses the OSS upstream "line-harness"
 *   naming. To keep upstream merges clean we keep BOXIV settings in
 *   wrangler.boxiv.toml and swap them in just for the deploy.
 *
 *   This follows OSS-SYNC-CHARTER §8.1: "swap wrangler.toml for deploy,
 *   then restore."
 *
 * Steps:
 *   1. Back up wrangler.toml → wrangler.toml.bak (gitignored)
 *   2. Copy wrangler.boxiv.toml → wrangler.toml
 *   3. vite build + wrangler deploy
 *   4. Restore wrangler.toml from backup (always, even on failure)
 */
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotenv, requireEnv } from '../../../../../scripts/dotenv.mjs';

loadDotenv();
requireEnv('VITE_LIFF_ID');

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(__dirname, '..');
const wranglerToml = resolve(workerDir, 'wrangler.toml');
const wranglerBoxiv = resolve(workerDir, 'wrangler.boxiv.toml');
const backup = resolve(workerDir, 'wrangler.toml.bak');

// Vite が import.meta.env 経由で SPA バンドルに焼き込む。
// apps/worker/src/client/main.ts は未設定だとモジュールロードで落ちるので必須。
const VITE_LIFF_ID = process.env.VITE_LIFF_ID;

if (!existsSync(wranglerBoxiv)) {
  console.error('✗ wrangler.boxiv.toml not found at ' + wranglerBoxiv);
  process.exit(1);
}

let swapped = false;
try {
  console.log('▶ swap wrangler.toml → wrangler.boxiv.toml');
  renameSync(wranglerToml, backup);
  copyFileSync(wranglerBoxiv, wranglerToml);
  swapped = true;

  console.log('▶ vite build (VITE_LIFF_ID=' + VITE_LIFF_ID + ')');
  execSync('pnpm exec vite build', {
    cwd: workerDir,
    stdio: 'inherit',
    env: { ...process.env, VITE_LIFF_ID },
  });

  console.log('▶ wrangler deploy (BOXIV production)');
  execSync('pnpm exec wrangler deploy', {
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
