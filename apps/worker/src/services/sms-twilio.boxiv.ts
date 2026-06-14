// BOXIV-only: Twilio SMS 送信。未設定なら no-op（skipped）。
// 必要 secret:
//   TWILIO_ACCOUNT_SID   ACxxxx
//   TWILIO_AUTH_TOKEN    xxxx
//   TWILIO_FROM          送信元 Twilio 番号(+81...) または Messaging Service SID(MGxxxx)
// 日本の携帯番号(0X0XXXXXXXX)は E.164(+81...)へ正規化して送る。

export interface TwilioEnv {
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM?: string;
}

export interface SmsResult {
  ok: boolean;
  skipped?: boolean; // 未設定でスキップ
  error?: string;
}

export function twilioConfigured(env: TwilioEnv): boolean {
  return !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM);
}

/** 日本の電話番号を E.164(+81…) に正規化。判定不能なら null。 */
export function toE164JP(raw: string): string | null {
  let s = (raw || '').replace(/[^\d+]/g, '');
  if (!s) return null;
  if (s.startsWith('+')) return s.length >= 11 ? s : null;
  if (s.startsWith('0')) return '+81' + s.slice(1);   // 0X0XXXXXXXX → +81X0XXXXXXXX
  if (s.startsWith('81')) return '+' + s;
  return null;
}

/**
 * SMS を1通送る。env 未設定なら {ok:false, skipped:true}。throw しない。
 */
export async function sendSms(env: TwilioEnv, to: string, body: string): Promise<SmsResult> {
  if (!twilioConfigured(env)) return { ok: false, skipped: true };
  const e164 = toE164JP(to);
  if (!e164) return { ok: false, error: `invalid phone: ${to}` };

  const params = new URLSearchParams({ To: e164, Body: body });
  if (env.TWILIO_FROM!.startsWith('MG')) params.set('MessagingServiceSid', env.TWILIO_FROM!);
  else params.set('From', env.TWILIO_FROM!);

  const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      },
    );
    if (res.status === 201 || res.ok) return { ok: true };
    const t = await res.text();
    return { ok: false, error: `${res.status}: ${t.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
