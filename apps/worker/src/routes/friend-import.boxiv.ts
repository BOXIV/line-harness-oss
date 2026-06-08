// BOXIV-only: Lステップからの移行で、本番 OA の既存フォロワーを Connect の D1 に
// 一括インポートするエンドポイント。LINE の followers/ids 列挙と upsert を
// サーバ側（worker）で行うため、クライアント側で大量 PII を列挙せずに済む。
//
// POST /api/friends/import-followers
//   body: { start?: string (LINE cursor), limit?: number(<=300), dryRun?: boolean }
//   returns: { scanned, inserted, skipped, next, dryRun }
// クライアント（line/scripts/import-followers.mjs）が `next` でページングを駆動する。
//
// 注意: display_name 等は入れず line_user_id + is_following=1 のみ。プロフィールは
// 友だちが接触した時に webhook の resolveOrCreateFriend が埋める（lazy）。
import { Hono } from 'hono';
import type { Env } from '../index.js';

const friendImport = new Hono<Env>();

friendImport.post('/api/friends/import-followers', async (c) => {
  const token = c.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return c.json({ success: false, error: 'LINE_CHANNEL_ACCESS_TOKEN not configured' }, 500);

  const body = (await c.req.json().catch(() => ({}))) as { start?: string; limit?: number; dryRun?: boolean };
  const limit = Math.min(Math.max(body.limit ?? 200, 1), 300);
  const dryRun = body.dryRun === true;

  // 1) fetch one page of follower IDs from LINE (server-side)
  const url = new URL('https://api.line.me/v2/bot/followers/ids');
  url.searchParams.set('limit', String(limit));
  if (body.start) url.searchParams.set('start', body.start);
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const txt = await res.text();
    return c.json({ success: false, error: `LINE followers/ids ${res.status}: ${txt}` }, 502);
  }
  const page = (await res.json()) as { userIds?: string[]; next?: string };
  const userIds = page.userIds ?? [];
  const next = page.next ?? null;

  if (dryRun) {
    return c.json({ success: true, data: { scanned: userIds.length, inserted: 0, skipped: 0, next, dryRun: true } });
  }

  // 2) 冪等 insert: friends.line_user_id は UNIQUE なので INSERT OR IGNORE で既存は skip。
  //    （SELECT ... WHERE line_user_id IN (...) は D1 のバインド変数上限に当たるため使わない）
  let inserted = 0;
  if (userIds.length) {
    const now = new Date().toISOString();
    const stmt = c.env.DB.prepare(
      `INSERT OR IGNORE INTO friends (id, line_user_id, display_name, picture_url, status_message, is_following, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, NULL, 1, ?, ?)`,
    );
    for (let i = 0; i < userIds.length; i += 50) {
      const chunk = userIds.slice(i, i + 50);
      const results = await c.env.DB.batch(chunk.map((uid) => stmt.bind(crypto.randomUUID(), uid, now, now)));
      inserted += results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
    }
  }

  return c.json({
    success: true,
    data: { scanned: userIds.length, inserted, skipped: userIds.length - inserted, next },
  });
});

// POST /api/friends/backfill-profiles — display_name 未設定の友だちに getProfile で
// 表示名/画像/ステータスを埋める。id カーソルで前進（失敗者は NULL のまま次回再試行可）。
//   body: { cursor?: string (last id), limit?: number(<=100) }
//   returns: { processed, updated, failed, nextCursor, done }
friendImport.post('/api/friends/backfill-profiles', async (c) => {
  const token = c.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return c.json({ success: false, error: 'LINE_CHANNEL_ACCESS_TOKEN not configured' }, 500);

  const body = (await c.req.json().catch(() => ({}))) as { cursor?: string; limit?: number };
  const limit = Math.min(Math.max(body.limit ?? 40, 1), 100);
  const cursor = body.cursor ?? '';

  const rows = await c.env.DB
    .prepare(`SELECT id, line_user_id FROM friends WHERE display_name IS NULL AND id > ? ORDER BY id LIMIT ?`)
    .bind(cursor, limit)
    .all<{ id: string; line_user_id: string }>();
  const batch = rows.results ?? [];

  let updated = 0;
  let failed = 0;
  const now = new Date().toISOString();
  for (const f of batch) {
    try {
      const r = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(f.line_user_id)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) { failed++; continue; }
      const p = (await r.json()) as { displayName?: string; pictureUrl?: string; statusMessage?: string };
      await c.env.DB
        .prepare(`UPDATE friends SET display_name = ?, picture_url = ?, status_message = ?, updated_at = ? WHERE id = ?`)
        .bind(p.displayName ?? null, p.pictureUrl ?? null, p.statusMessage ?? null, now, f.id)
        .run();
      if (p.displayName) updated++; else failed++;
    } catch {
      failed++;
    }
  }

  const nextCursor = batch.length ? batch[batch.length - 1].id : null;
  return c.json({
    success: true,
    data: { processed: batch.length, updated, failed, nextCursor, done: batch.length < limit },
  });
});

export { friendImport };
