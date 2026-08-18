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
      'ログイン画面（メールアドレスとコードが入力済みになります。開くだけでは',
      'ログインされないので、画面のボタンを押してください）:',
      input.loginUrl,
      '',
    );
  }
  lines.push(
    'このメールに心当たりがない場合は、コードを誰にも教えず破棄してください。',
    'あなたのアカウントで誰かがログインを試みた可能性があります。',
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
