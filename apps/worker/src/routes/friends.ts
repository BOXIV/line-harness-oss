import { Hono } from 'hono';
import {
  getFriends,
  getFriendById,
  getFriendCount,
  updateFriend,
  addTagToFriend,
  removeTagFromFriend,
  getFriendTags,
  getScenarios,
  enrollFriendInScenario,
  upsertChatOnOutgoing,
  jstNow,
} from '@line-crm/db';
import type { Friend as DbFriend, Tag as DbTag } from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { buildMessage } from '../services/step-delivery.js';
import { logFailedOutgoing } from '../services/message-log.boxiv.js';
import { buildQuoteIndex, firstSentMessageId, type QuotableRow } from '../utils/quote.js';
import type { Env } from '../index.js';
import { requireRole } from '../middleware/role-guard.js';

const friends = new Hono<Env>();

/**
 * Resolve a friend's OA channel access token + account id for event-bus actions.
 * send_message / switch_rich_menu actions in event-bus.ts no-op without a token,
 * so tag add/remove must thread the per-OA token (multi-account), falling back to
 * the env default. Mirrors the resolution in POST /api/friends/:id/messages.
 */
async function resolveFriendOA(
  db: D1Database,
  envToken: string,
  friendId: string,
): Promise<{ accessToken: string; lineAccountId: string | null }> {
  const friend = await getFriendById(db, friendId);
  const lineAccountId =
    ((friend as unknown as Record<string, unknown> | null)?.line_account_id as string | undefined) ?? null;
  if (!lineAccountId) return { accessToken: envToken, lineAccountId: null };
  const { getLineAccountById } = await import('@line-crm/db');
  const account = await getLineAccountById(db, lineAccountId);
  return { accessToken: account?.channel_access_token ?? envToken, lineAccountId };
}

/** Convert a D1 snake_case Friend row to the shared camelCase shape */
function serializeFriend(row: DbFriend) {
  return {
    id: row.id,
    lineUserId: row.line_user_id,
    displayName: row.display_name,
    managedName: row.managed_name,
    pictureUrl: row.picture_url,
    statusMessage: row.status_message,
    isFollowing: Boolean(row.is_following),
    metadata: JSON.parse(row.metadata || '{}'),
    refCode: (row as unknown as Record<string, unknown>).ref_code as string | null,
    userId: row.user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Convert a D1 snake_case Tag row to the shared camelCase shape */
function serializeTag(row: DbTag) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    createdAt: row.created_at,
  };
}

// GET /api/friends - list with pagination
friends.get('/api/friends', async (c) => {
  try {
    const limit = Number(c.req.query('limit') ?? '50');
    const offset = Number(c.req.query('offset') ?? '0');
    const tagId = c.req.query('tagId');
    const lineAccountId = c.req.query('lineAccountId');
    const statusOptionId = c.req.query('statusOptionId');
    const search = c.req.query('search');

    const db = c.env.DB;

    // Build WHERE conditions
    const conditions: string[] = [];
    const binds: unknown[] = [];
    if (tagId) {
      conditions.push('EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)');
      binds.push(tagId);
    }
    if (lineAccountId) {
      conditions.push('f.line_account_id = ?');
      binds.push(lineAccountId);
    }
    if (statusOptionId) {
      conditions.push(
        'EXISTS (SELECT 1 FROM friend_status_assignments fsa WHERE fsa.friend_id = f.id AND fsa.status_option_id = ?)',
      );
      binds.push(statusOptionId);
    }
    if (search) {
      // 友だち管理の表示ラベルは formatFriendLabel で managed_name か Notion 合成名
      // 「{notion.label} {notion.realName} (nickname)」になる。display_name(=nickname) だけだと
      // 例「10472 〇〇（〇〇）」の「10472」(=notion.label) や Notion実名(realName) が引っかからないため、
      // それらも検索対象に含める（metadata 内 JSON は json_extract で参照）。
      conditions.push(
        '(f.display_name LIKE ? OR f.managed_name LIKE ? OR f.line_user_id LIKE ? OR f.id LIKE ?'
        + " OR json_extract(f.metadata, '$.notion.label') LIKE ?"
        + " OR json_extract(f.metadata, '$.notion.realName') LIKE ?)",
      );
      const like = `%${search}%`;
      binds.push(like, like, like, like, like, like);
    }
    // Metadata filters: ?metadata.key=value (e.g. ?metadata.monthly_cost=〜100万円)
    const url = new URL(c.req.url);
    for (const [key, value] of url.searchParams.entries()) {
      if (key.startsWith('metadata.')) {
        const metaKey = key.slice('metadata.'.length);
        conditions.push(`json_extract(f.metadata, '$.' || ?) = ?`);
        binds.push(metaKey, value);
      }
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countStmt = db.prepare(`SELECT COUNT(*) as count FROM friends f ${where}`);
    const totalRow = await (binds.length > 0 ? countStmt.bind(...binds) : countStmt).first<{ count: number }>();
    const total = totalRow?.count ?? 0;

    const listStmt = db.prepare(
      `SELECT f.* FROM friends f ${where} ORDER BY f.created_at DESC LIMIT ? OFFSET ?`,
    );
    const listBinds = [...binds, limit, offset];
    const listResult = await listStmt.bind(...listBinds).all<DbFriend>();
    const items = listResult.results;

    // Fetch tags for each friend in parallel so the list response includes tags
    const itemsWithTags = await Promise.all(
      items.map(async (friend) => {
        const tags = await getFriendTags(db, friend.id);
        return { ...serializeFriend(friend), tags: tags.map(serializeTag) };
      }),
    );

    return c.json({
      success: true,
      data: {
        items: itemsWithTags,
        total,
        page: Math.floor(offset / limit) + 1,
        limit,
        hasNextPage: offset + limit < total,
      },
    });
  } catch (err) {
    console.error('GET /api/friends error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/friends/count - friend count (must be before /:id)
friends.get('/api/friends/count', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    let count: number;
    if (lineAccountId) {
      const row = await c.env.DB.prepare('SELECT COUNT(*) as count FROM friends WHERE is_following = 1 AND line_account_id = ?')
        .bind(lineAccountId).first<{ count: number }>();
      count = row?.count ?? 0;
    } else {
      count = await getFriendCount(c.env.DB);
    }
    return c.json({ success: true, data: { count } });
  } catch (err) {
    console.error('GET /api/friends/count error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/friends/ref-stats - ref code attribution stats
friends.get('/api/friends/ref-stats', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    const where = lineAccountId ? 'WHERE line_account_id = ?' : 'WHERE ref_code IS NOT NULL';
    const binds = lineAccountId ? [lineAccountId] : [];
    const stmt = c.env.DB.prepare(
      `SELECT ref_code, COUNT(*) as count FROM friends ${where} AND ref_code IS NOT NULL GROUP BY ref_code ORDER BY count DESC`,
    );
    const result = await (binds.length > 0 ? stmt.bind(...binds) : stmt).all<{ ref_code: string; count: number }>();
    const total = await c.env.DB.prepare(
      `SELECT COUNT(*) as count FROM friends ${lineAccountId ? 'WHERE line_account_id = ?' : ''} ${lineAccountId ? 'AND' : 'WHERE'} ref_code IS NOT NULL`,
    ).bind(...(lineAccountId ? [lineAccountId] : [])).first<{ count: number }>();
    return c.json({
      success: true,
      data: {
        routes: result.results.map((r) => ({ refCode: r.ref_code, friendCount: r.count })),
        totalWithRef: total?.count ?? 0,
      },
    });
  } catch (err) {
    console.error('GET /api/friends/ref-stats error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/friends/:id - get single friend with tags
friends.get('/api/friends/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const db = c.env.DB;

    const [friend, tags] = await Promise.all([
      getFriendById(db, id),
      getFriendTags(db, id),
    ]);

    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    return c.json({
      success: true,
      data: {
        ...serializeFriend(friend),
        tags: tags.map(serializeTag),
      },
    });
  } catch (err) {
    console.error('GET /api/friends/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/friends/:id - 管理画面で編集する可変フィールド（管理名）を更新
friends.put('/api/friends/:id', requireRole('owner','admin','manager'), async (c) => {
  try {
    const friendId = c.req.param('id');
    const db = c.env.DB;
    const friend = await getFriendById(db, friendId);
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }
    const body = await c.req.json<{ managedName?: string | null }>();
    const managedName =
      typeof body.managedName === 'string' ? body.managedName.trim() || null : null;
    const updated = await updateFriend(db, friendId, { managedName });
    return c.json({ success: true, data: updated ? serializeFriend(updated) : null });
  } catch (err) {
    console.error('PUT /api/friends/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/friends/:id/tags - add tag
friends.post('/api/friends/:id/tags', requireRole('owner','admin','manager'), async (c) => {
  try {
    const friendId = c.req.param('id');
    const body = await c.req.json<{ tagId: string }>();

    if (!body.tagId) {
      return c.json({ success: false, error: 'tagId is required' }, 400);
    }

    const db = c.env.DB;
    await addTagToFriend(db, friendId, body.tagId);

    // Enroll in tag_added scenarios that match this tag
    const allScenarios = await getScenarios(db);
    for (const scenario of allScenarios) {
      if (scenario.trigger_type === 'tag_added' && scenario.is_active && scenario.trigger_tag_id === body.tagId) {
        const existing = await db
          .prepare(`SELECT id FROM friend_scenarios WHERE friend_id = ? AND scenario_id = ?`)
          .bind(friendId, scenario.id)
          .first();
        if (!existing) {
          await enrollFriendInScenario(db, friendId, scenario.id);
        }
      }
    }

    // イベントバス発火: tag_change（send_message アクションが動くよう per-OA トークンを渡す）
    const { accessToken, lineAccountId } = await resolveFriendOA(db, c.env.LINE_CHANNEL_ACCESS_TOKEN, friendId);
    await fireEvent(
      db,
      'tag_change',
      { friendId, eventData: { tagId: body.tagId, action: 'add' } },
      accessToken,
      lineAccountId,
      c.env,
    );

    return c.json({ success: true, data: null }, 201);
  } catch (err) {
    console.error('POST /api/friends/:id/tags error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/friends/:id/tags/:tagId - remove tag
friends.delete('/api/friends/:id/tags/:tagId', requireRole('owner','admin','manager'), async (c) => {
  try {
    const friendId = c.req.param('id');
    const tagId = c.req.param('tagId');
    const db = c.env.DB;

    await removeTagFromFriend(db, friendId, tagId);

    // イベントバス発火: tag_change（send_message アクションが動くよう per-OA トークンを渡す）
    const { accessToken, lineAccountId } = await resolveFriendOA(db, c.env.LINE_CHANNEL_ACCESS_TOKEN, friendId);
    await fireEvent(
      db,
      'tag_change',
      { friendId, eventData: { tagId, action: 'remove' } },
      accessToken,
      lineAccountId,
      c.env,
    );

    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/friends/:id/tags/:tagId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/friends/:id/metadata - merge metadata fields
friends.put('/api/friends/:id/metadata', requireRole('owner','admin','manager'), async (c) => {
  try {
    const friendId = c.req.param('id');
    const db = c.env.DB;

    const friend = await getFriendById(db, friendId);
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    const body = await c.req.json<Record<string, unknown>>();
    const existing = JSON.parse(friend.metadata || '{}');
    const merged = { ...existing, ...body };
    const now = jstNow();

    await db
      .prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
      .bind(JSON.stringify(merged), now, friendId)
      .run();

    const updated = await getFriendById(db, friendId);
    const tags = await getFriendTags(db, friendId);

    return c.json({
      success: true,
      data: {
        ...serializeFriend(updated!),
        tags: tags.map(serializeTag),
      },
    });
  } catch (err) {
    console.error('PUT /api/friends/:id/metadata error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/friends/:id/messages - get message history
friends.get('/api/friends/:id/messages', async (c) => {
  try {
    const friendId = c.req.param('id');
    const result = await c.env.DB
      .prepare(
        `SELECT id, direction, message_type, content, status, line_message_id, quoted_message_id, created_at
         FROM messages_log WHERE friend_id = ? ORDER BY created_at ASC LIMIT 200`,
      )
      .bind(friendId)
      .all<QuotableRow & { status: string | null; created_at: string }>();

    // 引用返信の引用元を解決して quotedMessage として返す
    const rows = result.results;
    const quoteIndex = await buildQuoteIndex(c.env.DB, friendId, rows);
    const data = rows.map((m) => ({
      id: m.id,
      direction: m.direction,
      messageType: m.message_type,
      content: m.content,
      status: m.status,
      createdAt: m.created_at,
      quotedMessageId: m.quoted_message_id ?? null,
      quotedMessage: m.quoted_message_id ? quoteIndex.get(m.quoted_message_id) ?? null : null,
    }));
    return c.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/friends/:id/messages error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/friends/:id/messages - send message to friend
friends.post('/api/friends/:id/messages', requireRole('owner','admin','manager'), async (c) => {
  try {
    const friendId = c.req.param('id');
    const body = await c.req.json<{
      messageType?: string;
      content: string;
      altText?: string;
    }>();

    if (!body.content) {
      return c.json({ success: false, error: 'content is required' }, 400);
    }

    const db = c.env.DB;
    const friend = await getFriendById(db, friendId);
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    const messageType = body.messageType ?? 'text';

    // 未フォロー（友だち未追加/ブロック中）には送れない。LINE は push に 200 を返すが届かないため、
    // 失敗を即時通知し、送信失敗として記録する（黙って成功扱いにしない）。
    if (!friend.is_following) {
      await logFailedOutgoing(db, friend.id, messageType, body.content);
      return c.json({ success: false, error: 'この友だちは未フォロー（友だち未追加・ブロック中）のため送信できません。友だち追加を依頼してください。' }, 422);
    }

    const { LineClient } = await import('@line-crm/line-sdk');
    // Resolve access token from friend's account (multi-account support)
    let accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
    if ((friend as unknown as Record<string, unknown>).line_account_id) {
      const { getLineAccountById } = await import('@line-crm/db');
      const account = await getLineAccountById(db, (friend as unknown as Record<string, unknown>).line_account_id as string);
      if (account) accessToken = account.channel_access_token;
    }
    const lineClient = new LineClient(accessToken);

    // Auto-wrap URLs with tracking links (text with URLs → Flex with button)
    const { autoTrackContent } = await import('../services/auto-track.js');
    const tracked = await autoTrackContent(
      db, messageType, body.content,
      c.env.WORKER_URL || new URL(c.req.url).origin,
    );

    const message = buildMessage(tracked.messageType, tracked.content, body.altText);
    // 送信メッセージの LINE messageId を保存 → 友だちの引用返信の解決に使う。
    let sentLineId: string | null = null;
    try {
      sentLineId = firstSentMessageId(await lineClient.pushMessage(friend.line_user_id, [message]));
    } catch (err) {
      await logFailedOutgoing(db, friend.id, messageType, body.content);
      console.error('POST /api/friends/:id/messages: LINE push failed', err);
      return c.json({ success: false, error: 'LINE への送信に失敗しました。時間をおいて再度お試しください。' }, 502);
    }

    // Log outgoing message
    const logId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, line_message_id, created_at)
         VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, ?, ?)`,
      )
      .bind(logId, friend.id, messageType, body.content, sentLineId, jstNow())
      .run();

    // オペレーターチャットに表示されるよう、送信時にもチャットを作成/更新する
    // （inbound が来るまで一覧に出ない問題を解消。CLI/管理画面からの送信も対象）。
    await upsertChatOnOutgoing(db, friend.id);

    return c.json({ success: true, data: { messageId: logId } });
  } catch (err) {
    console.error('POST /api/friends/:id/messages error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { friends };
