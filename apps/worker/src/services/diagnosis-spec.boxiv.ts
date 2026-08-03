// BOXIV-only: バッテリー劣化診断の spec_API(getVehicleSpecs) 呼び出しを 1 箇所に集約する。
//
// なぜ分離したか:
//   フォーム送信時(routes/diagnosis-form.boxiv.ts)と後追いバックフィル
//   (services/diagnosis-spec-backfill.boxiv.ts)が同じ取得ロジックを共有するため。
//   v1 は「1 回叩いて失敗したら諦める」実装だったので、上流(Cloud Functions)の
//   コールドスタート起因の一過性障害でリードの spec が恒久的に欠落した。
//   実例: lead 537809e3-…（2026-08-01, VIN LRW…）は status='API取得不可' のまま NULL が残り、
//   同じ VIN を後から叩くと 200 OK で返る＝一過性だったが誰も再取得しなかった。
//   実測レイテンシは 1.2〜8.3 秒（コールドスタート時が最遅）とばらつく。
//
// 設計:
//   - タイムアウト(AbortSignal)を必ず付ける。上流が固まってもフォーム送信を巻き込まない。
//   - 一過性(タイムアウト/5xx/429/ネットワーク)だけ再試行し、認証・不正VIN等は即諦める。
//   - budgetMs で「合計何秒まで粘るか」を呼び出し側が決める(送信時は短く、cron は長く)。
//   - 200 でも中身が空/別形式なら失敗として扱う(レスポンス形式変更を silent success にしない)。

const SPEC_API_DEFAULT_URL =
  'https://asia-northeast1-boxiv-share.cloudfunctions.net/getVehicleSpecs';

// テスラの WMI（VIN 先頭3桁）: 米国/セミ・上海・ベルリン・その他
export const TESLA_WMI = ['5YJ', '7SA', 'LRW', 'XP7', 'SFZ', '7G2'];

export function isTeslaVin(vin: string): boolean {
  return TESLA_WMI.includes(vin.slice(0, 3));
}

// キー/URL は listing パイプライン（fetch-spec-api.mjs / .env.example）と同じ VEHICLE_SPECS_* を正とし、
// 旧 SPEC_* も後方互換で許容する。
export type SpecEnv = {
  VEHICLE_SPECS_API_KEY?: string;
  VEHICLE_SPECS_API_URL?: string;
  SPEC_API_KEY?: string;
  SPEC_API_URL?: string;
};

export function specApiKey(env: SpecEnv): string {
  return env.VEHICLE_SPECS_API_KEY || env.SPEC_API_KEY || '';
}

function specApiUrl(env: SpecEnv): string {
  return env.VEHICLE_SPECS_API_URL || env.SPEC_API_URL || SPEC_API_DEFAULT_URL;
}

export type SpecFetchOptions = {
  attempts?: number; // 最大試行回数（初回込み）
  timeoutMs?: number; // 1 試行あたりの上限
  budgetMs?: number; // 全試行の合計上限（次の試行が収まらないなら打ち切る）
};

export type SpecFetchResult =
  | { ok: true; specJson: string; spec: Record<string, unknown>; attempts: number }
  | { ok: false; error: string; attempts: number };

const RETRY_BACKOFF_MS = 700;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// spec の数値フィールドは "95.3%" / "60.0kWh" / "520 km" のように単位付き文字列のことがある。
// 先頭に現れる数値だけを取り出す（既に number の modelYear/totalPrice はそのまま通る）。
export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = v.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// trim が "" / typeOfDrive が null で返ることがあるので、空文字は NULL に寄せる。
function text(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s === '' ? null : s;
}

type AttemptResult =
  | { ok: true; specJson: string; spec: Record<string, unknown> }
  | { ok: false; error: string; retryable: boolean };

async function attemptFetch(url: string, key: string, timeoutMs: number): Promise<AttemptResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'x-api-key': key },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const name = (e as Error)?.name ?? '';
    const retryable = true; // ネットワーク断・タイムアウトはいずれも一過性とみなす
    const error =
      name === 'TimeoutError' || name === 'AbortError'
        ? `timeout ${timeoutMs}ms`
        : `network: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
    return { ok: false, error, retryable };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // 401/403=キー不正, 400/404=VIN 不正 → 再試行しても同じ。408/429/5xx は一過性。
    const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
    const detail = body ? ` ${body.replace(/\s+/g, ' ').trim().slice(0, 200)}` : '';
    return { ok: false, error: `HTTP ${res.status}${detail}`, retryable };
  }

  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch (e) {
    // レスポンス途中切断でも起きうるので再試行対象にする。
    return {
      ok: false,
      error: `JSON parse: ${String((e as Error)?.message ?? e).slice(0, 150)}`,
      retryable: true,
    };
  }

  // レスポンスは { specsResponse: { response: { ...fields... } } }。生 JSON は specsResponse ごと保存し
  // （listing の spec_api.json と同形式）、フィールド抽出は response 階層から行う。
  const sr = (data?.specsResponse ?? data) as Record<string, unknown> | undefined;
  const resp = (sr?.response ?? sr) as Record<string, unknown> | undefined;
  // 200 でも中身が空 / 別形式なら「取得できた」とは扱わない。
  // 上流は未知の VIN に対して 200 + {"specsResponse":{"response":{}}} を返すため、これを
  // 成功として通すと spec が全部 NULL の行が status='診断依頼' になり、欠測に気づけない。
  //
  // 即時リトライはしない（同じ空レスポンスを数秒間隔で叩き直しても答えは変わらない）。
  // 一時的な欠測の可能性は cron のバックフィルが時間を空けて拾い直す。
  if (
    !resp ||
    typeof resp !== 'object' ||
    (resp.vin == null && resp.batterySoH == null && resp.model == null)
  ) {
    const keys = resp && typeof resp === 'object' ? Object.keys(resp).slice(0, 8).join(',') : '';
    return { ok: false, error: `unexpected shape: ${keys || '(empty)'}`, retryable: false };
  }

  return { ok: true, specJson: JSON.stringify(sr).slice(0, 30000), spec: resp };
}

export async function fetchVehicleSpec(
  env: SpecEnv,
  vin: string,
  opts: SpecFetchOptions = {}
): Promise<SpecFetchResult> {
  const key = specApiKey(env);
  if (!key) return { ok: false, error: 'spec_API キー未設定', attempts: 0 };

  const maxAttempts = Math.max(1, opts.attempts ?? 2);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const budgetMs = opts.budgetMs ?? 20_000;
  const url = `${specApiUrl(env)}?vin=${encodeURIComponent(vin)}`;
  const startedAt = Date.now();

  let last = 'unknown';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const outcome = await attemptFetch(url, key, timeoutMs);
    if (outcome.ok) {
      return { ok: true, specJson: outcome.specJson, spec: outcome.spec, attempts: attempt };
    }
    last = `attempt${attempt}/${maxAttempts}: ${outcome.error}`;
    if (!outcome.retryable) return { ok: false, error: last, attempts: attempt };
    if (attempt >= maxAttempts) return { ok: false, error: last, attempts: attempt };
    // 次の試行が予算に収まらないなら打ち切る（フォーム送信を待たせ続けない）。
    const backoff = RETRY_BACKOFF_MS * attempt;
    if (Date.now() - startedAt + backoff + timeoutMs > budgetMs) {
      return { ok: false, error: `${last} (budget ${budgetMs}ms 到達)`, attempts: attempt };
    }
    await sleep(backoff);
  }
  return { ok: false, error: last, attempts: maxAttempts };
}

export type SpecFields = {
  model: string | null;
  trim: string | null;
  modelYear: number | null;
  typeOfDrive: string | null;
  batterySoH: number | null;
  degradationPct: number | null;
  batteryCapacityKwh: number | null;
  batterySoHAt: string | null;
  msrp: number | null;
  productionDate: string | null;
};

// 劣化率 = 100 − batterySoH（小数第1位まで）。spec が空なら全て null が返る。
export function extractSpecFields(spec: Record<string, unknown>): SpecFields {
  const batterySoH = num(spec.batterySoH);
  return {
    model: text(spec.model),
    trim: text(spec.trim),
    modelYear: num(spec.modelYear),
    typeOfDrive: text(spec.typeOfDrive),
    batterySoH,
    degradationPct: batterySoH === null ? null : Math.round((100 - batterySoH) * 10) / 10,
    batteryCapacityKwh: num(spec.batteryCapacityKwh),
    batterySoHAt: text(spec.batterySoHTimestamp),
    msrp: num(spec.totalPrice),
    productionDate: text(spec.productionDate),
  };
}
