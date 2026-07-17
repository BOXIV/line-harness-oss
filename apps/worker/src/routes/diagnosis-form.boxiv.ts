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
//   SPEC_API_KEY                — getVehicleSpecs の x-api-key（未設定なら spec 取得をスキップ）
//   SPEC_API_URL                — 既定 https://asia-northeast1-boxiv-share.cloudfunctions.net/getVehicleSpecs
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
import { renderFormPage } from './diagnosis-form-page.boxiv.js';
import type { Env } from '../index.js';

const SPEC_API_DEFAULT_URL =
  'https://asia-northeast1-boxiv-share.cloudfunctions.net/getVehicleSpecs';

// テスラの WMI（VIN 先頭3桁）: 米国/セミ・上海・ベルリン・その他
const TESLA_WMI = ['5YJ', '7SA', 'LRW', 'XP7', 'SFZ', '7G2'];

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

  const isTesla = TESLA_WMI.includes(vin.slice(0, 3));
  const leadId = crypto.randomUUID();
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  // --- spec_API（getVehicleSpecs）: テスラ VIN かつ API キー設定時のみ。失敗は非致命 ---
  let specJson: string | null = null;
  let spec: Record<string, unknown> = {};
  if (isTesla && c.env.SPEC_API_KEY) {
    try {
      const url = `${c.env.SPEC_API_URL || SPEC_API_DEFAULT_URL}?vin=${encodeURIComponent(vin)}`;
      const res = await fetch(url, { headers: { 'x-api-key': c.env.SPEC_API_KEY } });
      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        const sr = (data.specsResponse ?? data) as Record<string, unknown>;
        specJson = JSON.stringify(sr).slice(0, 30000);
        spec = sr;
      } else {
        console.error('diagnosis-form: spec_API status', res.status);
      }
    } catch (e) {
      console.error('diagnosis-form: spec_API error', e);
    }
  }

  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const batterySoH = num(spec.batterySoH);
  const degradation = batterySoH === null ? null : Math.round((100 - batterySoH) * 10) / 10;
  const status = !isTesla ? '非テスラ' : specJson === null ? (c.env.SPEC_API_KEY ? 'API取得不可' : '診断依頼') : '診断依頼';

  // --- D1 起票（必ず作成） ---
  try {
    await c.env.DB.prepare(
      `INSERT INTO diagnosis_leads (
         lead_id, line_user_id, display_name, name, email, phone, vin, is_tesla,
         odometer_km, shaken_month, consent, consented_at, utm,
         spec_json, model, trim, model_year, type_of_drive,
         battery_soh, degradation_pct, battery_capacity_kwh, battery_soh_at, msrp, production_date,
         status
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
      .bind(
        leadId, lineUserId, displayName, name, email, phone, vin, isTesla ? 1 : 0,
        odometerKm, shakenMonth, 1, now, utm,
        specJson,
        (spec.model as string) ?? null,
        (spec.trim as string) ?? null,
        num(spec.modelYear),
        (spec.typeOfDrive as string) ?? null,
        batterySoH, degradation, num(spec.batteryCapacityKwh),
        (spec.batterySoHTimestamp as string) ?? null,
        num(spec.totalPrice),
        (spec.productionDate as string) ?? null,
        status
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
      model: (spec.model as string) ?? null,
      trim: (spec.trim as string) ?? null,
      modelYear: num(spec.modelYear),
      typeOfDrive: (spec.typeOfDrive as string) ?? null,
      batterySoH, degradationPct: degradation,
      batteryCapacityKwh: num(spec.batteryCapacityKwh),
      msrp: num(spec.totalPrice),
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
        ':battery: *バッテリー診断 依頼受付*',
        `依頼ID: ${code(leadId)}`,
        `VIN: ${code(vin)}${isTesla ? '' : '（⚠️ 非テスラ）'}`,
        `走行距離: ${code(odometerKm.toLocaleString() + ' km')} ／ 次回車検: ${code(shakenMonth)}`,
        `お名前: ${code(name)} ／ LINE: ${code(displayName ?? '未連携')}`,
        batterySoH !== null
          ? `SoH: ${code(batterySoH + '%')}（劣化率 ${degradation}%）`
          : `spec_API: ${code(status === 'API取得不可' ? '取得不可 ⚠️' : '未実行')}`,
      ];
      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${slackToken}` },
        body: JSON.stringify({
          channel: slackChannel,
          attachments: [
            { color: '#2fd06f', fallback: `バッテリー診断 依頼受付 ${leadId}`, text: lines.join('\n') },
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
