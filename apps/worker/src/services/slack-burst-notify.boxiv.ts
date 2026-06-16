// BOXIV-only: 受信メッセージの Slack 通知をバースト集約する（30秒デバウンス）。
//
// 旧実装（webhook.ts の scheduleBurstNotify）は setTimeout(8s) と「自分が最新 incoming か」
// の判定だけで重複を防ごうとしていたが、通知済みマーカーが無く Worker invocation 間で状態を
// 共有できないため、② が ① の debounce 窓外に届くと「① 単独」→（5分窓で①を再取得して）
// 「①+②」の二重送信が起きていた。本実装は setTimeout を全廃し、
//   1. 受信時は D1 のバッファ(slack_notify_buffers)に notify_after=最終受信+30秒 を UPSERT するだけ
//   2. cron(1分)が「30秒沈黙したまとまり」を1通にまとめて送信し、送った行に
//      messages_log.slack_notified_at（永続マーカー）を刻む＝二度と再送しない
// で重複を根絶しつつ 30秒バッファでまとめる。CHAT_ALERT_SLACK_* 未設定なら no-op。
//
// 並行性: flush は cron(1分)からのみ呼ぶ前提（index.ts の scheduled で `* * * * *` 限定）。
// Cloudflare は同一 cron を多重起動しないため、1分間隔・サブ秒で完了する flush は競合しない。

export interface SlackBurstEnv {
  DB: D1Database;
  CHAT_ALERT_SLACK_BOT_TOKEN?: string;
  CHAT_ALERT_SLACK_CHANNEL_ID?: string;
}

// 最後の受信から 30 秒沈黙したら送る（デバウンス）。
const DEBOUNCE_MS = 30_000;
// 連投が続いても最初の受信から 3 分でいったん送る（会話継続中の starvation 防止の上限）。
const MAX_BURST_MS = 3 * 60_000;
// 1 通にまとめる最大件数 / 1 tick で処理する最大 friend 数。
const MAX_MESSAGES = 30;
const MAX_FRIENDS_PER_TICK = 100;
// flush 時の取得ガード: バースト開始の 60 秒前まで遡って未通知行を拾う。
// （INSERT(created_at) と UPSERT(first_msg_at) の僅かな時刻差で先頭を取りこぼさないため。
//   かつ古い履歴＝列追加直後の NULL 行は遥かに古いので除外され、一斉通知を防ぐ二重防御。）
const FETCH_LOOKBACK_MS = 60_000;

const JST_OFFSET_MS = 9 * 60 * 60_000;
/** epoch(ms) → JST ISO 文字列(YYYY-MM-DDTHH:mm:ss.sss+09:00)。jstNow() と同形式で、
 *  messages_log.created_at（INSERT 時に jstNow() を bind）と文字列比較できる。 */
function jstAt(epochMs: number): string {
  return new Date(epochMs + JST_OFFSET_MS).toISOString().replace('Z', '+09:00');
}

const MEDIA_KIND_LABEL: Record<string, string> = { image: '画像', video: '動画', audio: '音声', file: 'ファイル', sticker: 'スタンプ' };

// friends.metadata の Notion 連携情報 { notion: { label(掲載ID), realName(管理名) } } を取り出す。
function parseNotionMeta(metadataJson: string | null | undefined): { label?: string | null; realName?: string | null } | null {
  if (typeof metadataJson !== 'string' || !metadataJson) return null;
  try {
    const m = JSON.parse(metadataJson) as { notion?: { label?: string | null; realName?: string | null } };
    return m.notion ?? null;
  } catch {
    return null;
  }
}

// LINE Connect の管理ユーザー名。Notion 連携時は "掲載ID 実名 (LINE名)"、未連携は LINE名。
// apps/web/src/lib/friend-name.ts の formatFriendLabel と同一ロジック（dashboard と表記を揃える）。
function formatFriendLabel(displayName: string | null | undefined, notion: { label?: string | null; realName?: string | null } | null): string {
  const nickname = displayName || '名前なし';
  if (!notion) return nickname;
  const parts: string[] = [];
  if (notion.label) parts.push(notion.label);
  if (notion.realName) parts.push(notion.realName);
  if (!parts.length) return nickname;
  return `${parts.join(' ')} (${nickname})`;
}

/**
 * 受信メッセージを Slack バッファに積む（setTimeout は使わない）。friend 単位で
 * notify_after=now+30秒 に更新し「30秒沈黙でまとめて送る」デバウンスを D1 に表現する。
 * 実送信は processSlackBurstNotify（cron）が担当。同一 friend は1行に集約される。
 */
export async function enqueueBurstNotify(
  db: D1Database,
  friendId: string,
  lineAccountId: string | null,
): Promise<void> {
  const now = jstAt(Date.now());
  const notifyAfter = jstAt(Date.now() + DEBOUNCE_MS);
  await db
    .prepare(
      `INSERT INTO slack_notify_buffers (friend_id, line_account_id, first_msg_at, last_msg_at, notify_after, status)
       VALUES (?, ?, ?, ?, ?, 'pending')
       ON CONFLICT(friend_id) DO UPDATE SET
         last_msg_at = excluded.last_msg_at,
         notify_after = excluded.notify_after,
         status = 'pending'`,
    )
    .bind(friendId, lineAccountId, now, now, notifyAfter)
    .run();
}

interface BufferRow {
  friend_id: string;
  line_account_id: string | null;
  first_msg_at: string;
  notify_after: string;
}
interface MsgRow {
  id: string;
  message_type: string;
  content: string;
  created_at: string;
}

/**
 * cron(1分)から呼ぶ。締切(notify_after)を過ぎた、または最初の受信から MAX_BURST_MS を
 * 過ぎたバッファを1通にまとめて Slack に通知し、送った行に slack_notified_at を刻む。
 * 重複防止は slack_notified_at（永続マーカー）で担保。CHAT_ALERT_SLACK_* 未設定なら no-op。
 */
export async function processSlackBurstNotify(env: SlackBurstEnv): Promise<void> {
  const token = env.CHAT_ALERT_SLACK_BOT_TOKEN;
  const channel = env.CHAT_ALERT_SLACK_CHANNEL_ID;
  if (!token || !channel) return;
  const db = env.DB;

  const nowMs = Date.now();
  const now = jstAt(nowMs);
  const capCutoff = jstAt(nowMs - MAX_BURST_MS);

  const due = (await db
    .prepare(
      `SELECT friend_id, line_account_id, first_msg_at, notify_after
         FROM slack_notify_buffers
        WHERE status = 'pending' AND (notify_after <= ? OR first_msg_at <= ?)
        ORDER BY notify_after ASC
        LIMIT ?`,
    )
    .bind(now, capCutoff, MAX_FRIENDS_PER_TICK)
    .all<BufferRow>()).results ?? [];

  for (const buf of due) {
    try {
      await flushOne(db, token, channel, buf);
    } catch (err) {
      // バッファは残す（status='pending' のまま）→ 次の tick で再試行。
      console.error('processSlackBurstNotify: flush failed for', buf.friend_id, err);
    }
  }
}

async function flushOne(
  db: D1Database,
  token: string,
  channel: string,
  buf: BufferRow,
): Promise<void> {
  // バースト開始の少し前から、未通知の受信メッセージを時系列で取得。
  const fetchFrom = jstAt(Date.parse(buf.first_msg_at) - FETCH_LOOKBACK_MS);
  const rows = (await db
    .prepare(
      `SELECT id, message_type, content, created_at
         FROM messages_log
        WHERE friend_id = ? AND direction = 'incoming' AND slack_notified_at IS NULL AND created_at >= ?
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .bind(buf.friend_id, fetchFrom, MAX_MESSAGES)
    .all<MsgRow>()).results ?? [];

  // 送る本文が無ければバッファだけ掃除（notify_after 一致時のみ＝後続受信があれば残す）。
  if (!rows.length) {
    await db
      .prepare(`DELETE FROM slack_notify_buffers WHERE friend_id = ? AND notify_after = ?`)
      .bind(buf.friend_id, buf.notify_after)
      .run();
    return;
  }

  const fr = await db
    .prepare(`SELECT display_name, metadata FROM friends WHERE id = ?`)
    .bind(buf.friend_id)
    .first<{ display_name: string | null; metadata: string | null }>();
  const notion = parseNotionMeta(fr?.metadata);
  const userName = formatFriendLabel(fr?.display_name, notion); // LINE Connect 上の管理ユーザー名

  const lines = rows
    .map((r) => {
      const t = (r.created_at || '').slice(11, 16); // HH:MM
      let body = r.message_type === 'text' ? r.content : `[${MEDIA_KIND_LABEL[r.message_type] || r.message_type}]`;
      body = body.replace(/\s+/g, ' ').trim();
      if (body.length > 140) body = body.slice(0, 140) + '…';
      return `\`${t}\` ${body}`;
    })
    .join('\n');

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      channel,
      text: 'メッセージ受信がありました。',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `<!channel>\n*メッセージ受信がありました。*\nユーザー名: ${userName}` } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: lines || '(本文なし)' }] },
      ],
    }),
  });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!j.ok) {
    // 送信失敗 → マーカーを刻まず throw（バッファを残して次 tick で再試行）。
    throw new Error(`slack chat.postMessage failed: ${j.error || `http ${res.status}`}`);
  }

  // 送信成功 → 送った行に通知済みマーカーを刻む（二度と再送しない＝重複根絶）。
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  await db
    .prepare(`UPDATE messages_log SET slack_notified_at = ? WHERE id IN (${placeholders})`)
    .bind(jstAt(Date.now()), ...ids)
    .run();

  // バッファ掃除: notify_after が動いていなければ削除。flush 中に新メッセージが来て
  // notify_after が進んでいたら DELETE は不一致→残し、次 tick で新しいまとまりを送る。
  await db
    .prepare(`DELETE FROM slack_notify_buffers WHERE friend_id = ? AND notify_after = ?`)
    .bind(buf.friend_id, buf.notify_after)
    .run();
}
