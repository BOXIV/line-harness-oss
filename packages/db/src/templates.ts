import { jstNow } from './utils.js';
// テンプレート管理クエリヘルパー

export interface TemplateRow {
  id: string;
  name: string;
  category: string;
  message_type: string;
  message_content: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface TemplateCategoryRow {
  id: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

// sort_order 0 = 未並び替え。並び替え保存後は 1..n が入るので、
// 未並び替え分（新規作成）は先頭側に作成日新しい順で並ぶ（従来挙動を保存前は維持）。
export async function getTemplates(db: D1Database, category?: string): Promise<TemplateRow[]> {
  if (category) {
    const result = await db.prepare(`SELECT * FROM templates WHERE category = ? ORDER BY sort_order ASC, created_at DESC`)
      .bind(category).all<TemplateRow>();
    return result.results;
  }
  // 全件はカテゴリ順（template_categories.sort_order）→ カテゴリ内順で返す。
  // カテゴリ行が未生成でも表示できるよう LEFT JOIN + COALESCE で末尾送り。
  const result = await db.prepare(
    `SELECT t.* FROM templates t
     LEFT JOIN template_categories c ON c.name = t.category
     ORDER BY COALESCE(c.sort_order, 999999) ASC, t.category ASC, t.sort_order ASC, t.created_at DESC`
  ).all<TemplateRow>();
  return result.results;
}

/** テンプレに存在するカテゴリを template_categories に遅延生成しつつ、順序付きで返す（空カテゴリは返さない）。 */
export async function getTemplateCategories(db: D1Database): Promise<TemplateCategoryRow[]> {
  const missing = await db.prepare(
    `SELECT DISTINCT category AS name FROM templates
     WHERE category IS NOT NULL AND category != ''
       AND category NOT IN (SELECT name FROM template_categories)`
  ).all<{ name: string }>();
  if (missing.results.length > 0) {
    const now = jstNow();
    await db.batch(missing.results.map((m) =>
      db.prepare(`INSERT OR IGNORE INTO template_categories (id, name, sort_order, created_at, updated_at) VALUES (?, ?, 999999, ?, ?)`)
        .bind(crypto.randomUUID(), m.name, now, now)
    ));
  }
  const result = await db.prepare(
    `SELECT c.* FROM template_categories c
     WHERE EXISTS (SELECT 1 FROM templates t WHERE t.category = c.name)
     ORDER BY c.sort_order ASC, c.name ASC`
  ).all<TemplateCategoryRow>();
  return result.results;
}

/** カテゴリ表示順を names の並びで保存（1..n）。未登録名は行を生成して順序を付ける。 */
export async function setTemplateCategoryOrder(db: D1Database, names: string[]): Promise<void> {
  if (names.length === 0) return;
  const now = jstNow();
  await db.batch(names.map((name, i) =>
    db.prepare(
      `INSERT INTO template_categories (id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET sort_order = excluded.sort_order, updated_at = excluded.updated_at`
    ).bind(crypto.randomUUID(), name, i + 1, now, now)
  ));
}

/** name で upsert（test→prod promote 用）。 */
export async function upsertTemplateCategory(
  db: D1Database,
  input: { name: string; sortOrder?: number },
): Promise<TemplateCategoryRow> {
  const now = jstNow();
  await db.prepare(
    `INSERT INTO template_categories (id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET sort_order = excluded.sort_order, updated_at = excluded.updated_at`
  ).bind(crypto.randomUUID(), input.name, input.sortOrder ?? 999999, now, now).run();
  return (await db.prepare(`SELECT * FROM template_categories WHERE name = ?`).bind(input.name).first<TemplateCategoryRow>())!;
}

export async function deleteTemplateCategory(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM template_categories WHERE id = ?`).bind(id).run();
}

/** テンプレ表示順を ids の並びで保存（1..n）。カテゴリ内並び替え用。 */
export async function setTemplateOrder(db: D1Database, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const now = jstNow();
  await db.batch(ids.map((id, i) =>
    db.prepare(`UPDATE templates SET sort_order = ?, updated_at = ? WHERE id = ?`).bind(i + 1, now, id)
  ));
}

export async function getTemplateById(db: D1Database, id: string): Promise<TemplateRow | null> {
  return db.prepare(`SELECT * FROM templates WHERE id = ?`).bind(id).first<TemplateRow>();
}

export async function createTemplate(
  db: D1Database,
  input: { name: string; category?: string; messageType: string; messageContent: string; sortOrder?: number },
): Promise<TemplateRow> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db.prepare(`INSERT INTO templates (id, name, category, message_type, message_content, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, input.name, input.category ?? 'general', input.messageType, input.messageContent, input.sortOrder ?? 0, now, now).run();
  return (await getTemplateById(db, id))!;
}

export async function updateTemplate(
  db: D1Database,
  id: string,
  updates: Partial<{ name: string; category: string; messageType: string; messageContent: string }>,
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }
  if (updates.category !== undefined) { sets.push('category = ?'); values.push(updates.category); }
  if (updates.messageType !== undefined) { sets.push('message_type = ?'); values.push(updates.messageType); }
  if (updates.messageContent !== undefined) { sets.push('message_content = ?'); values.push(updates.messageContent); }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  values.push(jstNow());
  values.push(id);
  await db.prepare(`UPDATE templates SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
}

export async function deleteTemplate(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM templates WHERE id = ?`).bind(id).run();
}
