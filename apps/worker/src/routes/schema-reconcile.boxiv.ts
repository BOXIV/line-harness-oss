// BOXIV-only: prod D1 が --bootstrap で migration を「適用済み」マークしただけで実 SQL を
// 走らせていなかったため、ALTER TABLE ADD COLUMN 系の列が実体として欠落している
// （例: friends.metadata が無く /api/chats が 500）。
//
// この endpoint は migrations の ADD COLUMN 系の列を PRAGMA で存在確認し、欠けていれば
// ALTER で追加する（冪等・追記のみ・データ非破壊）。DDL はハードコードでユーザー入力なし。
//
// POST /api/admin/reconcile-schema  → { added: string[], present: number, missingTables: string[] }
import { Hono } from 'hono';
import type { Env } from '../index.js';

const schemaReconcile = new Hono<Env>();

// migrations 001-013 の ALTER TABLE ... ADD COLUMN を表→[列,型] で列挙。
// base schema.sql に既にある列は PRAGMA チェックで自動スキップされる。
const EXPECTED: Record<string, Array<[string, string]>> = {
  friends: [['user_id', 'TEXT'], ['score', 'INTEGER NOT NULL DEFAULT 0'], ['ref_code', 'TEXT'], ['metadata', "TEXT NOT NULL DEFAULT '{}'"], ['line_account_id', 'TEXT']],
  scenario_steps: [['condition_type', 'TEXT'], ['condition_value', 'TEXT'], ['next_step_on_false', 'INTEGER']],
  line_accounts: [['token_expires_at', 'TEXT'], ['login_channel_id', 'TEXT'], ['login_channel_secret', 'TEXT'], ['liff_id', 'TEXT']],
  scenarios: [['line_account_id', 'TEXT']],
  broadcasts: [['alt_text', 'TEXT'], ['line_account_id', 'TEXT']],
  reminders: [['line_account_id', 'TEXT']],
  automations: [['line_account_id', 'TEXT']],
  chats: [['line_account_id', 'TEXT'], ['last_read_at', 'TEXT']],
  auto_replies: [['line_account_id', 'TEXT']],
  notification_rules: [['line_account_id', 'TEXT']],
  messages_log: [['delivery_type', 'TEXT'], ['slack_notified_at', 'TEXT'], ['status', 'TEXT']],
  ref_tracking: [['fbclid', 'TEXT'], ['gclid', 'TEXT'], ['twclid', 'TEXT'], ['ttclid', 'TEXT'], ['utm_source', 'TEXT'], ['utm_medium', 'TEXT'], ['utm_campaign', 'TEXT'], ['user_agent', 'TEXT'], ['ip_address', 'TEXT']],
};

schemaReconcile.post('/api/admin/reconcile-schema', async (c) => {
  const added: string[] = [];
  const missingTables: string[] = [];
  let present = 0;

  for (const [table, cols] of Object.entries(EXPECTED)) {
    let existing: Set<string>;
    try {
      const info = await c.env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      const names = (info.results ?? []).map((r) => r.name);
      if (names.length === 0) { missingTables.push(table); continue; }
      existing = new Set(names);
    } catch {
      missingTables.push(table);
      continue;
    }
    for (const [col, type] of cols) {
      if (existing.has(col)) { present++; continue; }
      try {
        await c.env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`).run();
        added.push(`${table}.${col}`);
      } catch (err) {
        added.push(`${table}.${col} (FAILED: ${(err as Error).message})`);
      }
    }
  }

  return c.json({ success: true, data: { added, present, missingTables } });
});

export { schemaReconcile };
