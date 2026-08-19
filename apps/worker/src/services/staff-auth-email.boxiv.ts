// BOXIV-only: 管理画面ログイン（メール認証コード）まわりのメール送信と失敗通報。
//
// services/sendgrid.boxiv.ts の sendEmail は throw せず { ok:false } を返す実装なので、
// 「送ったつもりで届いていない」を黙って通過させないため、ここで必ず戻り値を見て
// 失敗を Slack に流す。ログインの入口をメール1本に絞る以上、到達性の不良は
// 「9名が同時にログイン不能」に直結する。
import { sendEmail, type SendGridEnv } from './sendgrid.boxiv.js';
import { slackWebhookPost, escapeSlackText } from './slack.boxiv.js';

export interface AdminAuthEmailEnv extends SendGridEnv {
  /** 管理画面ログインの異常を流す Slack Incoming Webhook。未設定なら催促用の URL を流用する。 */
  SLACK_ADMIN_ALERT_WEBHOOK_URL?: string;
  SLACK_REMINDER_WEBHOOK_URL?: string;
  /** 管理画面の URL（メール本文のリンク用）。未設定ならリンクを出さずコードのみ案内する。 */
  ADMIN_BASE_URL?: string;
}

/**
 * 迷惑メール報告の注意書き（全メール共通）。
 *
 * 抑制リストは**機能ごとではなくアドレス単位でアカウント全体**に効く。BOXIV から出るメールは
 * すべて同じ SendGrid アカウント・同じ送信元を共有しているので、**どのメールで報告を押されても
 * その人はログイン認証コードを受け取れなくなる**。しかも SendGrid は抑制リスト在籍の宛先にも
 * 202 を返して静かに破棄するため、送信側は成功にしか見えず Slack 通報も鳴らない
 * （現行の API キーは送信専用スコープで抑制リストを読めない）。
 * 技術で検知できないと決めた以上、本文で伝えるのが最後の防波堤になる。
 *
 * 撮影確定通知（PR #91）と文面を揃えている。片方だけ変えないこと。
 */
const SPAM_REPORT_WARNING =
  '⚠️ このメールを迷惑メール報告しないでください。管理画面ログイン用の認証メールを含む、' +
  'BOXIV からのすべてのメールが届かなくなります。';

/** Slack / ログに出す用の伏せ字。`toshiki.o@boxiv.co.jp` → `to***@boxiv.co.jp` */
export function maskEmail(email: string | null | undefined): string {
  const value = String(email ?? '');
  const at = value.indexOf('@');
  if (at <= 0) return '***';
  const local = value.slice(0, at);
  const domain = value.slice(at);
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}***${domain}`;
}

/** 管理画面ログインの異常を Slack へ流す。webhook 未設定なら console だけ（throw しない）。 */
export async function alertAdminAuth(env: AdminAuthEmailEnv, text: string): Promise<void> {
  console.error('[admin-auth]', text);
  const url = env.SLACK_ADMIN_ALERT_WEBHOOK_URL || env.SLACK_REMINDER_WEBHOOK_URL;
  if (!url) return;
  const res = await slackWebhookPost(url, `:rotating_light: 管理画面ログイン ${escapeSlackText(text)}`);
  if (!res.ok) console.error('[admin-auth] Slack 通報も失敗:', res.error);
}

/**
 * メール本文に載せるログイン画面の URL。
 *
 * **コードは絶対にクエリに載せない。** 載せると URL 自体が完全なログイン手段になり、
 *   - ブラウザ履歴に残る
 *   - 企業のメールゲートウェイ / プロキシの URL ログに残る
 *   - **メールを転送すると、ワンクリックのログインリンクごと相手に渡る**
 * の 3 つが同時に成立する。3 つ目は実際に起きた: 到達性の検証で
 * 「届きました」と報告する際に、URL ごとチャットへ貼られた。
 * 責める話ではなく、**「届いたか確認する」ときに人が自然にやること**なので、
 * 貼られても数字だけで済む形にしておく必要がある。
 *
 * `email` だけを載せるのは、再入力の手間を省く利便性は保ちつつ、
 * URL が単体では何の権限も持たないため。コードは本文から手で入れてもらう＝本来の姿。
 *
 * ⚠️ GET でコードを消費しない設計は「スキャナの先読みで焼かれない」ためのもので、
 *    「URL が資格情報になる」問題は別。前者を満たしても後者は防げない。
 */
export function buildLoginPageUrl(base: string | null | undefined, email: string): string | null {
  const trimmed = (base ?? '').replace(/\/+$/, '');
  if (!trimmed) return null;
  return `${trimmed}/login?email=${encodeURIComponent(email)}`;
}

/**
 * ログイン用の 6 桁コードを送る。
 *
 * 本文は「コードが主・リンクが従」の順で書く。リンクを主導線にするとメールスキャナ
 * (Microsoft SafeLinks / 社内ゲートウェイ) の先読みで単回リンクが消費される事故が起きる。
 * リンクを載せる場合もコードは消費せず、着地ページで人が押して初めて POST される
 * （GET でコードを消費しない）。
 */
export async function sendLoginCodeEmail(
  env: AdminAuthEmailEnv,
  input: { to: string; staffName: string; code: string; ttlMinutes: number; loginUrl?: string | null },
): Promise<{ ok: boolean; error?: string }> {
  const subject = `【BOXIV LINE Connect】ログイン認証コード ${input.code}`;
  const lines = [
    `${input.staffName} 様`,
    '',
    'BOXIV LINE Connect 管理画面のログイン認証コードです。',
    '',
    `　　${input.code}`,
    '',
    `このコードは ${input.ttlMinutes} 分で使えなくなり、1 回しか使えません。`,
    '',
  ];
  if (input.loginUrl) {
    lines.push(
      'ログイン画面（メールアドレスが入力済みになります。上のコードを入力してください）:',
      input.loginUrl,
      '',
    );
  }
  lines.push(
    'このメールに心当たりがない場合は、コードを誰にも教えず破棄してください。',
    'あなたのアカウントで誰かがログインを試みた可能性があります。',
    '',
    SPAM_REPORT_WARNING,
    '',
    '— BOXIV LINE Connect',
  );

  // 認証メールなのでトラッキングは切る。切らないと本文のログインリンクが
  // ct.sendgrid.net へ書き換えられ、(1) フィッシングそのものの見た目になり
  // (2) 迷惑メール判定の材料になり (3) 6 桁コード入りの URL が第三者に記録される。
  const res = await sendEmail(env, input.to, subject, {
    text: lines.join('\n'),
    disableTracking: true,
  });
  if (!res.ok) {
    await alertAdminAuth(
      env,
      `ログインコードのメール送信に失敗（宛先 ${maskEmail(input.to)} / ${input.staffName}）: ${res.error ?? res.status}`,
    );
  }
  return { ok: res.ok, error: res.error };
}

/**
 * メールアドレス変更を **旧アドレス** に通知する。
 *
 * 新アドレスではなく旧アドレスに送るのが要点。乗っ取り側がアドレスを自分のものに
 * 書き換えたとき、本人が気づける唯一の経路がここになる。
 * 送信失敗は Slack へ通報する（変更自体は成立しているので処理は止めない）。
 */
export async function notifyStaffEmailChanged(
  env: AdminAuthEmailEnv,
  input: { oldEmail: string; newEmail: string; staffName: string; actorName: string },
): Promise<void> {
  const subject = '【BOXIV LINE Connect】管理画面のログイン用メールアドレスが変更されました';
  const text = [
    `${input.staffName} 様`,
    '',
    'BOXIV LINE Connect 管理画面のログインに使うメールアドレスが変更されました。',
    '',
    `　変更前: ${input.oldEmail}`,
    `　変更後: ${input.newEmail}`,
    `　操作者: ${input.actorName}`,
    '',
    'この変更以降、このアドレスでは管理画面にログインできません。',
    'また、変更にともない現在のログインセッションはすべて無効化されました。',
    '',
    '心当たりがない場合は、至急 BOXIV の管理者へご連絡ください。',
    '',
    SPAM_REPORT_WARNING,
    '',
    '— BOXIV LINE Connect',
  ].join('\n');

  // 変更通知もトラッキング不要（本文にリンクは無いが、開封ピクセルを入れる理由も無い）。
  const res = await sendEmail(env, input.oldEmail, subject, { text, disableTracking: true });
  if (!res.ok) {
    await alertAdminAuth(
      env,
      `メール変更通知の送信に失敗（旧アドレス ${maskEmail(input.oldEmail)} / 対象 ${input.staffName}）: ${res.error ?? res.status}`,
    );
  }
}
