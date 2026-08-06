// BOXIV-only: LINE Login (Web OAuth) の共通ヘルパー。
//
// 出品フォーム連携（listing-form-line.ts）で使っていた HMAC 署名 state と
// OAuth code 交換・プロフィール取得を、複数フロー（プレミアム出品 / アプリ出品 /
// 劣化診断 …）で共有できるようここに集約する（MTG 2026-07-16: コールバック URL は
// 1つに集約し、署名 state の `flow` フィールドで分岐する方針）。
//
// state のワイヤ形式は `payloadB64url.sigB64url`（listing-form-line.ts 時代と同一）。
// 旧形式（flow フィールド無し）の in-flight state も検証・パースできる。

import type { Context } from 'hono';
import type { Friend } from '@line-crm/db';
import type { Env } from '../index.js';

// ─── フロー Strategy の契約（フロー横断・特定フローに依存しない） ─────

/** 連携フロー識別子。省略時（旧 state・後方互換）は 'listing_form' 扱い。 */
export type FlowId = 'listing_form' | 'app_listing';

/**
 * 全フロー共通の署名 state。共有 callback が「検証」と「終端 redirect」に使う最小フィールドのみ。
 * フロー固有フィールド（form_id 等）は各フローの state 型がこれを拡張して足す。
 */
export interface LinkStateBase {
  v: 1;
  flow?: FlowId;
  /** web フローの戻り先。アプリフローは固定スキームへ戻すため使わない（省略可）。 */
  return_to?: string;
  ts: number;
}

/**
 * 連携フローの Strategy。共有 callback が担うのは前半（state検証→OAuth交換→profile→follow判定→friend登録）
 * までで、そこから先（連携確定後のデータ書き込み＋イベント発火＋終端の描画/redirect）はフローが所有する。
 * 終端はフロー依存（web は HTML ページ、アプリは自スキームへ redirect）なので Response まで返す。
 * フロー追加時はハンドラを実装して LINK_FLOWS に1エントリ足すだけ（callback 本体は不変）。
 */
export interface LinkFlow<S extends LinkStateBase = LinkStateBase> {
  /**
   * 共通の friend upsert 後に呼ばれ、フロー固有のデータ書き込み＋イベント発火を行い、
   * 最終的にユーザーへ返す Response（HTML ページ or スキーム/return_to への redirect）を返す。
   * データ書き込みは非致命前提（失敗しても終端 Response は返す）。
   * `friend` は共通前半で登録済みの D1 friend（DB 障害等で取得できなければ null）。
   */
  complete(
    c: Context<Env>,
    ctx: S,
    profile: LineProfile,
    followStatus: boolean | null,
    friend: Friend | null,
  ): Promise<Response>;
}

// ─── return_to の許可判定（open-redirect 防御・フロー横断） ───────

// Allowed return_to hosts (open-redirect protection).
// Dev hosts (localhost) are only honored when the Worker itself runs on a dev/test origin.
const RETURN_TO_ALLOWED_HOSTS = [
  'lightning.boxiv.co.jp',
  'line-connect.boxiv.workers.dev',
  'line-connect-test.boxiv.workers.dev',
];
const RETURN_TO_DEV_HOSTS = ['localhost', '127.0.0.1'];

/** Worker 自身が dev/test オリジンで動いているか（テスト専用エンドポイントのゲート等に使う）。 */
export function isDevOrigin(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host.endsWith('-test.boxiv.workers.dev');
}

/**
 * return_to が許可ホストか判定する。start と callback の両方から使う（複数フロー共有）。
 * reqHost = Worker が現在配信しているホスト名（localhost の return_to を dev/test オリジンに限定するため）。
 */
export function isAllowedReturnTo(url: string, reqHost: string): boolean {
  try {
    const u = new URL(url);
    const isDevHost = RETURN_TO_DEV_HOSTS.includes(u.hostname);
    // Scheme must be https (blocks javascript:/data:/protocol-relative); http only for dev hosts.
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isDevHost)) return false;
    if (RETURN_TO_ALLOWED_HOSTS.includes(u.hostname)) return true;
    if (isDevHost) return isDevOrigin(reqHost); // localhost honored only on a dev/test Worker origin
    return false;
  } catch {
    return false;
  }
}

/** HTML 埋め込み用エスケープ。終端ページ（各フロー）と error ページ（共通）で共有。 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── HMAC 署名 state ─────────────────────────────────────────

/** 署名 state の TTL。発行から 30 分で失効。 */
export const LINK_STATE_TTL_MS = 30 * 60 * 1000;

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
  // UTF-8 safe: btoa() only accepts Latin1 and throws on non-Latin1 (e.g. 日本語 の display_name).
  // Encode to bytes first so a Japanese name in the signed state doesn't 500 the start endpoint.
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): string {
  const pad = s + '==='.slice((s.length + 3) % 4);
  const bin = atob(pad.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export async function packSignedState(payloadObj: object, secret: string): Promise<string> {
  const payload = JSON.stringify(payloadObj);
  const payloadB64 = b64urlEncode(payload);
  const sig = await hmacSign(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

export async function unpackSignedState<T = unknown>(token: string, secret: string): Promise<T | null> {
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

// ─── authorize の redirect_uri ────────────────────────────────

/** 共有 callback の正 URL。新規チャネルはこれを console に登録する。 */
export const CANONICAL_LINK_CALLBACK_PATH = '/link/callback';

/**
 * authorize に載せる redirect_uri を組み立てる。
 *
 * ⚠️ この値は LINE Login チャネルの「コールバックURL」に登録済みの文字列と完全一致していないと、
 * LINE が authorize の時点で 400 Bad Request を返し、連携が丸ごと止まる（Worker のログには
 * /listing-form/start の 302 だけが残り callback は永遠に来ないので、原因が非常に見えにくい）。
 *
 * 実障害: 2026-08-03 の本番デプロイで redirect_uri を旧 /listing-form/callback から
 * /link/callback へ切り替えたが、prod の Login チャネル(2010320277)に /link/callback が
 * 未登録だったため、出品フォームの LINE 連携が 2026-08-06 まで全ユーザーで失敗した
 * （test チャネル(2009711299)には登録済みだったので test では再現しなかった）。
 *
 * 既定は正 URL。console 側の登録が追いつかない環境は env `LINE_LOGIN_CALLBACK_PATH` に
 * 登録済みのパス（例: '/listing-form/callback'）を入れて回避する。callback ハンドラは
 * 受けた実パスから redirect_uri を導出するので、どちらで受けても code 交換は成立する。
 */
export function buildLinkCallbackUrl(env: LineLoginEnv, workerBase: string): string {
  const configured = (env.LINE_LOGIN_CALLBACK_PATH ?? '').trim();
  const path = configured || CANONICAL_LINK_CALLBACK_PATH;
  return `${workerBase}${path.startsWith('/') ? path : `/${path}`}`;
}

// ─── OAuth code 交換・プロフィール取得 ─────────────────────────

export interface LineLoginEnv {
  LINE_LOGIN_CHANNEL_ID?: string;
  LINE_LOGIN_CHANNEL_SECRET?: string;
  /** LINE Login チャネルに登録済みのコールバックパス。未設定なら CANONICAL_LINK_CALLBACK_PATH。 */
  LINE_LOGIN_CALLBACK_PATH?: string;
}

export interface LineTokens {
  access_token: string;
  id_token?: string;
}

export interface LineProfile {
  userId: string;
  displayName: string;
  pictureUrl?: string;
}

/**
 * authorization code をトークンに交換する。redirect_uri は authorize 時と同一であること。
 * 失敗時は { ok:false, status } を返す（ログ・エラーページ表示は呼び出し側の責務 —
 * フローごとに文言・相関キーが異なるため）。
 */
export async function exchangeLineCode(
  env: LineLoginEnv,
  code: string,
  redirectUri: string,
): Promise<{ ok: true; tokens: LineTokens } | { ok: false; status: number }> {
  const res = await fetch('https://api.line.me/oauth2/v2.1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: env.LINE_LOGIN_CHANNEL_ID ?? '',
      client_secret: env.LINE_LOGIN_CHANNEL_SECRET ?? '',
    }),
  });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, tokens: (await res.json()) as LineTokens };
}

/**
 * access_token で LINE プロフィールを取得する（scope=profile）。
 * 失敗時は { ok:false, status }（ログ・表示は呼び出し側）。
 */
export async function fetchLineProfile(
  accessToken: string,
): Promise<{ ok: true; profile: LineProfile } | { ok: false; status: number }> {
  const res = await fetch('https://api.line.me/v2/profile', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, profile: (await res.json()) as LineProfile };
}
