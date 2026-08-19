import { beforeAll } from 'vitest';
import { applySchema } from './schema.js';
import { seedStaff, testDb } from './fixtures.js';

// テストファイルごとに 1 回走る。applySchema / seedStaff はどちらも冪等
// （CREATE TABLE IF NOT EXISTS ＋ INSERT OR REPLACE、既適用エラーは読み飛ばし）なので、
// ストレージがファイル間で共有されても結果は変わらない。
beforeAll(async () => {
  await applySchema(testDb);
  await seedStaff(testDb);
});
