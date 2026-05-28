// BOXIV: 顧客ステータス変更時にリッチメニューを自動切替する。
// マッピングテーブル `rich_menu_status_mappings` から status_option_id → rich_menu_id を引き、
// LINE Messaging API の linkRichMenuToUser を叩く。失敗してもステータス更新自体は成功扱いとし、
// caller には warning のみ通知する設計。

import { LineClient } from '@line-crm/line-sdk';
import { getFriendById } from '@line-crm/db';

export interface AutoSwitchResult {
  applied: boolean;
  richMenuId?: string;
  error?: string;
}

/**
 * 指定された friend / status_option の組合せに紐付くリッチメニューを LINE 側で適用する。
 * - マッピングが無ければ no-op
 * - マッピングが is_active=0 なら no-op
 * - LINE API 失敗時はエラー文字列を返すが throw しない（ステータス変更自体は成功扱いとするため）
 */
export async function applyRichMenuForStatus(
  db: D1Database,
  channelAccessToken: string,
  friendId: string,
  statusOptionId: string,
): Promise<AutoSwitchResult> {
  const mapping = await db
    .prepare(
      `SELECT rich_menu_id
       FROM rich_menu_status_mappings
       WHERE status_option_id = ? AND is_active = 1
       LIMIT 1`,
    )
    .bind(statusOptionId)
    .first<{ rich_menu_id: string }>();

  if (!mapping) return { applied: false };

  const friend = await getFriendById(db, friendId);
  if (!friend) return { applied: false, error: 'friend not found' };

  const line = new LineClient(channelAccessToken);
  try {
    await line.linkRichMenuToUser(friend.line_user_id, mapping.rich_menu_id);
    return { applied: true, richMenuId: mapping.rich_menu_id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('applyRichMenuForStatus failed:', message);
    return { applied: false, richMenuId: mapping.rich_menu_id, error: message };
  }
}
