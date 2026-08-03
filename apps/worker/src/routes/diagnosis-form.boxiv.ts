// BOXIV-only: バッテリー劣化診断 LIFF フォーム（牧場モデルの入口）。
//
// Flow (v1 = Notion 起票前の最小構成):
//   1. リッチメニュー「🔋バッテリー診断」→ LIFF で GET /diagnosis-form を開く
//   2. liff.getProfile() で lineUserId / displayName を自動取得（ブラウザ直開きは空のまま）
//   3. POST /diagnosis-form/submit → バリデーション → spec_API(getVehicleSpecs) 自動コール
//      → D1 diagnosis_leads へ 1 行作成（spec 取得不可でも必ず作成）
//      → Slack #診断依頼 へ定型投稿（設定時のみ・非致命）
//      → LINE へ受付メッセージを push（lineUserId がある時のみ・非致命）
//   4. 以降（価格算出・PDF・結果 push）は既存パイプライン（半手動）が引き継ぐ
//
// 仕様の正本: line/campaigns/battery-diagnosis/REQUIREMENTS.md
//
// Optional env:
//   VEHICLE_SPECS_API_KEY       — getVehicleSpecs の x-api-key（正・未設定なら spec 取得をスキップ／旧 SPEC_API_KEY も可）
//   VEHICLE_SPECS_API_URL       — 既定 https://asia-northeast1-boxiv-share.cloudfunctions.net/getVehicleSpecs（旧 SPEC_API_URL も可）
//   DIAGNOSIS_SLACK_CHANNEL_ID  — #診断依頼 のチャンネル ID（未設定なら Slack 通知なし）
//   DIAGNOSIS_SLACK_BOT_TOKEN   — 未設定なら SELLENTRY_SLACK_BOT_TOKEN を流用
//   DIAGNOSIS_LIFF_ID           — 診断フォーム用 LIFF ID（未設定なら LIFF_URL から導出）
//   DIAGNOSIS_NOTION_DB_ID      — Notion「出品者リードリスト」DB ID
//
// リポジトリは public のため、ID 類も値はコミットせず wrangler secret で投入する:
//   echo '<value>' | pnpm exec wrangler secret put DIAGNOSIS_NOTION_DB_ID --name line-connect-test
//   echo '<value>' | pnpm exec wrangler secret put DIAGNOSIS_SLACK_CHANNEL_ID --name line-connect-test

import { Hono } from 'hono';
import { LineClient } from '@line-crm/line-sdk';
import { createDiagnosisLeadRow } from '../services/diagnosis-notion.boxiv.js';
import {
  fetchVehicleSpec,
  extractSpecFields,
  isTeslaVin,
  specApiKey,
} from '../services/diagnosis-spec.boxiv.js';
import { renderFormPage } from './diagnosis-form-page.boxiv.js';
import type { Env } from '../index.js';

export const diagnosisForm = new Hono<Env>();

// ---------------------------------------------------------------------------
// GET /diagnosis-form — フォームページ（BOXIV トンマナ: 白基調・黒CTA・角丸0・Noto Sans JP）
// ---------------------------------------------------------------------------
diagnosisForm.get('/diagnosis-form', (c) => {
  const liffId =
    c.env.DIAGNOSIS_LIFF_ID ||
    (c.env.LIFF_URL || '').replace(/^https:\/\/liff\.line\.me\//, '') ||
    '';
  return c.html(renderFormPage(liffId));
});

// ---------------------------------------------------------------------------
// POST /diagnosis-form/submit
// ---------------------------------------------------------------------------
diagnosisForm.options('/diagnosis-form/submit', (c) => c.body(null, 204));

diagnosisForm.post('/diagnosis-form/submit', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'invalid JSON' }, 400);
  }

  const str = (k: string, max = 200): string =>
    String(body[k] ?? '')
      .trim()
      .slice(0, max);

  const name = str('name', 60);
  const email = str('email', 254);
  // 全角数字→半角、ハイフン/空白除去
  const phone = str('phone', 20)
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[^\d]/g, '');
  const vin = str('vin', 17).toUpperCase();
  const odometerKm = Number(String(body.odometer_km ?? '').replace(/[^\d]/g, ''));
  const shakenMonth = str('shaken_month', 7); // YYYY-MM
  const consent = body.consent === true;
  const lineUserId = str('line_user_id', 64) || null;
  const displayName = str('display_name', 64) || null;
  const utm = str('utm', 2000) || null;

  const errors: string[] = [];
  if (!name) errors.push('お名前を入力してください');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('メールアドレスの形式が正しくありません');
  if (!/^\d{10,11}$/.test(phone)) errors.push('電話番号は数字10〜11桁で入力してください');
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) errors.push('VIN（車台番号）は17桁の英数字で入力してください');
  if (!Number.isFinite(odometerKm) || odometerKm <= 0 || odometerKm > 2000000)
    errors.push('走行距離を数字で入力してください');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(shakenMonth)) errors.push('次回車検の年月を選択してください');
  if (!consent) errors.push('同意にチェックしてください');
  if (errors.length > 0) return c.json({ success: false, error: errors.join(' / ') }, 400);

  const isTesla = isTeslaVin(vin);
  const leadId = crypto.randomUUID();
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  // --- spec_API（getVehicleSpecs）: テスラ VIN かつ API キー設定時のみ。失敗は非致命 ---
  // 上流はコールドスタート時に 8 秒以上かかることがあるので、10 秒 × 最大 2 回・合計 20 秒の
  // 予算で打ち切る（フォーム送信をこれ以上待たせない）。ここで取り切れなくても
  // status='API取得不可' として残し、cron の後追いバックフィルが指数バックオフで補完する。
  const hasSpecKey = specApiKey(c.env) !== '';
  let specJson: string | null = null;
  let spec: Record<string, unknown> = {};
  let specError: string | null = null;
  // spec_attempts は「取得サイクル数」（送信時=1／バックフィル1回=1）。バックオフ段数の指標で、
  // 1 サイクル内の HTTP 試行回数は spec_error の "attemptN/M" 側に残る。
  let specTried = false;
  if (isTesla && hasSpecKey) {
    const result = await fetchVehicleSpec(c.env, vin, {
      attempts: 2,
      timeoutMs: 10_000,
      budgetMs: 20_000,
    });
    specTried = true;
    if (result.ok) {
      specJson = result.specJson;
      spec = result.spec;
    } else {
      specError = result.error;
      console.error('diagnosis-form: spec_API failed', leadId, vin, result.error);
    }
  }

  const f = extractSpecFields(spec);
  const status = !isTesla ? '非テスラ' : specJson === null ? (hasSpecKey ? 'API取得不可' : '診断依頼') : '診断依頼';

  // --- 重複エントリー判定（起票前に照会。高頻度の再エントリーは Slack で黄色警告する） ---
  // 同一顧客/車両の指標: メール / 電話 / VIN / LINEユーザーID のいずれか一致を「重複」とみなす。
  // （lineUserId は NULL のことがあるため NOT NULL ガードで空一致を防ぐ）
  let dupCount = 0;
  let dupFirstAt: string | null = null;
  try {
    const dup = await c.env.DB.prepare(
      `SELECT COUNT(*) AS cnt, MIN(created_at) AS first_at FROM diagnosis_leads
         WHERE email = ?1 OR phone = ?2 OR vin = ?3
            OR (?4 IS NOT NULL AND line_user_id = ?4)`
    )
      .bind(email, phone, vin, lineUserId)
      .first<{ cnt: number; first_at: string | null }>();
    dupCount = dup?.cnt ?? 0;
    dupFirstAt = dup?.first_at ?? null;
  } catch (e) {
    console.error('diagnosis-form: dup check failed', e);
  }
  const isDuplicate = dupCount > 0;

  // --- D1 起票（必ず作成） ---
  try {
    await c.env.DB.prepare(
      `INSERT INTO diagnosis_leads (
         lead_id, line_user_id, display_name, name, email, phone, vin, is_tesla,
         odometer_km, shaken_month, consent, consented_at, utm,
         spec_json, model, trim, model_year, type_of_drive,
         battery_soh, degradation_pct, battery_capacity_kwh, battery_soh_at, msrp, production_date,
         status, spec_error, spec_attempts, spec_last_try_at, spec_derived
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
      .bind(
        leadId, lineUserId, displayName, name, email, phone, vin, isTesla ? 1 : 0,
        odometerKm, shakenMonth, 1, now, utm,
        specJson,
        f.model, f.trim, f.modelYear, f.typeOfDrive,
        f.batterySoH, f.degradationPct, f.batteryCapacityKwh,
        f.batterySoHAt, f.msrp, f.productionDate,
        // 失敗理由と試行回数を残す（cron のバックオフ計算と事後の原因切り分けに使う）
        status, specError, specTried ? 1 : 0, specTried ? now : null,
        // trim/駆動をオプションコードから復元した行は印を付ける（API 実値と区別する）
        f.derived ? 1 : 0
      )
      .run();
  } catch (e) {
    console.error('diagnosis-form: D1 insert failed', e);
    return c.json({ success: false, error: '送信に失敗しました。時間をおいて再度お試しください。' }, 500);
  }

  // --- Notion「出品者リードリスト」へ起票（設定時のみ・非致命） ---
  let notionPageId: string | null = null;
  try {
    notionPageId = await createDiagnosisLeadRow(c.env, {
      leadId, name, email, phone, vin,
      odometerKm, shakenMonth, consentedAt: now, status,
      lineUserId, displayName, utm,
      model: f.model,
      trim: f.trim,
      modelYear: f.modelYear,
      typeOfDrive: f.typeOfDrive,
      batterySoH: f.batterySoH,
      degradationPct: f.degradationPct,
      batteryCapacityKwh: f.batteryCapacityKwh,
      msrp: f.msrp,
      specJson,
    });
    if (notionPageId) {
      await c.env.DB.prepare('UPDATE diagnosis_leads SET notion_page_id = ? WHERE lead_id = ?')
        .bind(notionPageId, leadId)
        .run();
    }
  } catch (e) {
    console.error('diagnosis-form: notion create failed', e);
  }

  // --- Slack #pj-lightning-lead へ通知（#pj-lightning-sell と同じシンプルなカード形式・非致命） ---
  const slackToken = c.env.DIAGNOSIS_SLACK_BOT_TOKEN || c.env.SELLENTRY_SLACK_BOT_TOKEN;
  const slackChannel = c.env.DIAGNOSIS_SLACK_CHANNEL_ID;
  if (slackToken && slackChannel) {
    try {
      // 値はコードボックスで囲い、改行はサニタイズ（sell 通知と同じ流儀）
      const code = (s: string) => `\`${s.replace(/[\n\r`]/g, ' ').trim() || '-'}\``;
      const lines = [
        isDuplicate ? ':warning: *バッテリー診断 依頼受付（重複エントリー）*' : ':battery: *バッテリー診断 依頼受付*',
      ];
      // 重複時は先頭に警告行を出す（高頻度の再エントリーは要注意＝黄色カード）
      if (isDuplicate) {
        lines.push(
          `⚠️ *重複エントリー*: 同一の顧客/車両（メール・電話・VIN・LINEのいずれか一致）で既に ${code(String(dupCount) + '件')}。初回 ${code(dupFirstAt ?? '不明')}`
        );
      }
      lines.push(
        `依頼ID: ${code(leadId)}`,
        `VIN: ${code(vin)}${isTesla ? '' : '（⚠️ 非テスラ）'}`,
        `走行距離: ${code(odometerKm.toLocaleString() + ' km')} ／ 次回車検: ${code(shakenMonth)}`,
        `お名前: ${code(name)} ／ LINE: ${code(displayName ?? '未連携')}`,
        f.batterySoH !== null
          ? `SoH: ${code(f.batterySoH + '%')}（劣化率 ${f.degradationPct}%）`
          : `spec_API: ${code(status === 'API取得不可' ? '取得不可 ⚠️' : '未実行')}`
      );
      // 取得不可の時は原因と「自動で再取得する」ことを明示する（運用が手を出す前に待てるように）
      if (status === 'API取得不可') {
        lines.push(`原因: ${code(specError ?? '不明')}`, '⏳ 自動で再取得を試みます（最大6回・24時間まで）');
      }
      // 推定で埋めた場合は運用が裏取りできるよう明示する（API の実値ではない）
      if (f.derived) {
        lines.push(`ℹ️ グレード/駆動は API が空のためオプションコードから推定: ${code(f.trim ?? '-')}`);
      }
      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${slackToken}` },
        body: JSON.stringify({
          channel: slackChannel,
          attachments: [
            {
              // 重複は黄色、通常は緑
              color: isDuplicate ? '#f2c744' : '#2fd06f',
              fallback: `バッテリー診断 依頼受付 ${leadId}${isDuplicate ? '（重複）' : ''}`,
              text: lines.join('\n'),
            },
          ],
        }),
      });
    } catch (e) {
      console.error('diagnosis-form: slack notify failed', e);
    }
  }

  // --- LINE 受付メッセージ push（lineUserId がある時のみ・非致命） ---
  if (lineUserId) {
    try {
      const line = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
      await line.pushTextMessage(
        lineUserId,
        `受け付けました✅\n${name} 様のバッテリー診断結果は、1営業日以内にこちらのLINEでお送りします。\n\n※診断結果は推定・参考値です。`
      );
    } catch (e) {
      console.error('diagnosis-form: LINE push failed', e);
    }
  }

  return c.json({ success: true, data: { leadId } });
});
