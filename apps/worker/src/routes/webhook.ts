import { Hono } from 'hono';
import { verifySignature, LineClient } from '@line-crm/line-sdk';
import type { WebhookRequestBody, WebhookEvent, TextEventMessage } from '@line-crm/line-sdk';
import {
  upsertFriend,
  updateFriendFollowStatus,
  getFriendByLineUserId,
  getScenarios,
  enrollFriendInScenario,
  getScenarioSteps,
  advanceFriendScenario,
  completeFriendScenario,
  upsertChatOnMessage,
  getLineAccounts,
  jstNow,
} from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { buildMessage, expandVariables } from '../services/step-delivery.js';
import { ingestLineMedia } from '../services/incoming-media.boxiv.js';
import { enqueueBurstNotify } from '../services/slack-burst-notify.boxiv.js';
import { getLinkedEntryByLineUserId, hasListingPriceNotified, markListingPriceNotified } from '../services/listing-entry.boxiv.js';
import { firstSentMessageId } from '../utils/quote.js';
import type { Env } from '../index.js';

const webhook = new Hono<Env>();

webhook.post('/webhook', async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header('X-Line-Signature') ?? '';
  const db = c.env.DB;

  let body: WebhookRequestBody;
  try {
    body = JSON.parse(rawBody) as WebhookRequestBody;
  } catch {
    console.error('Failed to parse webhook body');
    return c.json({ status: 'ok' }, 200);
  }

  // Multi-account: resolve credentials from DB by destination (channel user ID)
  // or fall back to environment variables (default account)
  let channelSecret = c.env.LINE_CHANNEL_SECRET;
  let channelAccessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
  let matchedAccountId: string | null = null;

  if ((body as { destination?: string }).destination) {
    const accounts = await getLineAccounts(db);
    for (const account of accounts) {
      if (!account.is_active) continue;
      const isValid = await verifySignature(account.channel_secret, rawBody, signature);
      if (isValid) {
        channelSecret = account.channel_secret;
        channelAccessToken = account.channel_access_token;
        matchedAccountId = account.id;
        break;
      }
    }
  }

  // Verify with resolved secret
  const valid = await verifySignature(channelSecret, rawBody, signature);
  if (!valid) {
    console.error('Invalid LINE signature');
    return c.json({ status: 'ok' }, 200);
  }

  const lineClient = new LineClient(channelAccessToken);

  // 非同期処理 — LINE は ~1s 以内のレスポンスを要求
  const processingPromise = (async () => {
    const incoming: Array<{ friendId: string; msgId: string }> = [];
    for (const event of body.events) {
      try {
        await handleEvent(db, lineClient, event, channelAccessToken, matchedAccountId, c.env.WORKER_URL || new URL(c.req.url).origin, c.env.LIFF_URL, c.env.IMAGES, (fid, mid) => incoming.push({ friendId: fid, msgId: mid }));
      } catch (err) {
        console.error('Error handling webhook event:', err);
      }
    }
    // BOXIV: 受信メッセージを Slack 通知用バッファに積む（friend 単位・30秒デバウンス）。
    // 実送信は cron(1分)の processSlackBurstNotify が担当し、slack_notified_at で重複を防ぐ。
    if (c.env.CHAT_ALERT_SLACK_BOT_TOKEN && c.env.CHAT_ALERT_SLACK_CHANNEL_ID && incoming.length) {
      const uniqueFriendIds = [...new Set(incoming.map((i) => i.friendId))];
      await Promise.all(uniqueFriendIds.map((fid) => enqueueBurstNotify(db, fid, matchedAccountId)));
    }
  })();

  c.executionCtx.waitUntil(processingPromise);

  return c.json({ status: 'ok' }, 200);
});

// BOXIV: Lstep からの移行で、既存の OA 友だちが Connect の D1 に未登録のことがある。
// follow イベントは新規追加時にしか来ないため、既存友だちが postback / message で
// 初めて接触した時にプロフィールを取得して登録する（lazy backfill）。これが無いと
// 既存友だちのリッチメニュータップ等が friend 不在で黙って無視される。
async function resolveOrCreateFriend(
  db: D1Database,
  lineClient: LineClient,
  userId: string,
  lineAccountId: string | null = null,
) {
  const existing = await getFriendByLineUserId(db, userId);
  if (existing) return existing;
  let profile;
  try {
    profile = await lineClient.getProfile(userId);
  } catch (err) {
    console.error('resolveOrCreateFriend: getProfile failed for', userId, err);
  }
  const friend = await upsertFriend(db, {
    lineUserId: userId,
    displayName: profile?.displayName ?? null,
    pictureUrl: profile?.pictureUrl ?? null,
    statusMessage: profile?.statusMessage ?? null,
    // 接触（message/postback）が来た時点で相手は OA を友だち追加済み（=push 可能）。
    isFollowing: true,
  });
  if (lineAccountId) {
    await db
      .prepare('UPDATE friends SET line_account_id = ? WHERE id = ? AND line_account_id IS NULL')
      .bind(lineAccountId, friend.id)
      .run();
  }
  return friend;
}

async function handleEvent(
  db: D1Database,
  lineClient: LineClient,
  event: WebhookEvent,
  lineAccessToken: string,
  lineAccountId: string | null = null,
  workerUrl?: string,
  liffUrl?: string,
  mediaBucket?: R2Bucket,
  onIncoming?: (friendId: string, msgId: string) => void,
): Promise<void> {
  if (event.type === 'follow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    // プロフィール取得 & 友だち登録/更新
    let profile;
    try {
      profile = await lineClient.getProfile(userId);
    } catch (err) {
      console.error('Failed to get profile for', userId, err);
    }

    const friend = await upsertFriend(db, {
      lineUserId: userId,
      displayName: profile?.displayName ?? null,
      pictureUrl: profile?.pictureUrl ?? null,
      statusMessage: profile?.statusMessage ?? null,
      // follow イベント = 友だち追加（またはブロック解除）。確実に push 可能。
      isFollowing: true,
    });

    // Set line_account_id for multi-account tracking
    if (lineAccountId) {
      await db.prepare('UPDATE friends SET line_account_id = ? WHERE id = ? AND line_account_id IS NULL')
        .bind(lineAccountId, friend.id).run();
    }

    // BOXIV: 友だち追加完了フロー — 出品フォーム連携済みかで分岐する。
    //   連携済み(listing_entries.status='linked') → 出品価格お知らせ(listing_link_completed)を送信。
    //     OAuth 時に未フォロー/ブロックで送れなかった分の救済になり、後から友だち追加した人にも届く。
    //     二重送信は friend.metadata フラグ(listing_price_notified)で防止。連携済みは挨拶(friend_add)を送らない。
    //   未連携(ふつうのユーザ: フォーム未入力/広告登録のみ) → 既存の friend_add シナリオ（挨拶）。
    const linkedEntry = await getLinkedEntryByLineUserId(db, userId);
    if (linkedEntry) {
      if (!(await hasListingPriceNotified(db, friend.id))) {
        await fireEvent(
          db,
          'listing_link_completed',
          {
            friendId: friend.id,
            eventData: { formId: linkedEntry.match_key, displayName: friend.display_name, formInputName: linkedEntry.name ?? null },
          },
          lineAccessToken,
          lineAccountId,
        );
        await markListingPriceNotified(db, friend.id);
        console.log(`follow: 連携済み出品ユーザへ listing_link_completed を送信 friend=${friend.id} match_key=${linkedEntry.match_key}`);
      } else {
        console.log(`follow: 連携済みだが価格お知らせ送信済み — スキップ friend=${friend.id}`);
      }
      return; // 連携済みは friend_add（挨拶/イベント）を送らず終了
    }

    // friend_add シナリオに登録（このアカウントのシナリオのみ）
    const scenarios = await getScenarios(db);
    for (const scenario of scenarios) {
      // Only trigger scenarios belonging to this account (or unassigned for backward compat)
      const scenarioAccountMatch = !scenario.line_account_id || !lineAccountId || scenario.line_account_id === lineAccountId;
      if (scenario.trigger_type === 'friend_add' && scenario.is_active && scenarioAccountMatch) {
        try {
          const existing = await db
            .prepare(`SELECT id FROM friend_scenarios WHERE friend_id = ? AND scenario_id = ?`)
            .bind(friend.id, scenario.id)
            .first<{ id: string }>();
          if (!existing) {
            const friendScenario = await enrollFriendInScenario(db, friend.id, scenario.id);

            // Immediate delivery: if the first step has delay=0, send it now via replyMessage (free)
            const steps = await getScenarioSteps(db, scenario.id);
            const firstStep = steps[0];
            if (firstStep && firstStep.delay_minutes === 0 && friendScenario.status === 'active') {
              try {
                const expandedContent = expandVariables(firstStep.message_content, friend as { id: string; display_name: string | null; user_id: string | null });
                const message = buildMessage(firstStep.message_type, expandedContent);
                const sentLineId = firstSentMessageId(await lineClient.replyMessage(event.replyToken, [message]));
                console.log(`Immediate delivery: sent step ${firstStep.id} to ${userId}`);

                // Log outgoing message (replyMessage = 無料)。line_message_id=友だちの引用解決用。
                const logId = crypto.randomUUID();
                await db
                  .prepare(
                    `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, line_message_id, delivery_type, created_at)
                     VALUES (?, ?, 'outgoing', ?, ?, NULL, ?, ?, 'reply', ?)`,
                  )
                  .bind(logId, friend.id, firstStep.message_type, firstStep.message_content, firstStep.id, sentLineId, jstNow())
                  .run();

                // Advance or complete the friend_scenario
                const secondStep = steps[1] ?? null;
                if (secondStep) {
                  const nextDeliveryDate = new Date(Date.now() + 9 * 60 * 60_000);
                  nextDeliveryDate.setMinutes(nextDeliveryDate.getMinutes() + secondStep.delay_minutes);
                  // Enforce 9:00-21:00 JST delivery window
                  const h = nextDeliveryDate.getUTCHours();
                  if (h < 9 || h >= 21) {
                    if (h >= 21) nextDeliveryDate.setUTCDate(nextDeliveryDate.getUTCDate() + 1);
                    nextDeliveryDate.setUTCHours(9, 0, 0, 0);
                  }
                  await advanceFriendScenario(db, friendScenario.id, firstStep.step_order, nextDeliveryDate.toISOString().slice(0, -1) + '+09:00');
                } else {
                  await completeFriendScenario(db, friendScenario.id);
                }
              } catch (err) {
                console.error('Failed immediate delivery for scenario', scenario.id, err);
              }
            }
          }
        } catch (err) {
          console.error('Failed to enroll friend in scenario', scenario.id, err);
        }
      }
    }

    // イベントバス発火: friend_add（replyToken は Step 0 で使用済みの可能性あり）
    await fireEvent(db, 'friend_add', { friendId: friend.id, eventData: { displayName: friend.display_name } }, lineAccessToken, lineAccountId);
    return;
  }

  if (event.type === 'unfollow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    await updateFriendFollowStatus(db, userId, false);
    return;
  }

  // BOXIV patch: postback event handling (rich menu tap / template button tap)
  // Fires `postback_received` on the event bus so automations can match on
  // `postback_data` (e.g. リッチメニュー「車を出品する」→ menu=premium-listing)。
  if (event.type === 'postback') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;
    const friend = await resolveOrCreateFriend(db, lineClient, userId, lineAccountId);
    if (!friend) return;
    const data = event.postback?.data ?? '';
    await fireEvent(
      db,
      'postback_received',
      {
        friendId: friend.id,
        eventData: { data, params: event.postback?.params ?? null },
        replyToken: event.replyToken,
      },
      lineAccessToken,
      lineAccountId,
    );
    return;
  }

  if (event.type === 'message' && event.message.type === 'text') {
    const textMessage = event.message as TextEventMessage;
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    const friend = await resolveOrCreateFriend(db, lineClient, userId, lineAccountId);
    if (!friend) return;

    const incomingText = textMessage.text;
    const now = jstNow();
    const logId = crypto.randomUUID();

    // 引用返信のとき LINE は quotedMessageId（引用元の messageId）を付ける。
    // line-sdk の型には未定義のためローカルキャストで読む。引用解決のキーは line_message_id。
    const lineMessageId = textMessage.id ?? null;
    const quotedMessageId = (event.message as { quotedMessageId?: string }).quotedMessageId ?? null;

    // 受信メッセージをログに記録（line_message_id / quoted_message_id を保存 → ダッシュボードで引用元を復元）
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, line_message_id, quoted_message_id, created_at)
         VALUES (?, ?, 'incoming', 'text', ?, NULL, NULL, ?, ?, ?)`,
      )
      .bind(logId, friend.id, incomingText, lineMessageId, quotedMessageId, now)
      .run();

    // BOXIV: Slack 通知の対象に記録（webhook 側で塊にまとめて1通に）
    onIncoming?.(friend.id, logId);

    // チャットを作成/更新（ユーザーの自発的メッセージのみ unread にする）
    // ボタンタップ等の自動応答キーワードは除外
    const autoKeywords = ['料金', '機能', 'API', 'フォーム', 'ヘルプ', 'UUID', 'UUID連携について教えて', 'UUID連携を確認', '配信時間', '導入支援を希望します', 'アカウント連携を見る', '体験を完了する', 'BAN対策を見る', '連携確認'];
    const isAutoKeyword = autoKeywords.some(k => incomingText === k);
    const isTimeCommand = /(?:配信時間|配信|届けて|通知)[はを]?\s*\d{1,2}\s*時/.test(incomingText);
    if (!isAutoKeyword && !isTimeCommand) {
      await upsertChatOnMessage(db, friend.id);
    }

    // 配信時間設定: 「配信時間は○時」「○時に届けて」等のパターンを検出
    const timeMatch = incomingText.match(/(?:配信時間|配信|届けて|通知)[はを]?\s*(\d{1,2})\s*時/);
    if (timeMatch) {
      const hour = parseInt(timeMatch[1], 10);
      if (hour >= 6 && hour <= 22) {
        // Save preferred_hour to friend metadata
        const existing = await db.prepare('SELECT metadata FROM friends WHERE id = ?').bind(friend.id).first<{ metadata: string }>();
        const meta = JSON.parse(existing?.metadata || '{}');
        meta.preferred_hour = hour;
        await db.prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
          .bind(JSON.stringify(meta), jstNow(), friend.id).run();

        // Reply with confirmation
        try {
          const period = hour < 12 ? '午前' : '午後';
          const displayHour = hour <= 12 ? hour : hour - 12;
          await lineClient.replyMessage(event.replyToken, [
            buildMessage('flex', JSON.stringify({
              type: 'bubble',
              body: { type: 'box', layout: 'vertical', contents: [
                { type: 'text', text: '配信時間を設定しました', size: 'lg', weight: 'bold', color: '#1e293b' },
                { type: 'box', layout: 'vertical', contents: [
                  { type: 'text', text: `${period} ${displayHour}:00`, size: 'xxl', weight: 'bold', color: '#f59e0b', align: 'center' },
                  { type: 'text', text: `（${hour}:00〜）`, size: 'sm', color: '#64748b', align: 'center', margin: 'sm' },
                ], backgroundColor: '#fffbeb', cornerRadius: 'md', paddingAll: '20px', margin: 'lg' },
                { type: 'text', text: '今後のステップ配信はこの時間以降にお届けします。', size: 'xs', color: '#64748b', wrap: true, margin: 'lg' },
              ], paddingAll: '20px' },
            })),
          ]);
        } catch (err) {
          console.error('Failed to reply for time setting', err);
        }
        return;
      }
    }

    // Cross-account trigger: send message from another account via UUID
    if (incomingText === '体験を完了する' && lineAccountId) {
      try {
        const friendRecord = await db.prepare('SELECT user_id FROM friends WHERE id = ?').bind(friend.id).first<{ user_id: string | null }>();
        if (friendRecord?.user_id) {
          // Find the same user on other accounts
          const otherFriends = await db.prepare(
            'SELECT f.line_user_id, la.channel_access_token FROM friends f INNER JOIN line_accounts la ON la.id = f.line_account_id WHERE f.user_id = ? AND f.line_account_id != ? AND f.is_following = 1'
          ).bind(friendRecord.user_id, lineAccountId).all<{ line_user_id: string; channel_access_token: string }>();

          for (const other of otherFriends.results) {
            const otherClient = new LineClient(other.channel_access_token);
            const { buildMessage: bm } = await import('../services/step-delivery.js');
            await otherClient.pushMessage(other.line_user_id, [bm('flex', JSON.stringify({
              type: 'bubble', size: 'giga',
              header: { type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: '#fffbeb',
                contents: [{ type: 'text', text: `${friend.display_name || ''}さんへ`, size: 'lg', weight: 'bold', color: '#1e293b' }],
              },
              body: { type: 'box', layout: 'vertical', paddingAll: '20px',
                contents: [
                  { type: 'text', text: '別アカウントからのアクションを検知しました。', size: 'sm', color: '#0f172a', weight: 'bold', wrap: true },
                  { type: 'text', text: 'アカウント連携が正常に動作しています。体験ありがとうございました。', size: 'sm', color: '#1e293b', wrap: true, margin: 'md' },
                  { type: 'separator', margin: 'lg' },
                  { type: 'text', text: 'ステップ配信・フォーム即返信・アカウント連携・リッチメニュー・自動返信 — 全て無料、全てOSS。', size: 'xs', color: '#64748b', wrap: true, margin: 'lg' },
                ],
              },
              footer: { type: 'box', layout: 'vertical', paddingAll: '16px',
                contents: [
                  { type: 'button', action: { type: 'message', label: '導入について相談する', text: '導入支援を希望します' }, style: 'primary', color: '#0f172a' },
                  ...(liffUrl ? [{ type: 'button', action: { type: 'uri', label: 'フィードバックを送る', uri: `${liffUrl}?page=form` }, style: 'secondary', margin: 'sm' }] : []),
                ],
              },
            }))]);
          }

          // Reply on Account ② confirming
          await lineClient.replyMessage(event.replyToken, [buildMessage('flex', JSON.stringify({
            type: 'bubble',
            body: { type: 'box', layout: 'vertical', paddingAll: '20px',
              contents: [
                { type: 'text', text: 'Account ① にメッセージを送りました', size: 'sm', color: '#0f172a', weight: 'bold', align: 'center' },
                { type: 'text', text: 'Account ① のトーク画面を確認してください', size: 'xs', color: '#64748b', align: 'center', margin: 'md' },
              ],
            },
          }))]);
          return;
        }
      } catch (err) {
        console.error('Cross-account trigger error:', err);
      }
    }

    // 自動返信チェック（このアカウントのルール + グローバルルールのみ）
    // NOTE: Auto-replies use replyMessage (free, no quota) instead of pushMessage
    // The replyToken is only valid for ~1 minute after the message event
    const autoReplyQuery = lineAccountId
      ? `SELECT * FROM auto_replies WHERE is_active = 1 AND (line_account_id IS NULL OR line_account_id = ?) ORDER BY created_at ASC`
      : `SELECT * FROM auto_replies WHERE is_active = 1 AND line_account_id IS NULL ORDER BY created_at ASC`;
    const autoReplyStmt = db.prepare(autoReplyQuery);
    const autoReplies = await (lineAccountId ? autoReplyStmt.bind(lineAccountId) : autoReplyStmt)
      .all<{
        id: string;
        keyword: string;
        match_type: 'exact' | 'contains';
        response_type: string;
        response_content: string;
        is_active: number;
        created_at: string;
      }>();

    let matched = false;
    let replyTokenConsumed = false;
    for (const rule of autoReplies.results) {
      const isMatch =
        rule.match_type === 'exact'
          ? incomingText === rule.keyword
          : incomingText.includes(rule.keyword);

      if (isMatch) {
        try {
          // Expand template variables ({{name}}, {{uid}}, {{auth_url:CHANNEL_ID}})
          const expandedContent = expandVariables(rule.response_content, friend as { id: string; display_name: string | null; user_id: string | null }, workerUrl);
          const replyMsg = buildMessage(rule.response_type, expandedContent);
          const sentLineId = firstSentMessageId(await lineClient.replyMessage(event.replyToken, [replyMsg]));
          replyTokenConsumed = true;

          // 送信ログ（replyMessage = 無料）。line_message_id=友だちの引用解決用。
          const outLogId = crypto.randomUUID();
          await db
            .prepare(
              `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, line_message_id, delivery_type, created_at)
               VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, ?, 'reply', ?)`,
            )
            .bind(outLogId, friend.id, rule.response_type, rule.response_content, sentLineId, jstNow())
            .run();
        } catch (err) {
          console.error('Failed to send auto-reply', err);
          // replyToken may still be unused if replyMessage threw before LINE accepted it
        }

        matched = true;
        break;
      }
    }

    // イベントバス発火: message_received
    // Pass replyToken only when auto_reply didn't actually consume it
    await fireEvent(db, 'message_received', {
      friendId: friend.id,
      eventData: { text: incomingText, matched },
      replyToken: replyTokenConsumed ? undefined : event.replyToken,
    }, lineAccessToken, lineAccountId);

    return;
  }

  // BOXIV: handle incoming media (image / video / audio / file).
  // Download binary from LINE Data API, persist to R2, log to messages_log.
  if (
    event.type === 'message' &&
    (event.message.type === 'image' || event.message.type === 'video' ||
     event.message.type === 'audio' || event.message.type === 'file')
  ) {
    const userId = event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;
    const friend = await resolveOrCreateFriend(db, lineClient, userId, lineAccountId);
    if (!friend) return;

    const kind = event.message.type;
    const messageId = event.message.id;
    // 引用返信のとき LINE は quotedMessageId（引用元の messageId）を付ける。line-sdk の型には未定義。
    const quotedMessageId = (event.message as { quotedMessageId?: string }).quotedMessageId ?? null;
    if (!mediaBucket) {
      console.error(`webhook: media bucket not configured — skipping ${kind}`);
      return;
    }
    let info;
    try {
      info = await ingestLineMedia(
        mediaBucket,
        lineAccessToken,
        workerUrl ?? '',
        messageId,
        kind,
        kind === 'file'
          ? { fileName: event.message.fileName }
          : kind === 'video' || kind === 'audio'
            ? { duration: event.message.duration }
            : undefined,
      );
    } catch (err) {
      console.error(`webhook: failed to ingest ${kind} ${messageId}:`, err);
      // Still log a stub so the chat doesn't show a hole
      await db
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, line_message_id, quoted_message_id, created_at)
           VALUES (?, ?, 'incoming', ?, ?, NULL, NULL, ?, ?, ?)`,
        )
        .bind(crypto.randomUUID(), friend.id, kind, JSON.stringify({ error: 'ingest failed', messageId }), messageId, quotedMessageId, jstNow())
        .run();
      await upsertChatOnMessage(db, friend.id);
      return;
    }

    const mediaLogId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, line_message_id, quoted_message_id, created_at)
         VALUES (?, ?, 'incoming', ?, ?, NULL, NULL, ?, ?, ?)`,
      )
      .bind(mediaLogId, friend.id, kind, JSON.stringify(info), messageId, quotedMessageId, jstNow())
      .run();
    await upsertChatOnMessage(db, friend.id);
    onIncoming?.(friend.id, mediaLogId);
    return;
  }
}

export { webhook };
