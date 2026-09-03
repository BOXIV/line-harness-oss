/**
 * BOXIV: チャットの「直近ウィンドウ」取得。
 *
 * ⚠️ ここが `ORDER BY created_at ASC LIMIT n` だと **古い方から** n 件になる。
 *    n 件を超えたスレッドでは、いま送ったメッセージも相手の返信も画面に出ない
 *    （2026-09-03 実障害: 204 件のスレッドで直近 4 件＝送信3・受信1 が丸ごと消えた。
 *     LINE には届いていて Slack 通知も出るので「送れているのに見えない」になる）。
 *    新しい順に取って表示用へ反転する。
 */
import type { QuotableRow } from './quote.js';

/** 1 回に返すメッセージ数の既定値。 */
export const MESSAGE_WINDOW_DEFAULT = 200;
/** クライアントが指定できる上限。 */
export const MESSAGE_WINDOW_MAX = 500;

export type MessageRow = QuotableRow & {
  status: string | null;
  sent_by_name: string | null;
  created_at: string;
};

const COLUMNS =
  'id, friend_id, direction, message_type, content, status, line_message_id, quoted_message_id, sent_by_name, created_at';

/** limit クエリを既定値／上限へ丸める。数値でなければ既定値。 */
export function parseMessageLimit(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return MESSAGE_WINDOW_DEFAULT;
  return Math.min(n, MESSAGE_WINDOW_MAX);
}

/**
 * 友だちの直近メッセージを **古い順（表示順）** で返す。
 *
 * @param before 指定すると、この created_at より前だけを対象にする（さかのぼり読み込み）。
 * @returns rows は古い順。hasMore は「これより前にまだある」。
 */
export async function loadMessageWindow(
  db: D1Database,
  friendId: string,
  opts: { limit?: number; before?: string | null } = {},
): Promise<{ rows: MessageRow[]; hasMore: boolean }> {
  const limit = opts.limit ?? MESSAGE_WINDOW_DEFAULT;
  const before = opts.before || null;

  // created_at の同値でも順序が揺れないよう id を tiebreak に置く。
  // DESC で取って反転するので、表示順は (created_at ASC, id ASC) で安定する。
  const sql = before
    ? `SELECT ${COLUMNS} FROM messages_log WHERE friend_id = ? AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?`
    : `SELECT ${COLUMNS} FROM messages_log WHERE friend_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`;
  const bindings = before ? [friendId, before, limit + 1] : [friendId, limit + 1];

  const res = await db.prepare(sql).bind(...bindings).all<MessageRow>();
  const desc = res.results ?? [];
  const hasMore = desc.length > limit;
  return { rows: desc.slice(0, limit).reverse(), hasMore };
}
