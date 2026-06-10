// BOXIV-only: SendGrid トランザクションメール送信（出品フォーム未連携者へのフォローアップ用）。
//
// Workers から SMTP は使えないため SendGrid v3 REST API を fetch で叩く。
// 必要 secret:
//   SENDGRID_API_KEY        SG.xxxxx
//   SENDGRID_FROM_EMAIL     送信元（SendGray で認証済みドメイン/アドレス。例 no-reply@boxiv.co.jp）
//   SENDGRID_FROM_NAME      送信元表示名（任意。例 "BOXIV Lightning"）

export interface SendGridEnv {
  SENDGRID_API_KEY?: string;
  SENDGRID_FROM_EMAIL?: string;
  SENDGRID_FROM_NAME?: string;
}

export interface SendResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * プレーン/HTML メールを 1 通送る。成否を返す（throw しない）。
 * env が未設定なら ok=false（呼び出し側でログのみ・フロー継続）。
 */
export async function sendEmail(
  env: SendGridEnv,
  to: string,
  subject: string,
  opts: { text: string; html?: string; replyTo?: string },
): Promise<SendResult> {
  if (!env.SENDGRID_API_KEY || !env.SENDGRID_FROM_EMAIL) {
    return { ok: false, error: 'SENDGRID_API_KEY / SENDGRID_FROM_EMAIL 未設定' };
  }
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return { ok: false, error: `invalid recipient: ${to}` };
  }

  const content: Array<{ type: string; value: string }> = [{ type: 'text/plain', value: opts.text }];
  if (opts.html) content.push({ type: 'text/html', value: opts.html });

  const body = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: env.SENDGRID_FROM_EMAIL, name: env.SENDGRID_FROM_NAME || 'BOXIV Lightning' },
    ...(opts.replyTo ? { reply_to: { email: opts.replyTo } } : {}),
    subject,
    content,
  };

  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    // SendGrid は成功時 202。失敗はボディに詳細。
    if (res.status === 202) return { ok: true, status: 202 };
    const errText = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: errText.slice(0, 300) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
