// BOXIV: 送信失敗を messages_log に記録するための共通ヘルパー。
//
// 連携完了（friends.user_id 付与）でも未フォローだとメッセージは届かない。LINE Messaging API は
// 未追加/ブロック宛 push に HTTP 200 を返すため送信側で失敗を検知できないが、送信前の
// is_following ガードや LINE API エラー時にここで status='failed' を記録し、個別チャット画面で
// 「送信失敗」として可視化する（従来は console.error で握りつぶしていた）。
import { jstNow } from '@line-crm/db';

/** 送信操作をした管理画面ユーザー（migration 923）。自動送信では渡さない。 */
export interface OutgoingActor {
  id: string;
  name: string;
}

/**
 * 送信失敗を messages_log に status='failed' で記録する。
 * content は「送ろうとした本文」を入れる（オペレーターが何が届かなかったか分かるように）。
 * 記録自体の失敗は致命的でないため握りつぶす（ログのみ）。
 *
 * actor: 誰の操作で送ろうとしたか。成功時と同じく記録する — 失敗したバブルだけ
 * 送信者名が消えると、「誰の送信が届かなかったのか」が追えなくなる。
 */
export async function logFailedOutgoing(
  db: D1Database,
  friendId: string,
  messageType: string,
  content: string,
  actor?: OutgoingActor | null,
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, status, sent_by_id, sent_by_name, created_at)
         VALUES (?, ?, 'outgoing', ?, ?, 'failed', ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), friendId, messageType, content, actor?.id ?? null, actor?.name ?? null, jstNow())
      .run();
  } catch (err) {
    console.error('logFailedOutgoing: failed to record failed send', err);
  }
}
