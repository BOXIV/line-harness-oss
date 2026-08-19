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
//   - 失敗は必ず SpecFailureKind に分類して返す。上流が全部 HTTP 500 で返す以上、
//     分類しないと「待てば直る」か「人が直すまで直らない」かを運用が判断できない。
//     (2026-08-16 の実例: あるリードは 500 のまま 6 回・33 時間リトライして断念。
//      この 500 が上流障害なのかキー不正なのかは、記録された文字列からは最後まで分からなかった。)

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
  // 5xx で終わった時に「キー健全性 canary」を 1 回だけ追加で叩くか（既定 true）。
  probeOnFailure?: boolean;
};

// 失敗の種類。上流は何でも HTTP 500 で返すので、こちら側で必ず分類してから記録する。
//   nokey    — キーが env に無い（設定漏れ）
//   auth     — キーが上流に拒否された疑い（canary も 500）。人が直すまで直らない
//   upstream — 上流 5xx / 一過性。時間を空ければ直る可能性が高い
//   client   — 4xx（VIN 形式など）
//   timeout / network / parse — 通信レイヤの一過性
//   empty    — 200 だが中身が空（上流にその VIN のデータが無い）
export type SpecFailureKind =
  | 'nokey'
  | 'auth'
  | 'upstream'
  | 'client'
  | 'timeout'
  | 'network'
  | 'parse'
  | 'empty';

export type SpecFetchResult =
  | { ok: true; specJson: string; spec: Record<string, unknown>; attempts: number }
  | {
      ok: false;
      error: string;
      kind: SpecFailureKind;
      // true = バックオフで待っても直らない。即座に人へエスカレーションする。
      needsHuman: boolean;
      attempts: number;
    };

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
  | {
      ok: false;
      error: string;
      kind: SpecFailureKind;
      retryable: boolean;
      status: number | null;
      ms: number;
    };

async function attemptFetch(url: string, key: string, timeoutMs: number): Promise<AttemptResult> {
  // 経過時間は「キー不正」と「本物の障害」を見分ける唯一の手掛かりなので必ず残す。
  // 実測(2026-08-18): キー拒否は 120〜190ms の即答、正常照会は 0.8〜2.0 秒。
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'x-api-key': key },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const ms = Date.now() - startedAt;
    const name = (e as Error)?.name ?? '';
    const isTimeout = name === 'TimeoutError' || name === 'AbortError';
    // ネットワーク断・タイムアウトはいずれも一過性とみなす
    const error = isTimeout
      ? `timeout ${timeoutMs}ms`
      : `network: ${String((e as Error)?.message ?? e).slice(0, 200)} (${ms}ms)`;
    return { ok: false, error, kind: isTimeout ? 'timeout' : 'network', retryable: true, status: null, ms };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const ms = Date.now() - startedAt;
    // 408/429/5xx は一過性とみなして再試行、4xx はそのままでは直らない。
    // ⚠️ この上流は 401/400 を返さない。キー不正も VIN 不正も内部エラーも全部
    //    500 {"error":"unknown"} なので、ここでの分類はあくまで暫定。
    //    5xx の真因（auth か upstream か）は fetchVehicleSpec の canary で確定させる。
    const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
    const detail = body ? ` ${body.replace(/\s+/g, ' ').trim().slice(0, 200)}` : '';
    return {
      ok: false,
      error: `HTTP ${res.status} (${ms}ms)${detail}`,
      kind: retryable ? 'upstream' : 'client',
      retryable,
      status: res.status,
      ms,
    };
  }

  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch (e) {
    // レスポンス途中切断でも起きうるので再試行対象にする。
    return {
      ok: false,
      error: `JSON parse: ${String((e as Error)?.message ?? e).slice(0, 150)}`,
      kind: 'parse',
      retryable: true,
      status: res.status,
      ms: Date.now() - startedAt,
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
    return {
      ok: false,
      error: `200 だが期待した形ではない（上流にこの VIN のデータが無い or 形式変更）: ${keys || '(empty)'}`,
      kind: 'empty',
      retryable: false,
      status: res.status,
      ms: Date.now() - startedAt,
    };
  }

  return { ok: true, specJson: JSON.stringify(sr).slice(0, 30000), spec: resp };
}

// --- キー健全性 canary ------------------------------------------------------
//
// 上流 getVehicleSpecs はエラーを一切区別せず、**キー不正も VIN 不正も内部エラーも**
// 一律 HTTP 500 {"error":"unknown","message":"An unexpected error occurred"} で返す
// （401/400 は返らない。2026-08-18 実測）。そのままでは
//   「こちらの設定ミス（人が直すまで永久に失敗）」と
//   「上流の一過性障害（待てば直る）」
// を区別できず、実際に前者を 33 時間バックオフし続けて放置する事故が起きた。
//
// 唯一の切り分け手段が「**未知の VIN に対する応答の違い**」:
//   キー有効 → HTTP 200 + {"specsResponse":{"response":{}}}（0.8〜2.0 秒）
//   キー無効 → HTTP 500 {"error":"unknown"}（120〜190ms の即答）
// そこで実在しない合成 VIN を canary に使う。顧客の VIN は一切使わない（PII を持ち出さない）。
const AUTH_CANARY_VIN = 'LRW3E7EA0MC000001';

export type SpecAuthProbe = { ok: boolean; status: number | null; ms: number; note: string };

export async function probeSpecApiAuth(env: SpecEnv, timeoutMs = 5_000): Promise<SpecAuthProbe> {
  const key = specApiKey(env);
  if (!key) return { ok: false, status: null, ms: 0, note: 'キー未設定' };
  const startedAt = Date.now();
  try {
    const res = await fetch(`${specApiUrl(env)}?vin=${AUTH_CANARY_VIN}`, {
      headers: { 'x-api-key': key },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Date.now() - startedAt;
    return { ok: res.ok, status: res.status, ms, note: `canary HTTP ${res.status} in ${ms}ms` };
  } catch (e) {
    const ms = Date.now() - startedAt;
    const name = (e as Error)?.name ?? '';
    const isTimeout = name === 'TimeoutError' || name === 'AbortError';
    return {
      ok: false,
      status: null,
      ms,
      note: isTimeout ? `canary timeout ${timeoutMs}ms` : `canary network error (${ms}ms)`,
    };
  }
}

export async function fetchVehicleSpec(
  env: SpecEnv,
  vin: string,
  opts: SpecFetchOptions = {}
): Promise<SpecFetchResult> {
  const key = specApiKey(env);
  if (!key)
    return { ok: false, error: 'spec_API キー未設定', kind: 'nokey', needsHuman: true, attempts: 0 };

  const maxAttempts = Math.max(1, opts.attempts ?? 2);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const budgetMs = opts.budgetMs ?? 20_000;
  const url = `${specApiUrl(env)}?vin=${encodeURIComponent(vin)}`;
  const startedAt = Date.now();

  let last = 'unknown';
  let lastKind: SpecFailureKind = 'upstream';
  let lastStatus: number | null = null;

  // 5xx で終わった時だけ canary を 1 回叩き、auth（人が直す）と upstream（待てば直る）に確定させる。
  // 成功パスには一切足さない。canary はキー不正なら 130ms 前後で返るので、失敗時の追加待ちも短い。
  const finish = async (attempts: number, suffix = ''): Promise<SpecFetchResult> => {
    const error = `${last}${suffix}`;
    const ambiguous5xx = lastKind === 'upstream' && lastStatus !== null && lastStatus >= 500;
    if (!ambiguous5xx || opts.probeOnFailure === false) {
      return { ok: false, error, kind: lastKind, needsHuman: false, attempts };
    }
    const probe = await probeSpecApiAuth(env, Math.min(timeoutMs, 5_000));
    return probe.ok
      ? {
          ok: false,
          error: `${error} ／ ${probe.note} = キーは有効。上流障害かこの VIN 固有`,
          kind: 'upstream',
          needsHuman: false,
          attempts,
        }
      : {
          ok: false,
          error: `${error} ／ ${probe.note} = APIキー不正または上流全断の疑い（要人手）`,
          kind: 'auth',
          needsHuman: true,
          attempts,
        };
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const outcome = await attemptFetch(url, key, timeoutMs);
    if (outcome.ok) {
      return { ok: true, specJson: outcome.specJson, spec: outcome.spec, attempts: attempt };
    }
    last = `attempt${attempt}/${maxAttempts}: ${outcome.error}`;
    lastKind = outcome.kind;
    lastStatus = outcome.status;
    if (!outcome.retryable) return finish(attempt);
    if (attempt >= maxAttempts) return finish(attempt);
    // 次の試行が予算に収まらないなら打ち切る（フォーム送信を待たせ続けない）。
    const backoff = RETRY_BACKOFF_MS * attempt;
    if (Date.now() - startedAt + backoff + timeoutMs > budgetMs) {
      return finish(attempt, ` (budget ${budgetMs}ms 到達)`);
    }
    await sleep(backoff);
  }
  return finish(maxAttempts);
}

// --- trim / 駆動の推定補完 -------------------------------------------------
//
// 上流は初期 MIC 車（VIN 先頭 LRW＝上海製 等）で trim="" / typeOfDrive=null を返すことがある。
// モデルタイプコード（実例 `$MT329`）の name が上流の対応表に無く、trim 文字列を組み立てられて
// いないのが原因で、一過性ではない（同 VIN を何度叩いても空）。既存の garage パイプラインも
// 同じ条件を踏んでおり、そちらは人が入力した Notion「[Form]グレード」に退避している
// （listing/scripts/garage/garage-notion.mjs）。診断フォームはグレードを聞かない設計なので
// 退避先が無く、代わりに equipmentPrice のオプションコードから復元する。
//
// 命名は API 自身の書式に合わせる（例: "Model 3 Performance Dual Motor All-Wheel Drive"）。

const MODEL_NAMES: Record<string, string> = {
  m3: 'Model 3',
  my: 'Model Y',
  ms: 'Model S',
  mx: 'Model X',
};

type Equipment = { code?: string; name?: string };

function equipmentList(spec: Record<string, unknown>): Equipment[] {
  return Array.isArray(spec.equipmentPrice) ? (spec.equipmentPrice as Equipment[]) : [];
}

// "Dual Motor All-Wheel Drive" / "Rear-Wheel Drive" 等をそのまま使う（長い表記を優先）。
function drivePhrase(items: Equipment[]): string | null {
  const hits = items
    .map((e) => (e.name ?? '').trim())
    .filter((n) => /(All-Wheel|Rear-Wheel|Front-Wheel) Drive$/.test(n));
  if (hits.length === 0) return null;
  return hits.sort((a, b) => b.length - a.length)[0];
}

function driveCode(phrase: string): string | null {
  if (phrase.includes('All-Wheel')) return 'AWD';
  if (phrase.includes('Rear-Wheel')) return 'RWD';
  if (phrase.includes('Front-Wheel')) return 'FWD';
  return null;
}

// 誤検出を避けるため確度の高い手掛かりだけ採る。
//   Performance = `$SPT*`（Performance Upgrade）。"Performance Brakes/Pedals" は
//                 単体オプションとして Long Range 車にも付くので根拠にしない。
//   Long Range  = 名称に "Long Range" を含むもの。
//   Premium は "Premium Interior" / "Standard Connectivity" 等と紛らわしいので推定しない。
function driveVariant(items: Equipment[]): string | null {
  for (const e of items) {
    if ((e.code ?? '').startsWith('$SPT') || (e.name ?? '').trim() === 'Performance Upgrade') {
      return 'Performance';
    }
  }
  for (const e of items) {
    if ((e.name ?? '').includes('Long Range')) return 'Long Range';
  }
  return null;
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
  // trim / typeOfDrive をオプションコードから推定したか（API の実値ではない印）
  derived: boolean;
};

// 劣化率 = 100 − batterySoH（小数第1位まで）。spec が空なら全て null / derived=false が返る。
export function extractSpecFields(spec: Record<string, unknown>): SpecFields {
  const batterySoH = num(spec.batterySoH);
  let trim = text(spec.trim);
  let typeOfDrive = text(spec.typeOfDrive);
  let derived = false;

  if (!trim || !typeOfDrive) {
    const items = equipmentList(spec);
    const phrase = drivePhrase(items);
    if (phrase) {
      if (!typeOfDrive) {
        typeOfDrive = driveCode(phrase);
        derived = typeOfDrive !== null;
      }
      if (!trim) {
        const modelName = MODEL_NAMES[String(spec.model ?? '').toLowerCase()] ?? null;
        if (modelName) {
          // 通常の個体はモデルタイプコード（$MTxxx）の name が trim 文字列そのもの
          // （例: "Model 3 Long Range All-Wheel Drive"）＝ API はこれを trim に写しているだけ。
          // その name が残っていればそのまま採用する。実データ 10 件で完全一致を確認済み。
          // MIC 個体は $MT329 の name が空で、駆動オプション（"Dual Motor All-Wheel Drive"）
          // しか残らないため、モデル名とグレードを補って組み立てる。
          trim = phrase.startsWith(modelName)
            ? phrase
            : [modelName, driveVariant(items), phrase].filter(Boolean).join(' ');
          derived = true;
        }
      }
    }
  }

  return {
    model: text(spec.model),
    trim,
    modelYear: num(spec.modelYear),
    typeOfDrive,
    batterySoH,
    degradationPct: batterySoH === null ? null : Math.round((100 - batterySoH) * 10) / 10,
    batteryCapacityKwh: num(spec.batteryCapacityKwh),
    batterySoHAt: text(spec.batterySoHTimestamp),
    msrp: num(spec.totalPrice),
    productionDate: text(spec.productionDate),
    derived,
  };
}
