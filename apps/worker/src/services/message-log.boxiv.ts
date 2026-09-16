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
 * 送信が失敗した理由（migration 926）。管理画面の文言の出し分けに使う。
 *   blocked   … ブロック/友だち削除。LINE では二度と届かないので別経路に切り替える
 *   not_added … まだ友だち追加されていない。追加を案内すれば届くようになる
 *   api_error … LINE API がエラーを返した。時間をおいて再送で通ることがある
 */
export type OutgoingFailureReason = 'blocked' | 'not_added' | 'api_error';

/**
 * 未フォロー（is_following=0）の内訳を判定する。
 *
 * LINE はブロックと「一度も友だち追加していない」を区別して教えてくれない（どちらも
 * unfollow 相当で is_following=0 になる）。そこで **過去に届いた実績があるか** で切り分ける:
 * 受信メッセージが1件でもある、または成功した送信（status が 'failed' でない outgoing）が
 * あるなら、その時点では友だちだったはず＝いまは外された＝blocked。
 * 実績がゼロなら、そもそも追加されていない＝not_added。
 *
 * 判定を誤る方向は「ブロックされた人を not_added と言う」側に倒す（追加を案内するだけで
 * 実害が無い）。逆に一度も追加していない人へ「ブロックされています」と出すと、
 * オペレーターが相手を誤解したまま対応してしまう。
 */
export async function resolveNotFollowingReason(
  db: D1Database,
  friendId: string,
): Promise<OutgoingFailureReason> {
  try {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages_log
          WHERE friend_id = ?
            AND (direction = 'incoming' OR (direction = 'outgoing' AND IFNULL(status, '') != 'failed'))`,
      )
      .bind(friendId)
      .first<{ n: number }>();
    return (row?.n ?? 0) > 0 ? 'blocked' : 'not_added';
  } catch (err) {
    // 判定できないときは弱い方（追加案内）に倒す。断定的な「ブロック」を出さない。
    console.error('resolveNotFollowingReason: failed', err);
    return 'not_added';
  }
}

/**
 * 未フォローで送れなかったときに、オペレーターへ返す文言。
 * バブルの表示（apps/web の message-bubble）と同じ意味になるよう、ここ 1 箇所で決める。
 */
export function notFollowingMessage(reason: OutgoingFailureReason): string {
  return reason === 'blocked'
    ? 'ブロックされているため送信できませんでした。LINE では届きません。電話・メールなど別の手段でご連絡ください。'
    : 'まだ友だち追加されていないため送信できませんでした。友だち追加をご案内ください。';
}

/**
 * 送信失敗を messages_log に status='failed' で記録する。
 * content は「送ろうとした本文」を入れる（オペレーターが何が届かなかったか分かるように）。
 * 記録自体の失敗は致命的でないため握りつぶす（ログのみ）。
 *
 * actor: 誰の操作で送ろうとしたか。成功時と同じく記録する — 失敗したバブルだけ
 * 送信者名が消えると、「誰の送信が届かなかったのか」が追えなくなる。
 * reason: なぜ届かなかったか（migration 926）。省略時は NULL＝理由不明として扱う。
 */
export async function logFailedOutgoing(
  db: D1Database,
  friendId: string,
  messageType: string,
  content: string,
  actor?: OutgoingActor | null,
  reason?: OutgoingFailureReason | null,
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, status, sent_by_id, sent_by_name, failure_reason, created_at)
         VALUES (?, ?, 'outgoing', ?, ?, 'failed', ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        friendId,
        messageType,
        content,
        actor?.id ?? null,
        actor?.name ?? null,
        reason ?? null,
        jstNow(),
      )
      .run();
  } catch (err) {
    console.error('logFailedOutgoing: failed to record failed send', err);
  }
}
