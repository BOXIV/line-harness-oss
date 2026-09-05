import { Hono } from 'hono';
import {
  getFriendByLineUserId,
  createUser,
  getUserByEmail,
  linkFriendToUser,
  upsertFriend,
  getEntryRouteByRefCode,
  recordRefTracking,
  addTagToFriend,
  getLineAccountByChannelId,
  getLineAccounts,
  jstNow,
} from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { checkFollowing } from '../services/friendship.boxiv.js';
import type { Env } from '../index.js';

const liffRoutes = new Hono<Env>();

// OAuth 完了後の redirect 先を検証する（オープンリダイレクト対策）。
// state は署名なしでクライアントが自由に詰められるため、`/auth/callback` の最後で
// 生の redirect を無検証で c.redirect すると、正規の BOXIV オリジンから任意サイトへ
// 302 できてしまいフィッシングの踏み台になる。許可するのは:
//   - 同一オリジンの相対パス（"/" 始まりだが "//" や "/\" は不可＝プロトコル相対を弾く）
//   - host が boxiv 系 / 自 Worker の絶対 https URL
// 不許可なら null を返し、呼び出し側は既定の遷移（チャット等）にフォールバックする。
const REDIRECT_ALLOWED_HOSTS = [
  'lightning.boxiv.co.jp',
  'boxiv.co.jp',
  'line-connect.boxiv.workers.dev',
  'line-connect-test.boxiv.workers.dev',
  'liff.line.me',
  'line.me',
];
function safeRedirect(redirect: string | undefined, reqHost: string): string | null {
  if (!redirect) return null;
  // 相対パス: "/" 始まりで、かつ "//"（プロトコル相対）や "/\" でない。
  if (redirect.startsWith('/') && !redirect.startsWith('//') && !redirect.startsWith('/\\')) {
    return redirect;
  }
  try {
    const u = new URL(redirect);
    if (u.protocol !== 'https:') return null;
    if (u.hostname === reqHost || REDIRECT_ALLOWED_HOSTS.includes(u.hostname)) {
      return redirect;
    }
  } catch {
    // 相対でも絶対 URL でもない → 不許可
  }
  return null;
}

// ─── LINE Login OAuth (bot_prompt=aggressive) ───────────────────

/**
 * GET /auth/line — redirect to LINE Login with bot_prompt=aggressive
 *
 * This is THE friend-add URL. Put this on LPs, SNS, ads.
 * Query params:
 *   ?ref=xxx     — attribution tracking
 *   ?redirect=url — redirect after completion
 *   ?gclid=xxx   — Google Ads click ID
 *   ?fbclid=xxx  — Meta Ads click ID
 *   ?utm_source=xxx, utm_medium, utm_campaign, utm_content, utm_term — UTM params
 */
liffRoutes.get('/auth/line', async (c) => {
  const ref = c.req.query('ref') || '';
  const redirect = c.req.query('redirect') || '';
  const gclid = c.req.query('gclid') || '';
  const fbclid = c.req.query('fbclid') || '';
  const twclid = c.req.query('twclid') || '';
  const ttclid = c.req.query('ttclid') || '';
  const utmSource = c.req.query('utm_source') || '';
  const utmMedium = c.req.query('utm_medium') || '';
  const utmCampaign = c.req.query('utm_campaign') || '';
  const accountParam = c.req.query('account') || '';
  const uidParam = c.req.query('uid') || ''; // existing user UUID for cross-account linking
  const baseUrl = new URL(c.req.url).origin;

  // Multi-account: resolve LINE Login channel + LIFF from DB if account param provided
  let channelId = c.env.LINE_LOGIN_CHANNEL_ID;
  let liffUrl = c.env.LIFF_URL;
  if (accountParam) {
    const account = await getLineAccountByChannelId(c.env.DB, accountParam);
    if (account?.login_channel_id) {
      channelId = account.login_channel_id;
    }
    if (account?.liff_id) {
      liffUrl = `https://liff.line.me/${account.liff_id}`;
    }
  }
  const callbackUrl = `${baseUrl}/auth/callback`;

  // xh: refs are X Harness one-time tokens — never forward to third-party URLs (liff.line.me / QR)
  // The token must reach /auth/callback, so it IS included in the OAuth state (handled by this worker).
  // It must NOT appear in LIFF URLs or QR codes that escape to external domains.
  const externalRef = ref.startsWith('xh:') ? '' : ref;

  // Build LIFF URL with ref + ad params (for mobile → LINE app)
  // Extract LIFF ID from URL and pass as query param so the app can init correctly
  const liffIdMatch = liffUrl.match(/liff\.line\.me\/([0-9]+-[A-Za-z0-9]+)/);
  const liffParams = new URLSearchParams();
  if (liffIdMatch) liffParams.set('liffId', liffIdMatch[1]);
  if (externalRef) liffParams.set('ref', externalRef);
  if (redirect) liffParams.set('redirect', redirect);
  if (gclid) liffParams.set('gclid', gclid);
  if (fbclid) liffParams.set('fbclid', fbclid);
  if (twclid) liffParams.set('twclid', twclid);
  if (ttclid) liffParams.set('ttclid', ttclid);
  if (utmSource) liffParams.set('utm_source', utmSource);
  const liffTarget = liffParams.toString()
    ? `${liffUrl}?${liffParams.toString()}`
    : liffUrl;

  // Build OAuth URL (for desktop fallback)
  // Pack all tracking params into state so they survive the OAuth redirect.
  // The full ref (including xh: tokens) is stored in state — it is opaque to access.line.me
  // and only decoded by this worker's /auth/callback handler.
  const state = JSON.stringify({ ref, redirect, gclid, fbclid, twclid, ttclid, utmSource, utmMedium, utmCampaign, account: accountParam, uid: uidParam });
  const encodedState = btoa(state);
  const loginUrl = new URL('https://access.line.me/oauth2/v2.1/authorize');
  loginUrl.searchParams.set('response_type', 'code');
  loginUrl.searchParams.set('client_id', channelId);
  loginUrl.searchParams.set('redirect_uri', callbackUrl);
  // BOXIV: prod Login channel 2010320277 に email スコープが無いため除外
  // （email は liff.ts:295 の getUserByEmail フォールバックでのみ使用・ガード済）。
  loginUrl.searchParams.set('scope', 'profile openid');
  // aggressive: 同意画面の後に「友だち追加」専用画面を必ず表示し、未追加/ブロック中の人にも
  // 追加（=ブロック解除）を強く促す。normal は同意画面内の一オプションのため外されやすく、
  // 「連携済みだが未フォロー（=配信不達）」を生みやすい。callback 側でも実フォローを再判定する。
  loginUrl.searchParams.set('bot_prompt', 'aggressive');
  loginUrl.searchParams.set('state', encodedState);

  // Build LIFF URL with params (opens LINE app directly on mobile + QR on PC)
  // externalRef used — xh: tokens must not appear in QR codes or LIFF URLs
  const qrParams = new URLSearchParams();
  if (externalRef) qrParams.set('ref', externalRef);
  if (uidParam) qrParams.set('uid', uidParam);
  if (accountParam) qrParams.set('account', accountParam);
  const qrUrl = qrParams.toString() ? `${liffUrl}?${qrParams.toString()}` : liffUrl;

  // Mobile: redirect to LIFF URL (opens LINE app directly)
  // Exception: cross-account links (account param) use OAuth directly
  // because Account A's LIFF can't open from Account B's LINE chat
  const ua = (c.req.header('user-agent') || '').toLowerCase();
  const isMobile = /iphone|ipad|android|mobile/.test(ua);
  if (isMobile) {
    if (accountParam) {
      // Cross-account: use OAuth (LIFF won't work across accounts)
      return c.redirect(loginUrl.toString());
    }
    return c.redirect(qrUrl);
  }

  // PC: show QR code page
  return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LINE で友だち追加</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Hiragino Sans', system-ui, sans-serif; background: #0d1117; color: #fff; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 24px; padding: 48px; text-align: center; max-width: 480px; width: 90%; }
    h1 { font-size: 24px; font-weight: 800; margin-bottom: 8px; }
    .sub { font-size: 14px; color: rgba(255,255,255,0.5); margin-bottom: 32px; }
    .qr { background: #fff; border-radius: 16px; padding: 24px; display: inline-block; margin-bottom: 24px; }
    .qr img { display: block; width: 240px; height: 240px; }
    .hint { font-size: 13px; color: rgba(255,255,255,0.4); line-height: 1.6; }
    .badge { display: inline-block; margin-top: 24px; padding: 8px 20px; border-radius: 20px; font-size: 12px; font-weight: 600; color: #0f172a; background: rgba(6,199,85,0.1); border: 1px solid rgba(6,199,85,0.2); }
  </style>
</head>
<body>
  <div class="card">
    <h1>全機能を使う（0円）</h1>
    <p class="sub">スマートフォンで QR コードを読み取ってください</p>
    <div class="qr">
      <img src="https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(qrUrl)}" alt="QR Code">
    </div>
    <p class="hint">LINE アプリのカメラまたは<br>スマートフォンのカメラで読み取れます</p>
    <div class="badge">LINE Harness OSS</div>
  </div>
</body>
</html>`);
});

/**
 * GET /auth/callback — LINE Login callback
 *
 * Exchanges code for tokens, extracts sub (UUID), links friend.
 */
liffRoutes.get('/auth/callback', async (c) => {
  const code = c.req.query('code');
  const stateParam = c.req.query('state') || '';
  const error = c.req.query('error');

  // Parse state (contains ref, redirect, and ad click IDs)
  let ref = '';
  let redirect = '';
  let gclid = '';
  let fbclid = '';
  let twclid = '';
  let ttclid = '';
  let utmSource = '';
  let utmMedium = '';
  let utmCampaign = '';
  let accountParam = '';
  let uidParam = '';
  try {
    const parsed = JSON.parse(atob(stateParam));
    ref = parsed.ref || '';
    redirect = parsed.redirect || '';
    gclid = parsed.gclid || '';
    fbclid = parsed.fbclid || '';
    twclid = parsed.twclid || '';
    ttclid = parsed.ttclid || '';
    utmSource = parsed.utmSource || '';
    utmMedium = parsed.utmMedium || '';
    utmCampaign = parsed.utmCampaign || '';
    accountParam = parsed.account || '';
    uidParam = parsed.uid || '';
  } catch {
    // ignore
  }

  if (error || !code) {
    return c.html(errorPage(error || 'Authorization failed'));
  }

  try {
    const baseUrl = new URL(c.req.url).origin;
    const callbackUrl = `${baseUrl}/auth/callback`;

    // Multi-account: resolve LINE Login credentials from DB
    let loginChannelId = c.env.LINE_LOGIN_CHANNEL_ID;
    let loginChannelSecret = c.env.LINE_LOGIN_CHANNEL_SECRET;
    if (accountParam) {
      const account = await getLineAccountByChannelId(c.env.DB, accountParam);
      if (account?.login_channel_id && account?.login_channel_secret) {
        loginChannelId = account.login_channel_id;
        loginChannelSecret = account.login_channel_secret;
      }
    }

    // Exchange code for tokens
    const tokenRes = await fetch('https://api.line.me/oauth2/v2.1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callbackUrl,
        client_id: loginChannelId,
        client_secret: loginChannelSecret,
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error('Token exchange failed:', errText);
      return c.html(errorPage('Token exchange failed'));
    }

    const tokens = await tokenRes.json<{
      access_token: string;
      id_token: string;
      token_type: string;
    }>();

    // Verify ID token to get sub (use resolved login channel ID, not env default)
    const verifyRes = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        id_token: tokens.id_token,
        client_id: loginChannelId,
      }),
    });

    if (!verifyRes.ok) {
      return c.html(errorPage('ID token verification failed'));
    }

    const verified = await verifyRes.json<{
      sub: string;
      name?: string;
      email?: string;
      picture?: string;
    }>();

    // Get profile via access token
    const profileRes = await fetch('https://api.line.me/v2/profile', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    let displayName = verified.name || 'Unknown';
    let pictureUrl: string | null = null;
    if (profileRes.ok) {
      const profile = await profileRes.json<{
        userId: string;
        displayName: string;
        pictureUrl?: string;
      }>();
      displayName = profile.displayName;
      pictureUrl = profile.pictureUrl || null;
    }

    const db = c.env.DB;
    const lineUserId = verified.sub;

    // 実フォロー状態を Messaging API で判定する。LINE Login の profile/openid は
    // 友だち状態と無関係に userId を返すため、「連携完了（user_id 付与）＝配信可能」ではない。
    // accountParam があればそのOAのトークンを使う（既定は環境のチャネルトークン）。
    let accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (accountParam) {
      const acct = await getLineAccountByChannelId(db, accountParam);
      if (acct?.channel_access_token) accessToken = acct.channel_access_token;
    }
    const lineClient = new LineClient(accessToken);
    const followStatus = await checkFollowing(lineClient, lineUserId); // true=友だち / false=未追加 / null=判定不能

    // Upsert friend (may not exist yet if webhook hasn't fired)。
    // 実フォロー判定値を渡し、未追加で連携しただけのユーザーを is_following=1 と誤検知させない。
    // null（判定不能）のときは既存値を維持（勝手に下げない）。
    const friend = await upsertFriend(db, {
      lineUserId,
      displayName,
      pictureUrl,
      statusMessage: null,
      isFollowing: followStatus === null ? undefined : followStatus,
    });

    // Create or find user → link
    let userId: string | null = null;

    // Check if already linked
    const existingUserId = (friend as unknown as Record<string, unknown>).user_id as string | null;
    if (existingUserId) {
      userId = existingUserId;
    } else {
      // Cross-account linking: if uid is provided, use that existing UUID
      if (uidParam) {
        userId = uidParam;
      }

      // Try to find by email
      if (!userId && verified.email) {
        const existingUser = await getUserByEmail(db, verified.email);
        if (existingUser) userId = existingUser.id;
      }

      // Create new user only if no existing UUID found
      if (!userId) {
        const newUser = await createUser(db, {
          email: verified.email || null,
          displayName,
        });
        userId = newUser.id;
      }

      // Link friend to user
      await linkFriendToUser(db, friend.id, userId);
    }

    // Attribution tracking
    // xh: refs are X Harness one-time tokens (the token IS the secret) — never persist as ref_code
    if (ref && !ref.startsWith('xh:')) {
      // Save ref_code on the friend record (first touch wins — only set if not already set)
      await db
        .prepare(`UPDATE friends SET ref_code = ? WHERE id = ? AND ref_code IS NULL`)
        .bind(ref, friend.id)
        .run();

      // Look up entry route config
      const route = await getEntryRouteByRefCode(db, ref);

      // Persist tracking event with ad click IDs
      await recordRefTracking(db, {
        refCode: ref,
        friendId: friend.id,
        entryRouteId: route?.id ?? null,
        sourceUrl: null,
        fbclid: fbclid || null,
        gclid: gclid || null,
        twclid: twclid || null,
        ttclid: ttclid || null,
        utmSource: utmSource || null,
        utmMedium: utmMedium || null,
        utmCampaign: utmCampaign || null,
        userAgent: c.req.header('User-Agent') || null,
        ipAddress: c.req.header('CF-Connecting-IP') || null,
      });

      if (route) {
        // Auto-tag the friend
        if (route.tag_id) {
          await addTagToFriend(db, friend.id, route.tag_id);
        }
        // Auto-enroll in scenario (scenario_id stored; enrollment handled by scenario engine)
        // Future: call enrollFriendInScenario(db, friend.id, route.scenario_id) here
      }
    }

    // Save ad click IDs + UTM to friend metadata (for future ad API postback)
    const adMeta: Record<string, string> = {};
    if (gclid) adMeta.gclid = gclid;
    if (fbclid) adMeta.fbclid = fbclid;
    if (twclid) adMeta.twclid = twclid;
    if (ttclid) adMeta.ttclid = ttclid;
    if (utmSource) adMeta.utm_source = utmSource;
    if (utmMedium) adMeta.utm_medium = utmMedium;
    if (utmCampaign) adMeta.utm_campaign = utmCampaign;

    if (Object.keys(adMeta).length > 0) {
      const existingMeta = await db
        .prepare('SELECT metadata FROM friends WHERE id = ?')
        .bind(friend.id)
        .first<{ metadata: string }>();
      const merged = { ...JSON.parse(existingMeta?.metadata || '{}'), ...adMeta };
      await db
        .prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
        .bind(JSON.stringify(merged), jstNow(), friend.id)
        .run();
    }

    // X Harness token resolution: ref starting with "xh:" links X account to LINE friend
    if (ref && ref.startsWith('xh:')) {
      try {
        const xhToken = ref.slice(3);
        const xhResult = await resolveXHarnessToken(xhToken, c.env);
        if (xhResult?.xUsername) {
          const existingMeta = await db
            .prepare('SELECT metadata FROM friends WHERE id = ?')
            .bind(friend.id)
            .first<{ metadata: string }>();
          const meta = JSON.parse(existingMeta?.metadata || '{}');
          meta.x_username = xhResult.xUsername;
          await db
            .prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
            .bind(JSON.stringify(meta), jstNow(), friend.id)
            .run();
          console.log(`X Harness: linked @${xhResult.xUsername} to friend ${friend.id}`);
        }
        // Apply gate actions (tag + scenario) from X Harness
        if (xhResult) {
          await applyXHarnessActions(db, friend.id, xhResult);
        }
      } catch (err) {
        console.error('X Harness token resolution error (non-blocking):', err);
      }
    }

    // Auto-enroll in friend_add scenarios + immediate delivery (skip delivery window)。
    // 実フォロー済み（followStatus === true）のときだけ実行する。未追加ユーザーへの即時 push は
    // LINE 上は不達（HTTP 200 でもサイレント）になるため。未追加→後で友だち追加すれば
    // follow webhook が同じ friend_add シナリオを発火する。
    if (followStatus === true) try {
      const { getScenarios, enrollFriendInScenario: enroll, getScenarioSteps } = await import('@line-crm/db');
      const { buildMessage, expandVariables } = await import('../services/step-delivery.js');

      // Resolve which account this friend belongs to
      const matchedAccountId = accountParam
        ? (await getLineAccountByChannelId(db, accountParam))?.id ?? null
        : null;

      const scenarios = await getScenarios(db);
      for (const scenario of scenarios) {
        const scenarioAccountMatch = !scenario.line_account_id || !matchedAccountId || scenario.line_account_id === matchedAccountId;
        if (scenario.trigger_type === 'friend_add' && scenario.is_active && scenarioAccountMatch) {
          const existing = await db
            .prepare('SELECT id FROM friend_scenarios WHERE friend_id = ? AND scenario_id = ?')
            .bind(friend.id, scenario.id)
            .first<{ id: string }>();
          if (!existing) {
            await enroll(db, friend.id, scenario.id);

            // Immediate delivery of first step (skip delivery window)
            const steps = await getScenarioSteps(db, scenario.id);
            const firstStep = steps[0];
            if (firstStep && firstStep.delay_minutes === 0) {
              const expandedContent = expandVariables(
                firstStep.message_content,
                friend as { id: string; display_name: string | null; user_id: string | null },
                c.env.WORKER_URL,
                { json: firstStep.message_type === 'flex' },
              );
              await lineClient.pushMessage(lineUserId, [buildMessage(firstStep.message_type, expandedContent)]);
            }
          }
        }
      }
    } catch (err) {
      console.error('OAuth scenario enrollment error:', err);
    }

    // 未フォロー（友だち追加を断った/まだ追加していない）かつ遷移先指定が無い場合は、
    // 友だち追加ページを表示して追加を促す。連携（user_id）は完了しているが、これだけでは
    // メッセージが届かないため。redirect/booking フローは遷移先がUXを持つので従来どおり進める。
    if (followStatus === false && !redirect) {
      const basicId = await fetchBotBasicId(accessToken);
      return c.html(friendAddPage(displayName, pictureUrl, basicId));
    }

    // 撮影予約ページへのリダイレクトの場合はセッションCookieを発行
    // ⚠️ この分岐は下の safeRedirect を通らずに Location を返すので、ここでも必ず検証する。
    //    `redirect.includes('/booking?')` だけだと `https://evil.example/x/booking?` が
    //    通り、state を細工した OAuth 開始 URL 1 つで外部サイトへ飛ばせた（2026-08-29 監査）。
    const bookingRedirect =
      redirect && (redirect.startsWith('/booking') || redirect.includes('/booking?'))
        ? safeRedirect(redirect, new URL(c.req.url).hostname)
        : null;
    if (bookingRedirect) {
      try {
        const { createSessionToken, buildSessionCookie } = await import('../utils/session.js');
        if (c.env.SESSION_SECRET) {
          const sessionToken = await createSessionToken(
            { friendId: friend.id, lineUserId, displayName },
            c.env.SESSION_SECRET,
          );
          const cookie = buildSessionCookie(sessionToken);
          return new Response(null, {
            status: 302,
            headers: {
              Location: bookingRedirect,
              'Set-Cookie': cookie,
            },
          });
        }
      } catch (err) {
        console.error('booking session cookie set failed (non-blocking):', err);
      }
    }

    // Redirect or show completion（オープンリダイレクト対策で allowlist を通す）
    const validated = safeRedirect(redirect, new URL(c.req.url).hostname);
    if (validated) {
      return c.redirect(validated);
    }

    // Redirect to the correct bot's chat after auth
    // Find the LINE account by: account param, friend's account, or login channel ID
    let redirectAccount: Record<string, string> | null = null;
    if (accountParam) {
      redirectAccount = await getLineAccountByChannelId(db, accountParam) as Record<string, string> | null;
    }
    if (!redirectAccount) {
      // Find account by login_channel_id used in this OAuth flow
      redirectAccount = await db
        .prepare('SELECT * FROM line_accounts WHERE login_channel_id = ?')
        .bind(loginChannelId)
        .first<Record<string, string>>();
    }
    if (!redirectAccount) {
      // Fallback: first active account
      redirectAccount = await db
        .prepare('SELECT * FROM line_accounts WHERE is_active = 1 LIMIT 1')
        .first<Record<string, string>>();
    }
    if (redirectAccount?.channel_access_token) {
      try {
        const botInfo = await fetch('https://api.line.me/v2/bot/info', {
          headers: { Authorization: `Bearer ${redirectAccount.channel_access_token}` },
        });
        if (botInfo.ok) {
          const bot = await botInfo.json() as { basicId?: string };
          if (bot.basicId) {
            return c.redirect(`https://line.me/R/ti/p/${bot.basicId}`);
          }
        }
      } catch {
        // Fall through to completion page
      }
    }

    return c.html(completionPage(displayName, pictureUrl, ref));

  } catch (err) {
    console.error('Auth callback error:', err);
    return c.html(errorPage('Internal error'));
  }
});

// ─── Existing LIFF endpoints ────────────────────────────────────

// POST /api/liff/profile - get friend by LINE userId (public, no auth)
liffRoutes.post('/api/liff/profile', async (c) => {
  try {
    const body = await c.req.json<{ lineUserId: string }>();
    if (!body.lineUserId) {
      return c.json({ success: false, error: 'lineUserId is required' }, 400);
    }

    const friend = await getFriendByLineUserId(c.env.DB, body.lineUserId);
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    return c.json({
      success: true,
      data: {
        id: friend.id,
        displayName: friend.display_name,
        isFollowing: Boolean(friend.is_following),
        userId: (friend as unknown as Record<string, unknown>).user_id ?? null,
      },
    });
  } catch (err) {
    console.error('POST /api/liff/profile error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/liff/link - link friend to user UUID (public, verified via LINE ID token)
liffRoutes.post('/api/liff/link', async (c) => {
  try {
    const body = await c.req.json<{
      idToken: string;
      displayName?: string | null;
      ref?: string;
      existingUuid?: string;
    }>();

    if (!body.idToken) {
      return c.json({ success: false, error: 'idToken is required' }, 400);
    }

    // Try verifying with default Login channel, then DB accounts
    const loginChannelIds = [c.env.LINE_LOGIN_CHANNEL_ID];
    const dbAccounts = await getLineAccounts(c.env.DB);
    for (const acct of dbAccounts) {
      if (acct.login_channel_id && !loginChannelIds.includes(acct.login_channel_id)) {
        loginChannelIds.push(acct.login_channel_id);
      }
    }

    let verifyRes: Response | null = null;
    for (const channelId of loginChannelIds) {
      verifyRes = await fetch('https://api.line.me/oauth2/v2.1/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ id_token: body.idToken, client_id: channelId }),
      });
      if (verifyRes.ok) break;
    }

    if (!verifyRes?.ok) {
      return c.json({ success: false, error: 'Invalid ID token' }, 401);
    }

    const verified = await verifyRes.json<{ sub: string; email?: string; name?: string }>();
    const lineUserId = verified.sub;
    const email = verified.email || null;

    const db = c.env.DB;
    const friend = await getFriendByLineUserId(db, lineUserId);
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    if ((friend as unknown as Record<string, unknown>).user_id) {
      // Still save ref even if already linked (but never persist xh: tokens as ref_code)
      if (body.ref && !body.ref.startsWith('xh:')) {
        await db.prepare('UPDATE friends SET ref_code = ? WHERE id = ? AND ref_code IS NULL')
          .bind(body.ref, friend.id).run();
      }
      // X Harness token resolution for already-linked friends
      if (body.ref && body.ref.startsWith('xh:')) {
        try {
          const xhToken = body.ref.slice(3);
          const xhResult = await resolveXHarnessToken(xhToken, c.env);
          if (xhResult?.xUsername) {
            const existingMeta = await db
              .prepare('SELECT metadata FROM friends WHERE id = ?')
              .bind(friend.id)
              .first<{ metadata: string }>();
            const meta = JSON.parse(existingMeta?.metadata || '{}');
            meta.x_username = xhResult.xUsername;
            await db
              .prepare('UPDATE friends SET metadata = ? WHERE id = ?')
              .bind(JSON.stringify(meta), friend.id)
              .run();
            console.log(`X Harness: linked @${xhResult.xUsername} to friend ${friend.id}`);
          }
          if (xhResult) {
            await applyXHarnessActions(db, friend.id, xhResult);
          }
        } catch (err) {
          console.error('X Harness token resolution error (non-blocking):', err);
        }
      }
      return c.json({
        success: true,
        data: { userId: (friend as unknown as Record<string, unknown>).user_id, alreadyLinked: true },
      });
    }

    let userId: string | null = null;
    if (email) {
      const existingUser = await getUserByEmail(db, email);
      if (existingUser) userId = existingUser.id;
    }

    if (!userId) {
      const newUser = await createUser(db, {
        email,
        displayName: body.displayName || verified.name,
      });
      userId = newUser.id;
    }

    await linkFriendToUser(db, friend.id, userId);

    // Save ref_code from LIFF (first touch wins)
    // xh: refs are X Harness one-time tokens — never persist as ref_code
    if (body.ref && !body.ref.startsWith('xh:')) {
      await db.prepare('UPDATE friends SET ref_code = ? WHERE id = ? AND ref_code IS NULL')
        .bind(body.ref, friend.id).run();

      // Record ref tracking
      try {
        const route = await getEntryRouteByRefCode(db, body.ref);
        await recordRefTracking(db, {
          refCode: body.ref,
          friendId: friend.id,
          entryRouteId: route?.id ?? null,
          sourceUrl: null,
        });
      } catch { /* silent */ }
    }

    // X Harness token resolution: ref starting with "xh:" links X account to LINE friend
    if (body.ref && body.ref.startsWith('xh:')) {
      try {
        const xhToken = body.ref.slice(3);
        const xhResult = await resolveXHarnessToken(xhToken, c.env);
        if (xhResult?.xUsername) {
          const existingMeta = await db
            .prepare('SELECT metadata FROM friends WHERE id = ?')
            .bind(friend.id)
            .first<{ metadata: string }>();
          const meta = JSON.parse(existingMeta?.metadata || '{}');
          meta.x_username = xhResult.xUsername;
          await db
            .prepare('UPDATE friends SET metadata = ? WHERE id = ?')
            .bind(JSON.stringify(meta), friend.id)
            .run();
          console.log(`X Harness: linked @${xhResult.xUsername} to friend ${friend.id}`);
        }
        if (xhResult) {
          await applyXHarnessActions(db, friend.id, xhResult);
        }
      } catch (err) {
        console.error('X Harness token resolution error (non-blocking):', err);
      }
    }

    return c.json({
      success: true,
      data: { userId, alreadyLinked: false },
    });
  } catch (err) {
    console.error('POST /api/liff/link error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ─── Attribution Analytics ──────────────────────────────────────

/**
 * GET /api/analytics/ref-summary — ref code analytics summary
 */
liffRoutes.get('/api/analytics/ref-summary', async (c) => {
  try {
    const db = c.env.DB;
    const lineAccountId = c.req.query('lineAccountId');
    const accountFilter = lineAccountId ? 'AND f.line_account_id = ?' : '';
    const accountBinds = lineAccountId ? [lineAccountId] : [];

    const rows = await db
      .prepare(
        `SELECT
          er.ref_code,
          er.name,
          COUNT(DISTINCT rt.friend_id) as friend_count,
          COUNT(rt.id) as click_count,
          MAX(rt.created_at) as latest_at
        FROM entry_routes er
        LEFT JOIN ref_tracking rt ON er.ref_code = rt.ref_code
        LEFT JOIN friends f ON f.id = rt.friend_id ${accountFilter ? `${accountFilter}` : ''}
        GROUP BY er.ref_code, er.name
        ORDER BY friend_count DESC`,
      )
      .bind(...accountBinds)
      .all<{
        ref_code: string;
        name: string;
        friend_count: number;
        click_count: number;
        latest_at: string | null;
      }>();

    const totalStmt = lineAccountId
      ? db.prepare(`SELECT COUNT(*) as count FROM friends WHERE line_account_id = ?`).bind(lineAccountId)
      : db.prepare(`SELECT COUNT(*) as count FROM friends`);
    const totalFriendsRes = await totalStmt.first<{ count: number }>();

    const refStmt = lineAccountId
      ? db.prepare(`SELECT COUNT(*) as count FROM friends WHERE ref_code IS NOT NULL AND ref_code != '' AND line_account_id = ?`).bind(lineAccountId)
      : db.prepare(`SELECT COUNT(*) as count FROM friends WHERE ref_code IS NOT NULL AND ref_code != ''`);
    const friendsWithRefRes = await refStmt.first<{ count: number }>();

    const totalFriends = totalFriendsRes?.count ?? 0;
    const friendsWithRef = friendsWithRefRes?.count ?? 0;

    return c.json({
      success: true,
      data: {
        routes: (rows.results ?? []).map((r) => ({
          refCode: r.ref_code,
          name: r.name,
          friendCount: r.friend_count,
          clickCount: r.click_count,
          latestAt: r.latest_at,
        })),
        totalFriends,
        friendsWithRef,
        friendsWithoutRef: totalFriends - friendsWithRef,
      },
    });
  } catch (err) {
    console.error('GET /api/analytics/ref-summary error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/analytics/ref/:refCode — detailed friend list for a single ref code
 */
liffRoutes.get('/api/analytics/ref/:refCode', async (c) => {
  try {
    const db = c.env.DB;
    const refCode = c.req.param('refCode');

    const routeRow = await db
      .prepare(`SELECT ref_code, name FROM entry_routes WHERE ref_code = ?`)
      .bind(refCode)
      .first<{ ref_code: string; name: string }>();

    if (!routeRow) {
      return c.json({ success: false, error: 'Entry route not found' }, 404);
    }

    const lineAccountId = c.req.query('lineAccountId');
    const accountFilter = lineAccountId ? 'AND f.line_account_id = ?' : '';
    const binds = lineAccountId ? [refCode, refCode, lineAccountId] : [refCode, refCode];

    const friends = await db
      .prepare(
        `SELECT
          f.id,
          f.display_name,
          f.ref_code,
          rt.created_at as tracked_at
        FROM friends f
        LEFT JOIN ref_tracking rt ON f.id = rt.friend_id AND rt.ref_code = ?
        WHERE f.ref_code = ? ${accountFilter}
        ORDER BY rt.created_at DESC`,
      )
      .bind(...binds)
      .all<{
        id: string;
        display_name: string;
        ref_code: string | null;
        tracked_at: string | null;
      }>();

    return c.json({
      success: true,
      data: {
        refCode: routeRow.ref_code,
        name: routeRow.name,
        friends: (friends.results ?? []).map((f) => ({
          id: f.id,
          displayName: f.display_name,
          trackedAt: f.tracked_at,
        })),
      },
    });
  } catch (err) {
    console.error('GET /api/analytics/ref/:refCode error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/links/wrap - wrap a URL with LIFF redirect proxy
liffRoutes.post('/api/links/wrap', async (c) => {
  try {
    const body = await c.req.json<{ url: string; ref?: string }>();
    if (!body.url) {
      return c.json({ success: false, error: 'url is required' }, 400);
    }

    const liffUrl = c.env.LIFF_URL;
    if (!liffUrl) {
      return c.json({ success: false, error: 'LIFF_URL not configured' }, 500);
    }

    const params = new URLSearchParams({ redirect: body.url });
    if (body.ref) {
      params.set('ref', body.ref);
    }

    const wrappedUrl = `${liffUrl}?${params.toString()}`;
    return c.json({ success: true, data: { url: wrappedUrl } });
  } catch (err) {
    console.error('POST /api/links/wrap error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ─── HTML Templates ─────────────────────────────────────────────

function authLandingPage(liffUrl: string, oauthUrl: string): string {
  // Extract LIFF ID from URL like https://liff.line.me/{LIFF_ID}?ref=test
  const liffIdMatch = liffUrl.match(/liff\.line\.me\/([^?]+)/);
  const liffId = liffIdMatch ? liffIdMatch[1] : '';
  // Query string part (e.g., ?ref=test)
  const qsIndex = liffUrl.indexOf('?');
  const liffQs = qsIndex >= 0 ? liffUrl.slice(qsIndex) : '';

  // line:// scheme to force open LINE app with LIFF
  const lineSchemeUrl = `https://line.me/R/app/${liffId}${liffQs}`;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LINE で開く</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Hiragino Sans', system-ui, sans-serif; background: #0f172a; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 16px; padding: 40px 24px; box-shadow: 0 4px 16px rgba(0,0,0,0.15); text-align: center; max-width: 400px; width: 90%; }
    .line-icon { font-size: 48px; margin-bottom: 16px; }
    h2 { font-size: 20px; color: #333; margin-bottom: 8px; }
    .sub { font-size: 14px; color: #999; margin-bottom: 24px; }
    .btn { display: block; width: 100%; padding: 16px; border: none; border-radius: 8px; font-size: 16px; font-weight: 700; text-decoration: none; text-align: center; cursor: pointer; transition: opacity 0.15s; font-family: inherit; }
    .btn:active { opacity: 0.85; }
    .btn-line { background: #0f172a; color: #fff; margin-bottom: 12px; }
    .btn-web { background: #f5f5f5; color: #666; font-size: 13px; padding: 12px; }
    .loading { margin-top: 16px; font-size: 13px; color: #999; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <div class="card" id="card">
    <div class="line-icon">💬</div>
    <h2>LINEで開く</h2>
    <p class="sub">LINEアプリが起動します</p>
    <a href="${escapeHtml(lineSchemeUrl)}" class="btn btn-line" id="openBtn">LINEアプリで開く</a>
    <a href="${escapeHtml(oauthUrl)}" class="btn btn-web" id="pcBtn">PCの方・LINEが開かない方</a>
    <p class="loading hidden" id="loading">LINEアプリを起動中...</p>
  </div>
  <script>
    var lineUrl = '${escapeHtml(lineSchemeUrl)}';
    var ua = navigator.userAgent.toLowerCase();
    var isMobile = /iphone|ipad|android/.test(ua);
    var isLine = /line\\//.test(ua);
    var isIOS = /iphone|ipad/.test(ua);
    var isAndroid = /android/.test(ua);

    if (isLine) {
      // Already in LINE — go to LIFF directly
      window.location.href = '${escapeHtml(liffUrl)}';
    } else if (isMobile) {
      // Mobile browser — try to open LINE app
      document.getElementById('loading').classList.remove('hidden');
      document.getElementById('openBtn').classList.add('hidden');

      // Use line.me/R/app/ which is a Universal Link (iOS) / App Link (Android)
      // This opens LINE app directly without showing browser login
      setTimeout(function() {
        window.location.href = lineUrl;
      }, 100);

      // Fallback: if LINE app doesn't open within 2s, show the button
      setTimeout(function() {
        document.getElementById('loading').classList.add('hidden');
        document.getElementById('openBtn').classList.remove('hidden');
        document.getElementById('openBtn').textContent = 'もう一度試す';
      }, 2500);
    }
  </script>
</body>
</html>`;
}

function completionPage(displayName: string, pictureUrl: string | null, ref: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>登録完了</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Hiragino Sans', system-ui, sans-serif; background: #f5f5f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 16px; padding: 40px 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); text-align: center; max-width: 400px; width: 90%; }
    .check { width: 64px; height: 64px; border-radius: 50%; background: #0f172a; color: #fff; font-size: 32px; line-height: 64px; margin: 0 auto 16px; }
    h2 { font-size: 20px; color: #0f172a; margin-bottom: 16px; }
    .profile { display: flex; align-items: center; justify-content: center; gap: 12px; margin: 16px 0; }
    .profile img { width: 48px; height: 48px; border-radius: 50%; }
    .profile .name { font-size: 16px; font-weight: 600; }
    .message { font-size: 14px; color: #666; line-height: 1.6; margin-top: 12px; }
    .ref { display: inline-block; margin-top: 12px; padding: 4px 12px; background: #f0f0f0; border-radius: 12px; font-size: 11px; color: #999; }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">✓</div>
    <h2>登録完了！</h2>
    <div class="profile">
      ${pictureUrl ? `<img src="${escapeHtml(pictureUrl)}" alt="">` : ''}
      <p class="name">${escapeHtml(displayName)} さん</p>
    </div>
    <p class="message">ありがとうございます！<br>これからお役立ち情報をお届けします。<br>このページは閉じて大丈夫です。</p>
    ${ref ? `<p class="ref">${escapeHtml(ref)}</p>` : ''}
  </div>
</body>
</html>`;
}

/** Messaging API の /v2/bot/info から OA の basicId（@xxxx）を取得。友だち追加URLの組み立てに使う。 */
async function fetchBotBasicId(channelAccessToken: string): Promise<string> {
  try {
    const res = await fetch('https://api.line.me/v2/bot/info', {
      headers: { Authorization: `Bearer ${channelAccessToken}` },
    });
    if (res.ok) {
      const bot = (await res.json()) as { basicId?: string };
      return bot.basicId || '';
    }
  } catch {
    // ignore — basicId 無しでもページは表示する
  }
  return '';
}

/**
 * 連携は完了したが OA を友だち追加していないユーザーに、友だち追加を促すページ。
 * 追加しないとメッセージが届かないため、登録完了ではなくこの画面を出す。
 */
function friendAddPage(displayName: string, pictureUrl: string | null, basicId: string): string {
  const addUrl = basicId ? `https://line.me/R/ti/p/${escapeHtml(basicId)}` : '';
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>あと少しで完了</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Hiragino Sans', system-ui, sans-serif; background: #f5f5f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 16px; padding: 40px 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); text-align: center; max-width: 400px; width: 90%; }
    .icon { width: 64px; height: 64px; border-radius: 50%; background: #06C755; color: #fff; font-size: 32px; line-height: 64px; margin: 0 auto 16px; }
    h2 { font-size: 20px; color: #0f172a; margin-bottom: 12px; }
    .profile { display: flex; align-items: center; justify-content: center; gap: 12px; margin: 12px 0; }
    .profile img { width: 40px; height: 40px; border-radius: 50%; }
    .profile .name { font-size: 15px; font-weight: 600; }
    .message { font-size: 14px; color: #475569; line-height: 1.7; margin: 12px 0 24px; }
    .btn { display: block; width: 100%; padding: 16px; border: none; border-radius: 10px; font-size: 16px; font-weight: 700; text-decoration: none; text-align: center; background: #06C755; color: #fff; }
    .btn:active { opacity: 0.85; }
    .sub { font-size: 12px; color: #94a3b8; margin-top: 16px; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">+</div>
    <h2>あと少しで完了です</h2>
    <div class="profile">
      ${pictureUrl ? `<img src="${escapeHtml(pictureUrl)}" alt="">` : ''}
      <p class="name">${escapeHtml(displayName)} さん</p>
    </div>
    <p class="message">メッセージをお届けするには<br><b>友だち追加</b>が必要です。<br>下のボタンから追加をお願いします。</p>
    ${addUrl ? `<a href="${addUrl}" class="btn">LINEで友だち追加する</a>` : `<p class="message">お手数ですが LINE 公式アカウントを検索して友だち追加してください。</p>`}
    <p class="sub">追加後、メッセージが届くようになります。<br>このページは閉じて大丈夫です。</p>
  </div>
</body>
</html>`;
}

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>エラー</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Hiragino Sans', system-ui, sans-serif; background: #f5f5f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 16px; padding: 40px 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); text-align: center; max-width: 400px; width: 90%; }
    h2 { font-size: 18px; color: #e53e3e; margin-bottom: 12px; }
    p { font-size: 14px; color: #666; }
  </style>
</head>
<body>
  <div class="card">
    <h2>エラー</h2>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── X Harness Token Resolution ─────────────────────────────────

/**
 * Apply X Harness gate actions (tag + scenario) to a LINE friend.
 * Non-blocking — failures are logged but don't interrupt the flow.
 */
async function applyXHarnessActions(
  db: D1Database,
  friendId: string,
  result: XHarnessTokenResult,
): Promise<void> {
  // Add tag if specified
  if (result.tag) {
    try {
      // Find or create the tag by name
      let tagRow = await db
        .prepare('SELECT id FROM tags WHERE name = ?')
        .bind(result.tag)
        .first<{ id: string }>();
      if (!tagRow) {
        const tagId = crypto.randomUUID();
        const { jstNow } = await import('@line-crm/db');
        tagRow = await db
          .prepare('INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?) RETURNING id')
          .bind(tagId, result.tag, jstNow())
          .first<{ id: string }>();
      }
      if (tagRow) {
        const { addTagToFriend } = await import('@line-crm/db');
        await addTagToFriend(db, friendId, tagRow.id);
        console.log(`X Harness: added tag "${result.tag}" to friend ${friendId}`);
      }
    } catch (err) {
      console.error(`X Harness: failed to add tag "${result.tag}":`, err);
    }
  }

  // Start scenario if specified
  if (result.scenarioId) {
    try {
      const { enrollFriendInScenario } = await import('@line-crm/db');
      await enrollFriendInScenario(db, friendId, result.scenarioId);
      console.log(`X Harness: enrolled friend ${friendId} in scenario ${result.scenarioId}`);
    } catch (err) {
      console.error(`X Harness: failed to enroll in scenario:`, err);
    }
  }
}

interface XHarnessTokenResult {
  xUsername: string | null;
  tag: string | null;
  scenarioId: string | null;
}

/**
 * Resolve an X Harness token to get the linked X username + gate config (tag, scenario).
 * The token IS the secret — no Bearer auth needed on the resolve endpoint.
 */
async function resolveXHarnessToken(
  token: string,
  env: { X_HARNESS_URL?: string },
): Promise<XHarnessTokenResult | null> {
  if (!env.X_HARNESS_URL) return null;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout — must not block login flow
    try {
      const res = await fetch(`${env.X_HARNESS_URL}/api/tokens/${token}/resolve`, {
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const body = await res.json() as { success: boolean; data?: XHarnessTokenResult };
      if (!body.success || !body.data) return null;
      return { xUsername: body.data.xUsername, tag: body.data.tag ?? null, scenarioId: body.data.scenarioId ?? null };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    return null;
  }
}

// ─── LIFF IDトークン検証（共有ヘルパ） ──────────────────────────

/**
 * LIFF SDK の ID トークンを LINE の verify エンドポイントで検証し、ペイロードを返す。
 * 検証失敗（改ざん・期限切れ・別チャネル発行）は null。
 *
 * LIFF IDトークンの client_id は LIFF Channel ID。LINE_CHANNEL_ID を利用。
 * 既存実装と同様、複数アカウントをフォールバックで試す。
 */
export async function verifyLiffIdToken(
  db: D1Database,
  env: { LINE_CHANNEL_ID: string; LINE_LOGIN_CHANNEL_ID: string },
  idToken: string,
): Promise<{ sub: string; name?: string; email?: string } | null> {
  const channelIds = [env.LINE_CHANNEL_ID, env.LINE_LOGIN_CHANNEL_ID].filter(Boolean);
  const dbAccounts = await getLineAccounts(db);
  for (const acct of dbAccounts) {
    if (acct.channel_id && !channelIds.includes(acct.channel_id)) {
      channelIds.push(acct.channel_id);
    }
    if (acct.login_channel_id && !channelIds.includes(acct.login_channel_id)) {
      channelIds.push(acct.login_channel_id);
    }
  }

  for (const channelId of channelIds) {
    const verifyRes = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
    });
    if (verifyRes.ok) {
      return await verifyRes.json<{ sub: string; name?: string; email?: string }>();
    }
  }
  return null;
}

// ─── 撮影予約 LIFF自動認証 ──────────────────────────────────────

/**
 * POST /api/liff/booking-auth
 *
 * LIFF SDKから取得したIDトークンで本人確認 → friendId解決 → セッションCookie発行
 * 出品者がLINEアプリ内で予約ページを開いた時に自動ログインするためのエンドポイント
 *
 * body: { idToken: string }
 * response: { success, data: { friendId, lineUserId, displayName } }
 * Set-Cookie: __booking_session=<jwt>
 */
liffRoutes.post('/api/liff/booking-auth', async (c) => {
  try {
    const body = await c.req.json<{ idToken: string }>();
    if (!body.idToken) {
      return c.json({ success: false, error: 'idToken is required' }, 400);
    }
    if (!c.env.SESSION_SECRET) {
      return c.json({ success: false, error: 'SESSION_SECRET is not configured' }, 500);
    }

    const verified = await verifyLiffIdToken(c.env.DB, c.env, body.idToken);
    if (!verified) {
      return c.json({ success: false, error: 'Invalid ID token' }, 401);
    }

    const lineUserId = verified.sub;
    const friend = await getFriendByLineUserId(c.env.DB, lineUserId);
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found in LINE Harness' }, 404);
    }

    const { createSessionToken, buildSessionCookie } = await import('../utils/session.js');
    const sessionToken = await createSessionToken(
      {
        friendId: friend.id,
        lineUserId,
        displayName: friend.display_name || verified.name || 'Unknown',
      },
      c.env.SESSION_SECRET,
    );

    return new Response(
      JSON.stringify({
        success: true,
        data: {
          friendId: friend.id,
          lineUserId,
          displayName: friend.display_name || verified.name || 'Unknown',
        },
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': buildSessionCookie(sessionToken),
        },
      },
    );
  } catch (err) {
    console.error('POST /api/liff/booking-auth error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { liffRoutes };
