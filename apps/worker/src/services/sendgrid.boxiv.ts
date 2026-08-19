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
  opts: {
    text: string;
    html?: string;
    replyTo?: string;
    /**
     * クリック/開封トラッキングを無効化する（**認証メールでは必ず true にする**）。
     *
     * SendGrid はアカウント既定でクリックトラッキングが有効なため、本文中の URL を
     * `https://u########.ct.sendgrid.net/ls/click?upn=…` へ書き換える（実測）。認証メールでは
     * これが 3 つの実害になる:
     *   1. 認証メールが「見慣れない第三者ドメインの不透明なリンクを踏ませる」形になり、
     *      フィッシングそのものの見た目になる。踏むなと教育されている相手ほど踏まない。
     *   2. 送信ドメインと異なるドメインへのリンクは迷惑メール判定の材料になる。
     *      到達性の悪い宛先（コンシューマ Outlook 等）ほど効く。
     *   3. ログインリンクには **6 桁コードがクエリに載る**。書き換えられると
     *      その URL が SendGrid のクリックトラッキング側に記録され、
     *      メールスキャナの先読みが「クリック」として残る。資格情報の経路に第三者が増える。
     * リンクブランディング（url####.<ドメイン> の CNAME）を設定すれば 1・2 は緩和できるが、
     * 3 は残る。認証メールはトラッキングする理由が無いので、送信単位で切るのが正しい。
     */
    disableTracking?: boolean;
  },
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
    // アカウント既定を送信単位で上書きする。enable だけでなく enable_text も false にすること
    // （テキスト本文中の URL は enable_text 側で書き換えられる。実測でここが効いていた）。
    ...(opts.disableTracking
      ? {
          tracking_settings: {
            click_tracking: { enable: false, enable_text: false },
            open_tracking: { enable: false },
          },
        }
      : {}),
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
