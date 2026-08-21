import { jstNow } from './utils.js';
// テンプレート管理クエリヘルパー

/**
 * テンプレの送り先分類。友だち側の分類（worker: services/source-tag.boxiv.ts /
 * web: lib/friend-source.ts）と同じ語彙にしてある。'common' はどちらにも使うテンプレ。
 */
export const TEMPLATE_SOURCES = ['seller', 'buyer', 'common'] as const;
export type TemplateSource = (typeof TEMPLATE_SOURCES)[number];

export function isTemplateSource(value: unknown): value is TemplateSource {
  return typeof value === 'string' && (TEMPLATE_SOURCES as readonly string[]).includes(value);
}

export interface TemplateRow {
  id: string;
  name: string;
  category: string;
  message_type: string;
  message_content: string;
  sort_order: number;
  /** migration 922: 'seller' | 'buyer' | 'common'。既定は 'common'。 */
  source: TemplateSource;
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
export interface TemplateFilter {
  category?: string;
  /** 出品者向け / 購入者向け / 共通 の絞り込み（管理画面のタブ・チャットのテンプレ選択）。 */
  source?: TemplateSource;
}

export async function getTemplates(db: D1Database, filter: TemplateFilter = {}): Promise<TemplateRow[]> {
  const conditions: string[] = [];
  const binds: unknown[] = [];
  if (filter.category) { conditions.push('t.category = ?'); binds.push(filter.category); }
  if (filter.source) { conditions.push('t.source = ?'); binds.push(filter.source); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  // カテゴリ順（template_categories.sort_order）→ カテゴリ内順で返す。
  // カテゴリ行が未生成でも表示できるよう LEFT JOIN + COALESCE で末尾送り。
  const result = await db.prepare(
    `SELECT t.* FROM templates t
     LEFT JOIN template_categories c ON c.name = t.category
     ${where}
     ORDER BY COALESCE(c.sort_order, 999999) ASC, t.category ASC, t.sort_order ASC, t.created_at DESC`
  ).bind(...binds).all<TemplateRow>();
  return result.results;
}

/**
 * 実際にテンプレが存在するカテゴリを表示順で返す。
 * 副作用なし（GET から D1 への書込を起こさない ＝ promote-data の dry-run が prod を触らない）。
 * 順序行が無いカテゴリは sort_order=999999 相当で名前順の末尾に付き、id は null。
 */
export async function getTemplateCategories(
  db: D1Database,
  source?: TemplateSource,
): Promise<TemplateCategoryRow[]> {
  // source 指定時は「そのタブに出るテンプレが属するカテゴリ」だけを返す
  // （出品者タブに購入者専用カテゴリのチップが残ると、押しても 0 件になる）。
  const filter = source ? 'AND source = ?' : '';
  const binds = source ? [source] : [];
  const result = await db.prepare(
    `SELECT c.id AS id, t.category AS name,
            COALESCE(c.sort_order, 999999) AS sort_order,
            c.created_at AS created_at, c.updated_at AS updated_at
     FROM (SELECT DISTINCT category FROM templates WHERE category IS NOT NULL AND category != '' ${filter}) t
     LEFT JOIN template_categories c ON c.name = t.category
     ORDER BY COALESCE(c.sort_order, 999999) ASC, t.category ASC`
  ).bind(...binds).all<TemplateCategoryRow>();
  return result.results;
}

/**
 * カテゴリ表示順を names の並びで保存（1..n）。未登録名は行を生成する。
 *
 * ⚠️ names は「全カテゴリ」とは限らない。出品者/購入者タブで絞った一覧から保存されると
 * 部分集合になるので、送られてきた並びは**現在の全体順に差し込む**（names が占めている
 * スロットにだけ names の順を入れ、それ以外のカテゴリは動かさない）。全件送信時は
 * merged === names になるので、従来の挙動と一致する。
 *
 * merged に無い既存行（テンプレを持たなくなった隠れカテゴリ等）は 999999 に押し出す。
 * これをしないと、隠れ行が保持する古い連番が復活時に可視カテゴリの序数と衝突し、
 * 意図しない位置に割り込む。
 */
export async function setTemplateCategoryOrder(db: D1Database, names: string[]): Promise<void> {
  if (names.length === 0) return;
  const current = (await getTemplateCategories(db)).map((c) => c.name);
  const targets = new Set(names);
  const queue = [...names];
  const merged = current.map((name) => (targets.has(name) ? (queue.shift() ?? name) : name));
  merged.push(...queue); // 現在の一覧に無い名前（新規カテゴリ）は末尾に付ける

  const now = jstNow();
  const placeholders = merged.map(() => '?').join(', ');
  await db.batch([
    db.prepare(`UPDATE template_categories SET sort_order = 999999, updated_at = ? WHERE name NOT IN (${placeholders})`)
      .bind(now, ...merged),
    ...merged.map((name, i) =>
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

/**
 * テンプレ表示順を ids の並びで保存（1..n）。カテゴリ内並び替え用。
 *
 * ⚠️ ids はカテゴリの全件とは限らない（出品者/購入者タブで絞った一覧から保存されると、
 * 同じカテゴリに別 source の行が残る）。ids だけに 1..n を振ると、送られてこなかった
 * 行が古い序数のまま残って重複し、並びが不定になる。カテゴリ単位で現在順を土台にし、
 * ids が占めるスロットにだけ ids の並びを差し込んでから通し番号を振り直す。
 */
export async function setTemplateOrder(db: D1Database, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(', ');
  const target = (await db.prepare(`SELECT id, category FROM templates WHERE id IN (${placeholders})`)
    .bind(...ids).all<{ id: string; category: string }>()).results;
  if (target.length === 0) return;

  const categoryOf = new Map(target.map((r) => [r.id, r.category]));
  const now = jstNow();
  const statements: D1PreparedStatement[] = [];

  for (const category of new Set(target.map((r) => r.category))) {
    const current = (await db.prepare(
      `SELECT id FROM templates WHERE category = ? ORDER BY sort_order ASC, created_at DESC`
    ).bind(category).all<{ id: string }>()).results.map((r) => r.id);

    const queue = ids.filter((id) => categoryOf.get(id) === category);
    const targets = new Set(queue);
    const merged = current.map((id) => (targets.has(id) ? (queue.shift() ?? id) : id));
    merged.push(...queue); // current に無い id（直前に別カテゴリから移した行 等）は末尾へ

    merged.forEach((id, i) => statements.push(
      db.prepare(`UPDATE templates SET sort_order = ?, updated_at = ? WHERE id = ?`).bind(i + 1, now, id)
    ));
  }
  if (statements.length > 0) await db.batch(statements);
}

export async function getTemplateById(db: D1Database, id: string): Promise<TemplateRow | null> {
  return db.prepare(`SELECT * FROM templates WHERE id = ?`).bind(id).first<TemplateRow>();
}

export async function createTemplate(
  db: D1Database,
  input: {
    name: string;
    category?: string;
    messageType: string;
    messageContent: string;
    sortOrder?: number;
    source?: TemplateSource;
  },
): Promise<TemplateRow> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db.prepare(`INSERT INTO templates (id, name, category, message_type, message_content, sort_order, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, input.name, input.category ?? 'general', input.messageType, input.messageContent, input.sortOrder ?? 0, input.source ?? 'common', now, now).run();
  return (await getTemplateById(db, id))!;
}

export async function updateTemplate(
  db: D1Database,
  id: string,
  updates: Partial<{ name: string; category: string; messageType: string; messageContent: string; source: TemplateSource }>,
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
  // source はカテゴリ内順（sort_order）のスコープではないので、変更しても並びはそのまま。
  if (updates.source !== undefined) { sets.push('source = ?'); values.push(updates.source); }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  values.push(jstNow());
  values.push(id);
  await db.prepare(`UPDATE templates SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
}

export async function deleteTemplate(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM templates WHERE id = ?`).bind(id).run();
}
