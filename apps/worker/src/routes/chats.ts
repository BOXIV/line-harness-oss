import { Hono } from 'hono';
import { buildMessage } from '../services/step-delivery.js';
import {
  linkFriendToNotion,
  readNotionLinks,
  primaryLink,
  type NotionFriendLinks,
} from '../services/notion-friend-link.boxiv.js';
import { logFailedOutgoing } from '../services/message-log.boxiv.js';
import { buildQuoteIndex, firstSentMessageId, type QuotableRow } from '../utils/quote.js';
import { SOURCE_TAG_NAMES } from '../services/source-tag.boxiv.js';
import {
  getOperators,
  getOperatorById,
  createOperator,
  updateOperator,
  deleteOperator,
  getChats,
  getChatById,
  getChatByFriendId,
  createChat,
  updateChat,
  jstNow,
} from '@line-crm/db';
import type { Env } from '../index.js';
import { requireRole } from '../middleware/role-guard.js';

const chats = new Hono<Env>();

function clampLoadingSeconds(value: number | undefined): number {
  const n = Number.isFinite(value) ? Math.floor(value as number) : 5;
  return Math.min(60, Math.max(5, n));
}

async function startLoadingAnimation(
  accessToken: string,
  chatId: string,
  loadingSeconds: number,
): Promise<void> {
  const response = await fetch('https://api.line.me/v2/bot/chat/loading/start', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ chatId, loadingSeconds }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      detail
        ? `LINE API error: ${response.status} - ${detail}`
        : `LINE API error: ${response.status}`,
    );
  }
}

// ========== オペレーターCRUD ==========

chats.get('/api/operators', async (c) => {
  try {
    const items = await getOperators(c.env.DB);
    return c.json({
      success: true,
      data: items.map((o) => ({
        id: o.id,
        name: o.name,
        email: o.email,
        role: o.role,
        isActive: Boolean(o.is_active),
        createdAt: o.created_at,
        updatedAt: o.updated_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/operators error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.post('/api/operators', requireRole('owner','admin'), async (c) => {
  try {
    const body = await c.req.json<{ name: string; email: string; role?: string }>();
    if (!body.name || !body.email) return c.json({ success: false, error: 'name and email are required' }, 400);
    const item = await createOperator(c.env.DB, body);
    return c.json({ success: true, data: { id: item.id, name: item.name, email: item.email, role: item.role } }, 201);
  } catch (err) {
    console.error('POST /api/operators error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.put('/api/operators/:id', requireRole('owner','admin'), async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    await updateOperator(c.env.DB, id, body);
    const updated = await getOperatorById(c.env.DB, id);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: { id: updated.id, name: updated.name, email: updated.email, role: updated.role, isActive: Boolean(updated.is_active) } });
  } catch (err) {
    console.error('PUT /api/operators/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.delete('/api/operators/:id', requireRole('owner','admin'), async (c) => {
  try {
    await deleteOperator(c.env.DB, c.req.param('id'));
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/operators/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== チャットCRUD ==========

// BOXIV: friends.metadata の Notion 連携（出品者DB / 購入者DB）。
// `notion` は primary（出品者優先・無ければ購入者）の1件で、一覧の表示名に使う。
// `notionLinks` は両方を持つ（チャット詳細のピル表示用）。
function parseFriendNotionLinks(metadataJson: unknown): NotionFriendLinks {
  return readNotionLinks(typeof metadataJson === 'string' ? metadataJson : null);
}

chats.get('/api/chats', async (c) => {
  try {
    const status = c.req.query('status') ?? undefined;
    const operatorId = c.req.query('operatorId') ?? undefined;
    const lineAccountId = c.req.query('lineAccountId') ?? undefined;
    const statusOptionId = c.req.query('statusOptionId') ?? undefined;

    // JOIN friends to get display_name / picture / metadata + current Notion-synced status.
    //
    // BOXIV: friend_source は分類タグ（出品者/購入者）から解決した source。
    // 管理UIの「全て / 出品者 / 購入者」タブの絞り込みと並び順に使う。判定順は web 側
    // friend-source.ts と同じ（出品者を先に見る）。タグ一覧を別途引かずに済むよう
    // 相関サブクエリで1回に畳んでいる（タグ名は SOURCE_TAG_NAMES を bind）。
    let sql = `SELECT c.*, f.display_name, f.managed_name, f.picture_url, f.line_user_id, f.metadata,
                      so.id AS status_option_id, so.name AS status_option_name,
                      so.color AS status_option_color, so.source AS status_option_source,
                      (SELECT CASE
                                WHEN MAX(CASE WHEN t.name = ? THEN 1 ELSE 0 END) = 1 THEN 'seller'
                                WHEN MAX(CASE WHEN t.name = ? THEN 1 ELSE 0 END) = 1 THEN 'buyer'
                              END
                         FROM friend_tags ft
                         JOIN tags t ON t.id = ft.tag_id
                        WHERE ft.friend_id = c.friend_id) AS friend_source,
                      -- BOXIV: 未送信の下書き件数。一覧に ✏️n を出して「用意されているのに
                      -- 送られていない」チャットに気づけるようにする（送信は必ず人が行う）。
                      (SELECT COUNT(*) FROM message_drafts d WHERE d.friend_id = c.friend_id) AS draft_count,
                      (SELECT COUNT(*) FROM messages_log m
                         WHERE m.friend_id = c.friend_id AND m.direction = 'incoming'
                           AND (c.last_read_at IS NULL OR m.created_at > c.last_read_at)) AS unread_count
               FROM chats c
               LEFT JOIN friends f ON c.friend_id = f.id
               LEFT JOIN friend_status_assignments fsa ON fsa.friend_id = f.id
               LEFT JOIN status_options so ON so.id = fsa.status_option_id`;
    const conditions: string[] = [];
    // SELECT 側のプレースホルダが先に来るので、WHERE 条件より前に積む。
    const bindings: unknown[] = [SOURCE_TAG_NAMES.seller, SOURCE_TAG_NAMES.buyer];

    if (status) {
      conditions.push('c.status = ?');
      bindings.push(status);
    }
    if (operatorId) {
      conditions.push('c.operator_id = ?');
      bindings.push(operatorId);
    }
    if (lineAccountId) {
      conditions.push('f.line_account_id = ?');
      bindings.push(lineAccountId);
    }
    if (statusOptionId) {
      conditions.push('fsa.status_option_id = ?');
      bindings.push(statusOptionId);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY c.last_message_at DESC';

    const result = await c.env.DB.prepare(sql).bind(...bindings).all();

    return c.json({
      success: true,
      data: result.results.map((ch: Record<string, unknown>) => ({
        id: ch.id,
        friendId: ch.friend_id,
        friendName: ch.display_name || '名前なし',
        managedName: ch.managed_name ?? null,
        friendPictureUrl: ch.picture_url || null,
        notion: primaryLink(parseFriendNotionLinks(ch.metadata)),
        // 分類タグ由来の出品者/購入者。どちらのタグも無ければ null（未分類）。
        source: (ch.friend_source as 'seller' | 'buyer' | null) ?? null,
        customerStatus: ch.status_option_id
          ? {
              id: ch.status_option_id,
              name: ch.status_option_name,
              color: ch.status_option_color,
              source: ch.status_option_source,
            }
          : null,
        operatorId: ch.operator_id,
        status: ch.status,
        notes: ch.notes,
        lastMessageAt: ch.last_message_at,
        unreadCount: Number(ch.unread_count) || 0,
        draftCount: Number(ch.draft_count) || 0,
        createdAt: ch.created_at,
        updatedAt: ch.updated_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/chats error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.get('/api/chats/:id', async (c) => {
  try {
    const item = await getChatById(c.env.DB, c.req.param('id'));
    if (!item) return c.json({ success: false, error: 'Chat not found' }, 404);

    // 友だち情報を取得
    const friend = await c.env.DB
      .prepare(`SELECT display_name, managed_name, picture_url, line_user_id, metadata FROM friends WHERE id = ?`)
      .bind(item.friend_id)
      .first<{ display_name: string | null; managed_name: string | null; picture_url: string | null; line_user_id: string; metadata: string | null }>();

    // チャットに関連するメッセージログも取得
    const messages = await c.env.DB
      .prepare(`SELECT id, friend_id, direction, message_type, content, status, line_message_id, quoted_message_id, sent_by_name, created_at FROM messages_log WHERE friend_id = ? ORDER BY created_at ASC LIMIT 200`)
      .bind(item.friend_id)
      .all();

    // 引用返信の引用元を解決（quoted_message_id → 引用元メッセージのプレビュー）
    const rows = messages.results as unknown as Array<QuotableRow & { status: string | null; sent_by_name: string | null; created_at: string }>;
    const quoteIndex = await buildQuoteIndex(c.env.DB, item.friend_id, rows);

    return c.json({
      success: true,
      data: {
        id: item.id,
        friendId: item.friend_id,
        friendName: friend?.display_name || '名前なし',
        managedName: friend?.managed_name ?? null,
        lineUserId: friend?.line_user_id ?? null,
        friendPictureUrl: friend?.picture_url || null,
        notion: primaryLink(parseFriendNotionLinks(friend?.metadata ?? null)),
        // 出品者/購入者それぞれの連携（両方持ち得る）。詳細ヘッダのピル表示に使う。
        notionLinks: parseFriendNotionLinks(friend?.metadata ?? null),
        operatorId: item.operator_id,
        status: item.status,
        notes: item.notes,
        lastMessageAt: item.last_message_at,
        createdAt: item.created_at,
        messages: rows.map((m) => ({
          id: m.id,
          direction: m.direction,
          messageType: m.message_type,
          content: m.content,
          status: m.status,
          // 送信者名（migration 923）。自動送信は NULL。管理画面だけの表示で顧客には出ない。
          sentByName: m.sent_by_name ?? null,
          createdAt: m.created_at,
          // 引用返信: quotedMessageId が非NULL = 引用元あり。解決できた場合のみ quotedMessage を返す。
          quotedMessageId: m.quoted_message_id ?? null,
          quotedMessage: m.quoted_message_id ? quoteIndex.get(m.quoted_message_id) ?? null : null,
        })),
      },
    });
  } catch (err) {
    console.error('GET /api/chats/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.post('/api/chats', requireRole('owner','admin','manager'), async (c) => {
  try {
    const body = await c.req.json<{ friendId: string; operatorId?: string; lineAccountId?: string | null }>();
    if (!body.friendId) return c.json({ success: false, error: 'friendId is required' }, 400);

    // Find-or-create: avoid creating duplicate chat sessions for the same friend.
    // The webhook path already uses upsertChatOnMessage; this brings the
    // operator-initiated path in line with that behaviour.
    const existing = await getChatByFriendId(c.env.DB, body.friendId);
    if (existing) {
      if (body.lineAccountId) {
        await c.env.DB.prepare(`UPDATE chats SET line_account_id = ? WHERE id = ?`)
          .bind(body.lineAccountId, existing.id).run();
      }
      return c.json({ success: true, data: { id: existing.id, friendId: existing.friend_id, status: existing.status } });
    }

    const item = await createChat(c.env.DB, body);
    if (body.lineAccountId) {
      await c.env.DB.prepare(`UPDATE chats SET line_account_id = ? WHERE id = ?`)
        .bind(body.lineAccountId, item.id).run();
    }
    return c.json({ success: true, data: { id: item.id, friendId: item.friend_id, status: item.status } }, 201);
  } catch (err) {
    console.error('POST /api/chats error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// チャットのアサイン/ステータス更新/ノート更新
chats.put('/api/chats/:id', requireRole('owner','admin','manager'), async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{ operatorId?: string | null; status?: string; notes?: string }>();
    await updateChat(c.env.DB, id, body);
    const updated = await getChatById(c.env.DB, id);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      data: { id: updated.id, friendId: updated.friend_id, operatorId: updated.operator_id, status: updated.status, notes: updated.notes },
    });
  } catch (err) {
    console.error('PUT /api/chats/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// チャットを既読にする（last_read_at を now に更新→未読数を 0 に戻す）。status も in_progress へ。
chats.post('/api/chats/:id/read', requireRole('owner','admin','manager'), async (c) => {
  try {
    const id = c.req.param('id');
    const existing = await getChatById(c.env.DB, id);
    if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
    const now = jstNow();
    await updateChat(c.env.DB, id, {
      lastReadAt: now,
      status: existing.status === 'unread' ? 'in_progress' : existing.status,
    });
    return c.json({ success: true, data: { id, lastReadAt: now } });
  } catch (err) {
    console.error('POST /api/chats/:id/read error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// オペレーター入力中のローディング表示を開始
chats.post('/api/chats/:id/loading', requireRole('owner','admin','manager'), async (c) => {
  try {
    const chatId = c.req.param('id');
    const chat = await getChatById(c.env.DB, chatId);
    if (!chat) return c.json({ success: false, error: 'Chat not found' }, 404);

    let loadingSecondsInput: number | undefined;
    try {
      const body = await c.req.json<{ loadingSeconds?: number }>();
      loadingSecondsInput = body.loadingSeconds;
    } catch {
      loadingSecondsInput = undefined;
    }
    const loadingSeconds = clampLoadingSeconds(loadingSecondsInput);

    const friend = await c.env.DB
      .prepare(`SELECT * FROM friends WHERE id = ?`)
      .bind(chat.friend_id)
      .first<{ id: string; line_user_id: string }>();
    if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);

    await startLoadingAnimation(
      c.env.LINE_CHANNEL_ACCESS_TOKEN,
      friend.line_user_id,
      loadingSeconds,
    );

    return c.json({ success: true, data: { started: true, loadingSeconds } });
  } catch (err) {
    console.error('POST /api/chats/:id/loading error:', err);
    const message = err instanceof Error ? err.message : 'Internal server error';
    return c.json({ success: false, error: message }, 500);
  }
});

// オペレーターからメッセージ送信
chats.post('/api/chats/:id/send', requireRole('owner','admin','manager'), async (c) => {
  try {
    const chatId = c.req.param('id');
    const chat = await getChatById(c.env.DB, chatId);
    if (!chat) return c.json({ success: false, error: 'Chat not found' }, 404);

    const body = await c.req.json<{ messageType?: string; content: string }>();
    if (!body.content) return c.json({ success: false, error: 'content is required' }, 400);

    // BOXIV: 「誰が送ったか」を messages_log に残す（migration 923）。オペレーターチャットの
    // 送信バブルに日時と並べて出す。requireRole を通っているので staff は必ずある。
    const actor = c.get('staff');

    const friend = await c.env.DB
      .prepare(`SELECT id, line_user_id, is_following, metadata FROM friends WHERE id = ?`)
      .bind(chat.friend_id)
      .first<{ id: string; line_user_id: string; is_following: number; metadata: string | null }>();
    if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);

    const messageType = body.messageType ?? 'text';

    // 未フォロー（友だち未追加/ブロック中）には送れない。LINE は push に 200 を返すが届かないため、
    // オペレーターに失敗を即時通知し、送信失敗として記録する（黙って成功扱いにしない）。
    if (!friend.is_following) {
      await logFailedOutgoing(c.env.DB, friend.id, messageType, body.content, actor);
      return c.json({ success: false, error: 'この友だちは未フォロー（友だち未追加・ブロック中）のため送信できません。友だち追加を依頼してください。' }, 422);
    }

    // LINE APIでメッセージ送信 — buildMessage で text / image / video / flex / file を統一処理
    const { LineClient } = await import('@line-crm/line-sdk');
    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    const lineMessage = buildMessage(messageType, body.content);
    // 送信レスポンスの sentMessages[].id を line_message_id に保存 → 友だちがこのメッセージを
    // 引用返信した際に引用元として解決できるようにする。
    let sentLineId: string | null = null;
    try {
      sentLineId = firstSentMessageId(await lineClient.pushMessage(friend.line_user_id, [lineMessage]));
    } catch (err) {
      await logFailedOutgoing(c.env.DB, friend.id, messageType, body.content, actor);
      console.error('POST /api/chats/:id/send: LINE push failed', err);
      return c.json({ success: false, error: 'LINE への送信に失敗しました。時間をおいて再度お試しください。' }, 502);
    }

    // メッセージログに記録
    const logId = crypto.randomUUID();
    await c.env.DB
      .prepare(`INSERT INTO messages_log (id, friend_id, direction, message_type, content, line_message_id, sent_by_id, sent_by_name, created_at) VALUES (?, ?, 'outgoing', ?, ?, ?, ?, ?, ?)`)
      .bind(logId, friend.id, messageType, body.content, sentLineId, actor.id, actor.name, jstNow())
      .run();

    // チャットの最終メッセージ日時を更新。返信＝既読とみなし last_read_at も now にして未読数を 0 に戻す。
    await updateChat(c.env.DB, chatId, { status: 'in_progress', lastMessageAt: jstNow(), lastReadAt: jstNow() });

    // BOXIV: Notion 出品者DB との初回自動連携（出品者リンク未設定のときだけ）。
    // 購入者は1人が複数の商談行を持ち自動選択を誤ると反映先が固定されるため、自動連携しない
    // （購入者リンクはチャットの Notion連携ピッカーからオペレーターが明示的に張る）。
    if (!readNotionLinks(friend.metadata)['seller']?.pageId) {
      const promise = linkFriendToNotion(c.env.DB, c.env, friend.id, friend.line_user_id)
        .catch((err) => console.error('auto notion link failed for', friend.id, err));
      c.executionCtx.waitUntil(promise);
    }

    return c.json({ success: true, data: { sent: true, messageId: logId } });
  } catch (err) {
    console.error('POST /api/chats/:id/send error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { chats };
