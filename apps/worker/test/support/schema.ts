/**
 * テスト用 D1 に本番相当のスキーマを組み立てる（BOXIV）。
 *
 * packages/db/schema.sql（現行スナップショット）を適用したあと、
 * packages/db/migrations/*.sql をファイル名順で流す。schema.sql は
 * 一部の migration 適用後の姿を既に含んでいるため（例: work_area は
 * schema.sql にあるが 912 でも ADD COLUMN される）、
 * 「列/テーブルが既にある」系のエラーだけは握りつぶして先へ進む。
 * それ以外のエラーは握りつぶさない（スキーマ破損をテストで気づけるように）。
 */

import schemaSql from '../../../../packages/db/schema.sql?raw';

const migrationModules = import.meta.glob('../../../../packages/db/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const ALREADY_APPLIED = /duplicate column name|already exists/i;

/**
 * SQL を文単位に分割する。
 * - 行コメント(`--`)は文字列リテラルの外側でのみ除去する
 * - 文末の `;` で区切る（このリポジトリの SQL にトリガー/明示 BEGIN は無い）
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inString = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];

    if (inString) {
      current += ch;
      if (ch === "'") {
        // '' はエスケープされたシングルクォート
        if (sql[i + 1] === "'") {
          current += sql[++i];
        } else {
          inString = false;
        }
      }
      continue;
    }

    if (ch === "'") {
      inString = true;
      current += ch;
      continue;
    }

    // 行コメント: 改行まで捨てる
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      current += '\n';
      continue;
    }

    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
      continue;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

async function runAll(db: D1Database, sql: string, source: string): Promise<void> {
  for (const statement of splitSqlStatements(sql)) {
    try {
      await db.prepare(statement).run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (ALREADY_APPLIED.test(message)) continue;
      throw new Error(`${source}: ${message}\n--- statement ---\n${statement}`);
    }
  }
}

/** schema.sql + 全 migration をテスト用 D1 に適用する。 */
export async function applySchema(db: D1Database): Promise<void> {
  await runAll(db, schemaSql, 'schema.sql');

  const files = Object.keys(migrationModules).sort();
  for (const file of files) {
    await runAll(db, migrationModules[file]!, file.split('/').pop()!);
  }
}

/** 適用された migration ファイル名（ソート済み）。件数アサート用。 */
export function migrationFileNames(): string[] {
  return Object.keys(migrationModules)
    .map((p) => p.split('/').pop()!)
    .sort();
}
