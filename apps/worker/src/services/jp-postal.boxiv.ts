// BOXIV-only: 住所 → 郵便番号 の補完（旧 reconcile-daemon の Claude CLI を API に置換）。
//
// Workers から CLI は不可なので Geocoding API を fetch で叩く。既定は Google Geocoding
// （address_components の postal_code を拾う）。GOOGLE_GEOCODING_API_KEY 未設定なら no-op。
// ベストエフォート（throw しない）。連携/起票フローをブロックしない非致命処理。
//
// 必要 secret（任意）:
//   GOOGLE_GEOCODING_API_KEY   Google Maps Geocoding API キー

export interface PostalEnv {
  GOOGLE_GEOCODING_API_KEY?: string;
}

/**
 * 住所文字列から日本の郵便番号（NNN-NNNN）を推定する。
 * 取得できなければ null（呼び出し側は欠落のまま続行）。
 */
export async function lookupPostalCode(env: PostalEnv, address: string): Promise<string | null> {
  const addr = (address || '').trim();
  if (!addr) return null;
  if (!env.GOOGLE_GEOCODING_API_KEY) return null;

  try {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', addr);
    url.searchParams.set('region', 'jp');
    url.searchParams.set('language', 'ja');
    url.searchParams.set('key', env.GOOGLE_GEOCODING_API_KEY);

    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = (await res.json()) as {
      status?: string;
      results?: Array<{ address_components?: Array<{ types?: string[]; long_name?: string }> }>;
    };
    if (data.status !== 'OK' || !data.results?.length) return null;

    for (const r of data.results) {
      for (const c of r.address_components ?? []) {
        if (c.types?.includes('postal_code') && c.long_name) {
          const digits = c.long_name.replace(/[^\d]/g, '');
          if (digits.length === 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
          return c.long_name;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}
