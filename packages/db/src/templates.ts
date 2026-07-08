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
  /** 順序行がまだ無い（未並び替え）カテゴリでは null。 */
  id: string | null;
  name: string;
  sort_order: number;
  created_at: string | null;
  updated_at: string | null;
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

/**
 * 実際にテンプレが存在するカテゴリを表示順で返す。
 * 副作用なし（GET から D1 への書込を起こさない ＝ promote-data の dry-run が prod を触らない）。
 * 順序行が無いカテゴリは sort_order=999999 相当で名前順の末尾に付き、id は null。
 */
export async function getTemplateCategories(db: D1Database): Promise<TemplateCategoryRow[]> {
  const result = await db.prepare(
    `SELECT c.id AS id, t.category AS name,
            COALESCE(c.sort_order, 999999) AS sort_order,
            c.created_at AS created_at, c.updated_at AS updated_at
     FROM (SELECT DISTINCT category FROM templates WHERE category IS NOT NULL AND category != '') t
     LEFT JOIN template_categories c ON c.name = t.category
     ORDER BY COALESCE(c.sort_order, 999999) ASC, t.category ASC`
  ).all<TemplateCategoryRow>();
  return result.results;
}

/**
 * カテゴリ表示順を names の並びで保存（1..n）。未登録名は行を生成する。
 * names に無い既存行（テンプレを持たなくなった隠れカテゴリ等）は 999999 に押し出す。
 * これをしないと、隠れ行が保持する古い連番が復活時に可視カテゴリの序数と衝突し、
 * 意図しない位置に割り込む。
 */
export async function setTemplateCategoryOrder(db: D1Database, names: string[]): Promise<void> {
  if (names.length === 0) return;
  const now = jstNow();
  const placeholders = names.map(() => '?').join(', ');
  await db.batch([
    db.prepare(`UPDATE template_categories SET sort_order = 999999, updated_at = ? WHERE name NOT IN (${placeholders})`)
      .bind(now, ...names),
    ...names.map((name, i) =>
      db.prepare(
        `INSERT INTO template_categories (id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET sort_order = excluded.sort_order, updated_at = excluded.updated_at`
      ).bind(crypto.randomUUID(), name, i + 1, now, now)
    ),
  ]);
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
  if (updates.category !== undefined) {
    sets.push('category = ?'); values.push(updates.category);
    // sort_order はカテゴリ内スコープ。別カテゴリへ移すと古い序数を持ち込んで
    // 既存行と衝突する/末尾に沈むので、未並び替え(0)に戻す。
    const current = await getTemplateById(db, id);
    if (current && current.category !== updates.category) sets.push('sort_order = 0');
  }
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
