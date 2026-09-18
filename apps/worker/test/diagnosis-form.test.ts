/**
 * 愛車相場チェック・Battery劣化診断フォーム（BOXIV / migration 928）。
 *
 * 最初の 1 問「お車の種類」で 2 ルートに分かれる:
 *   ルートA（Tesla Model 3 / Y）= VIN → spec_API → 劣化診断つき
 *   ルートB（その他のテスラ／テスラ以外のEV／VIN不明）= 車種・グレード・初度登録年月 → 相場のみ
 *
 * 外部（Notion / Slack / LINE / spec_API）は fetch を差し替えて、送った中身だけを確かめる。
 * 実キー・実顧客データは使わない（値はすべてダミー）。
 *
 * ここで固定するのは:
 *   1. ルートA は従来どおり spec_API を呼び、診断種別=劣化診断・受付文言がルートA になる
 *   2. ルートA で選んだ車種と VIN の車種が違っても送信は通り、API の車種で保存・Slack で食い違いを出す
 *   3. ルートB は spec_API を呼ばず、車種/グレード/初度登録日を Notion に書き、VIN を書かない
 *   4. ルートB 同士（VIN 空）が「重複」と判定されない
 *   5. 後追いバックフィルの対象条件（API取得不可 AND is_tesla=1）にルートB の行が入らない
 *   6. car_type を送らない旧フォーム（開きっぱなしの画面）も従来どおりルートA として受ける
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb } from './support/fixtures.js';
import { diagnosisForm } from '../src/routes/diagnosis-form.boxiv.js';
import { buildLeadRowProps } from '../src/services/diagnosis-notion.boxiv.js';
import { SOUBA_CAR_GROUPS } from '../src/services/souba-car-models.boxiv.js';

type Call = { url: string; body: Record<string, unknown> | null };

const ENV = {
  DB: testDb,
  NOTION_API_KEY: 'test-notion-key',
  DIAGNOSIS_NOTION_DB_ID: 'test-lead-db',
  DIAGNOSIS_SLACK_CHANNEL_ID: 'C-TEST',
  SELLENTRY_SLACK_BOT_TOKEN: 'xoxb-test',
  LINE_CHANNEL_ACCESS_TOKEN: 'test-line-token',
  VEHICLE_SPECS_API_KEY: 'test-spec-key',
};

let calls: Call[] = [];
let specModel = 'm3';

beforeEach(async () => {
  calls = [];
  specModel = 'm3';
  await testDb.prepare('DELETE FROM diagnosis_leads').run();
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const raw = typeof init?.body === 'string' ? init.body : null;
    calls.push({ url, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null });
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('getVehicleSpecs')) {
      return json({
        specsResponse: {
          response: { vin: 'x', model: specModel, trim: 'Long Range', modelYear: 2021, batterySoH: 92.5, batteryCapacityKwh: 75 },
        },
      });
    }
    if (url.includes('api.notion.com/v1/pages')) return json({ id: 'notion-page-1' });
    return json({ ok: true });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const COMMON = {
  odometer_km: '35000',
  shaken_month: '2027-08',
  name: 'テスト 太郎',
  email: 'taro@example.com',
  phone: '09000000000',
  consent: true,
  line_user_id: 'U-test-1',
  display_name: 'たろう',
};

async function submit(body: Record<string, unknown>) {
  const res = await diagnosisForm.request(
    '/diagnosis-form/submit',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    ENV
  );
  return { status: res.status, json: (await res.json()) as { success: boolean; error?: string; data?: { leadId: string } } };
}

const callTo = (part: string) => calls.filter((c) => c.url.includes(part));
const notionProps = () => (callTo('api.notion.com/v1/pages')[0]?.body?.properties ?? {}) as Record<string, any>;
const slackText = () => ((callTo('slack.com')[0]?.body?.attachments as { text: string }[])[0].text);
const lineText = () => ((callTo('api.line.me')[0]?.body?.messages as { text: string }[])[0].text);

async function leadRow(leadId: string) {
  return testDb.prepare('SELECT * FROM diagnosis_leads WHERE lead_id = ?').bind(leadId).first<Record<string, unknown>>();
}

describe('ルートA（Tesla Model 3 / Y）', () => {
  it('VIN で spec_API を呼び、診断種別=劣化診断・流入タグ付きで起票する', async () => {
    const r = await submit({ ...COMMON, car_type: 'tesla_m3', vin: '5yj3e7eb0mf000001', src: 'richmenu' });
    expect(r.status).toBe(200);
    expect(callTo('getVehicleSpecs')).toHaveLength(1);

    const row = await leadRow(r.json.data!.leadId);
    expect(row).toMatchObject({ car_type: 'tesla_m3', diagnosis_kind: '劣化診断', entry_source: 'richmenu', vin: '5YJ3E7EB0MF000001', is_tesla: 1, status: '診断依頼' });

    const props = notionProps();
    expect(props['診断種別']).toEqual({ select: { name: '劣化診断' } });
    expect(props['流入タグ']).toEqual({ select: { name: 'richmenu' } });
    expect(props['[Form]車種名']).toEqual({ select: { name: 'Tesla Model 3' } });
    expect(props['劣化率(%)']).toEqual({ number: 7.5 });
    expect(props['[Form]初度登録日']).toBeUndefined();

    expect(slackText()).toContain('診断種別: `劣化診断`');
    expect(lineText()).toContain('愛車相場レポート（バッテリー劣化診断つき）');
    expect(lineText()).toContain('ご売却のお願いをすることはありません');
  });

  it('選んだ車種と VIN の車種が違っても通し、API の車種で保存して Slack に食い違いを出す', async () => {
    specModel = 'ms';
    const r = await submit({ ...COMMON, car_type: 'tesla_m3', vin: '5YJSA7E20MF000001' });
    expect(r.json.success).toBe(true);
    expect(notionProps()['[Form]車種名']).toEqual({ select: { name: 'Tesla Model S' } });
    expect(slackText()).toContain('選択した車種と VIN の車種が違います');
  });

  it('VIN が 17 桁でなければ送信できない', async () => {
    const r = await submit({ ...COMMON, car_type: 'tesla_my', vin: '5YJ3E7EB0MF' });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('VIN');
  });

  it('car_type を送らない旧フォームは従来どおりルートAとして受ける', async () => {
    const r = await submit({ ...COMMON, vin: '5YJ3E7EB0MF000002' });
    expect(r.status).toBe(200);
    expect(callTo('getVehicleSpecs')).toHaveLength(1);
    expect(await leadRow(r.json.data!.leadId)).toMatchObject({ car_type: null, diagnosis_kind: '劣化診断' });
  });
});

describe('ルートB（その他のテスラ／テスラ以外のEV／VIN不明）', () => {
  it('spec_API を呼ばず、車種・グレード・初度登録日を書き、VIN を書かない', async () => {
    const r = await submit({
      ...COMMON, car_type: 'other_ev', car_model: 'nissan_ariya', grade_mode: 'pick', grade: 'B6',
      first_reg_year: '2023', first_reg_month: '4', src: 'greeting',
    });
    expect(r.status).toBe(200);
    expect(callTo('getVehicleSpecs')).toHaveLength(0);

    const row = await leadRow(r.json.data!.leadId);
    expect(row).toMatchObject({
      car_type: 'other_ev', diagnosis_kind: '相場のみ', entry_source: 'greeting', vin: '', is_tesla: 0,
      status: '診断依頼', car_model: 'Nissan ARIYA', grade: 'B6', grade_is_free: 0, first_reg_month: '2023-04',
    });

    const props = notionProps();
    expect(props['診断種別']).toEqual({ select: { name: '相場のみ' } });
    expect(props['[Form]車種名']).toEqual({ select: { name: 'Nissan ARIYA' } });
    expect(props['[Form]グレード'].rich_text[0].text.content).toBe('B6');
    expect(props['[Form]初度登録日']).toEqual({ date: { start: '2023-04-01' } });
    expect(props['車台番号・VIN（車検証）']).toBeUndefined();

    expect(slackText()).toContain('診断種別: `相場のみ`');
    expect(slackText()).toContain('車種: `Nissan ARIYA`');
    expect(lineText()).toContain('愛車相場レポートは、1営業日以内');
    expect(lineText()).not.toContain('劣化診断');
  });

  it('自由入力のグレードは印を付けて保存し、空欄では送信できない', async () => {
    const base = { ...COMMON, car_type: 'other_ev', car_model: 'mb_eqssuv', first_reg_year: '2024', first_reg_month: '不明' };
    const empty = await submit({ ...base, grade_mode: 'free', grade: '' });
    expect(empty.status).toBe(400);
    expect(empty.json.error).toContain('グレード');

    const ok = await submit({ ...base, grade_mode: 'free', grade: 'Z FWD' });
    expect(ok.status).toBe(200);
    expect(await leadRow(ok.json.data!.leadId)).toMatchObject({ grade: 'Z FWD', grade_is_free: 1, first_reg_month: null, first_reg_raw: '2024 / 不明' });
    const props = notionProps();
    expect(props['[Form]グレード'].rich_text[0].text.content).toBe('Z FWD（自由入力）');
    expect(props['[Form]初度登録日']).toBeUndefined();
  });

  it('候補に無いグレードを pick で送っても受け付けない（候補表が正）', async () => {
    const r = await submit({
      ...COMMON, car_type: 'other_ev', car_model: 'nissan_ariya', grade_mode: 'pick', grade: 'でたらめ',
      first_reg_year: '2023', first_reg_month: '4',
    });
    expect(r.status).toBe(400);
  });

  it('Model 3 で「車台番号がわからない」を選ぶとルートB（相場のみ）になる', async () => {
    const r = await submit({
      ...COMMON, car_type: 'tesla_m3', no_vin: true, car_model: 'tesla_model3', grade_mode: 'unknown',
      first_reg_year: '不明', first_reg_month: '不明',
    });
    expect(r.status).toBe(200);
    expect(callTo('getVehicleSpecs')).toHaveLength(0);
    expect(await leadRow(r.json.data!.leadId)).toMatchObject({ car_type: 'tesla_m3', diagnosis_kind: '相場のみ', vin: '', grade: null });
    expect(slackText()).toContain('車台番号不明のため相場のみ');
  });

  it('次回車検は必須（キー項目）。「わからない」や空では送信できない', async () => {
    const base = { ...COMMON, car_type: 'other_ev', car_model: 'unknown', grade_mode: 'unknown', first_reg_year: '不明', first_reg_month: '不明' };
    for (const shaken of ['unknown', '']) {
      const r = await submit({ ...base, shaken_month: shaken });
      expect(r.status).toBe(400);
      expect(r.json.error).toContain('次回車検');
    }
    const ok = await submit(base);
    expect(ok.status).toBe(200);
    expect(notionProps()['次回車検']).toEqual({ date: { start: '2027-08-01' } });
  });

  it('VIN が空のルートB同士は「重複」と判定しない', async () => {
    const base = { car_type: 'other_ev', car_model: 'bmw_i4', grade_mode: 'unknown', first_reg_year: '2022', first_reg_month: '1' };
    await submit({ ...COMMON, ...base, email: 'a@example.com', phone: '09011111111', line_user_id: 'U-a' });
    calls = [];
    await submit({ ...COMMON, ...base, email: 'b@example.com', phone: '09022222222', line_user_id: 'U-b' });
    expect(slackText()).not.toContain('重複エントリー');
  });

  it('後追いバックフィルの対象条件にルートBの行は入らない', async () => {
    await submit({
      ...COMMON, car_type: 'tesla_other', car_model: 'tesla_modelx', grade_mode: 'pick', grade: 'Plaid',
      first_reg_year: '2021', first_reg_month: '6',
    });
    const picked = await testDb
      .prepare(`SELECT COUNT(*) AS n FROM diagnosis_leads WHERE status = 'API取得不可' AND is_tesla = 1 AND spec_json IS NULL`)
      .first<{ n: number }>();
    expect(picked?.n).toBe(0);
  });
});

describe('流入タグ', () => {
  it('決めた 3 種以外の src は保存しない', async () => {
    const r = await submit({ ...COMMON, car_type: 'tesla_my', vin: '5YJ3E7EB0MF000003', src: '<script>' });
    expect(await leadRow(r.json.data!.leadId)).toMatchObject({ entry_source: null });
    expect(notionProps()['流入タグ']).toBeUndefined();
  });
});

describe('フォーム画面', () => {
  it('統合フォームの見出しと車種候補を出し、旧イントロ演出を出さない', async () => {
    const res = await diagnosisForm.request('/diagnosis-form', {}, ENV);
    const html = await res.text();
    expect(html).toContain('愛車相場チェック・Battery劣化診断');
    expect(html).toContain('車台番号がわからない方はこちら');
    expect(html).toContain('"notionName":"Nissan SAKURA"');
    expect(html).not.toContain('diagnosis-hero.mp4');
  });
});

describe('車種候補表', () => {
  it('LP の車種と、運用で指定した車種がすべて入っている', () => {
    const labels = SOUBA_CAR_GROUPS.flatMap((g) => g.models.map((m) => m.label));
    const lp = ['Model 3', 'Model Y', 'Model S', 'Model X', 'サクラ', 'アリア', 'リーフ', 'bZ4X', 'ソルテラ', 'IONIQ 5', 'ID.4', 'EQA', 'EQB', 'i4', 'ATTO 3', 'Taycan', '輸入EV（その他）', '国産EV（その他）', 'わからない'];
    const added = ['EQE', 'EQS', 'i5', 'iX', 'iX3', 'DOLPHIN', 'SEAL', 'SEALION 7', 'N-VAN e:', 'N-ONE e:', 'Model Y L（6人乗り）', 'bZ4X Touring', 'EQE SUV', 'EQS SUV', 'i5 ツーリング'];
    for (const name of [...lp, ...added]) expect(labels).toContain(name);
  });

  it('プラグインハイブリッドは載せない（フォームの対象は電気自動車）', () => {
    const labels = SOUBA_CAR_GROUPS.flatMap((g) => g.models.map((m) => m.label));
    expect(labels.some((l) => l.includes('SEALION 6'))).toBe(false);
  });

  it('同じ車種の中でグレード候補が重複していない', () => {
    for (const m of SOUBA_CAR_GROUPS.flatMap((g) => g.models)) {
      expect(new Set(m.grades).size, m.label).toBe(m.grades.length);
    }
  });

  it('id と Notion 名に重複が無い', () => {
    const models = SOUBA_CAR_GROUPS.flatMap((g) => g.models);
    expect(new Set(models.map((m) => m.id)).size).toBe(models.length);
    expect(new Set(models.map((m) => m.notionName)).size).toBe(models.length);
  });
});

describe('Notion 起票プロパティ', () => {
  it('UTM が無ければ流入(UTM)を書かない', () => {
    const props = buildLeadRowProps({
      leadId: 'x', name: 'n', email: 'e@example.com', phone: '0900', vin: '', odometerKm: 1,
      shakenMonth: '2027-01', consentedAt: '2026-09-17T00:00:00Z', status: '診断依頼',
    });
    expect(props['流入(UTM)']).toBeUndefined();
  });
});
