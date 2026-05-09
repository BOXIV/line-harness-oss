// BOXIV-only: LINE Login integration for STUDIO listing form on lightning.boxiv.co.jp.
//
// Flow:
//   1. User submits STUDIO form on lightning.boxiv.co.jp
//   2. STUDIO posts form fields to Slack #aaa (existing — handled by STUDIO)
//   3. Page shows "LINEで連携" button that redirects to:
//        GET /listing-form/start?form_id=XXX&return_to=YYY[&display_name=ZZZ]
//   4. We redirect to LINE Login OAuth with bot_prompt=normal (asks user to add the OA as friend)
//   5. LINE redirects back to /listing-form/callback?code=&state=
//   6. We exchange code → access_token → profile (LINE userId, displayName)
//   7. We post a notification to Slack #aaa (configurable channel)
//   8. A separate reconciliation bot (existing) batches Slack #aaa to match form
//      submissions with LINE link events, then writes to Notion.
//   9. We redirect user to return_to (with ?linked=1) or show success page.
//
// Required env (Worker secrets):
//   LINE_LOGIN_CHANNEL_ID, LINE_LOGIN_CHANNEL_SECRET   — existing
//   SESSION_SECRET                                      — existing (used for state HMAC)
//   SELLENTRY_SLACK_BOT_TOKEN                           — claude-sellentry bot (xoxb-...)
//   SLACK_LISTING_LINK_CHANNEL_ID                       — #pj-lightning-sell (e.g. C08PSA6A7PW)
//
// Set new secrets via wrangler:
//   cd line/line-harness-oss/apps/worker
//   pnpm exec wrangler secret put SELLENTRY_SLACK_BOT_TOKEN --config wrangler.boxiv.toml
//   pnpm exec wrangler secret put SLACK_LISTING_LINK_CHANNEL_ID --config wrangler.boxiv.toml

import { Hono } from 'hono';
import type { Env } from '../index.js';

const listingFormLine = new Hono<Env>();

// Allowed return_to hosts (open-redirect protection)
const RETURN_TO_ALLOWED_HOSTS = [
  'lightning.boxiv.co.jp',
  'line-connect.boxiv.workers.dev',
  'line-connect-test.boxiv.workers.dev',
  'localhost',
  '127.0.0.1',
];

const STATE_TTL_MS = 30 * 60 * 1000; // 30 min

// ─── HMAC state signing ─────────────────────────────────────

async function hmacSign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlEncode(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): string {
  let pad = s + '==='.slice((s.length + 3) % 4);
  return atob(pad.replace(/-/g, '+').replace(/_/g, '/'));
}

async function packState(payloadObj: object, secret: string): Promise<string> {
  const payload = JSON.stringify(payloadObj);
  const payloadB64 = b64urlEncode(payload);
  const sig = await hmacSign(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

async function unpackState<T = unknown>(token: string, secret: string): Promise<T | null> {
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;
  const expected = await hmacSign(payloadB64, secret);
  // Constant-time compare via length + char-by-char XOR
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    return JSON.parse(b64urlDecode(payloadB64)) as T;
  } catch {
    return null;
  }
}

function isAllowedReturnTo(url: string): boolean {
  try {
    const u = new URL(url);
    return RETURN_TO_ALLOWED_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

// ─── Routes ──────────────────────────────────────────────────

interface ListingStateV1 {
  v: 1;
  form_id: string;
  return_to: string;
  display_name: string;
  ts: number;
}

/**
 * GET /listing-form/start
 *
 * Entry point from lightning.boxiv.co.jp's "LINEで連携" button.
 * Redirects user to LINE Login OAuth with bot_prompt=normal so the user is
 * asked to add the BOXIV official LINE account as friend during login.
 *
 * Query params:
 *   form_id     (required) — STUDIO form submission identifier
 *   return_to   (optional) — URL to redirect after successful link
 *                            (must match RETURN_TO_ALLOWED_HOSTS)
 *   display_name(optional) — pre-filled name from the form (for success page)
 */
listingFormLine.get('/listing-form/start', async (c) => {
  const formId = c.req.query('form_id') ?? '';
  const returnTo = c.req.query('return_to') ?? '';
  const displayName = c.req.query('display_name') ?? '';

  if (!formId) {
    return c.json({ success: false, error: 'form_id is required' }, 400);
  }
  if (returnTo && !isAllowedReturnTo(returnTo)) {
    return c.json({ success: false, error: 'return_to host not allowed' }, 400);
  }
  if (!c.env.SESSION_SECRET) {
    return c.json({ success: false, error: 'SESSION_SECRET not configured' }, 500);
  }
  if (!c.env.LINE_LOGIN_CHANNEL_ID) {
    return c.json({ success: false, error: 'LINE_LOGIN_CHANNEL_ID not configured' }, 500);
  }

  const state = await packState(
    { v: 1, form_id: formId, return_to: returnTo, display_name: displayName, ts: Date.now() } satisfies ListingStateV1,
    c.env.SESSION_SECRET,
  );

  const callbackUrl = `${new URL(c.req.url).origin}/listing-form/callback`;
  const loginUrl = new URL('https://access.line.me/oauth2/v2.1/authorize');
  loginUrl.searchParams.set('response_type', 'code');
  loginUrl.searchParams.set('client_id', c.env.LINE_LOGIN_CHANNEL_ID);
  loginUrl.searchParams.set('redirect_uri', callbackUrl);
  loginUrl.searchParams.set('scope', 'profile openid');
  loginUrl.searchParams.set('bot_prompt', 'normal');
  loginUrl.searchParams.set('state', state);

  return c.redirect(loginUrl.toString());
});

/**
 * GET /listing-form/callback
 *
 * LINE Login redirects here after user grants permission.
 * Exchanges code for access_token, fetches profile, posts notification to Slack,
 * then redirects to return_to (or shows success page).
 */
listingFormLine.get('/listing-form/callback', async (c) => {
  const code = c.req.query('code');
  const stateParam = c.req.query('state');
  const errorParam = c.req.query('error');
  const errorDesc = c.req.query('error_description') ?? '';

  if (errorParam) {
    return c.html(renderErrorPage(`LINE 連携がキャンセルされました（${errorParam}）`, errorDesc), 400);
  }
  if (!code || !stateParam) {
    return c.json({ success: false, error: 'code and state required' }, 400);
  }
  if (!c.env.SESSION_SECRET) {
    return c.json({ success: false, error: 'SESSION_SECRET not configured' }, 500);
  }

  const ctx = await unpackState<ListingStateV1>(stateParam, c.env.SESSION_SECRET);
  if (!ctx || ctx.v !== 1) {
    return c.json({ success: false, error: 'invalid state' }, 400);
  }
  if (Date.now() - ctx.ts > STATE_TTL_MS) {
    return c.json({ success: false, error: 'state expired' }, 400);
  }

  // Exchange code → tokens
  const callbackUrl = `${new URL(c.req.url).origin}/listing-form/callback`;
  const tokenRes = await fetch('https://api.line.me/oauth2/v2.1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrl,
      client_id: c.env.LINE_LOGIN_CHANNEL_ID,
      client_secret: c.env.LINE_LOGIN_CHANNEL_SECRET,
    }),
  });
  if (!tokenRes.ok) {
    const errBody = await tokenRes.text();
    console.error('listing-form callback: token exchange failed', tokenRes.status, errBody);
    return c.json({ success: false, error: 'LINE token exchange failed' }, 500);
  }
  const tokens = (await tokenRes.json()) as { access_token: string };

  // Fetch profile
  const profileRes = await fetch('https://api.line.me/v2/profile', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!profileRes.ok) {
    const errBody = await profileRes.text();
    console.error('listing-form callback: profile fetch failed', profileRes.status, errBody);
    return c.json({ success: false, error: 'LINE profile fetch failed' }, 500);
  }
  const profile = (await profileRes.json()) as {
    userId: string;
    displayName: string;
    pictureUrl?: string;
  };

  // Post to Slack — non-fatal: log on failure but still complete the flow
  await postSlackLinkNotification(c.env, ctx, profile).catch((err) => {
    console.error('listing-form callback: slack post threw', err);
  });

  // Redirect to return_to (with ?linked=1) or render success page
  if (ctx.return_to) {
    try {
      const url = new URL(ctx.return_to);
      url.searchParams.set('linked', '1');
      return c.redirect(url.toString());
    } catch {
      // fall through to default success page if return_to was somehow malformed
    }
  }
  return c.html(renderSuccessPage(profile.displayName));
});

// ─── helpers ─────────────────────────────────────────────────

async function postSlackLinkNotification(
  env: Env['Bindings'],
  ctx: ListingStateV1,
  profile: { userId: string; displayName: string; pictureUrl?: string },
) {
  if (!env.SELLENTRY_SLACK_BOT_TOKEN || !env.SLACK_LISTING_LINK_CHANNEL_ID) {
    console.warn('listing-form callback: SELLENTRY_SLACK_BOT_TOKEN / SLACK_LISTING_LINK_CHANNEL_ID not configured — skipping');
    return;
  }
  const text = '出品フォーム LINE 連携完了';
  const fields: string[] = [
    `• Form ID: \`${ctx.form_id}\``,
    `• LINE userId: \`${profile.userId}\``,
    `• 表示名: ${profile.displayName}`,
  ];
  if (ctx.display_name) fields.push(`• フォーム入力名: ${ctx.display_name}`);

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${env.SELLENTRY_SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({
      channel: env.SLACK_LISTING_LINK_CHANNEL_ID,
      text,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: `:link: ${text}` } },
        { type: 'section', text: { type: 'mrkdwn', text: fields.join('\n') } },
      ],
    }),
  });
  const body = (await res.json()) as { ok: boolean; error?: string; ts?: string };
  if (!body.ok) {
    console.error('listing-form callback: slack chat.postMessage failed', body.error);
  }
}

function renderSuccessPage(displayName: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>連携完了</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hiragino Sans','Yu Gothic',system-ui,sans-serif;background:#0f172a;color:#fff;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{text-align:center;max-width:420px;width:90%;padding:48px 24px}
h1{font-size:26px;font-weight:800;margin-bottom:16px}
p{color:rgba(255,255,255,0.75);line-height:1.7;font-size:15px}
.note{font-size:12px;color:rgba(255,255,255,0.4);margin-top:32px}
</style>
</head>
<body>
<div class="card">
<h1>連携完了 🎉</h1>
<p>${escapeHtml(displayName)} さん、ありがとうございます。<br>追って LINE でご連絡いたします。</p>
<p class="note">このページは閉じていただいて構いません。</p>
</div>
</body>
</html>`;
}

function renderErrorPage(title: string, detail: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>エラー</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hiragino Sans','Yu Gothic',system-ui,sans-serif;background:#0f172a;color:#fff;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{text-align:center;max-width:420px;width:90%;padding:48px 24px}
h1{font-size:22px;font-weight:800;margin-bottom:16px;color:#fca5a5}
p{color:rgba(255,255,255,0.75);line-height:1.7;font-size:14px}
</style>
</head>
<body>
<div class="card">
<h1>${escapeHtml(title)}</h1>
${detail ? `<p>${escapeHtml(detail)}</p>` : ''}
</div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export { listingFormLine };
