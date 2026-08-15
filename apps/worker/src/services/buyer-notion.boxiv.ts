// BOXIV-only: 購入者リスト(Notion) への書き込み。
//
// ⚠️ 出品者リストと違い、購入者リストは「リード台帳」ではなく **取引管理DB** で、
// 担当者・契約日・粗利・陸送情報などの運用データが入り、既に人手/AI運用で
// 購入エントリーが起票されている（`エントリー情報` に「通知タイプ：購入エントリー」）。
// そのため本モジュールは:
//   - **既存プロパティに書く**（新設は match_key / LINE User ID / 連携ステータス の3つだけ）
//   - **運用が所有する項目は触らない**（ステータス / 商談ID / 認知経路 / 支払い方法 /
//     取引形態 / 納車日 など。誤って運用値を壊さないため）
//   - **重複行を作らない**（match_key → LINE User ID → メール+掲載ID の順で既存行を探し、
//     見つかれば PATCH。無いときだけ新規作成）
//
// フローは出品者と同じ2段:
//   1. 購入エントリー送信時点で起票/更新（未連携・match_key キー）
//   2. LINE 連携で lineUserId / 連携ステータス を PATCH
//
// 必要 env: NOTION_API_KEY, NOTION_BUYER_DB_ID

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export interface BuyerNotionEnv {
  NOTION_API_KEY?: string;
  NOTION_BUYER_DB_ID?: string;
  NOTION_BUYER_MATCH_KEY_PROP?: string;        // default 'match_key'（新設）
  NOTION_BUYER_LINE_USER_ID_PROP?: string;     // default 'LINE User ID'（新設）
  NOTION_BUYER_LINK_STATUS_PROP?: string;      // default '連携ステータス'（新設）
  NOTION_BUYER_LINK_STATUS_UNLINKED?: string;  // default '1_フォーム入力'
  NOTION_BUYER_LINK_STATUS_LINKED?: string;    // default '3_連携済'
  NOTION_BUYER_TITLE_PROP?: string;            // default '名前'
  NOTION_BUYER_PHONE_PROP?: string;            // default '電話番号'
  NOTION_BUYER_EMAIL_PROP?: string;            // default 'メールアドレス'
  NOTION_BUYER_MEMO_PROP?: string;             // default 'エントリー情報'
  NOTION_BUYER_ADDRESS_PROP?: string;          // default '住所'
  NOTION_BUYER_PREFECTURE_PROP?: string;       // default '都道府県'
  NOTION_BUYER_ZIP_PROP?: string;              // default '郵便番号'
  NOTION_BUYER_VEHICLE_PROP?: string;          // default '車両'
  NOTION_BUYER_DEAL_ID_PROP?: string;          // default '商談ID'（読み取り専用。照合にのみ使う）
}

interface Cfg {
  apiKey: string;
  dbId: string;
  matchKeyProp: string;
  lineUserIdProp: string;
  linkStatusProp: string;
  linkStatusUnlinked: string;
  linkStatusLinked: string;
  titleProp: string;
  phoneProp: string;
  emailProp: string;
  memoProp: string;
  addressProp: string;
  prefectureProp: string;
  zipProp: string;
  vehicleProp: string;
  dealIdProp: string;
}

export function notionBuyerConfig(env: BuyerNotionEnv): Cfg | null {
  const dbId = env.NOTION_BUYER_DB_ID;
  if (!env.NOTION_API_KEY || !dbId) return null;
  return {
    apiKey: env.NOTION_API_KEY,
    dbId,
    matchKeyProp: env.NOTION_BUYER_MATCH_KEY_PROP || 'match_key',
    lineUserIdProp: env.NOTION_BUYER_LINE_USER_ID_PROP || 'LINE User ID',
    linkStatusProp: env.NOTION_BUYER_LINK_STATUS_PROP || '連携ステータス',
    linkStatusUnlinked: env.NOTION_BUYER_LINK_STATUS_UNLINKED || '1_フォーム入力',
    linkStatusLinked: env.NOTION_BUYER_LINK_STATUS_LINKED || '3_連携済',
    titleProp: env.NOTION_BUYER_TITLE_PROP || '名前',
    phoneProp: env.NOTION_BUYER_PHONE_PROP || '電話番号',
    emailProp: env.NOTION_BUYER_EMAIL_PROP || 'メールアドレス',
    memoProp: env.NOTION_BUYER_MEMO_PROP || 'エントリー情報',
    addressProp: env.NOTION_BUYER_ADDRESS_PROP || '住所',
    prefectureProp: env.NOTION_BUYER_PREFECTURE_PROP || '都道府県',
    zipProp: env.NOTION_BUYER_ZIP_PROP || '郵便番号',
    vehicleProp: env.NOTION_BUYER_VEHICLE_PROP || '車両',
    dealIdProp: env.NOTION_BUYER_DEAL_ID_PROP || '商談ID',
  };
}

async function notionApi(cfg: Cfg, path: string, method: string, body?: unknown): Promise<any> {
  const res = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`Notion ${method} ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

const richText = (v: unknown) => ({ rich_text: [{ type: 'text', text: { content: String(v) } }] });
const title = (v: unknown) => ({ title: [{ type: 'text', text: { content: String(v) } }] });

// ─── 購入エントリー値の正規化 ────────────────────────────────────

/** 「希望ナンバー」「車庫証明取得代行」は select（有り / 無し / 不明）。チェック状態を寄せる。 */
function toAriNashi(v: unknown): '有り' | '無し' {
  if (typeof v === 'boolean') return v ? '有り' : '無し';
  const s = String(v ?? '').trim();
  if (!s) return '無し';
  return /^(off|false|0|いいえ|不要|なし|無し|無)$/i.test(s) ? '無し' : '有り';
}

/** 「〇〇県」で始まる自由入力から都道府県だけを取り出す（フォームは自由入力）。 */
const PREFS = ['北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県','茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県','新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県','静岡県','愛知県','三重県','滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県','鳥取県','島根県','岡山県','広島県','山口県','徳島県','香川県','愛媛県','高知県','福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県'];
function normalizePrefecture(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const hit = PREFS.find((p) => s.startsWith(p) || s.startsWith(p.replace(/[都道府県]$/, '')));
  return hit ?? null;
}

/**
 * フォームの select 値 → Notion の select 値。**表記が微妙に違う**ので明示的に対応表を持つ
 * （実測: フォーム `AIのオススメ` / Notion `AIのおすすめ`、フォーム `YouTube広告` / Notion `Youtube広告` 等）。
 * 対応表に無い値は書かず備考へ回す。Notion の select は未知の値を渡すと**選択肢自体が増えてしまい**、
 * 運用中のDBに near-duplicate なオプションを作ってしまうため。
 */
const PAYMENT_MAP: Record<string, string> = {
  'ローン (オリコ)': 'BOXIV：オリコ',
  '銀行系ローン': '他社：ローン',
  '現金': '現金',
};
const CHANNEL_MAP: Record<string, string> = {
  '僕テス(YouTube)': '僕テス（youtube）',
  '僕テス(Xの投稿)': '僕テス(Xの投稿)',
  'Google検索': 'Google検索',
  'X広告': 'X広告',
  'Facebook広告': 'Facebook広告',
  'Instagram広告': 'Instagram広告',
  'YouTube広告': 'Youtube広告',
  'テスカスフォーラム': 'テスカスフォーラム',
  'Webメディア': 'Webメディア',
  '知り合いの口コミ': '知り合いの口コミ',
  'テスラストアのセールスマン': 'テスラストアのセールスマン',
  'EVイベント/展示会': 'EVイベント/展示会',
  'AIのオススメ': 'AIのおすすめ',
  'それ以外': 'それ以外',
};

/** フォームのフィールド名（input の name 属性。**表示ラベルとは別物**）。実フォームで実測した値。 */
const F = {
  name: 'お名前',
  kana: 'カタカナ',
  phone: '電話番号',
  email: 'メールアドレス',
  zip: '郵便番号',
  address: 'ご住所',
  prefecture: '都道府県',       // 納車先の都道府県
  city: '市町村区',
  plateWanted: '希望ナンバー有無',
  plateNo: '希望ナンバー',
  etc: 'ETC再セットアップ',
  garageCert: '車庫証明取得代行',
  arcAid: 'ArcAid相談希望',
  shopWanted: 'BOXIV shop 購入希望',
  shopItems: 'BOXIV shop 購入希望商品',
  payment: 'お支払い方法',
  channel: 'サービスを知ったきっかけ',
  listingId: '掲載ID',
  consent: '同意ボタン',
} as const;

/**
 * 既存行の `エントリー情報` と同じ体裁でエントリー内容を1つのテキストにまとめる。
 * 専用プロパティに載らない項目はここに集約するので、フォームに項目が増えても値が落ちない。
 */
function buildEntryInfo(fields: Record<string, unknown>, listingId: string | null, vehicle: string | null): string {
  const lines: string[] = ['通知タイプ：購入エントリー'];
  if (listingId) lines.push(`掲載ID：${listingId}`);
  if (vehicle) lines.push(`車両：${vehicle}`);
  const push = (label: string, key: string) => {
    const v = fields[key];
    if (v !== null && v !== undefined && String(v).trim() !== '') lines.push(`${label}：${String(v).trim()}`);
  };
  push('納車する都道府県', F.prefecture);
  push('納車する市町村区', F.city);
  if (F.plateWanted in fields) lines.push(`希望ナンバー有無：${toAriNashi(fields[F.plateWanted]) === '有り' ? 'あり' : 'なし'}`);
  push('希望ナンバー', F.plateNo);
  if (F.etc in fields) lines.push(`ETC再セットアップ：${toAriNashi(fields[F.etc])}`);
  if (F.garageCert in fields) lines.push(`車庫証明取得代行：${toAriNashi(fields[F.garageCert])}`);
  if (F.arcAid in fields) lines.push(`テスラ専用保険の相談：${toAriNashi(fields[F.arcAid])}`);
  if (F.shopWanted in fields) lines.push(`BOXIV shop 購入希望：${toAriNashi(fields[F.shopWanted])}`);
  push('BOXIV shop 希望商品', F.shopItems);
  push('お支払い方法', F.payment);
  push('認知経路', F.channel);
  push('お名前(カナ)', F.kana);

  // 上記で拾えなかった項目も落とさず末尾に足す（フォームの項目追加に追従するため）。
  // 旧フィールド名も念のため既知扱いにして二重掲載を防ぐ。
  const KNOWN = new Set<string>([
    'match_key', 'Match Key', '利用規約', '車両',
    F.name, F.kana, F.phone, F.email, F.zip, F.address, F.prefecture, F.city,
    F.plateWanted, F.plateNo, F.etc, F.garageCert, F.arcAid, F.shopWanted, F.shopItems,
    F.payment, F.channel, F.listingId, F.consent,
    // 旧名（フォーム改訂前）
    'お名前 (漢字)', 'お名前 (カナ)', '納車先の指定', '土日祝日納車', 'BOXIV shop 20%オフ',
  ]);
  for (const [label, raw] of Object.entries(fields)) {
    if (KNOWN.has(label)) continue;
    if (raw === null || raw === undefined || String(raw).trim() === '') continue;
    lines.push(`${label}：${String(raw).trim()}`);
  }
  return lines.join('\n');
}

/**
 * 購入エントリー → 購入者リストの既存プロパティ。
 * 運用が所有する項目（ステータス / 商談ID / 認知経路 / 支払い方法 / 取引形態 / 納車日 等）は
 * 意図的に書かない。誤って進行中の取引データを上書きしないため。
 */
function buildBuyerProps(
  formData: Record<string, unknown>,
  input: { name?: string | null; phone?: string | null; email?: string | null; zip?: string | null; listingId?: string | null; vehicle?: string | null },
  cfg: Cfg,
): Record<string, unknown> {
  const fields = formData || {};
  const props: Record<string, unknown> = {};
  const pick = (k: string): string | null => {
    const v = fields[k];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };

  if (input.phone) props[cfg.phoneProp] = { phone_number: input.phone };
  if (input.email) props[cfg.emailProp] = { email: input.email };
  if (input.zip) props[cfg.zipProp] = richText(input.zip);

  const address = pick(F.address);
  if (address) props[cfg.addressProp] = richText(address);

  // 都道府県は「納車先の都道府県」を入れる（既存行もその運用）。判別できなければ住所から拾う。
  const pref = normalizePrefecture(fields[F.prefecture]) ?? normalizePrefecture(address);
  if (pref) props[cfg.prefectureProp] = richText(pref);

  // 掲載ID + 車両サマリ。掲載IDを含めておくと Notion 上で車両が一意に辿れる。
  const vehicleText = [input.listingId, input.vehicle].filter(Boolean).join(' ');
  if (vehicleText) props[cfg.vehicleProp] = richText(vehicleText);

  // 有り/無し の select 群。チェックボックスの状態を寄せる。
  if (F.plateWanted in fields) props['希望ナンバー'] = { select: { name: toAriNashi(fields[F.plateWanted]) } };
  const plateNo = pick(F.plateNo);
  if (plateNo && !/^(on|true|1|有り|あり)$/i.test(plateNo)) props['希望ナンバー 番号'] = richText(plateNo);
  if (F.garageCert in fields) props['車庫証明取得代行'] = { select: { name: toAriNashi(fields[F.garageCert]) } };
  if (F.etc in fields) props['ETCセットアップ'] = { select: { name: toAriNashi(fields[F.etc]) } };

  // 表記が違う select は対応表で正規化し、**既知の値に解決できたときだけ**書く。
  // 未知の値を渡すと Notion が選択肢を新規作成してしまい、運用中のDBを汚すため。
  const payment = PAYMENT_MAP[pick(F.payment) ?? ''];
  if (payment) props['支払い方法'] = { select: { name: payment } };
  const channel = CHANNEL_MAP[pick(F.channel) ?? ''];
  if (channel) props['認知経路'] = { select: { name: channel } };

  props[cfg.memoProp] = richText(buildEntryInfo(fields, input.listingId ?? null, input.vehicle ?? null));
  return props;
}

// ─── 既存行の探索（重複行を作らないための照合） ─────────────────

async function queryPageId(cfg: Cfg, filter: Record<string, unknown>): Promise<string | null> {
  try {
    const q = await notionApi(cfg, `/databases/${cfg.dbId}/query`, 'POST', { filter, page_size: 1 });
    return q.results?.[0]?.id || null;
  } catch {
    return null;
  }
}

const byRichText = (prop: string, value: string) => ({ property: prop, rich_text: { equals: value } });

/**
 * この購入エントリーに対応する既存行を探す。
 *   1. match_key（この経路で起票済み）
 *   2. LINE User ID（連携済みの既存行）
 *   3. メールアドレス ＋ 商談ID が `{掲載ID}-` で始まる
 *      … 人手/AI 運用が先に起票した行を拾う（購入者リストは取引管理DBで既存運用がある）。
 *      掲載ID が無いときは車両を特定できないので email 単独では引き当てない（別車両の取引に
 *      誤って紐付けるのを防ぐ）。
 */
async function findExistingPage(
  cfg: Cfg,
  keys: { matchKey?: string | null; lineUserId?: string | null; email?: string | null; listingId?: string | null },
): Promise<string | null> {
  if (keys.matchKey) {
    const hit = await queryPageId(cfg, byRichText(cfg.matchKeyProp, keys.matchKey));
    if (hit) return hit;
  }
  if (keys.lineUserId) {
    const hit = await queryPageId(cfg, byRichText(cfg.lineUserIdProp, keys.lineUserId));
    if (hit) return hit;
  }
  if (keys.email && keys.listingId) {
    const hit = await queryPageId(cfg, {
      and: [
        { property: cfg.emailProp, email: { equals: keys.email } },
        { property: cfg.dealIdProp, rich_text: { starts_with: `${keys.listingId}-` } },
      ],
    });
    if (hit) return hit;
  }
  return null;
}

export interface CreateBuyerInput {
  matchKey: string;
  formData: Record<string, unknown>;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  zip?: string | null;
  /** エントリー対象車両の掲載ID（/car/details/{掲載ID} 由来） */
  listingId?: string | null;
  /** 車両サマリ（メーカー 車種 グレード 年式） */
  vehicle?: string | null;
}

/**
 * 購入エントリー送信時の起票/更新。既存行があれば PATCH、無ければ新規作成（未連携）。
 * 返り値: Notion pageId（失敗・未設定なら null）。
 */
export async function createOrUpdateBuyerRow(env: BuyerNotionEnv, input: CreateBuyerInput): Promise<string | null> {
  const cfg = notionBuyerConfig(env);
  if (!cfg) return null;
  const props = buildBuyerProps(input.formData, input, cfg);

  const existing = await findExistingPage(cfg, {
    matchKey: input.matchKey,
    email: input.email,
    listingId: input.listingId,
  });
  if (existing) {
    // 既存行には match_key だけ足す（title は運用が付けた値を尊重して上書きしない）。
    await notionApi(cfg, `/pages/${existing}`, 'PATCH', {
      properties: { ...props, [cfg.matchKeyProp]: richText(input.matchKey) },
    });
    return existing;
  }

  const createProps: Record<string, unknown> = { ...props };
  createProps[cfg.matchKeyProp] = richText(input.matchKey);
  createProps[cfg.titleProp] = title(input.name || input.matchKey);
  createProps[cfg.linkStatusProp] = { select: { name: cfg.linkStatusUnlinked } };

  const created = await notionApi(cfg, `/pages`, 'POST', { parent: { database_id: cfg.dbId }, properties: createProps });
  return created.id ?? null;
}

export interface LinkBuyerInput {
  matchKey: string;
  lineUserId: string;
  displayName?: string | null;
  knownPageId?: string | null;
}

/**
 * LINE 連携時に lineUserId / 連携ステータス(連携済) を PATCH する。
 * 運用ステータス（`ステータス `）は購入者リストでは触らない — 選択肢が取引フェーズ
 * （1_問合せ対応中 …）で、連携完了を表す値が無く、進行中の取引を巻き戻してしまうため。
 * 返り値: Notion pageId（失敗・未設定なら null）。
 */
export async function linkBuyerRow(env: BuyerNotionEnv, input: LinkBuyerInput): Promise<string | null> {
  const cfg = notionBuyerConfig(env);
  if (!cfg) return null;

  const pageId = input.knownPageId
    || await findExistingPage(cfg, { matchKey: input.matchKey, lineUserId: input.lineUserId });

  const props: Record<string, unknown> = {
    [cfg.lineUserIdProp]: richText(input.lineUserId),
    [cfg.linkStatusProp]: { select: { name: cfg.linkStatusLinked } },
  };

  if (pageId) {
    await notionApi(cfg, `/pages/${pageId}`, 'PATCH', { properties: props });
    return pageId;
  }

  // orphan link（エントリー送信が無いまま連携された）→ 最小行を作成
  const createProps: Record<string, unknown> = { ...props };
  createProps[cfg.matchKeyProp] = richText(input.matchKey);
  createProps[cfg.titleProp] = title(input.displayName || input.lineUserId);
  const created = await notionApi(cfg, `/pages`, 'POST', { parent: { database_id: cfg.dbId }, properties: createProps });
  return created.id ?? null;
}
