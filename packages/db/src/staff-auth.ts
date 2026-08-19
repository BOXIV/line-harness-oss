// BOXIV: 管理画面のメール認証コードログイン（staff_login_challenges / staff_sessions）。
//
// 設計の要点:
//   - 平文の 6 桁コードもセッショントークンも DB に保存しない。SHA-256 の hex だけを持つ。
//   - 総当たり対策は D1 側で行う。middleware/rate-limit.ts は isolate ごとのメモリで、
//     Worker では同じ攻撃者のリクエストが別 isolate に散るため当てにならない。
//     試行加算は「単一 UPDATE 文 + meta.changes」でアトミックに行う（read-then-write しない）。
//   - セッションは D1 実体。検証のたびに staff_members を join して is_active と role を
//     引き直すので、スタッフ一覧で「無効化」を押した次の操作から締め出せる。
//   - 機械用の API キー経路（staff_members.api_key / env API_KEY）はここでは一切扱わない。
//     人間の認証と機械の認証を分離するのがこの仕組みの目的。
import { jstNow } from './utils';
import type { StaffMember } from './staff';

// ---------------------------------------------------------------------------
// 既定値（呼び出し側で env から上書きできる）
// ---------------------------------------------------------------------------

/** 6 桁コードの有効期限（分） */
export const DEFAULT_CODE_TTL_MINUTES = 10;
/** 1 チャレンジあたりのコード検証試行回数の上限 */
export const DEFAULT_MAX_ATTEMPTS = 5;
/**
 * セッションの絶対期限（時間）。既定 7 日。
 *
 * iOS Safari はサイトを 7 日間触らないとブラウザの保存領域を消すため、
 * それより長い期限は低頻度利用者（撮影スタッフ）には実効性が無い。
 * 「端末が覚えている期間」と「サーバ側の期限」を揃えておくと、
 * 切れた理由の説明が 1 つで済む。
 */
export const DEFAULT_SESSION_TTL_HOURS = 24 * 7;
/**
 * 同一スタッフがコード発行できる回数と窓（分）。
 *
 * この枠は **第三者に消費されうる**（start は認証不要でメールアドレスさえ知っていれば叩ける）。
 * そのため枠自体は緩めに取り、実質的な抑止は下の IP 単位のスロットル（migration 920）で行う。
 * ここを絞りすぎると、攻撃者が枠を食い潰して本人の「コードを送る」を無言で殺せる。
 */
export const DEFAULT_ISSUE_MAX = 10;
export const DEFAULT_ISSUE_WINDOW_MINUTES = 15;
/**
 * 同一 IP から **同一スタッフ宛** にコードを発行できる回数の上限
 * （窓は DEFAULT_ISSUE_WINDOW_MINUTES と共有）。
 *
 * IP だけで括ってはいけない。出口 IP を共有している職場やモバイル回線では、
 * 別々の人が自分宛のコードを取っているだけで枠を食い合い、6 人目が
 * 「コードを送る」を押しても無言で何も起きなくなる。
 * 防ぎたいのは「第三者が特定アカウントの発行枠を消費する」ことなので、
 * (IP, スタッフ) の組で数えるのが正しい粒度。
 */
export const DEFAULT_ISSUE_MAX_PER_IP = 5;

/**
 * 同一プレフィクスからのコード発行回数の**外枠**上限（メールアドレスに依らない）。
 *
 * 内側の (プレフィクス, メールハッシュ) 上限だけだと、鍵がメール由来なので
 * 攻撃者がアドレスを変えるだけで auth_throttle の行を無限に作れる
 * （1 アドレスにつき内側上限までは素通しなので手前で止まらない）。行数を縛るのがこの層の役目。
 *
 * メールアドレスと無関係に効くので、登録の有無で挙動が変わらない＝列挙に使えない。
 *
 * 100 の根拠: 正規の最悪ケースは「9 名が同じプレフィクスから各自 5 回まで再送」= 45 回。
 * その 2 倍の余裕を取る。IPv6 は /64 に丸めるのでオフィス全体が 1 枠を共有する点に注意
 * （絞りすぎると共有回線の締め出しが別の形で戻るため、env で緩められるようにしてある）。
 */
export const DEFAULT_ISSUE_MAX_PER_IP_TOTAL = 100;

/**
 * 同一 IP からのコード検証**失敗**回数の上限と窓（分）。総当たりの実質的な上限はここ。
 *
 * 成功は数えない（peekThrottle で門番だけして、失敗したときに hitThrottle で加算する）。
 * 成功も数えると、社内 NAT やモバイルの CGNAT で出口 IP を共有している人たちが
 * 「正しくログインしただけ」で互いを締め出す。Phase 4 の一斉オンボーディングで
 * 全員を同じ場所に集めた瞬間に発火する類の事故になる。
 *
 * 20 / 15分は、10^6 通り・TTL 10分のコードに対して無視できる試行数でありながら、
 * 共有 IP で数人が打ち間違えても届かない水準。
 *
 * ⚠️ **この上限だけでは「第三者による一時的なログイン封じ」を防げない。**
 * 不一致時の加算は「その時点で生きているチャレンジ **全件** に +1」なので
 * （verifyAndConsumeLoginCode の末尾）、1 本ずつ焼かれるのではない:
 *
 *   - **5 回の失敗バーストで、生きているコードが本数に関係なく全部ロックされる。**
 *     1 本でも 5 本でも攻撃者のコストは 5 回（実測: 発行 5 本に対し 5 回の失敗で 5 本ロック、
 *     攻撃者の消費は 20 のうち 5）。
 *   - よって窓あたりの予算 20 は「4 本焼ける」ではなく「**4 回バーストできる**」。
 *   - 本人が 1 本ずつ発行し直す動きなら、5 本の発行枠 > 4 バーストで最後の 1 本が残る。
 *     しかし「メールが遅い」と思って**再送を続けて押す**と、発行枠 5 を先に使い切った状態で
 *     全部が同時に生きるため、**1 バースト（5 回）で窓を潰される**。
 *
 * 実害の上限は「窓（既定 15 分）のあいだ本人がメールコードで入れない」。
 * 恒久的な締め出しではなく、Slack には上限到達が鳴り、管理者による救済コード発行の経路も
 * 生きている。緩和するなら「再送は生きているコードを再利用して発行枠を消費しない」方向だが、
 * それはメール送信回数の上限を別に持つ必要がある。ここは設計上の綱引きとして現状を選んでいる。
 *
 * この値を上げても下げてもこの性質は変わらない（バーストのコストは DEFAULT_MAX_ATTEMPTS で決まる）。
 * 上げると総当たりの試行回数が増え、下げると共有回線での誤ロックが増える、という別の綱引きになる。
 */
export const DEFAULT_VERIFY_FAIL_MAX_PER_IP = 20;
export const DEFAULT_VERIFY_FAIL_WINDOW_MINUTES = 15;

/**
 * パスワード（＝APIキー）ログインの失敗上限。**メールコードとは別の枠**にする。
 *
 * 守っている秘密の強度が桁違いに違うため、枠を共有してはいけない:
 *   - メールコードは 10^6 通り。総当たりが現実的なので厳しい上限が要る
 *   - パスワードは `lh_` + 32hex（128bit）か env API_KEY（実測 51 文字・英数記号混在）。
 *     オンラインでの総当たりは非現実的
 * 共有すると、弱い方（コード）を守るための上限が強い方（パスワード）の入口を塞ぐ。
 * 実際それが起きていた: 他人のコード入力ミスで枠が埋まると、
 * 正しいオーナーキーを持つ人が**資格情報を見てもらう前に 429 で門前払い**されていた。
 *
 * 枠は (プレフィクス, 宛先メール) の組で数える。他人の失敗で締め出されないため。
 * 加えてプレフィクスのみの外枠を置く。メールアドレスを変えれば枠が増える、を塞ぐ
 * （env API_KEY は ADMIN_OWNER_EMAIL 未設定なら任意のアドレスで通るので、
 *   外枠が無いとアドレスを変え続けて無制限に試せてしまう）。
 */
export const DEFAULT_PW_FAIL_MAX_PER_EMAIL = 10;
export const DEFAULT_PW_FAIL_MAX_PER_IP_TOTAL = 50;
export const DEFAULT_PW_FAIL_WINDOW_MINUTES = 15;

/**
 * verify が一度に照合する「生きているチャレンジ」の既定上限。
 *
 * 発行上限から導出する。別々の定数にすると、発行上限を上げたときに
 * 古い方のコードが照合対象から静かに落ちる。
 * env で ADMIN_LOGIN_ISSUE_MAX を上書きした場合は、呼び出し側が
 * verifyAndConsumeLoginCode の candidateLimit で同じ値を渡すこと
 * （定数のままだと上書き分に追随しない）。
 */
const CANDIDATE_LIMIT = DEFAULT_ISSUE_MAX;

/** セッショントークンのプレフィクス。既存 API キー（`lh_` + 32hex）と衝突しない。 */
export const SESSION_TOKEN_PREFIX = 'lhs_';

// ---------------------------------------------------------------------------
// 低レベルユーティリティ
// ---------------------------------------------------------------------------

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(digest));
}

/**
 * 長さが同じ hex 同士の定数時間比較。
 * 早期 return による文字単位のタイミング差でハッシュを 1 文字ずつ絞られないようにする。
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 6 桁の数字コード（先頭 0 も許す）。crypto.getRandomValues を剰余バイアス無しで使う。 */
export function generateLoginCode(): string {
  const buf = new Uint32Array(1);
  // 4294967296 % 1000000 != 0 のため、剰余バイアスの出る上端を捨ててから mod を取る。
  const limit = Math.floor(0xffffffff / 1_000_000) * 1_000_000;
  let value: number;
  do {
    crypto.getRandomValues(buf);
    value = buf[0]!;
  } while (value >= limit);
  return String(value % 1_000_000).padStart(6, '0');
}

/** コードのハッシュ。id をソルト代わりに混ぜ、10^6 通りの総当たり表で全行を逆引きされないようにする。 */
function hashLoginCode(challengeId: string, code: string): Promise<string> {
  return sha256Hex(`${code}:${challengeId}`);
}

function addMinutes(from: Date, minutes: number): string {
  return jstIso(new Date(from.getTime() + minutes * 60_000));
}

function addHours(from: Date, hours: number): string {
  return jstIso(new Date(from.getTime() + hours * 3_600_000));
}

/** jstNow() と同じ書式（YYYY-MM-DDTHH:mm:ss.sss+09:00）。文字列比較で時系列比較が成立する。 */
function jstIso(date: Date): string {
  const jst = new Date(date.getTime() + 9 * 60 * 60_000);
  return jst.toISOString().slice(0, -1) + '+09:00';
}

// ---------------------------------------------------------------------------
// メールアドレスの正規化 / 検証
// ---------------------------------------------------------------------------

/** 単純だが実務上十分な形式検証。国際化ドメインや引用符付きローカル部は許容しない。 */
export function isValidEmail(email: string): boolean {
  return /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]{2,}$/.test(email);
}

/**
 * 照合用の正規化。前後空白を落とし小文字化するだけで、ドット除去や +タグ除去はしない
 * （Gmail 以外では別アドレスになり得るため。ここで潰すと別人のアカウントに当ててしまう）。
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// 試行元（IP）単位のスロットル — migration 920
// ---------------------------------------------------------------------------

export interface ThrottleResult {
  /** 上限内なら true。**この試行を含めた**カウントで判定する。 */
  allowed: boolean;
  count: number;
}

/**
 * bucket のカウンタを 1 進め、窓の中で上限を超えていないかを返す。
 *
 * 窓の切り替えと加算を **単一 UPSERT + RETURNING** で行う（read-then-write しない）。
 * 同時リクエストが来ても数え漏らさないため、ここは 1 文であることが要件。
 *
 * アカウント単位ではなく試行元単位で数えるのが要点。start/verify は認証不要なので、
 * アカウント単位のカウンタは「メールアドレスを知っているだけの第三者」に消費でき、
 * 本人のログインを封じる手段になってしまう（migration 920 のコメント参照）。
 */
export async function hitThrottle(
  db: D1Database,
  bucket: string,
  max: number,
  windowMinutes: number,
): Promise<ThrottleResult> {
  const now = new Date();
  const nowIso = jstIso(now);
  const windowStart = addMinutes(now, -windowMinutes);

  const row = await db
    .prepare(
      `INSERT INTO auth_throttle (bucket, count, window_started_at, updated_at)
            VALUES (?, 1, ?, ?)
       ON CONFLICT(bucket) DO UPDATE SET
            count = CASE WHEN auth_throttle.window_started_at <= ? THEN 1
                         ELSE auth_throttle.count + 1 END,
            window_started_at = CASE WHEN auth_throttle.window_started_at <= ? THEN ?
                                     ELSE auth_throttle.window_started_at END,
            updated_at = ?
       RETURNING count`,
    )
    .bind(bucket, nowIso, nowIso, windowStart, windowStart, nowIso, nowIso)
    .first<{ count: number }>();

  const count = row?.count ?? 1;
  return { allowed: count <= max, count };
}

/**
 * スロットル bucket 名。scope を渡すと (IP, scope) の組で数える。
 * 発行上限は scope=staffId で括る（IP だけだと共有回線の別人同士が枠を食い合う）。
 */
/**
 * IPv6 を /64 に丸める。IPv4 はそのまま返す。
 *
 * **これが無いと IP 単位の制御が全部無意味になる。**
 * cf-connecting-ip は実際に IPv6 で届き（実測: `240a:61:30d0:...:2d93`）、
 * IPv6 は家庭回線でも VPS でも **1 契約に /64 が割り当たるのが標準**。
 * アドレス 1 個ずつを鍵にすると、攻撃者は 2^64 個の送信元を自由に使えるので、
 * 失敗上限も発行上限も素通りし、上限到達の Slack 通報は永久に鳴らない。
 *
 * /64 を選ぶ理由: モバイルは端末ごとに /64 が割り当たるので同僚同士が潰し合わない。
 * オフィスの IPv6 は 1 つの /64 を共有するが、それは IPv4 の NAT 共有と同じ状況で、
 * (プレフィクス, メールハッシュ) の鍵が既に同僚同士の潰し合いを防いでいる。
 *
 * ⚠️ /48 以上を持つ相手はプレフィクスを変えて回避できる。これは多層防御の 1 枚であって、
 *    単独で総当たりを止めるものではない（実際の推測回数はチャレンジ単位の attempts で縛る）。
 */
export function normalizeThrottleHost(ip: string | null | undefined): string {
  const raw = String(ip ?? '').trim();
  if (!raw) return 'unknown';

  // ゾーンインデックス（fe80::1%eth0）は落とす
  const head = raw.split('%')[0]!;
  if (!head.includes(':')) return head; // IPv4

  // IPv4 射影/互換アドレス（::ffff:192.0.2.1）は IPv4 として扱う。
  // /64 に丸めると全部 0:0:0:0 になり、無関係な相手が 1 つの枠を共有してしまう。
  const mapped = /^(?:::ffff:|::)((?:\d{1,3}\.){3}\d{1,3})$/i.exec(head);
  if (mapped) return mapped[1]!;

  const groups = expandIpv6(head);
  if (!groups) return head; // 解釈できない形はそのまま（丸めないほうが安全側）
  return `${groups.slice(0, 4).join(':')}::/64`;
}

/** IPv6 を 8 グループへ展開する。解釈できなければ null。 */
function expandIpv6(input: string): string[] | null {
  let s = input.toLowerCase();

  // 末尾に IPv4 記法を持つ形（2001:db8::192.0.2.1）は 2 グループの 16 進へ直す
  const tail = /((?:\d{1,3}\.){3}\d{1,3})$/.exec(s);
  if (tail) {
    const octets = tail[1]!.split('.').map((n) => Number(n));
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hex = `${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
    s = s.slice(0, s.length - tail[1]!.length) + hex;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;

  const toGroups = (part: string) => (part ? part.split(':').filter((x) => x !== '') : []);
  const left = toGroups(halves[0] ?? '');
  const right = halves.length === 2 ? toGroups(halves[1] ?? '') : [];

  let groups: string[];
  if (halves.length === 1) {
    if (left.length !== 8) return null;
    groups = left;
  } else {
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    groups = [...left, ...Array(fill).fill('0'), ...right];
  }

  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  // 先頭 0 を落として正規化（2001:0db8 と 2001:db8 が別の鍵にならないように）
  return groups.map((g) => g.replace(/^0+(?=.)/, ''));
}

export type ThrottleKind = 'login_issue' | 'login_fail' | 'login_pw';

export function throttleBucket(
  kind: ThrottleKind,
  ip: string | null | undefined,
  scope?: string | null,
): string {
  // 区切りに `|` を使う。`:` にしてはいけない — IPv6 アドレスは `:` を含むため
  // `login_fail:ip:<ipv6>:<scope>` 形式だと scope が 16 進として読める語のとき
  // 「末尾がその語の IPv6 アドレス」と衝突しうる。`alert` は 16 進ではないので
  // 今は無事だが、将来 `beef` `face` のような scope を足した瞬間に静かに壊れる。
  // `|` は IP にもスタッフ ID(UUID) にも現れないので、この推論自体が不要になる。
  const host = normalizeThrottleHost(ip);
  return scope ? `${kind}|${host}|${scope}` : `${kind}|${host}`;
}

/**
 * 窓の中の現在値を **加算せずに** 読む。
 *
 * 「門番は成功・失敗どちらでも通すが、加算するのは失敗のときだけ」を実現するために要る。
 * hitThrottle だけで門番も兼ねると、成功したログインまで枠を消費して
 * 共有 IP の利用者同士が締め出し合う。
 *
 * read-then-write になるので、同時実行時は上限を並列数ぶん超えうる。
 * ここは厳密なクォータではなく総当たりの抑止なので、その緩さは許容する
 * （チャレンジ単位の attempts が別途 5 回で効いている）。
 *
 * ⚠️ 窓の判定式 `window_started_at > windowStart` は、hitThrottle の CASE 式
 *    `window_started_at <= windowStart`（＝古いのでリセット）と **厳密な補集合**であること。
 *    境界（完全一致）では peek が 0 を返し hit が 1 にリセットして辻褄が合う。
 *    片方だけ書き換えると、窓の境目で「門番は通すのに加算はリセットされる」等のズレが出る。
 *    どちらかを触るときは必ず両方を見ること。
 */
export async function peekThrottle(
  db: D1Database,
  bucket: string,
  windowMinutes: number,
): Promise<number> {
  const windowStart = addMinutes(new Date(), -windowMinutes);
  const row = await db
    .prepare('SELECT count FROM auth_throttle WHERE bucket = ? AND window_started_at > ?')
    .bind(bucket, windowStart)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

// ---------------------------------------------------------------------------
// ログインチャレンジ
// ---------------------------------------------------------------------------

export interface StaffLoginChallengeRow {
  id: string;
  staff_id: string;
  email: string;
  code_hash: string;
  purpose: string;
  issued_by_id: string | null;
  issued_by_name: string | null;
  attempts: number;
  max_attempts: number;
  expires_at: string;
  used_at: string | null;
  request_ip: string | null;
  created_at: string;
}

export interface CreateLoginChallengeInput {
  staffId: string;
  email: string;
  /** 'login' = 本人がメールで受け取る / 'admin_issued' = 管理者による救済発行 */
  purpose?: 'login' | 'admin_issued';
  issuedById?: string | null;
  issuedByName?: string | null;
  ttlMinutes?: number;
  maxAttempts?: number;
  requestIp?: string | null;
}

export interface CreatedLoginChallenge {
  id: string;
  /** 平文コード。呼び出し側でメール送信 or 管理者への表示に使い、保存はしない。 */
  code: string;
  expiresAt: string;
}

/** 6 桁コードを 1 件発行する。平文コードは戻り値にだけ現れる。 */
export async function createLoginChallenge(
  db: D1Database,
  input: CreateLoginChallengeInput,
): Promise<CreatedLoginChallenge> {
  const id = crypto.randomUUID();
  const code = generateLoginCode();
  const codeHash = await hashLoginCode(id, code);
  const now = new Date();
  const expiresAt = addMinutes(now, input.ttlMinutes ?? DEFAULT_CODE_TTL_MINUTES);

  await db
    .prepare(
      `INSERT INTO staff_login_challenges
         (id, staff_id, email, code_hash, purpose, issued_by_id, issued_by_name,
          attempts, max_attempts, expires_at, used_at, request_ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?)`,
    )
    .bind(
      id,
      input.staffId,
      input.email,
      codeHash,
      input.purpose ?? 'login',
      input.issuedById ?? null,
      input.issuedByName ?? null,
      input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      expiresAt,
      input.requestIp ?? null,
      jstNow(),
    )
    .run();

  return { id, code, expiresAt };
}

/** 直近 windowMinutes 以内に発行されたチャレンジ数。発行の量産を止めるために使う。 */
export async function countRecentChallenges(
  db: D1Database,
  staffId: string,
  windowMinutes = DEFAULT_ISSUE_WINDOW_MINUTES,
): Promise<number> {
  const since = addMinutes(new Date(), -windowMinutes);
  const row = await db
    .prepare(
      'SELECT COUNT(*) AS n FROM staff_login_challenges WHERE staff_id = ? AND created_at >= ?',
    )
    .bind(staffId, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export type VerifyCodeResult =
  | { ok: true; challenge: StaffLoginChallengeRow; session: CreatedSession | null }
  | { ok: false; reason: 'no_challenge' | 'locked' | 'invalid' };

/**
 * コードを検証して消費する（単回）。session を渡すと、消費とセッション発行を
 * **同一 batch（＝1 トランザクション）**で行う。
 *
 * 生きているチャレンジを新しい順に CANDIDATE_LIMIT 件見て、ハッシュ一致した 1 件を
 *   UPDATE ... WHERE id = ? AND used_at IS NULL AND expires_at > ? AND attempts < max_attempts
 * の単一文で消費する。meta.changes === 1 のときだけ成功とみなすので、
 * 同じコードで同時に 2 本走っても 1 本しか通らない。
 *
 * ⚠️ 消費とセッション発行を分けて実行してはいけない。分けると、セッション発行が失敗した
 *    ときに「コードは消費済みなのにログインできず、入れ直しても no_challenge」という
 *    抜け出せない状態になる。INSERT 側にも同じ条件を WHERE EXISTS で持たせてあるので、
 *    どちらか一方だけが成立することはない。
 *
 * 不一致のときは **この時点で生きていたチャレンジ**（candidates）の attempts を 1 つ進める。
 * 加算対象を staff_id 全件にすると、リクエスト中に発行された本人の新しいコードまで
 * 巻き添えで焼けるため、読み出した候補の id に限定する。
 * 「発行し直せば試行枠がリセットされる」抜け道は、アカウント単位の attempts ではなく
 * 試行元 IP 単位のスロットル（hitThrottle / migration 920）で塞ぐ。
 */
export async function verifyAndConsumeLoginCode(
  db: D1Database,
  staffId: string,
  code: string,
  session?: CreateSessionInput,
  candidateLimit: number = CANDIDATE_LIMIT,
): Promise<VerifyCodeResult> {
  const now = jstNow();

  const candidates = await db
    .prepare(
      `SELECT * FROM staff_login_challenges
        WHERE staff_id = ? AND used_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .bind(staffId, now, Math.max(candidateLimit, 1))
    .all<StaffLoginChallengeRow>();

  const rows = candidates.results ?? [];
  if (rows.length === 0) return { ok: false, reason: 'no_challenge' };

  const live = rows.filter((r) => r.attempts < r.max_attempts);
  if (live.length === 0) return { ok: false, reason: 'locked' };

  for (const row of live) {
    const expected = await hashLoginCode(row.id, code);
    if (!timingSafeEqualHex(expected, row.code_hash)) continue;

    const consumeSql = `UPDATE staff_login_challenges
            SET used_at = ?, attempts = attempts + 1
          WHERE id = ? AND used_at IS NULL AND expires_at > ? AND attempts < max_attempts`;

    if (!session) {
      const consumed = await db.prepare(consumeSql).bind(now, row.id, now).run();
      if (consumed.meta.changes === 1) {
        return {
          ok: true,
          challenge: { ...row, used_at: now, attempts: row.attempts + 1 },
          session: null,
        };
      }
      // changes === 0 = 同時に別リクエストが消費した / 直前に期限切れ。使い回しは許さない。
      return { ok: false, reason: 'invalid' };
    }

    const pending = await buildSessionInsert(db, session, row.id, now);
    const [inserted, consumed] = await db.batch([pending.statement, db.prepare(consumeSql).bind(now, row.id, now)]);

    if (consumed.meta.changes === 1 && inserted.meta.changes === 1) {
      return {
        ok: true,
        challenge: { ...row, used_at: now, attempts: row.attempts + 1 },
        session: pending.session,
      };
    }
    return { ok: false, reason: 'invalid' };
  }

  const ids = live.map((r) => r.id);
  await db
    .prepare(
      `UPDATE staff_login_challenges
          SET attempts = attempts + 1
        WHERE id IN (${ids.map(() => '?').join(', ')})
          AND used_at IS NULL AND expires_at > ? AND attempts < max_attempts`,
    )
    .bind(...ids, now)
    .run();

  return { ok: false, reason: 'invalid' };
}

/** 生きているチャレンジを全部無効化する（ログイン成功時・メール変更時など）。 */
export async function invalidateLoginChallenges(db: D1Database, staffId: string): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      'UPDATE staff_login_challenges SET used_at = ? WHERE staff_id = ? AND used_at IS NULL',
    )
    .bind(now, staffId)
    .run();
}

// ---------------------------------------------------------------------------
// セッション
// ---------------------------------------------------------------------------

export interface StaffSessionRow {
  id: string;
  staff_id: string;
  secret_hash: string;
  issued_via: string;
  user_agent: string | null;
  ip: string | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
}

export interface CreateSessionInput {
  staffId: string;
  issuedVia?: 'email_code' | 'admin_issued';
  userAgent?: string | null;
  ip?: string | null;
  ttlHours?: number;
}

export interface CreatedSession {
  id: string;
  /** `lhs_<id>.<secret>`。平文はこの戻り値にだけ現れる。 */
  token: string;
  expiresAt: string;
}

interface PendingSession {
  session: CreatedSession;
  statement: D1PreparedStatement;
}

/**
 * セッションの INSERT 文とトークンを組み立てる（まだ実行しない）。
 *
 * challengeId を渡すと「そのチャレンジがまだ消費可能なときだけ挿入する」条件付き INSERT になる。
 * これを同一 batch 内の消費 UPDATE と並べることで、**片方だけ成立することがなくなる**。
 * 分けて実行すると、消費だけ通ってセッション発行が落ちたときに
 * 「正しいコードを打ったのに 401、入れ直しても no_challenge」という抜け出せない状態になる。
 */
async function buildSessionInsert(
  db: D1Database,
  input: CreateSessionInput,
  challengeId: string | null,
  now: string,
): Promise<PendingSession> {
  const id = randomHex(16);
  const secret = randomHex(32);
  const secretHash = await sha256Hex(secret);
  const createdAt = new Date();
  const expiresAt = addHours(createdAt, input.ttlHours ?? DEFAULT_SESSION_TTL_HOURS);

  const columns =
    '(id, staff_id, secret_hash, issued_via, user_agent, ip, created_at, last_used_at, expires_at, revoked_at, revoked_reason)';
  const values = [
    id,
    input.staffId,
    secretHash,
    input.issuedVia ?? 'email_code',
    input.userAgent ?? null,
    input.ip ?? null,
    jstIso(createdAt),
    expiresAt,
  ];

  const statement = challengeId
    ? db
        .prepare(
          `INSERT INTO staff_sessions ${columns}
           SELECT ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL
            WHERE EXISTS (
                  SELECT 1 FROM staff_login_challenges
                   WHERE id = ? AND used_at IS NULL AND expires_at > ? AND attempts < max_attempts
                 )`,
        )
        .bind(...values, challengeId, now)
    : db
        .prepare(`INSERT INTO staff_sessions ${columns} VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL)`)
        .bind(...values);

  return {
    session: { id, token: `${SESSION_TOKEN_PREFIX}${id}.${secret}`, expiresAt },
    statement,
  };
}

export async function createStaffSession(
  db: D1Database,
  input: CreateSessionInput,
): Promise<CreatedSession> {
  const pending = await buildSessionInsert(db, input, null, jstNow());
  await pending.statement.run();
  return pending.session;
}

/** `lhs_<id>.<secret>` を分解する。形が違えば null。 */
export function parseSessionToken(token: string): { id: string; secret: string } | null {
  if (!token.startsWith(SESSION_TOKEN_PREFIX)) return null;
  const rest = token.slice(SESSION_TOKEN_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot <= 0 || dot === rest.length - 1) return null;
  const id = rest.slice(0, dot);
  const secret = rest.slice(dot + 1);
  if (!/^[0-9a-f]+$/.test(id) || !/^[0-9a-f]+$/.test(secret)) return null;
  return { id, secret };
}

export interface ResolvedSession {
  session: StaffSessionRow;
  staff: StaffMember;
}

/**
 * セッショントークンを解決する。
 *
 * staff_sessions ⨝ staff_members の 1 クエリで、**毎回** is_active と role を引き直す。
 * ここが JWT との決定的な違いで、スタッフ一覧で「無効化」を押した次の操作から締め出せる。
 */
export async function resolveStaffSession(
  db: D1Database,
  token: string,
): Promise<ResolvedSession | null> {
  const parsed = parseSessionToken(token);
  if (!parsed) return null;

  const now = jstNow();
  const row = await db
    .prepare(
      `SELECT
         s.id AS s_id, s.staff_id AS s_staff_id, s.secret_hash AS s_secret_hash,
         s.issued_via AS s_issued_via, s.user_agent AS s_user_agent, s.ip AS s_ip,
         s.created_at AS s_created_at, s.last_used_at AS s_last_used_at,
         s.expires_at AS s_expires_at, s.revoked_at AS s_revoked_at,
         s.revoked_reason AS s_revoked_reason,
         m.id AS m_id, m.name AS m_name, m.email AS m_email, m.role AS m_role,
         m.api_key AS m_api_key, m.is_active AS m_is_active, m.work_area AS m_work_area,
         m.created_at AS m_created_at, m.updated_at AS m_updated_at
       FROM staff_sessions s
       JOIN staff_members m ON m.id = s.staff_id
      WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND m.is_active = 1`,
    )
    .bind(parsed.id, now)
    .first<Record<string, unknown>>();

  if (!row) return null;

  const secretHash = await sha256Hex(parsed.secret);
  if (!timingSafeEqualHex(secretHash, String(row.s_secret_hash))) return null;

  return {
    session: {
      id: String(row.s_id),
      staff_id: String(row.s_staff_id),
      secret_hash: String(row.s_secret_hash),
      issued_via: String(row.s_issued_via),
      user_agent: (row.s_user_agent as string | null) ?? null,
      ip: (row.s_ip as string | null) ?? null,
      created_at: String(row.s_created_at),
      last_used_at: (row.s_last_used_at as string | null) ?? null,
      expires_at: String(row.s_expires_at),
      revoked_at: (row.s_revoked_at as string | null) ?? null,
      revoked_reason: (row.s_revoked_reason as string | null) ?? null,
    },
    staff: {
      id: String(row.m_id),
      name: String(row.m_name),
      email: (row.m_email as string | null) ?? null,
      role: row.m_role as StaffMember['role'],
      api_key: String(row.m_api_key),
      is_active: Number(row.m_is_active),
      work_area: (row.m_work_area as string | null) ?? null,
      created_at: String(row.m_created_at),
      updated_at: String(row.m_updated_at),
    },
  };
}

/** last_used_at の更新。毎リクエスト書くと D1 書込が増えるので、一定間隔を空けたときだけ書く。 */
export async function touchStaffSession(
  db: D1Database,
  sessionId: string,
  lastUsedAt: string | null,
  minIntervalMinutes = 5,
): Promise<void> {
  if (lastUsedAt) {
    const elapsed = Date.now() - new Date(lastUsedAt).getTime();
    if (elapsed < minIntervalMinutes * 60_000) return;
  }
  await db
    .prepare('UPDATE staff_sessions SET last_used_at = ? WHERE id = ?')
    .bind(jstNow(), sessionId)
    .run();
}

export type RevokeReason =
  | 'logout'
  | 'staff_disabled'
  | 'role_changed'
  | 'email_changed'
  | 'staff_deleted'
  | 'admin';

/** セッション 1 本を失効させる。戻り値は実際に失効した件数（0 or 1）。 */
export async function revokeStaffSession(
  db: D1Database,
  sessionId: string,
  reason: RevokeReason,
): Promise<number> {
  const result = await db
    .prepare(
      'UPDATE staff_sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL',
    )
    .bind(jstNow(), reason, sessionId)
    .run();
  return result.meta.changes ?? 0;
}

/**
 * そのスタッフの生きているセッションを全部失効させる。
 * 無効化・ロール変更・メール変更で必ず呼ぶ（呼ばないと旧セッションが権限を持ち続ける）。
 */
export async function revokeAllStaffSessions(
  db: D1Database,
  staffId: string,
  reason: RevokeReason,
): Promise<number> {
  const result = await db
    .prepare(
      'UPDATE staff_sessions SET revoked_at = ?, revoked_reason = ? WHERE staff_id = ? AND revoked_at IS NULL',
    )
    .bind(jstNow(), reason, staffId)
    .run();
  return result.meta.changes ?? 0;
}

export interface StaffSessionSummary {
  id: string;
  issuedVia: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
}

/** セッション一覧（本人の「ログイン中の端末」表示 / 監査用）。secret_hash は返さない。 */
export async function listStaffSessions(
  db: D1Database,
  staffId: string,
  opts: { includeRevoked?: boolean; limit?: number } = {},
): Promise<StaffSessionSummary[]> {
  const where = opts.includeRevoked
    ? 'WHERE staff_id = ?'
    : 'WHERE staff_id = ? AND revoked_at IS NULL AND expires_at > ?';
  const binds: unknown[] = opts.includeRevoked ? [staffId] : [staffId, jstNow()];
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  const res = await db
    .prepare(
      `SELECT id, issued_via, user_agent, ip, created_at, last_used_at, expires_at,
              revoked_at, revoked_reason
         FROM staff_sessions ${where}
        ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(...binds, limit)
    .all<StaffSessionRow>();

  return (res.results ?? []).map((r) => ({
    id: r.id,
    issuedVia: r.issued_via,
    userAgent: r.user_agent,
    ip: r.ip,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    revokedReason: r.revoked_reason,
  }));
}

/**
 * メールアドレスからスタッフを引く（在籍者のみ・大文字小文字を無視）。
 *
 * 同じアドレスで複数行ある場合は「どちらの権限で入れるべきか」を機械的に決められないので
 * null を返して入口を閉じる（弱い方を勝たせても強い方を勝たせても事故になる）。
 * 呼び出し側は理由を伏せた同一のレスポンスを返し、アドレスの存在を漏らさないこと。
 */
export async function findActiveStaffByEmail(
  db: D1Database,
  email: string,
): Promise<StaffMember | null> {
  const normalized = normalizeEmail(email);
  const res = await db
    .prepare(
      'SELECT * FROM staff_members WHERE is_active = 1 AND LOWER(TRIM(email)) = ? LIMIT 2',
    )
    .bind(normalized)
    .all<StaffMember>();
  const rows = res.results ?? [];
  if (rows.length !== 1) return null;
  return rows[0]!;
}

/** 同じメールアドレスを持つ他のスタッフがいるか（作成/更新時の重複チェック用）。 */
export async function emailTakenByOther(
  db: D1Database,
  email: string,
  excludeStaffId?: string | null,
): Promise<boolean> {
  const normalized = normalizeEmail(email);
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM staff_members
        WHERE LOWER(TRIM(email)) = ? AND id != ?`,
    )
    .bind(normalized, excludeStaffId ?? '')
    .first<{ n: number }>();
  return (row?.n ?? 0) > 0;
}

/** スタッフ削除時の後始末。routes/staff.ts の cascade から呼ぶ。 */
export function staffAuthCascadeStatements(db: D1Database, staffId: string): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM staff_sessions WHERE staff_id = ?').bind(staffId),
    db.prepare('DELETE FROM staff_login_challenges WHERE staff_id = ?').bind(staffId),
  ];
}

/** 期限切れ行の掃除（cron から呼ぶ想定。呼ばなくても機能は壊れない）。 */
export async function pruneExpiredStaffAuthRows(db: D1Database, keepDays = 90): Promise<void> {
  const cutoff = addHours(new Date(), -24 * keepDays);
  // auth_throttle は bucket が IP 単位なので放置すると際限なく増える。
  // 窓（分オーダー）を大きく超えた行は残しておく意味が無いので、1 日で切る。
  const throttleCutoff = addHours(new Date(), -24);
  await db.batch([
    db.prepare('DELETE FROM staff_login_challenges WHERE expires_at < ?').bind(cutoff),
    db.prepare('DELETE FROM staff_sessions WHERE expires_at < ?').bind(cutoff),
    db.prepare('DELETE FROM auth_throttle WHERE updated_at < ?').bind(throttleCutoff),
  ]);
}
