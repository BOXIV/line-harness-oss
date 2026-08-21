import { Hono } from 'hono';
import {
  getTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  getTemplateCategories,
  setTemplateCategoryOrder,
  upsertTemplateCategory,
  deleteTemplateCategory,
  setTemplateOrder,
  isTemplateSource,
  TEMPLATE_SOURCES,
} from '@line-crm/db';
import type { TemplateSource } from '@line-crm/db';
import type { Env } from '../index.js';

const templates = new Hono<Env>();

/**
 * ?source= の解釈。空・未指定は「絞り込みなし」。
 * 未知の値はエラーにせず undefined（＝全件）にする。古いクライアントが投げた値で
 * 一覧が 500 になるより、絞り込みが効かない方が実害が小さい。
 */
function parseSourceQuery(value: string | undefined): TemplateSource | undefined {
  return isTemplateSource(value) ? value : undefined;
}

templates.get('/api/templates', async (c) => {
  try {
    const category = c.req.query('category') ?? undefined;
    const source = parseSourceQuery(c.req.query('source'));
    const items = await getTemplates(c.env.DB, { category, source });
    return c.json({
      success: true,
      data: items.map((t) => ({
        id: t.id,
        name: t.name,
        category: t.category,
        messageType: t.message_type,
        messageContent: t.message_content,
        sortOrder: t.sort_order,
        source: t.source,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/templates error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ─── カテゴリ（表示順マスタ）───
// 注意: /api/templates/reorder・/api/template-categories/* は :id ルートより先に登録する。

/** GET /api/template-categories — テンプレに存在するカテゴリを表示順で返す */
templates.get('/api/template-categories', async (c) => {
  try {
    const items = await getTemplateCategories(c.env.DB, parseSourceQuery(c.req.query('source')));
    return c.json({
      success: true,
      data: items.map((r) => ({ id: r.id, name: r.name, sortOrder: r.sort_order })),
    });
  } catch (err) {
    console.error('GET /api/template-categories error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** PUT /api/template-categories/reorder — カテゴリ表示順を一括保存 */
templates.put('/api/template-categories/reorder', async (c) => {
  try {
    const body = await c.req.json<{ names?: string[] }>();
    if (!Array.isArray(body.names) || body.names.length === 0 || body.names.some((n) => typeof n !== 'string' || !n)) {
      return c.json({ success: false, error: 'names (non-empty string array) is required' }, 400);
    }
    await setTemplateCategoryOrder(c.env.DB, body.names);
    // 返すのは呼び出し元が表示している範囲（タブ）に合わせる。全体順に差し込まれた結果を返す。
    const items = await getTemplateCategories(c.env.DB, parseSourceQuery(c.req.query('source')));
    return c.json({
      success: true,
      data: items.map((r) => ({ id: r.id, name: r.name, sortOrder: r.sort_order })),
    });
  } catch (err) {
    console.error('PUT /api/template-categories/reorder error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** POST /api/template-categories — name で upsert（test→prod promote 用） */
templates.post('/api/template-categories', async (c) => {
  try {
    const body = await c.req.json<{ name?: string; sortOrder?: number }>();
    if (!body.name) return c.json({ success: false, error: 'name is required' }, 400);
    const row = await upsertTemplateCategory(c.env.DB, { name: body.name, sortOrder: body.sortOrder });
    return c.json({ success: true, data: { id: row.id, name: row.name, sortOrder: row.sort_order } }, 201);
  } catch (err) {
    console.error('POST /api/template-categories error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** DELETE /api/template-categories/:id — 順序行の削除（テンプレ本体には影響しない） */
templates.delete('/api/template-categories/:id', async (c) => {
  try {
    await deleteTemplateCategory(c.env.DB, c.req.param('id'));
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/template-categories/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** PUT /api/templates/reorder — カテゴリ内のテンプレ表示順を一括保存 */
templates.put('/api/templates/reorder', async (c) => {
  try {
    const body = await c.req.json<{ ids?: string[] }>();
    if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.some((n) => typeof n !== 'string' || !n)) {
      return c.json({ success: false, error: 'ids (non-empty string array) is required' }, 400);
    }
    await setTemplateOrder(c.env.DB, body.ids);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('PUT /api/templates/reorder error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

templates.get('/api/templates/:id', async (c) => {
  try {
    const item = await getTemplateById(c.env.DB, c.req.param('id'));
    if (!item) return c.json({ success: false, error: 'Template not found' }, 404);
    return c.json({
      success: true,
      data: { id: item.id, name: item.name, category: item.category, messageType: item.message_type, messageContent: item.message_content, sortOrder: item.sort_order, source: item.source, createdAt: item.created_at, updatedAt: item.updated_at },
    });
  } catch (err) {
    console.error('GET /api/templates/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

templates.post('/api/templates', async (c) => {
  try {
    const body = await c.req.json<{ name: string; category?: string; messageType: string; messageContent: string; sortOrder?: number; source?: string }>();
    if (!body.name || !body.messageType || !body.messageContent) {
      return c.json({ success: false, error: 'name, messageType, messageContent are required' }, 400);
    }
    // source は省略可（既定 'common'）。誤った値は 400 で弾く: 黙って 'common' に落とすと
    // 出品者向けのつもりのテンプレが共通タブに紛れ、間違った相手へ送る材料になる。
    if (body.source !== undefined && !isTemplateSource(body.source)) {
      return c.json({ success: false, error: `source must be one of ${TEMPLATE_SOURCES.join(' / ')}` }, 400);
    }
    const item = await createTemplate(c.env.DB, { ...body, source: body.source as TemplateSource | undefined });
    return c.json({ success: true, data: { id: item.id, name: item.name, category: item.category, messageType: item.message_type, sortOrder: item.sort_order, source: item.source, createdAt: item.created_at } }, 201);
  } catch (err) {
    console.error('POST /api/templates error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

templates.put('/api/templates/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{
      name?: string; category?: string; messageType?: string; messageContent?: string; source?: string;
    }>();
    if (body.source !== undefined && !isTemplateSource(body.source)) {
      return c.json({ success: false, error: `source must be one of ${TEMPLATE_SOURCES.join(' / ')}` }, 400);
    }
    await updateTemplate(c.env.DB, id, { ...body, source: body.source as TemplateSource | undefined });
    const updated = await getTemplateById(c.env.DB, id);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      data: { id: updated.id, name: updated.name, category: updated.category, messageType: updated.message_type, messageContent: updated.message_content, source: updated.source },
    });
  } catch (err) {
    console.error('PUT /api/templates/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

templates.delete('/api/templates/:id', async (c) => {
  try {
    await deleteTemplate(c.env.DB, c.req.param('id'));
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/templates/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { templates };
