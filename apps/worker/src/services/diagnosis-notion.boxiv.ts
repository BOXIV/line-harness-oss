// BOXIV-only: 愛車相場チェック・バッテリー劣化診断リードを Notion「出品者リードリスト」へ起票する。
// DB は出品者リストのコピーから診断用に整理済み（依頼ID/診断ステータス/劣化率(%) 等を追加）。
// 呼び出し元: routes/diagnosis-form.boxiv.ts（非致命 — 失敗しても送信自体は成功させる）と
// services/diagnosis-spec-backfill.boxiv.ts（後追いで spec を取得できた行の追記）。

const NOTION_API = 'https://api.notion.com/v1';

export type DiagnosisNotionEnv = {
  NOTION_API_KEY?: string;
  DIAGNOSIS_NOTION_DB_ID?: string;
};

export type DiagnosisLeadInput = {
  leadId: string;
  name: string;
  email: string;
  phone: string;
  vin: string; // ルートB は空文字
  odometerKm: number;
  shakenMonth: string; // YYYY-MM（必須）
  consentedAt: string; // ISO8601
  status: string; // 診断依頼 | API取得不可 | 非テスラ
  diagnosisKind?: string | null; // 劣化診断 | 相場のみ
  entrySource?: string | null; // richmenu | greeting | ad_souba
  // ルートB の入力値。ルートA では spec 側（model/trim）が優先される
  carModelName?: string | null; // [Form]車種名 に書く名前（例: Nissan SAKURA）
  grade?: string | null;
  gradeIsFree?: boolean;
  firstRegMonth?: string | null; // YYYY-MM
  lineUserId?: string | null;
  displayName?: string | null;
  utm?: string | null;
  model?: string | null;
  trim?: string | null;
  modelYear?: number | null;
  typeOfDrive?: string | null;
  batterySoH?: number | null;
  degradationPct?: number | null;
  batteryCapacityKwh?: number | null;
  msrp?: number | null;
  specJson?: string | null;
};

// spec_API の model 略称 → Notion「[Form]車種名」select の名称
const MODEL_NAMES: Record<string, string> = {
  my: 'Tesla Model Y',
  m3: 'Tesla Model 3',
  ms: 'Tesla Model S',
  mx: 'Tesla Model X',
};

export function specModelName(model: string | null | undefined): string | null {
  return model ? MODEL_NAMES[model.toLowerCase()] ?? model : null;
}

function rt(content: string) {
  return { rich_text: [{ text: { content: content.slice(0, 1900) } }] };
}

// spec_API 由来のプロパティ。起票時（createDiagnosisLeadRow）と
// 後追い補完時（updateDiagnosisLeadSpec）で同じマッピングを使い、両者がずれないようにする。
// 値が無いものは props に載せない（Notion 側の既存値を空で上書きしないため）。
function buildSpecProps(input: DiagnosisSpecFields): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const modelName = specModelName(input.model);
  if (modelName) props['[Form]車種名'] = { select: { name: modelName } };
  if (input.modelYear != null) props['[App]年式'] = { number: input.modelYear };
  if (input.trim) props['[Form]グレード'] = rt(input.trim);
  if (input.typeOfDrive) props['駆動'] = rt(input.typeOfDrive);
  if (input.batterySoH != null) props['バッテリーSoH(%)'] = { number: input.batterySoH };
  if (input.degradationPct != null) props['劣化率(%)'] = { number: input.degradationPct };
  if (input.batteryCapacityKwh != null) props['充電容量(kWh)'] = { number: input.batteryCapacityKwh };
  if (input.msrp != null) props['新車価格(MSRP)'] = { number: input.msrp };
  if (input.specJson) props['[App]vehicle_spec'] = rt(input.specJson);
  return props;
}

export type DiagnosisSpecFields = Pick<
  DiagnosisLeadInput,
  | 'model'
  | 'trim'
  | 'modelYear'
  | 'typeOfDrive'
  | 'batterySoH'
  | 'degradationPct'
  | 'batteryCapacityKwh'
  | 'msrp'
  | 'specJson'
>;

// 後追いバックフィルで spec を取得できた行に追記する（診断ステータスも 診断依頼 に戻す）。
// 起票時に Notion 側だけ空のまま取り残される不整合を防ぐのが目的。
export async function updateDiagnosisLeadSpec(
  env: DiagnosisNotionEnv,
  pageId: string,
  input: DiagnosisSpecFields & { status?: string }
): Promise<boolean> {
  if (!env.NOTION_API_KEY || !pageId) return false;

  const props = buildSpecProps(input);
  if (input.status) props['診断ステータス'] = { select: { name: input.status } };
  if (Object.keys(props).length === 0) return false;

  const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${env.NOTION_API_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ properties: props }),
  });
  if (!res.ok) {
    console.error('diagnosis-notion: update failed', pageId, res.status, await res.text());
    return false;
  }
  return true;
}

// 起票時のプロパティ一式。テストが Notion に送る形を直接確かめられるよう関数に分けている。
export function buildLeadRowProps(input: DiagnosisLeadInput): Record<string, unknown> {
  const props: Record<string, unknown> = {
    名前: { title: [{ text: { content: input.name } }] },
    依頼ID: rt(input.leadId),
    '[Form]メールアドレス': { email: input.email },
    '[Form]電話番号': { phone_number: input.phone },
    '[Form]走行距離': { number: input.odometerKm },
    次回車検: { date: { start: `${input.shakenMonth}-01` } },
    同意日時: { date: { start: input.consentedAt } },
    診断ステータス: { select: { name: input.status } },
  };
  if (input.vin) props['車台番号・VIN（車検証）'] = rt(input.vin);
  if (input.diagnosisKind) props['診断種別'] = { select: { name: input.diagnosisKind } };
  if (input.entrySource) props['流入タグ'] = { select: { name: input.entrySource } };
  if (input.lineUserId) props['LINE User ID'] = rt(input.lineUserId);
  if (input.utm) props['流入(UTM)'] = rt(input.utm);

  // ルートB の入力値（ルートA は下の spec 由来が上書きする）
  if (input.carModelName) props['[Form]車種名'] = { select: { name: input.carModelName } };
  if (input.grade) {
    // 候補から選んだか自由入力かを、相場算定の担当者が見分けられるようにする
    props['[Form]グレード'] = rt(input.gradeIsFree ? `${input.grade}（自由入力）` : input.grade);
  }
  if (input.firstRegMonth) props['[Form]初度登録日'] = { date: { start: `${input.firstRegMonth}-01` } };

  Object.assign(props, buildSpecProps(input));
  return props;
}

export async function createDiagnosisLeadRow(
  env: DiagnosisNotionEnv,
  input: DiagnosisLeadInput
): Promise<string | null> {
  if (!env.NOTION_API_KEY || !env.DIAGNOSIS_NOTION_DB_ID) return null;

  const res = await fetch(`${NOTION_API}/pages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.NOTION_API_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      parent: { database_id: env.DIAGNOSIS_NOTION_DB_ID },
      properties: buildLeadRowProps(input),
    }),
  });
  if (!res.ok) {
    console.error('diagnosis-notion: create failed', res.status, await res.text());
    return null;
  }
  const page = (await res.json()) as { id: string };
  return page.id;
}
