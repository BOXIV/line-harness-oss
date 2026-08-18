// BOXIV-only: spec_API 取得に失敗した診断リードを後から補完する cron ジョブ。
//
// フォーム送信時のリトライ（10秒×2回）で取り切れなかった行は status='API取得不可' で
// D1/Notion に残る。上流(Cloud Functions)の一過性障害はこの窓を超えて続くことがあるため
// （実例: lead 537809e3-… は送信時に失敗したが、後から同じ VIN を叩くと 200 OK）、
// ここで指数バックオフしながら再取得し、成功したら D1 と Notion の両方を埋める。
//
// 運用上の性質:
//   - 1 tick あたり最大 BATCH 件。spec_API は 1 件あたり数秒かかるので少数ずつ処理する。
//   - MAX_ATTEMPTS 回で打ち切り、Slack に手動対応を促す（永久リトライはしない）。
//   - 916 以前に作られた行は spec_attempts=0 / spec_last_try_at=NULL なので即座に対象になる。

import {
  fetchVehicleSpec,
  extractSpecFields,
  specApiKey,
  probeSpecApiAuth,
  type SpecEnv,
} from './diagnosis-spec.boxiv.js';
import { updateDiagnosisLeadSpec, type DiagnosisNotionEnv } from './diagnosis-notion.boxiv.js';

export type DiagnosisBackfillEnv = SpecEnv &
  DiagnosisNotionEnv & {
    DB: D1Database;
    DIAGNOSIS_SLACK_CHANNEL_ID?: string;
    DIAGNOSIS_SLACK_BOT_TOKEN?: string;
    SELLENTRY_SLACK_BOT_TOKEN?: string;
  };

// 試行回数 N 回目の「後」に待つ分数。5分 → 30分 → 2時間 → 6時間 → 24時間 → 24時間 …
//
// 以前は 5 段 / 6 回打ち切り = 送信から約 33 時間で断念していた。実際の事故では
// 上流にその VIN のデータが載ったのが送信の約 44 時間後で、断念の 11 時間後だった
// （2026-08-16 の障害。依頼IDは D1 diagnosis_leads と Slack 側に残る）。
// 1 日で諦めるのは上流の実力より短いので、
// 24 時間刻みを足して 3 日強（約 80 時間）まで粘る。
// 1 サイクルは HTTP 3 試行なので、伸ばしても上流への負荷は 1 日 1 回分しか増えない。
const BACKOFF_MIN = [5, 30, 120, 360, 1440, 1440, 1440];
const MAX_ATTEMPTS = 8;
const BATCH = 3;
const CANDIDATE_LIMIT = 20;

type LeadRow = {
  lead_id: string;
  vin: string;
  name: string;
  spec_attempts: number;
  spec_last_try_at: string | null;
  spec_error: string | null;
  notion_page_id: string | null;
  created_at: string;
};

// spec_error の先頭に付ける分類マーカー。D1 を見ただけで「待てば直る」か
// 「人が直すまで直らない」かが分かるようにするためのもの（grep 可能にもしておく）。
const AUTH_MARK = '[auth]';

export type DiagnosisBackfillSummary = {
  picked: number;
  ok: number;
  failed: number;
  gaveUp: number;
};

// 断念通知に「次に何をすべきか」を添えるための対応表。
const FAILURE_HINT: Record<string, string> = {
  nokey: 'Worker に VEHICLE_SPECS_API_KEY が入っていない。secret を投入する',
  auth: 'キーが拒否されている。Worker の VEHICLE_SPECS_API_KEY を確認・再投入する',
  upstream: '上流の障害。時間を置いて手動補完スクリプトで取り直す',
  client: 'リクエストが不正。VIN の入力ミスを疑う',
  timeout: '上流が応答しない。時間を置いて手動補完スクリプトで取り直す',
  network: '通信エラー。時間を置いて手動補完スクリプトで取り直す',
  parse: '上流のレスポンス形式が変わった疑い。実際の応答を確認する',
  empty: '上流にこの VIN のデータが無い。VIN の入力ミス、または上流未登録',
};

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// spec_last_try_at が無い行（916 以前 / 未試行）は即 due。
function isDue(row: LeadRow, now: number): boolean {
  if (!row.spec_last_try_at) return true;
  const last = Date.parse(row.spec_last_try_at);
  if (!Number.isFinite(last)) return true;
  const idx = Math.min(Math.max(row.spec_attempts - 1, 0), BACKOFF_MIN.length - 1);
  return now - last >= BACKOFF_MIN[idx] * 60_000;
}

async function postSlack(env: DiagnosisBackfillEnv, color: string, lines: string[]): Promise<void> {
  const token = env.DIAGNOSIS_SLACK_BOT_TOKEN || env.SELLENTRY_SLACK_BOT_TOKEN;
  const channel = env.DIAGNOSIS_SLACK_CHANNEL_ID;
  if (!token || !channel) return;
  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        channel,
        attachments: [{ color, fallback: lines[0], text: lines.join('\n') }],
      }),
    });
  } catch (e) {
    console.error('diagnosis-backfill: slack notify failed', e);
  }
}

export async function backfillDiagnosisSpecs(
  env: DiagnosisBackfillEnv
): Promise<DiagnosisBackfillSummary> {
  const summary: DiagnosisBackfillSummary = { picked: 0, ok: 0, failed: 0, gaveUp: 0 };
  // キーが無い環境（test の一部）では status が '診断依頼' のままなので対象自体が出ないが、
  // 無駄な D1 照会も避けるためここで早期 return する。
  if (!specApiKey(env)) return summary;

  let candidates: LeadRow[];
  try {
    const res = await env.DB.prepare(
      `SELECT lead_id, vin, name, spec_attempts, spec_last_try_at, spec_error,
              notion_page_id, created_at
         FROM diagnosis_leads
        WHERE status = 'API取得不可' AND is_tesla = 1 AND spec_json IS NULL
          AND spec_attempts < ?1
        ORDER BY COALESCE(spec_last_try_at, created_at) ASC
        LIMIT ?2`
    )
      .bind(MAX_ATTEMPTS, CANDIDATE_LIMIT)
      .all<LeadRow>();
    candidates = res.results ?? [];
  } catch (e) {
    console.error('diagnosis-backfill: candidate query failed', e);
    return summary;
  }

  const now = Date.now();
  const due = candidates.filter((r) => isDue(r, now)).slice(0, BATCH);
  summary.picked = due.length;
  if (due.length === 0) return summary;

  const code = (s: string) => `\`${s.replace(/[\n\r`]/g, ' ').trim() || '-'}\``;

  // --- 先にキー健全性だけ確かめる ------------------------------------------
  // 上流はキー不正も内部エラーも同じ HTTP 500 で返すので、キーが死んでいる状態で
  // リトライを回すと「直せば取れたはずのリード」の試行回数だけが焼かれ、キーを
  // 直した時にはもう cron が拾わない、という最悪の形になる（2026-08-16 の事故の構造）。
  // そこで due がある時だけ canary を 1 回叩き、拒否されたら試行回数を消費せずに撤退する。
  const probe = await probeSpecApiAuth(env);
  if (!probe.ok) {
    const at = nowIso();
    const detail = `${AUTH_MARK} ${probe.note} — spec_API キーが拒否されています（試行回数は消費せず待機）`;
    // 既にこのマーカーが付いている行しか無ければ「通知済みの継続中障害」なので黙る。
    const firstDetection = due.some((r) => !(r.spec_error ?? '').startsWith(AUTH_MARK));
    for (const row of due) {
      try {
        // ⚠️ spec_last_try_at は**触らない**。ここを更新するとバックオフが進み、
        // 試行回数の多い行は「キーが直った後 24 時間放置」になってしまう。
        // 実際には 1 回も叩いていないので、due のまま次の tick で拾わせる。
        await env.DB.prepare(
          `UPDATE diagnosis_leads SET spec_error = ?1, updated_at = ?2 WHERE lead_id = ?3`
        )
          .bind(detail.slice(0, 500), at, row.lead_id)
          .run();
      } catch (e) {
        console.error('diagnosis-backfill: auth-hold update failed', row.lead_id, e);
      }
    }
    console.error('diagnosis-backfill: spec_API auth probe failed', probe.note, due.length);
    if (firstDetection) {
      await postSlack(env, '#e01e5a', [
        ':rotating_light: *spec_API のキーが拒否されています（バッテリー診断が全件止まります）*',
        `canary 応答: ${code(probe.note)}`,
        `再取得待ちの依頼: ${code(String(due.length) + '件')}（試行回数は消費していません）`,
        '→ Cloudflare Worker `line-connect` の `VEHICLE_SPECS_API_KEY` を確認してください。',
        '　 `.env` の値に引用符・空白が混ざっていないかも合わせて確認（`node line/scripts/sync-line-secrets.mjs prod`）。',
      ]);
    }
    return summary;
  }

  for (const row of due) {
    const at = nowIso();
    // cron はユーザーを待たせないので、送信時より長めの予算で粘る。
    const result = await fetchVehicleSpec(env, row.vin, {
      attempts: 3,
      timeoutMs: 20_000,
      budgetMs: 60_000,
    });

    if (!result.ok) {
      summary.failed++;
      const attempts = row.spec_attempts + 1;
      try {
        await env.DB.prepare(
          `UPDATE diagnosis_leads
              SET spec_error = ?1, spec_attempts = ?2, spec_last_try_at = ?3, updated_at = ?3
            WHERE lead_id = ?4`
        )
          .bind(`[${result.kind}] ${result.error}`.slice(0, 500), attempts, at, row.lead_id)
          .run();
      } catch (e) {
        console.error('diagnosis-backfill: failure update failed', row.lead_id, e);
      }
      console.error('diagnosis-backfill: retry failed', row.lead_id, attempts, result.error);
      // 上限に達したらここで諦める。以降 cron は拾わないので人間に引き継ぐ。
      if (attempts >= MAX_ATTEMPTS) {
        summary.gaveUp++;
        await postSlack(env, '#e01e5a', [
          ':rotating_light: *バッテリー診断 spec 自動取得を断念（手動対応が必要）*',
          `依頼ID: ${code(row.lead_id)}`,
          `VIN: ${code(row.vin)} ／ お名前: ${code(row.name)}`,
          `${MAX_ATTEMPTS} 回試行して取得できませんでした。最後のエラー: ${code(result.error)}`,
          // 「何をすればいいか」まで書く。エラー文字列だけでは運用が動けなかった。
          `分類: ${code(result.kind)} — ${FAILURE_HINT[result.kind]}`,
          `手動補完: ${code('node line/scripts/diagnosis-spec-retry.mjs ' + row.lead_id + ' --apply')}`,
        ]);
      }
      continue;
    }

    const f = extractSpecFields(result.spec);
    try {
      await env.DB.prepare(
        `UPDATE diagnosis_leads
            SET spec_json = ?1, model = ?2, trim = ?3, model_year = ?4, type_of_drive = ?5,
                battery_soh = ?6, degradation_pct = ?7, battery_capacity_kwh = ?8,
                battery_soh_at = ?9, msrp = ?10, production_date = ?11,
                status = '診断依頼', spec_error = NULL, spec_derived = ?12,
                spec_attempts = ?13, spec_last_try_at = ?14, updated_at = ?14
          WHERE lead_id = ?15`
      )
        .bind(
          result.specJson, f.model, f.trim, f.modelYear, f.typeOfDrive,
          f.batterySoH, f.degradationPct, f.batteryCapacityKwh,
          f.batterySoHAt, f.msrp, f.productionDate,
          f.derived ? 1 : 0,
          row.spec_attempts + 1, at, row.lead_id
        )
        .run();
    } catch (e) {
      // D1 に入らなかったものを成功扱いすると Notion とずれるので、ここで打ち切る。
      console.error('diagnosis-backfill: success update failed', row.lead_id, e);
      summary.failed++;
      continue;
    }
    summary.ok++;

    // Notion 側も同じ行を埋める（非致命 — 失敗しても D1 は補完済み）。
    let notionOk = false;
    if (row.notion_page_id) {
      try {
        notionOk = await updateDiagnosisLeadSpec(env, row.notion_page_id, {
          status: '診断依頼',
          model: f.model,
          trim: f.trim,
          modelYear: f.modelYear,
          typeOfDrive: f.typeOfDrive,
          batterySoH: f.batterySoH,
          degradationPct: f.degradationPct,
          batteryCapacityKwh: f.batteryCapacityKwh,
          msrp: f.msrp,
          specJson: result.specJson,
        });
      } catch (e) {
        console.error('diagnosis-backfill: notion update failed', row.lead_id, e);
      }
    }

    const lines = [
      ':white_check_mark: *バッテリー診断 spec を自動補完しました*',
      `依頼ID: ${code(row.lead_id)}`,
      `VIN: ${code(row.vin)} ／ お名前: ${code(row.name)}`,
      f.batterySoH !== null
        ? `SoH: ${code(f.batterySoH + '%')}（劣化率 ${f.degradationPct}%）`
        : `SoH: ${code('取得値なし')}`,
      `Notion: ${code(row.notion_page_id ? (notionOk ? '更新済み' : '更新失敗 ⚠️') : '未起票')}`,
    ];
    // 推定で埋めた場合は運用が裏取りできるよう明示する（API の実値ではない）
    if (f.derived) {
      lines.push(`ℹ️ グレード/駆動は API が空のためオプションコードから推定: ${code(f.trim ?? '-')}`);
    }
    await postSlack(env, '#2fd06f', lines);
  }

  return summary;
}
