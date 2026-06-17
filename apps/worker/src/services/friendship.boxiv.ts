// BOXIV: ユーザーが OA を友だち追加しているか（実フォロー状態）を Messaging API で判定する。
//
// LINE Login の profile/openid スコープは友だち状態と無関係に userId を返すため、
// 「連携完了（friends.user_id 付与）＝配信可能」ではない。Messaging API の
// /v2/bot/profile/{userId} は友だち未追加・ブロック中だと 404/403 を返すので、これで実態を判定する。
//
// 注: 既存の LineClient.getProfile を使う（line-sdk の dist は deploy 時に再ビルドされない前提のため、
// SDK へメソッドを追加せず worker 側で完結させる）。
import type { LineClient } from '@line-crm/line-sdk';

/**
 * @returns true=友だち, false=未追加/ブロック中(404/403), null=判定不能（一過性エラー＝フォロー状態を勝手に下げない）
 */
export async function checkFollowing(
  lineClient: LineClient,
  userId: string,
): Promise<boolean | null> {
  try {
    await lineClient.getProfile(userId);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // request() は `LINE API error: <status> <statusText> — <body>` を throw する。
    if (/LINE API error: (404|403)\b/.test(msg)) return false;
    return null; // 5xx / ネットワーク等 → 不明
  }
}
