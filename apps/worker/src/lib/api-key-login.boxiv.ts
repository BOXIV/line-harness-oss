// BOXIV-only: 「API キーで管理画面に入れるのは誰か」の唯一の定義。
//
// 2026-09-02 に移行期間を終了し、**オーナー以外の API キー認証を禁止**した。
// それまでは staff_members.api_key を貼れば誰でも管理画面に入れたが、
//   - キーは配布した時点でしか本人性が確認できない（貸し借り・退職後の持ち出しが分からない）
//   - 失効はキーの再発行という手作業でしか行えない
// ため、人間の入口はメールログイン（`lhs_` セッション。毎リクエスト staff_members を
// 引き直すので、無効化した次の操作から締め出せる）に一本化した。
//
// owner だけ残す理由: env API_KEY の保持者にはメールアドレスが無く（合成の env-owner）、
// **メール配信が止まったときの最後の入口**がこれになる。ここを塞ぐと復旧経路ごと消える。
//
// ⚠️ 機械クライアント（MCP / promote-*.mjs / slack-daemon 等）は env API_KEY を使うので
//    影響しない。非オーナーの staff キーを機械に配っている場合はここで止まる。

export type StaffRole = 'owner' | 'admin' | 'manager' | 'staff';

/** API キー単体で認証を通してよいロールか。 */
export function isApiKeyAuthAllowed(role: StaffRole | string): boolean {
  return role === 'owner';
}

/** 拒否時の文言。次に何をすればよいかを必ず書く（締め出しに見えると問い合わせになる）。 */
export const API_KEY_AUTH_DISABLED_MESSAGE =
  'APIキーでのログインは終了しました。ログイン画面から、登録済みのメールアドレスに届く6桁コードでログインしてください';
