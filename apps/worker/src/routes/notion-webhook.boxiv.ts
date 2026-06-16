// BOXIV-only: Notion DB オートメーション(Send webhook) の受信口（PR6 / 案2）。
// Notion 側で「顧客ステータスが変更されたら指定URLへ Send webhook」を設定し、
// custom header（x-boxiv-notion-secret）に共有シークレットを付与する。
// ここでは即 200 を返し、ページ取得＋D1反映は waitUntil で非同期化する
// （失敗で automation が auto-pause しないよう、認証 OK なら常に成功応答）。
// 取りこぼしは 12h reconcile cron が自己修復する。

import { Hono } from 'hono';
import type { Env } from '../index.js';
import { syncNotionPageStatus } from '../services/notion-status-sync.boxiv.js';

const notionWebhook = new Hono<Env>();

// ペイロードから page id を取り出す（automation の形式差異に頑健に）。
function extractPageId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const asObj = (v: unknown): Record<string, unknown> | undefined =>
    v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  const data = asObj(b.data);
  const page = asObj(b.page);
  const src = asObj(b.source);
  const candidates = [data?.id, page?.id, b.id, asObj(data?.page)?.id, src?.page_id, b.page_id];
  for (const cand of candidates) {
    if (typeof cand === 'string' && cand.length >= 8) return cand;
  }
  return null;
}

notionWebhook.post('/api/notion/automation', async (c) => {
  // 共有シークレット認証（custom header）。未設定なら無効（503）。
  const expected = c.env.NOTION_AUTOMATION_SECRET;
  if (!expected) {
    return c.json({ success: false, error: 'notion automation not configured' }, 503);
  }
  const provided = c.req.header('x-boxiv-notion-secret') || '';
  if (provided !== expected) {
    return c.json({ success: false, error: 'unauthorized' }, 401);
  }

  let body: unknown = null;
  try {
    body = await c.req.json();
  } catch {
    body = null;
  }
  const pageId = extractPageId(body);

  // 即 200（automation の auto-pause 回避）。実処理は waitUntil で非同期化。
  if (pageId) {
    c.executionCtx.waitUntil(
      syncNotionPageStatus(c.env.DB, c.env, pageId).catch((err) => {
        console.error('notion automation sync failed for', pageId, err);
      }),
    );
  } else {
    console.error('notion automation: page id not found in payload');
  }
  return c.json({ success: true });
});

export { notionWebhook };
