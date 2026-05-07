/**
 * 予約ページ用 セッショントークン
 *
 * Web Crypto API (HMAC-SHA256) でJSONペイロードを署名・検証する簡易JWTライク実装。
 * 外部ライブラリ不要。Cookieに格納してSSRページ間で認証情報を引き継ぐ。
 */

export interface BookingSession {
  friendId: string;
  lineUserId: string;
  displayName: string;
  exp: number; // unix秒
}

const COOKIE_NAME = '__booking_session';
const TTL_SECONDS = 24 * 60 * 60; // 24時間

function base64urlEncode(bytes: Uint8Array): string {
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function getKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function createSessionToken(
  payload: Omit<BookingSession, 'exp'>,
  secret: string,
): Promise<string> {
  const full: BookingSession = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + TTL_SECONDS,
  };
  const body = base64urlEncode(new TextEncoder().encode(JSON.stringify(full)));
  const key = await getKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const sigB64 = base64urlEncode(new Uint8Array(sig));
  return `${body}.${sigB64}`;
}

export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<BookingSession | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [body, sig] = parts;
    const key = await getKey(secret);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64urlDecode(sig),
      new TextEncoder().encode(body),
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(body))) as BookingSession;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function buildSessionCookie(token: string): string {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${TTL_SECONDS}`;
}

export function readSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(';').map((c) => c.trim());
  for (const c of cookies) {
    if (c.startsWith(`${COOKIE_NAME}=`)) {
      return c.slice(COOKIE_NAME.length + 1);
    }
  }
  return null;
}
