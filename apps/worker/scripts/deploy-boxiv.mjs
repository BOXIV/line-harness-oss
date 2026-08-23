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
import { copyFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotenv, requireEnv } from '../../../../../scripts/dotenv.mjs';

// ⚠️ env を**明示**する。省略すると BOXIV_ENV / WITH_SECRETS_PROFILE 次第で test に倒れ、
//    test の LIFF ID が本番ビルドに焼かれる。requireEnv は「値がある」ので素通りし、
//    壊れ方は「本番の LIFF ページだけが test を指す」になる（ログを読み返すまで気づけない）。
loadDotenv({ env: 'prod' });
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
  // deploy 前に必ず dist を再ビルドする。これを怠ると古い dist が bundle され、
  // 例: pushMessage の sentMessages 取得が無効化されて引用元解決が静かに壊れる。
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
