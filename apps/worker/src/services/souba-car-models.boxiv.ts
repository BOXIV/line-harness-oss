// BOXIV-only: 愛車相場チェック（統合フォーム・ルートB）の車種とグレード候補。
//
// フォームの選択肢（routes/diagnosis-form-page.boxiv.ts）とサーバ側の検証
// （routes/diagnosis-form.boxiv.ts）が同じこの表を読む。選択肢を増やすときはここだけ直す。
//
// - 車種は LP（W-LP_愛車相場チェックLP）の車種＋運用で問い合わせが来る車種（2026-09-17 岩木さん指定）
// - notionName は Notion「出品者リードリスト」の [Form]車種名（select）に書く名前。
//   「メーカー 車名」にそろえる（既存の Tesla Model 3 / Nissan ARIYA / Hyundai IONIQ5 / BYD ATTO3 と同じ形）
// - grades は 2026-09-17 にメーカー公式・価格.com・グーネット等で「日本で新車販売された」と確認できた主要グレード。
//   新しい順。限定車・特別仕様車・駆動違い（2WD/4WD）はベースのグレードに含めている。
//   確認できなかったグレードは入れない（フォームには「わからない」「リストにない（入力する）」が常に付く）。
//   空配列の車種はフォームで最初から自由入力欄を出す。
// - プラグインハイブリッド（例: BYD SEALION 6 の日本仕様は DM-i＝PHEV）はフォームの対象（電気自動車）外なので載せない。

export type SoubaCarModel = {
  id: string;
  label: string;
  notionName: string;
  grades: string[];
};

export type SoubaCarGroup = { maker: string; models: SoubaCarModel[] };

const TESLA_SX = ['Plaid', 'ロングレンジ', 'パフォーマンス', 'P100D', '100D', '75D'];

export const SOUBA_CAR_GROUPS: SoubaCarGroup[] = [
  {
    maker: 'テスラ',
    models: [
      // スタンダードレンジプラスは 2022/1 に RWD へ改名。中古車では旧名が多いので両方残す
      { id: 'tesla_model3', label: 'Model 3', notionName: 'Tesla Model 3', grades: ['パフォーマンス', 'ロングレンジ AWD', 'RWD', 'スタンダードレンジプラス'] },
      { id: 'tesla_modely', label: 'Model Y', notionName: 'Tesla Model Y', grades: ['パフォーマンス', 'ロングレンジ AWD', 'RWD'] },
      { id: 'tesla_modelyl', label: 'Model Y L（6人乗り）', notionName: 'Tesla Model Y L', grades: ['Model Y L'] },
      { id: 'tesla_models', label: 'Model S', notionName: 'Tesla Model S', grades: TESLA_SX },
      { id: 'tesla_modelx', label: 'Model X', notionName: 'Tesla Model X', grades: TESLA_SX },
    ],
  },
  {
    maker: '日産',
    models: [
      { id: 'nissan_sakura', label: 'サクラ', notionName: 'Nissan SAKURA', grades: ['G', 'X', 'S'] },
      { id: 'nissan_ariya', label: 'アリア', notionName: 'Nissan ARIYA', grades: ['NISMO B9 e-4ORCE', 'NISMO B6 e-4ORCE', 'B9 e-4ORCE', 'B9', 'B6 e-4ORCE', 'B6'] },
      {
        // 2代目と3代目で G / X が同名なので、世代を名前に付ける
        id: 'nissan_leaf',
        label: 'リーフ',
        notionName: 'Nissan LEAF',
        grades: [
          'B7 G（3代目）', 'B7 X（3代目）', 'B5 G（3代目）', 'B5 X（3代目）', 'B5 S（3代目）', 'AUTECH（3代目）', 'NISMO（3代目）',
          'e+ G（2代目）', 'e+ X（2代目）', 'G（2代目）', 'X（2代目）', 'S（2代目）', 'NISMO（2代目）', 'AUTECH（2代目）',
        ],
      },
    ],
  },
  {
    maker: 'トヨタ',
    models: [
      // 2025/10 の改良で電池容量が変わったが、初度登録年月で見分けられるので Z は分けない
      { id: 'toyota_bz4x', label: 'bZ4X', notionName: 'Toyota bZ4X', grades: ['Z', 'G'] },
      { id: 'toyota_bz4xtouring', label: 'bZ4X Touring', notionName: 'Toyota bZ4X Touring', grades: ['Z'] },
    ],
  },
  { maker: 'スバル', models: [{ id: 'subaru_solterra', label: 'ソルテラ', notionName: 'Subaru SOLTERRA', grades: ['ET-HS', 'ET-SS'] }] },
  {
    maker: 'ホンダ',
    models: [
      { id: 'honda_nvane', label: 'N-VAN e:', notionName: 'Honda N-VAN e:', grades: ['e: L4', 'e: FUN', 'e: L2', 'e: G'] },
      { id: 'honda_nonee', label: 'N-ONE e:', notionName: 'Honda N-ONE e:', grades: ['e: L', 'e: G'] },
    ],
  },
  {
    maker: 'ヒョンデ',
    models: [
      { id: 'hyundai_ioniq5', label: 'IONIQ 5', notionName: 'Hyundai IONIQ5', grades: ['Voyage L', 'Voyage', 'Voyage AWD', 'Lounge', 'Lounge AWD', 'グレード名なし（初期の標準車）', 'IONIQ 5 N'] },
    ],
  },
  {
    maker: 'フォルクスワーゲン',
    models: [{ id: 'vw_id4', label: 'ID.4', notionName: 'Volkswagen ID.4', grades: ['Pro', 'Lite', 'Pro Launch Edition', 'Lite Launch Edition'] }],
  },
  {
    maker: 'メルセデス・ベンツ',
    models: [
      // EQA 350 4MATIC は日本未導入。250 → 250+ は 2024 年の改良での改名
      { id: 'mb_eqa', label: 'EQA', notionName: 'Mercedes-Benz EQA', grades: ['EQA 250+', 'EQA 250'] },
      { id: 'mb_eqb', label: 'EQB', notionName: 'Mercedes-Benz EQB', grades: ['EQB 250+', 'EQB 350 4MATIC', 'EQB 250'] },
      { id: 'mb_eqe', label: 'EQE', notionName: 'Mercedes-Benz EQE', grades: ['EQE 350+', 'AMG EQE 53 4MATIC+'] },
      { id: 'mb_eqesuv', label: 'EQE SUV', notionName: 'Mercedes-Benz EQE SUV', grades: ['EQE 350 4MATIC SUV', 'AMG EQE 53 4MATIC+ SUV'] },
      { id: 'mb_eqs', label: 'EQS', notionName: 'Mercedes-Benz EQS', grades: ['EQS 450+', 'AMG EQS 53 4MATIC+'] },
      // EQS SUV は日本導入（2023/5〜）までは確認できたが、グレード名は未確認のため候補なし
      { id: 'mb_eqssuv', label: 'EQS SUV', notionName: 'Mercedes-Benz EQS SUV', grades: [] },
    ],
  },
  {
    maker: 'BMW',
    models: [
      { id: 'bmw_i4', label: 'i4', notionName: 'BMW i4', grades: ['M60 xDrive', 'eDrive40 M Sport', 'eDrive35 M Sport', 'M50 xDrive', 'eDrive40'] },
      { id: 'bmw_i5', label: 'i5', notionName: 'BMW i5', grades: ['M60 xDrive', 'eDrive40 M Sport', 'eDrive40 Excellence'] },
      { id: 'bmw_i5touring', label: 'i5 ツーリング', notionName: 'BMW i5 Touring', grades: ['M60 xDrive', 'eDrive40 M Sport'] },
      { id: 'bmw_ix', label: 'iX', notionName: 'BMW iX', grades: ['M70 xDrive', 'xDrive60 M Sport', 'M60', 'xDrive50', 'xDrive40'] },
      // 2026/7 発売の新型（ノイエクラッセ）と旧型 G08 で名前が紛らわしいので世代を付ける
      { id: 'bmw_ix3', label: 'iX3', notionName: 'BMW iX3', grades: ['50 xDrive M Sport（新型）', '50 xDrive（新型）', 'M Sport（旧型）'] },
    ],
  },
  {
    maker: 'BYD',
    models: [
      { id: 'byd_atto3', label: 'ATTO 3', notionName: 'BYD ATTO3', grades: ['ATTO 3'] },
      { id: 'byd_dolphin', label: 'DOLPHIN', notionName: 'BYD DOLPHIN', grades: ['Long Range', 'Baseline'] },
      { id: 'byd_seal', label: 'SEAL', notionName: 'BYD SEAL', grades: ['SEAL AWD', 'SEAL'] },
      { id: 'byd_sealion7', label: 'SEALION 7', notionName: 'BYD SEALION7', grades: ['SEALION 7 AWD', 'SEALION 7'] },
    ],
  },
  {
    maker: 'ポルシェ',
    models: [{ id: 'porsche_taycan', label: 'Taycan', notionName: 'PORSCHE Taycan', grades: ['タイカン', 'タイカン4', 'タイカン4S', 'GTS', 'ターボ', 'ターボS', 'ターボGT'] }],
  },
  {
    maker: 'その他',
    models: [
      { id: 'other_import', label: '輸入EV（その他）', notionName: 'その他（輸入EV）', grades: [] },
      { id: 'other_domestic', label: '国産EV（その他）', notionName: 'その他（国産EV）', grades: [] },
      { id: 'unknown', label: 'わからない', notionName: '不明', grades: [] },
    ],
  },
];

const BY_ID = new Map<string, SoubaCarModel>(
  SOUBA_CAR_GROUPS.flatMap((g) => g.models).map((m) => [m.id, m])
);

export function findSoubaCarModel(id: string): SoubaCarModel | null {
  return BY_ID.get(id) ?? null;
}

// お車の種類（フォームの最初の 1 問）。A = 劣化診断つき、B = 相場のみ。
export const CAR_TYPES = {
  tesla_m3: { label: 'Tesla Model 3', route: 'A', modelId: 'tesla_model3' },
  tesla_my: { label: 'Tesla Model Y', route: 'A', modelId: 'tesla_modely' },
  tesla_other: { label: 'その他のテスラ', route: 'B', modelId: null },
  other_ev: { label: 'テスラ以外のEV', route: 'B', modelId: null },
} as const;

export type CarType = keyof typeof CAR_TYPES;

export function isCarType(v: string): v is CarType {
  return Object.prototype.hasOwnProperty.call(CAR_TYPES, v);
}

// 流入タグ。リッチメニュー／友だち追加あいさつのリンクに ?src= で付ける。
export const ENTRY_SOURCES = ['richmenu', 'greeting', 'ad_souba'] as const;
export type EntrySource = (typeof ENTRY_SOURCES)[number];

export function toEntrySource(v: unknown): EntrySource | null {
  const s = String(v ?? '');
  return (ENTRY_SOURCES as readonly string[]).includes(s) ? (s as EntrySource) : null;
}

export const DIAGNOSIS_KIND = { A: '劣化診断', B: '相場のみ' } as const;
