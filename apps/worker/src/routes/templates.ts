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
} from '@line-crm/db';
import type { Env } from '../index.js';

const templates = new Hono<Env>();

templates.get('/api/templates', async (c) => {
  try {
    const category = c.req.query('category') ?? undefined;
    const items = await getTemplates(c.env.DB, category);
    return c.json({
      success: true,
      data: items.map((t) => ({
        id: t.id,
        name: t.name,
        category: t.category,
        messageType: t.message_type,
        messageContent: t.message_content,
        sortOrder: t.sort_order,
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
    const items = await getTemplateCategories(c.env.DB);
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
    const items = await getTemplateCategories(c.env.DB);
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
      data: { id: item.id, name: item.name, category: item.category, messageType: item.message_type, messageContent: item.message_content, sortOrder: item.sort_order, createdAt: item.created_at, updatedAt: item.updated_at },
    });
  } catch (err) {
    console.error('GET /api/templates/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

templates.post('/api/templates', async (c) => {
  try {
    const body = await c.req.json<{ name: string; category?: string; messageType: string; messageContent: string; sortOrder?: number }>();
    if (!body.name || !body.messageType || !body.messageContent) {
      return c.json({ success: false, error: 'name, messageType, messageContent are required' }, 400);
    }
    const item = await createTemplate(c.env.DB, body);
    return c.json({ success: true, data: { id: item.id, name: item.name, category: item.category, messageType: item.message_type, sortOrder: item.sort_order, createdAt: item.created_at } }, 201);
  } catch (err) {
    console.error('POST /api/templates error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

templates.put('/api/templates/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    await updateTemplate(c.env.DB, id, body);
    const updated = await getTemplateById(c.env.DB, id);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      data: { id: updated.id, name: updated.name, category: updated.category, messageType: updated.message_type, messageContent: updated.message_content },
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
