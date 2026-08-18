// BOXIV-only: 管理画面ログイン（メール6桁コード）。
//
// 人間の入口だけをここに置く。機械の入口（staff_members.api_key / env API_KEY）は
// middleware/auth.ts のまま 1 バイトも変えない。promote-*.mjs / slack-daemon /
// mcp-server など 14 本以上のスクリプトが同じキーを使っているため。
//
// 認証をスキップするのは start と verify の **完全一致のみ**（middleware/auth.ts）。
// 前方一致にすると /api/auth/session まで素通りする。
import { Hono } from 'hono';
import {
  countRecentChallenges,
  createLoginChallenge,
  findActiveStaffByEmail,
  getStaffById,
  hitThrottle,
  invalidateLoginChallenges,
  isValidEmail,
  listStaffSessions,
  recordAuditLog,
  revokeStaffSession,
  throttleBucket,
  verifyAndConsumeLoginCode,
  DEFAULT_CODE_TTL_MINUTES,
  DEFAULT_ISSUE_MAX,
  DEFAULT_ISSUE_MAX_PER_IP,
  DEFAULT_ISSUE_WINDOW_MINUTES,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_SESSION_TTL_HOURS,
  DEFAULT_VERIFY_FAIL_MAX_PER_IP,
  DEFAULT_VERIFY_FAIL_WINDOW_MINUTES,
} from '@line-crm/db';
import { requireRole } from '../middleware/role-guard.js';
import {
  alertAdminAuth,
  maskEmail,
  sendLoginCodeEmail,
} from '../services/staff-auth-email.boxiv.js';
import { escapeSlackText, slackWebhookPost } from '../services/slack.boxiv.js';
import type { Env } from '../index.js';

const authEmail = new Hono<Env>();

// ---------------------------------------------------------------------------
// 設定（env で上書き可。既定は packages/db の定数）
// ---------------------------------------------------------------------------

function intEnv(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function config(env: Env['Bindings']) {
  return {
    codeTtlMinutes: intEnv(env.ADMIN_LOGIN_CODE_TTL_MINUTES, DEFAULT_CODE_TTL_MINUTES),
    maxAttempts: intEnv(env.ADMIN_LOGIN_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS),
    issueMax: intEnv(env.ADMIN_LOGIN_ISSUE_MAX, DEFAULT_ISSUE_MAX),
    issueMaxPerIp: intEnv(env.ADMIN_LOGIN_ISSUE_MAX_PER_IP, DEFAULT_ISSUE_MAX_PER_IP),
    issueWindowMinutes: intEnv(env.ADMIN_LOGIN_ISSUE_WINDOW_MINUTES, DEFAULT_ISSUE_WINDOW_MINUTES),
    failMaxPerIp: intEnv(env.ADMIN_LOGIN_FAIL_MAX_PER_IP, DEFAULT_VERIFY_FAIL_MAX_PER_IP),
    failWindowMinutes: intEnv(
      env.ADMIN_LOGIN_FAIL_WINDOW_MINUTES,
      DEFAULT_VERIFY_FAIL_WINDOW_MINUTES,
    ),
    sessionTtlHours: intEnv(env.ADMIN_SESSION_TTL_HOURS, DEFAULT_SESSION_TTL_HOURS),
  };
}

/**
 * 試行元 IP。**cf-connecting-ip だけを見る。**
 *
 * x-forwarded-for へフォールバックしてはいけない。XFF はクライアントが自由に付けられ、
 * `split(',')[0]` はその自称値を拾う。スロットルの鍵にすると、攻撃者はヘッダを1文字
 * 変えるだけで毎回まっさらな枠を手に入れられ、IP 単位の上限が丸ごと無意味になる。
 * 一方 cf-connecting-ip は Cloudflare のエッジが必ず上書きし、**クライアントが付けて
 * 送ると 403(error 1000) で弾かれる**（実測）。詐称できないのはこちらだけ。
 *
 * 記録用（challenge.request_ip / session.ip）も同じ値を使う。自称値を証跡に残すと、
 * 後から調べたときに実在しない IP を追いかけることになる。
 */
function clientIp(headers: Headers): string | null {
  return headers.get('cf-connecting-ip');
}

/**
 * 試行元 IP 単位のスロットル。**IP が取れないときは掛けない。**
 *
 * 取れない場合に全員を 1 つの bucket へまとめると、ヘッダが落ちた瞬間に
 * 「9 名まとめてログイン不能」という、この改修が防ごうとしているものそのものが起きる。
 * Cloudflare 経由なら cf-connecting-ip は常に付く（クライアントが詐称してもエッジで上書きされる）ので、
 * 取れないのは異常事態。素通しにしたうえで運用に見えるようにする。
 * 素通しでも、チャレンジ単位の attempts とアカウント単位の発行上限は依然として効く。
 */
async function ipThrottle(
  c: { env: Env['Bindings'] },
  kind: 'login_issue' | 'login_fail',
  ip: string | null,
  max: number,
  windowMinutes: number,
): Promise<{ allowed: boolean; count: number }> {
  if (!ip) {
    console.warn(`[admin-auth] ${kind}: クライアント IP が取得できずスロットルをスキップ`);
    return { allowed: true, count: 0 };
  }
  return hitThrottle(c.env.DB, throttleBucket(kind, ip), max, windowMinutes);
}

/** Slack へ 1 行流す（webhook 未設定なら console のみ）。throw しない。 */
async function notifySlack(env: Env['Bindings'], text: string): Promise<void> {
  const url = env.SLACK_ADMIN_ALERT_WEBHOOK_URL || env.SLACK_REMINDER_WEBHOOK_URL;
  if (!url) return;
  await slackWebhookPost(url, text);
}

/**
 * ログイン系の監査ログ。
 *
 * ログイン成功/失敗/ログアウトは「認証前」または「認証を確定させる瞬間」の出来事なので、
 * middleware/audit-log.boxiv.ts（c.get('staff') 前提）では拾えない。必ずここから明示的に書く。
 */
async function auditLogin(
  env: Env['Bindings'],
  input: {
    action: string;
    summary: string;
    actorId: string | null;
    actorName: string | null;
    actorRole: string | null;
    status: number;
    path: string;
    detail?: Record<string, unknown>;
    sessionId?: string | null;
  },
): Promise<void> {
  try {
    await recordAuditLog(env.DB, {
      actorId: input.actorId,
      actorName: input.actorName,
      actorRole: input.actorRole,
      action: input.action,
      summary: input.summary,
      targetType: 'staff',
      targetId: input.actorId,
      targetLabel: input.actorName,
      method: 'POST',
      path: input.path,
      status: input.status,
      // メールアドレスは detail に生で入れない（マスク済みだけ入れる）。
      detail: input.detail ?? {},
      actorVia: 'session',
      actorSessionId: input.sessionId ?? null,
    });
  } catch (err) {
    console.error('auditLogin failed:', err);
  }
}

/**
 * 宛先の存在を漏らさない共通レスポンス。
 *
 * 「そのアドレスは登録されていません」を返すと、誰が管理画面に入れるかを外から
 * 総当たりで列挙できてしまう。登録の有無にかかわらず同じ本文・同じ status を返す。
 */
const GENERIC_START_RESPONSE = {
  success: true,
  data: { message: '登録されているメールアドレスであれば、認証コードを送信しました。' },
};

/**
 * 汎用レスポンスを返してよいのは「**構文として妥当なメールアドレス**が来たが、
 * それが登録済みかどうかは明かさない」場合だけ。
 *
 * 本文が壊れている / email が無い / 空 / 形式不正 は 400 で明確に落とす。
 * これらが登録済みアドレスであることはあり得ないので隠して得るものが無く、
 * 一方で隠すと「フロントがフィールド名を間違えた」ような不具合が
 * 画面上『メールを送りました』に化けて、利用者は永遠に来ないメールを待つことになる。
 * 403 が「APIキーが正しくありません」に化けて 3 日間の締め出しに気づけなかったのと同じ型。
 */
const BAD_REQUEST = {
  success: false,
  error: 'メールアドレスの形式が正しくありません',
} as const;

// ---------------------------------------------------------------------------
// POST /api/auth/email/start — コードを発行してメールで送る（認証不要）
// ---------------------------------------------------------------------------
authEmail.post('/api/auth/email/start', async (c) => {
  const cfg = config(c.env);
  try {
    const body = await c.req.json<{ email?: string }>().catch(() => null);
    // 本文が JSON でない / email が無い / 空 / 形式不正 → 400（BAD_REQUEST のコメント参照）
    if (!body || typeof body !== 'object') return c.json(BAD_REQUEST, 400);
    const email = String(body.email ?? '').trim();
    if (!email || !isValidEmail(email)) return c.json(BAD_REQUEST, 400);

    const ip = clientIp(c.req.raw.headers);

    // 試行元（IP）単位の発行上限。アカウント単位の枠より先に効かせる。
    // この口は認証不要なので、アカウント単位だけで数えると
    // 「メールアドレスを知っているだけの第三者」が本人の発行枠を食い潰して
    // 本人の『コードを送る』を無言で殺せる（migration 920 のコメント参照）。
    const ipQuota = await ipThrottle(c, 'login_issue', ip, cfg.issueMaxPerIp, cfg.issueWindowMinutes);
    if (!ipQuota.allowed) {
      console.warn('[admin-auth] start: IP 単位の発行上限', ip, ipQuota.count);
      return c.json(GENERIC_START_RESPONSE);
    }

    // ここから先は「構文は妥当」。登録の有無は一切漏らさず、常に同じ応答を返す。
    const staff = await findActiveStaffByEmail(c.env.DB, email);
    if (!staff) {
      console.log('[admin-auth] start: 未登録または重複アドレス', maskEmail(email));
      return c.json(GENERIC_START_RESPONSE);
    }

    // アカウント単位の発行上限（IP 単位の上限を通り抜けた分に対する保険）。
    const recent = await countRecentChallenges(c.env.DB, staff.id, cfg.issueWindowMinutes);
    if (recent >= cfg.issueMax) {
      await notifySlack(
        c.env,
        `:warning: ログインコードの発行が上限に達しました（${escapeSlackText(staff.name)} / ${cfg.issueWindowMinutes}分で${recent}回）`,
      );
      return c.json(GENERIC_START_RESPONSE);
    }

    const challenge = await createLoginChallenge(c.env.DB, {
      staffId: staff.id,
      email: staff.email ?? email,
      purpose: 'login',
      ttlMinutes: cfg.codeTtlMinutes,
      maxAttempts: cfg.maxAttempts,
      requestIp: ip,
    });

    // リンクはコードを「入力済みにする」だけ。開いた時点では消費されない（消費は POST /verify）。
    const base = (c.env.ADMIN_BASE_URL ?? '').replace(/\/+$/, '');
    const loginUrl = base
      ? `${base}/login?email=${encodeURIComponent(staff.email ?? email)}&code=${challenge.code}`
      : null;

    const sent = await sendLoginCodeEmail(c.env, {
      to: staff.email ?? email,
      staffName: staff.name,
      code: challenge.code,
      ttlMinutes: cfg.codeTtlMinutes,
      loginUrl,
    });

    // 送信できなかったことを本人は知りようがない（画面は同じ文言を出す）ので、
    // 必ず運用側に見えるところへ出す。sendLoginCodeEmail 内でも Slack 通報している。
    if (!sent.ok) {
      console.error('[admin-auth] ログインコードの送信に失敗', maskEmail(staff.email ?? email));
    }

    return c.json(GENERIC_START_RESPONSE);
  } catch (err) {
    // ここに来るのは D1 / SendGrid 側の想定外。汎用 200 で握り潰すと
    // 「送ったつもりで誰にも届いていない」状態が画面にもログにも残らない。
    console.error('POST /api/auth/email/start error:', err);
    await alertAdminAuth(
      c.env,
      `ログインコードの発行処理が失敗: ${err instanceof Error ? err.message : String(err)}`,
    );
    return c.json({ success: false, error: '認証コードの送信に失敗しました' }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/email/verify — コードを検証してセッションを発行（認証不要）
// ---------------------------------------------------------------------------
authEmail.post('/api/auth/email/verify', async (c) => {
  const cfg = config(c.env);
  const FAIL = { success: false, error: 'メールアドレスまたは認証コードが正しくありません' } as const;

  try {
    const body = await c.req.json<{ email?: string; code?: string }>().catch(() => null);
    // 「形が違う」は 400、「資格情報が合わない」は 401 と分ける。
    // 401 に混ぜると、フロントの不具合（フィールド名の取り違え等）が
    // 「コードが間違っています」に化けて、利用者は正しいコードを打ち直し続ける。
    if (!body || typeof body !== 'object') {
      return c.json({ success: false, error: 'リクエストの形式が正しくありません' }, 400);
    }
    const email = String(body.email ?? '').trim();
    const code = String(body.code ?? '').replace(/[\s-]/g, '');

    if (!email || !isValidEmail(email)) {
      return c.json({ success: false, error: 'メールアドレスの形式が正しくありません' }, 400);
    }
    if (!/^\d{6}$/.test(code)) {
      return c.json({ success: false, error: '認証コードは6桁の数字です' }, 400);
    }

    // ここから先は入力の形が正しい。失敗理由は一切区別せず 401 のみを返す
    // （未登録アドレスと間違ったコードを外から見分けられないようにする）。

    const ip = clientIp(c.req.raw.headers);

    // 試行元（IP）単位の失敗上限。総当たりの実質的な上限はここで決まる。
    // アカウント単位の attempts だけに頼ると、メールアドレスを知っている第三者が
    // 無効コードを投げるだけで本人の受け取ったコードごと焼き切れてしまう。
    // 上限に達した後は **チャレンジに一切触れずに** 落とすのが要点
    //（触ると結局その第三者が本人のコードを焼けることになる）。
    const ipQuota = await ipThrottle(c, 'login_fail', ip, cfg.failMaxPerIp, cfg.failWindowMinutes);
    if (!ipQuota.allowed) {
      console.warn('[admin-auth] verify: IP 単位の失敗上限', ip, ipQuota.count);
      if (ipQuota.count === cfg.failMaxPerIp + 1) {
        await notifySlack(
          c.env,
          `:lock: 管理画面ログインの失敗が同一 IP で上限に達しました（${cfg.failWindowMinutes}分で${ipQuota.count}回）。総当たりの可能性があります。`,
        );
      }
      // 401（コードが違う）と混ぜない。この判定はメールアドレスを引く**前**に、
      // 試行元 IP だけで行っているので、登録の有無は一切漏れない。
      // 一方で混ぜると、正しいコードを持っている本人が「コードが違う」と言われ続け、
      // 打ち直すほど状況が悪くなる（打ち直しも失敗として数えられる）。
      return c.json(
        {
          success: false,
          error: `ログインの試行が多すぎます。${cfg.failWindowMinutes}分ほど待ってから、もう一度お試しください`,
        },
        429,
      );
    }

    const staff = await findActiveStaffByEmail(c.env.DB, email);
    if (!staff) return c.json(FAIL, 401);

    const result = await verifyAndConsumeLoginCode(c.env.DB, staff.id, code, {
      staffId: staff.id,
      // 管理者発行コードで入った事実はセッションにも残す（監査ログだけに頼らない）。
      issuedVia: 'email_code',
      userAgent: c.req.header('user-agent') ?? null,
      ip,
      ttlHours: cfg.sessionTtlHours,
    });
    if (!result.ok) {
      await auditLogin(c.env, {
        action: 'auth.login_failed',
        summary: '管理画面へのログインに失敗',
        actorId: staff.id,
        actorName: staff.name,
        actorRole: staff.role,
        status: 401,
        path: '/api/auth/email/verify',
        detail: { reason: result.reason, emailMasked: maskEmail(staff.email) },
      });
      if (result.reason === 'locked') {
        await notifySlack(
          c.env,
          `:lock: ログインコードの試行回数上限に達しました（${escapeSlackText(staff.name)}）。本人でない可能性があります。`,
        );
      }
      return c.json(FAIL, 401);
    }

    // セッションはコード消費と同一 batch で作られている（片方だけ成立しない）。
    // ここが null になるのは呼び出し側が session を渡さなかったときだけ。
    const session = result.session;
    if (!session) {
      // 到達しない想定。到達したら 401 に化けさせず 500 + 通報で気づけるようにする。
      await alertAdminAuth(c.env, 'verify: セッションが発行されずに成功が返った（実装の不整合）');
      return c.json({ success: false, error: 'ログイン処理に失敗しました' }, 500);
    }

    // 管理者発行コードで入った事実をセッションにも残す（監査ログだけに頼らない）。
    if (result.challenge.purpose === 'admin_issued') {
      await c.env.DB.prepare("UPDATE staff_sessions SET issued_via = 'admin_issued' WHERE id = ?")
        .bind(session.id)
        .run();
    }

    // 他の未使用コードも道連れにする（発行済みの別コードを後から使わせない）。
    // セッションは既に発行済みなので、ここが失敗してもログインは成立している。
    await invalidateLoginChallenges(c.env.DB, staff.id);

    await auditLogin(c.env, {
      action: 'auth.login',
      summary: '管理画面にログイン',
      actorId: staff.id,
      actorName: staff.name,
      actorRole: staff.role,
      status: 200,
      path: '/api/auth/email/verify',
      sessionId: session.id,
      detail: {
        via: result.challenge.purpose === 'admin_issued' ? '管理者発行コード' : 'メールコード',
        emailMasked: maskEmail(staff.email),
      },
    });

    c.executionCtx.waitUntil(
      notifySlack(
        c.env,
        `:white_check_mark: 管理画面ログイン: ${escapeSlackText(staff.name)}（${escapeSlackText(staff.role)}）` +
          (result.challenge.purpose === 'admin_issued' ? ' ※管理者発行コード' : ''),
      ).catch(() => {}),
    );

    return c.json({
      success: true,
      data: {
        token: session.token,
        expiresAt: session.expiresAt,
        staff: {
          id: staff.id,
          name: staff.name,
          role: staff.role,
          email: staff.email,
          workArea: staff.work_area ?? null,
        },
      },
    });
  } catch (err) {
    // 内部エラーを 401 に混ぜない。混ぜると「正しいコードを打ったのに
    // コードが違うと言われる」状態になり、しかもコードは消費済みなので
    // 打ち直しても no_challenge で同じ 401 が返り、利用者は抜け出せない。
    // start 側が 500 + 通報なのに verify だけ 401 では非対称でもある。
    console.error('POST /api/auth/email/verify error:', err);
    await alertAdminAuth(
      c.env,
      `ログイン検証が失敗: ${err instanceof Error ? err.message : String(err)}`,
    );
    return c.json({ success: false, error: 'ログイン処理に失敗しました' }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /api/auth/session — 現在のセッション（要認証）
// ---------------------------------------------------------------------------
// ⚠️ 認証スキップ一覧には入れない。start/verify を「完全一致」で並べているのはこのため
//    （前方一致にするとこのルートまで素通りする）。
authEmail.get('/api/auth/session', async (c) => {
  const staff = c.get('staff');
  const sessionId = c.get('authSessionId') ?? null;
  return c.json({
    success: true,
    data: {
      staff,
      authVia: c.get('authVia') ?? null,
      sessionId,
      sessions: sessionId ? await listStaffSessions(c.env.DB, staff.id) : [],
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout — 今のセッションを失効（要認証）
// ---------------------------------------------------------------------------
authEmail.post('/api/auth/logout', async (c) => {
  const staff = c.get('staff');
  const sessionId = c.get('authSessionId');

  // API キーでログインしている旧経路は「失効させるセッション」が無い。
  // 端末側でキーを消すだけなので、ここは成功として返す（画面の挙動を分岐させない）。
  if (!sessionId) return c.json({ success: true, data: { revoked: 0 } });

  const revoked = await revokeStaffSession(c.env.DB, sessionId, 'logout');
  await auditLogin(c.env, {
    action: 'auth.logout',
    summary: '管理画面からログアウト',
    actorId: staff.id,
    actorName: staff.name,
    actorRole: staff.role,
    status: 200,
    path: '/api/auth/logout',
    sessionId,
  });
  return c.json({ success: true, data: { revoked } });
});

// ---------------------------------------------------------------------------
// POST /api/staff/:id/login-code — 管理者による救済コード発行
// ---------------------------------------------------------------------------
// メールが届かない人を入れるための経路。**構造上「なりすませる」機能**でもあり、
// しかも旧方式のキー再生成と違って本人のログインを壊さないので本人が気づかない。
// 緩和は「発行者名を必ず残す」「上位ロールは対象にできない」の 2 点だけで、
// 権限の性質そのものは消せない（可用性とのトレードオフとして受け入れる判断）。
authEmail.post('/api/staff/:id/login-code', requireRole('owner', 'manager'), async (c) => {
  const cfg = config(c.env);
  try {
    const id = c.req.param('id')!;
    const actor = c.get('staff');

    const target = await getStaffById(c.env.DB, id);
    if (!target) return c.json({ success: false, error: 'Staff member not found' }, 404);
    if (target.is_active !== 1) {
      return c.json({ success: false, error: '無効化されたスタッフにはコードを発行できません' }, 400);
    }

    // マネージャーが発行できる相手は撮影スタッフのみ。routes/staff.ts の既存 4 箇所
    // （作成 / 編集 / 削除 / キー再生成）が全て「manager は staff のみ」で揃っているので、
    // ここだけ広げない。
    //
    // 特に **キー再生成との対比**が決定的:
    //   - 他 manager のキー再生成 = 禁止。しかも実行すれば相手のログインが壊れて本人が気づく
    //   - 他 manager への救済コード発行 = ここを開けると許可。しかも相手のログインを壊さず
    //     本人は気づかない
    // より強くて、より静かな経路を、既存が禁じている相手に対して開けることになる。
    // 可用性のための機能が既存の権限境界を後ろから崩す形なので、staff のみに閉じる。
    //
    // 対価: manager が入れなくなった場合の救済は owner（env API_KEY 保管者）に限られる。
    // 「manager 同士のなりすまし」を塞ぐ対価として受け入れる。
    if (actor.role === 'manager' && target.role !== 'staff') {
      return c.json(
        { success: false, error: 'マネージャーは撮影スタッフにのみ発行できます' },
        403,
      );
    }

    // ⚠️ verify は必ず findActiveStaffByEmail でスタッフを解決する。つまり
    //    「メール未設定」「他スタッフとメール重複（複数一致は null に倒す設計）」の行に
    //    コードを発行しても、そのコードは **構造上どのアドレスを打っても消費できない**。
    //    ここを検証しないと、メール不達者のための唯一の救済経路が
    //    琥珀バナー + Slack 通知つきで「成功したふり」をする。発行前に必ず落とす。
    if (!target.email || !isValidEmail(target.email)) {
      return c.json(
        {
          success: false,
          error:
            'このスタッフにはログインできるメールアドレスが登録されていません。先にメールアドレスを登録してください（変更はオーナーのみ）',
        },
        400,
      );
    }
    const resolved = await findActiveStaffByEmail(c.env.DB, target.email);
    if (!resolved || resolved.id !== target.id) {
      return c.json(
        {
          success: false,
          error:
            'このメールアドレスは他のスタッフと重複しているため、コードを発行してもログインできません。先に重複を解消してください',
        },
        409,
      );
    }

    const challenge = await createLoginChallenge(c.env.DB, {
      staffId: target.id,
      email: target.email,
      purpose: 'admin_issued',
      issuedById: actor.id,
      issuedByName: actor.name,
      ttlMinutes: cfg.codeTtlMinutes,
      maxAttempts: cfg.maxAttempts,
      requestIp: clientIp(c.req.raw.headers),
    });

    // 発行者名を必ず残す（監査ログ + Slack）。これが唯一の抑止力。
    await recordAuditLog(c.env.DB, {
      actorId: actor.id,
      actorName: actor.name,
      actorRole: actor.role,
      action: 'auth.login_code_issued',
      summary: '他スタッフのログインコードを発行',
      targetType: 'staff',
      targetId: target.id,
      targetLabel: target.name,
      method: 'POST',
      path: `/api/staff/${target.id}/login-code`,
      status: 200,
      detail: { targetRole: target.role, emailMasked: maskEmail(target.email) },
      actorVia: c.get('authVia') ?? null,
      actorSessionId: c.get('authSessionId') ?? null,
    });

    await notifySlack(
      c.env,
      `:key: ${escapeSlackText(actor.name)} が ${escapeSlackText(target.name)}（${escapeSlackText(target.role)}）の` +
        `ログインコードを発行しました。本人以外が使えば、そのまま本人として操作できます。`,
    );

    return c.json({
      success: true,
      data: {
        code: challenge.code,
        expiresAt: challenge.expiresAt,
        staff: { id: target.id, name: target.name, email: target.email, role: target.role },
      },
    });
  } catch (err) {
    console.error('POST /api/staff/:id/login-code error:', err);
    await alertAdminAuth(c.env, `救済コードの発行に失敗: ${err instanceof Error ? err.message : String(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { authEmail };
