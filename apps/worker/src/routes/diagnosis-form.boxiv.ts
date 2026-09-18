// BOXIV-only: 愛車相場チェック・Battery劣化診断 LIFF フォーム（牧場モデルの入口）。
//
// Flow:
//   1. リッチメニュー「愛車相場チェック・Battery劣化診断」／友だち追加あいさつ → LIFF で GET /diagnosis-form を開く
//      （リンクに ?src=richmenu / greeting を付けると流入タグとして残る）
//   2. liff.getProfile() で lineUserId / displayName を自動取得（ブラウザ直開きは空のまま）
//   3. POST /diagnosis-form/submit → 最初の 1 問「お車の種類」でルートを分けてバリデーション
//      ルートA（Tesla Model 3 / Y）: VIN → spec_API(getVehicleSpecs) 自動コール → 劣化診断つき
//      ルートB（その他のテスラ／テスラ以外のEV／VIN不明）: 車種・グレード・初度登録年月 → 相場のみ（spec_API は呼ばない）
//      → D1 diagnosis_leads へ 1 行作成（spec 取得不可でも必ず作成）
//      → Notion「出品者リードリスト」へ起票（設定時のみ・非致命）
//      → Slack #診断依頼 へ定型投稿（設定時のみ・非致命）
//      → LINE へ受付メッセージを push（lineUserId がある時のみ・非致命）
//   4. 以降（価格算出・PDF・結果 push）は既存パイプライン（半手動）が引き継ぐ
//
// 仕様の正本: line/campaigns/battery-diagnosis/REQUIREMENTS.md
//   統合フォームの依頼書: Drive 2608_LTG_WARM_愛車相場チェック/02_LINEコネクトクリエーティブ/W-LINE_統合フォーム_実装依頼書_v01
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
import { createDiagnosisLeadRow, specModelName } from '../services/diagnosis-notion.boxiv.js';
import {
  fetchVehicleSpec,
  extractSpecFields,
  isTeslaVin,
  specApiKey,
} from '../services/diagnosis-spec.boxiv.js';
import {
  CAR_TYPES,
  DIAGNOSIS_KIND,
  findSoubaCarModel,
  isCarType,
  toEntrySource,
  type CarType,
} from '../services/souba-car-models.boxiv.js';
import { renderFormPage } from './diagnosis-form-page.boxiv.js';
import type { Env } from '../index.js';

export const diagnosisForm = new Hono<Env>();

// ---------------------------------------------------------------------------
// GET /diagnosis-form — フォームページ（BOXIV トンマナ: 白基調・黒CTA・Noto Sans JP）
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

// ルートA で選んだ車種と spec_API の model 略称の対応（食い違いの検出用）
const EXPECTED_SPEC_MODEL: Partial<Record<CarType, string>> = { tesla_m3: 'm3', tesla_my: 'my' };

const FIRST_REG_OLDEST_YEAR = 2020; // これより前は「2019以前」にまとめる

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
  const odometerKm = Number(String(body.odometer_km ?? '').replace(/[^\d]/g, ''));
  // 次回車検 YYYY-MM。温度（HOT/WARM/COLD）と出品提案の時期を決めるキー項目なので必須（「わからない」は受けない）
  const shakenMonth = str('shaken_month', 7);
  const consent = body.consent === true;
  const lineUserId = str('line_user_id', 64) || null;
  const displayName = str('display_name', 64) || null;
  const utm = str('utm', 2000) || null;
  const entrySource = toEntrySource(body.src);

  // お車の種類。car_type を送らない旧フォーム（開きっぱなしの画面）は従来どおりルートA として受ける。
  const carTypeRaw = str('car_type', 20);
  const carType: CarType | null = isCarType(carTypeRaw) ? carTypeRaw : null;
  // 「車台番号がわからない方はこちら」で Model 3 / Y からルートB に切り替えた場合は no_vin=true
  const route: 'A' | 'B' = carType && (CAR_TYPES[carType].route === 'B' || body.no_vin === true) ? 'B' : 'A';

  const errors: string[] = [];
  if (carTypeRaw && !carType) errors.push('お車の種類を選択してください');

  let vin = '';
  let carModelName: string | null = null;
  let grade: string | null = null;
  let gradeIsFree = false;
  let firstRegMonth: string | null = null;
  let firstRegRaw: string | null = null;

  if (route === 'A') {
    vin = str('vin', 17).toUpperCase();
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) errors.push('VIN（車台番号）は17桁の英数字で入力してください');
    const modelId = carType ? CAR_TYPES[carType].modelId : null;
    carModelName = modelId ? findSoubaCarModel(modelId)?.notionName ?? null : null;
  } else {
    const model = findSoubaCarModel(str('car_model', 40));
    if (!model) {
      errors.push('車種を選択してください');
    } else {
      carModelName = model.notionName;
      const gradeMode = str('grade_mode', 10); // pick | unknown | free
      const gradeValue = str('grade', 50);
      if (gradeMode === 'pick' && model.grades.includes(gradeValue)) {
        grade = gradeValue;
      } else if (gradeMode === 'free' && gradeValue) {
        grade = gradeValue;
        gradeIsFree = true;
      } else if (gradeMode !== 'unknown') {
        errors.push('グレードを選択するか、入力してください');
      }
    }

    const year = str('first_reg_year', 10);
    const month = str('first_reg_month', 4);
    const thisYear = new Date().getFullYear();
    const yearOk =
      year === '2019以前' || year === '不明' ||
      (/^\d{4}$/.test(year) && Number(year) >= FIRST_REG_OLDEST_YEAR && Number(year) <= thisYear);
    const monthOk = month === '不明' || /^([1-9]|1[0-2])$/.test(month);
    if (!yearOk || !monthOk) {
      errors.push('初度登録年月を選択してください');
    } else {
      firstRegRaw = `${year} / ${month === '不明' ? '不明' : month + '月'}`;
      if (/^\d{4}$/.test(year) && month !== '不明') firstRegMonth = `${year}-${month.padStart(2, '0')}`;
    }
  }

  if (!name) errors.push('お名前を入力してください');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('メールアドレスの形式が正しくありません');
  if (!/^\d{10,11}$/.test(phone)) errors.push('電話番号は数字10〜11桁で入力してください');
  if (!Number.isFinite(odometerKm) || odometerKm <= 0 || odometerKm > 2000000)
    errors.push('走行距離を数字で入力してください');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(shakenMonth)) errors.push('次回車検の年月を選択してください');
  if (!consent) errors.push('同意にチェックしてください');
  if (errors.length > 0) return c.json({ success: false, error: errors.join(' / ') }, 400);

  const diagnosisKind = DIAGNOSIS_KIND[route];
  const isTesla = route === 'A' && isTeslaVin(vin);
  const leadId = crypto.randomUUID();
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  // --- spec_API（getVehicleSpecs）: ルートA のテスラ VIN かつ API キー設定時のみ。失敗は非致命 ---
  // 上流はコールドスタート時に 8 秒以上かかることがあるので、10 秒 × 最大 2 回・合計 20 秒の
  // 予算で打ち切る（フォーム送信をこれ以上待たせない）。ここで取り切れなくても
  // status='API取得不可' として残し、cron の後追いバックフィルが指数バックオフで補完する。
  const hasSpecKey = specApiKey(c.env) !== '';
  let specJson: string | null = null;
  let spec: Record<string, unknown> = {};
  let specError: string | null = null;
  // 失敗の分類（auth/upstream/timeout/empty …）。Slack の文面と D1 の記録を分ける根拠にする。
  let specKind: string | null = null;
  let specNeedsHuman = false;
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
      specKind = result.kind;
      specNeedsHuman = result.needsHuman;
      // 分類を先頭に付けて残す。上流が全部 HTTP 500 で返すので、生のエラー文字列だけでは
      // 「待てば直る」のか「キーが死んでいる」のかを後から誰も判定できない。
      specError = `[${result.kind}] ${result.error}`;
      console.error('diagnosis-form: spec_API failed', leadId, vin, specError);
    }
  }

  const f = extractSpecFields(spec);
  const status =
    route === 'B'
      ? '診断依頼'
      : !isTesla
        ? '非テスラ'
        : specJson === null
          ? (hasSpecKey ? 'API取得不可' : '診断依頼')
          : '診断依頼';

  // ルートA: 選んだ車種と VIN の車種が違う場合は API の値を正として保存し、食い違いだけ記録する（ユーザーには出さない）
  const expectedModel = carType ? EXPECTED_SPEC_MODEL[carType] : undefined;
  const modelMismatch = route === 'A' && !!expectedModel && !!f.model && f.model.toLowerCase() !== expectedModel;

  // --- 重複エントリー判定（起票前に照会。高頻度の再エントリーは Slack で黄色警告する） ---
  // 同一顧客/車両の指標: メール / 電話 / VIN / LINEユーザーID のいずれか一致を「重複」とみなす。
  // （lineUserId は NULL、ルートB の vin は空文字のことがあるため、空一致を防ぐガードを入れる）
  let dupCount = 0;
  let dupFirstAt: string | null = null;
  try {
    const dup = await c.env.DB.prepare(
      `SELECT COUNT(*) AS cnt, MIN(created_at) AS first_at FROM diagnosis_leads
         WHERE email = ?1 OR phone = ?2
            OR (?3 <> '' AND vin = ?3)
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
         status, spec_error, spec_attempts, spec_last_try_at, spec_derived,
         car_type, diagnosis_kind, entry_source, car_model, grade, grade_is_free, first_reg_month, first_reg_raw
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
        f.derived ? 1 : 0,
        carType, diagnosisKind, entrySource, route === 'B' ? carModelName : null,
        grade, gradeIsFree ? 1 : 0, firstRegMonth, firstRegRaw
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
      diagnosisKind, entrySource,
      carModelName, grade, gradeIsFree, firstRegMonth,
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
      const lines = buildSlackLines({
        route, diagnosisKind, entrySource, isDuplicate, dupCount, dupFirstAt,
        leadId, vin, isTesla, odometerKm, shakenMonth, name, displayName,
        carTypeLabel: carType ? CAR_TYPES[carType].label : null,
        noVin: route === 'B' && !!carType && CAR_TYPES[carType].route === 'A',
        carModelName, grade, gradeIsFree, firstRegRaw,
        modelMismatch, specModel: specModelName(f.model),
        batterySoH: f.batterySoH, degradationPct: f.degradationPct,
        status, specError, specKind, specNeedsHuman,
        derived: f.derived, trim: f.trim,
      });
      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${slackToken}` },
        body: JSON.stringify({
          channel: slackChannel,
          attachments: [
            {
              // キー起因の spec 失敗は赤（要即対応）、重複は黄色、通常は緑
              color: specNeedsHuman ? '#e01e5a' : isDuplicate ? '#f2c744' : '#2fd06f',
              fallback: `愛車相場チェック 受付（${diagnosisKind}） ${leadId}${isDuplicate ? '（重複）' : ''}`,
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
      await line.pushTextMessage(lineUserId, acceptanceMessage(route, name));
    } catch (e) {
      console.error('diagnosis-form: LINE push failed', e);
    }
  }

  return c.json({ success: true, data: { leadId } });
});

// 受付メッセージ（依頼書 §5-5 ①）。LP の約束（無料・売却のお願いをしない・参考値）とそろえる。
export function acceptanceMessage(route: 'A' | 'B', name: string): string {
  return route === 'A'
    ? `受け付けました✅\n${name} 様の愛車相場レポート（バッテリー劣化診断つき）は、1営業日以内にこちらのLINEでお送りします。\nご売却のお願いをすることはありませんので、ご安心ください。\n\n※相場・診断結果は推定・参考値です。`
    : `受け付けました✅\n${name} 様の愛車相場レポートは、1営業日以内にこちらのLINEでお送りします。\nご売却のお願いをすることはありませんので、ご安心ください。\n\n※相場は推定・参考値です。`;
}

type SlackInput = {
  route: 'A' | 'B';
  diagnosisKind: string;
  entrySource: string | null;
  isDuplicate: boolean;
  dupCount: number;
  dupFirstAt: string | null;
  leadId: string;
  vin: string;
  isTesla: boolean;
  odometerKm: number;
  shakenMonth: string;
  name: string;
  displayName: string | null;
  carTypeLabel: string | null;
  noVin: boolean;
  carModelName: string | null;
  grade: string | null;
  gradeIsFree: boolean;
  firstRegRaw: string | null;
  modelMismatch: boolean;
  specModel: string | null;
  batterySoH: number | null;
  degradationPct: number | null;
  status: string;
  specError: string | null;
  specKind: string | null;
  specNeedsHuman: boolean;
  derived: boolean;
  trim: string | null;
};

// 運用担当が「おすすめ価格提案に劣化率を追記するか」を投稿だけで判断できるよう、診断種別を 2 行目に出す。
export function buildSlackLines(s: SlackInput): string[] {
  // 値はコードボックスで囲い、改行はサニタイズ（sell 通知と同じ流儀）
  const code = (v: string) => `\`${v.replace(/[\n\r`]/g, ' ').trim() || '-'}\``;
  const title = s.route === 'A' ? ':battery: *愛車相場チェック 受付（劣化診断つき）*' : ':red_car: *愛車相場チェック 受付（相場のみ）*';
  const lines = [s.isDuplicate ? `:warning: ${title.replace(/^:\w+: /, '')}（重複エントリー）` : title];
  lines.push(`診断種別: ${code(s.diagnosisKind)} ／ 流入: ${code(s.entrySource ?? '不明')}`);
  // 重複時は警告行を出す（高頻度の再エントリーは要注意＝黄色カード）
  if (s.isDuplicate) {
    lines.push(
      `⚠️ *重複エントリー*: 同一の顧客/車両（メール・電話・VIN・LINEのいずれか一致）で既に ${code(String(s.dupCount) + '件')}。初回 ${code(s.dupFirstAt ?? '不明')}`
    );
  }
  lines.push(`依頼ID: ${code(s.leadId)}`);

  if (s.route === 'A') {
    lines.push(`お車の種類: ${code(s.carTypeLabel ?? '（旧フォーム）')} ／ VIN: ${code(s.vin)}${s.isTesla ? '' : '（⚠️ 非テスラ）'}`);
    if (s.modelMismatch) {
      lines.push(`⚠️ 選択した車種と VIN の車種が違います: 選択 ${code(s.carTypeLabel ?? '-')} ／ VIN ${code(s.specModel ?? '-')}（VIN を正として保存）`);
    }
  } else {
    lines.push(`お車の種類: ${code(s.carTypeLabel ?? '-')}${s.noVin ? '（車台番号不明のため相場のみ）' : ''}`);
    lines.push(
      `車種: ${code(s.carModelName ?? '-')} ／ グレード: ${code(s.grade ?? 'わからない')}${s.gradeIsFree ? '（自由入力）' : ''}`
    );
    lines.push(`初度登録: ${code(s.firstRegRaw ?? '-')}`);
  }

  lines.push(
    `走行距離: ${code(s.odometerKm.toLocaleString() + ' km')} ／ 次回車検: ${code(s.shakenMonth)}`,
    `お名前: ${code(s.name)} ／ LINE: ${code(s.displayName ?? '未連携')}`
  );

  if (s.route === 'A') {
    lines.push(
      s.batterySoH !== null
        ? `SoH: ${code(s.batterySoH + '%')}（劣化率 ${s.degradationPct}%）`
        : `spec_API: ${code(s.status === 'API取得不可' ? '取得不可 ⚠️' : '未実行')}`
    );
    // 取得不可の時は原因と「次に何が起きるか」を明示する。
    // キー起因（auth / nokey）は待っても直らないので、待機案内ではなく即対応を促す。
    if (s.status === 'API取得不可') {
      lines.push(`原因: ${code(s.specError ?? '不明')}`);
      lines.push(
        s.specNeedsHuman
          ? `🚨 ${s.specKind === 'nokey' ? 'Worker に spec_API キーが入っていません' : 'spec_API キーが拒否されています'} — 自動では復旧しません。\`VEHICLE_SPECS_API_KEY\` を確認してください`
          : '⏳ 自動で再取得を試みます（最大8回・約3日まで）'
      );
    }
    // 推定で埋めた場合は運用が裏取りできるよう明示する（API の実値ではない）
    if (s.derived) {
      lines.push(`ℹ️ グレード/駆動は API が空のためオプションコードから推定: ${code(s.trim ?? '-')}`);
    }
  }
  return lines;
}
