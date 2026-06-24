/**
 * 引用（quote reply）解決ユーティリティ
 *
 * 友だちがトーク画面で過去のメッセージを「引用」して返信すると、LINE は受信イベントに
 * `quotedMessageId`（引用元の LINE メッセージID）を付ける。ダッシュボードで引用元の
 * バブルを表示するため、messages_log を friend_id × line_message_id で照合して復元する。
 *
 * 復元の優先順位:
 *   1. messages_log.line_message_id（migration 911 以降の受信/送信メッセージに付与）
 *   2. メディアの content.key に埋まった messageId（旧データ救済。例: media/image/536…123.jpg → 536…123）
 */

export interface QuotedPreview {
  id: string;
  direction: string;
  messageType: string;
  content: string;
}

/**
 * push/reply のレスポンスから送信済みメッセージの LINE messageId を取り出す。
 * これを outgoing 行の line_message_id に保存しておくと、友だちが後でその
 * メッセージを引用返信した際に引用元として解決できる（複数送信時も引用対象は先頭1件）。
 * LINE が空ボディを返した場合は undefined になり得るので防御的に扱う。
 */
export function firstSentMessageId(res: unknown): string | null {
  const id = (res as { sentMessages?: Array<{ id?: unknown }> } | null | undefined)?.sentMessages?.[0]?.id;
  return typeof id === 'string' && id ? id : null;
}

/** メッセージ行から LINE メッセージID を取り出す。line_message_id が無いメディアは R2 key から復元。 */
export function resolveLineMessageId(row: {
  message_type: string;
  content: string;
  line_message_id: string | null;
}): string | null {
  if (row.line_message_id) return row.line_message_id;
  if (row.message_type === 'image' || row.message_type === 'video' || row.message_type === 'audio' || row.message_type === 'file') {
    try {
      const o = JSON.parse(row.content) as { key?: unknown; messageId?: unknown };
      if (typeof o.messageId === 'string' && o.messageId) return o.messageId;
      if (typeof o.key === 'string') {
        // media/<kind>/<messageId>.<ext> → <messageId>
        const m = o.key.match(/\/([^/]+)\.[A-Za-z0-9]+$/);
        if (m) return m[1];
      }
    } catch {
      /* content is not JSON — ignore */
    }
  }
  return null;
}

export interface QuotableRow {
  id: string;
  direction: string;
  message_type: string;
  content: string;
  line_message_id: string | null;
  quoted_message_id: string | null;
}

/**
 * 取得済みのメッセージ群から「LINE メッセージID → プレビュー」の索引を作る。
 * ウィンドウ外の引用元は line_message_id で補足クエリして埋める。
 * 返り値: quoted_message_id をキーに引ける Map。引用元が見つからなければ未登録。
 */
export async function buildQuoteIndex(
  db: D1Database,
  friendId: string,
  rows: QuotableRow[],
): Promise<Map<string, QuotedPreview>> {
  const byLineId = new Map<string, QuotedPreview>();
  for (const r of rows) {
    const lid = resolveLineMessageId(r);
    if (lid && !byLineId.has(lid)) {
      byLineId.set(lid, { id: r.id, direction: r.direction, messageType: r.message_type, content: r.content });
    }
  }

  // ウィンドウ内で解決できなかった引用元を補足クエリ（古いメッセージを引用したケース）
  const missing = new Set<string>();
  for (const r of rows) {
    if (r.quoted_message_id && !byLineId.has(r.quoted_message_id)) missing.add(r.quoted_message_id);
  }
  if (missing.size > 0) {
    const ids = [...missing];
    const placeholders = ids.map(() => '?').join(',');
    const supp = await db
      .prepare(
        `SELECT id, direction, message_type, content, line_message_id
           FROM messages_log
          WHERE friend_id = ? AND line_message_id IN (${placeholders})`,
      )
      .bind(friendId, ...ids)
      .all<{ id: string; direction: string; message_type: string; content: string; line_message_id: string | null }>();
    for (const s of supp.results) {
      if (s.line_message_id && !byLineId.has(s.line_message_id)) {
        byLineId.set(s.line_message_id, { id: s.id, direction: s.direction, messageType: s.message_type, content: s.content });
      }
    }
  }

  return byLineId;
}
