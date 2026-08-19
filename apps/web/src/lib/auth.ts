/**
 * 管理画面の認証トークンを扱う唯一の場所（BOXIV）。
 *
 * ここに集約している理由:
 *   - 認証ヘッダを組み立てる場所が散っていると、方式を切り替えたときに取りこぼす。
 *     実際、旧実装は api.ts の fetchApi 以外に生の fetch が 3 箇所あった
 *     （media.upload / richMenus.fetchImage / richMenus.autoSwitch.rebind）。
 *   - 401 の後始末（セッション破棄 → /login）を 1 箇所に集めるため。
 *
 * トークンは Authorization: Bearer で送る。Cookie は使えない:
 * 管理画面は *.pages.dev、API は *.workers.dev で、どちらも Public Suffix のため
 * 別サイト扱いになり Cookie を跨げない。Cookie 化は同一オリジン化とセットで行う。
 */

/** メールログインで発行された D1 実体セッション（`lhs_<id>.<secret>`） */
const SESSION_KEY = 'lh_session'
/** 旧方式の API キー（`lh_` + 32hex）。移行期間中は併存させる。 */
const LEGACY_KEY = 'lh_api_key'
const NAME_KEY = 'lh_staff_name'
const ROLE_KEY = 'lh_staff_role'

function read(key: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    return localStorage.getItem(key)
  } catch {
    // Safari のプライベートモード等で localStorage が使えないことがある
    return null
  }
}

function write(key: string, value: string): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 保存できなくてもその場のセッションは続行させる */
  }
}

function remove(key: string): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(key)
  } catch {
    /* noop */
  }
}

/**
 * API に送るトークン。新セッションを優先し、無ければ旧 API キーへフォールバックする。
 * このフォールバックがあるおかげで、メールログイン導入の時点では誰も締め出されない。
 */
export function getAuthToken(): string {
  return read(SESSION_KEY) || read(LEGACY_KEY) || ''
}

export function isAuthenticated(): boolean {
  return getAuthToken().length > 0
}

/** いまどちらの経路で入っているか（移行の進み具合を画面に出すため）。 */
export function getAuthKind(): 'session' | 'apiKey' | null {
  if (read(SESSION_KEY)) return 'session'
  if (read(LEGACY_KEY)) return 'apiKey'
  return null
}

export function setSession(token: string): void {
  write(SESSION_KEY, token)
  // 同じ端末に旧キーが残っていると、セッション失効後に旧キーで入り直せてしまい
  // 「無効化したのに入れる」状態になる。新方式で入ったら旧キーは捨てる。
  remove(LEGACY_KEY)
}

/** 旧方式のログイン（env API_KEY を含む）。Phase 5 で入口ごと外す。 */
export function setLegacyApiKey(key: string): void {
  write(LEGACY_KEY, key)
  remove(SESSION_KEY)
}

export function setStaffProfile(name: string, role: string): void {
  write(NAME_KEY, name)
  write(ROLE_KEY, role)
}

/**
 * 表示用のロール。**認可の判断には使わない**（localStorage は利用者が書き換えられる）。
 * 実際の権限は毎リクエスト Worker 側が staff_members を引き直して決める。
 */
export function getCachedRole(): string | null {
  return read(ROLE_KEY)
}

export function getCachedName(): string | null {
  return read(NAME_KEY)
}

export function clearAuth(): void {
  remove(SESSION_KEY)
  remove(LEGACY_KEY)
  remove(NAME_KEY)
  remove(ROLE_KEY)
}

/** 認証ヘッダ。生の fetch を書く場所も必ずこれを通す。 */
export function authHeaders(extra?: HeadersInit): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${getAuthToken()}` }
  if (extra) {
    new Headers(extra).forEach((value, key) => {
      headers[key] = value
    })
  }
  return headers
}

/**
 * 401 を受けたときの後始末。トークンを捨ててログイン画面へ送る。
 *
 * セッションは Worker 側で失効させられる（無効化・ロール変更・メール変更・ログアウト）ので、
 * 401 は「異常」ではなく通常の遷移として起きる。ここで捨てないと、死んだトークンで
 * 叩き続けて全画面がエラー表示になる。
 *
 * ⚠️ ログイン画面では **何も捨てずに** 返すこと。破棄を先に書いてはいけない。
 *    /api/auth/email/verify はコード不一致・期限切れ・試行上限をすべて 401 で返すので、
 *    破棄が先だと「移行期の人が /login で 6 桁を 1 回打ち間違えるだけで
 *    旧 API キーまで消える」。画面に出るのは「コードが正しくありません」だけで、
 *    鍵が消えた事実はどこにも出ず、キーは一覧で伏せ字なので自力復旧できない。
 *    2026-08-15 の「403 が『APIキーが正しくありません』に化けた」のと同じ型。
 */
export function handleUnauthorized(): void {
  if (typeof window === 'undefined') return
  if (window.location.pathname.startsWith('/login')) return
  clearAuth()
  const next = window.location.pathname + window.location.search
  window.location.href = `/login?next=${encodeURIComponent(next)}`
}

/**
 * `?next=` の検証。同一オリジンに解決できるものだけを通し、パス部分だけを返す。
 *
 * `startsWith('/') && !startsWith('//')` の文字列判定では防げない:
 *   new URL('/\evil.com', location.origin).href === 'https://evil.com/'
 * バックスラッシュがスラッシュとして解釈されるため、正規ドメインで本物のログインを
 * 終えた直後に偽の「セッションが切れました」へ着地させられる。
 *
 * next はセッション切れからの復帰先として実際に使っている（auth-guard.tsx / handleUnauthorized）
 * ので、機能ごと消すのではなく URL として解決して検証する。
 */
export function safeNextPath(
  next: string | null | undefined,
  origin?: string,
): string | null {
  const base = origin ?? (typeof window !== 'undefined' ? window.location.origin : null)
  if (!next || !base) return null
  try {
    const url = new URL(next, base)
    if (url.origin !== base) return null
    const path = url.pathname + url.search + url.hash
    // ⚠️ origin 検査だけでは足りない。攻撃者が **自オリジンを前置** すると
    //    （`https://<自オリジン>//evil.com`）origin は一致するのに pathname が
    //    `//evil.com` になり、router.push に渡すとプロトコル相対 URL として
    //    外部サイトへハードナビゲーションする。`/\/evil.com` でも `///evil.com` になる。
    //    権限部として読み直されうる形をここで弾く。
    if (!path.startsWith('/') || path.startsWith('//')) return null
    return path
  } catch {
    return null
  }
}
