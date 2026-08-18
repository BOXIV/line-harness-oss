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
  NOTION_BUYER_CONTACT_MEMO_PROP?: string;     // default 'コンタクトメモ'（上書き履歴を残す）
  NOTION_BUYER_ADDRESS_PROP?: string;          // default '住所'
  NOTION_BUYER_PREFECTURE_PROP?: string;       // default '都道府県'
  NOTION_BUYER_ZIP_PROP?: string;              // default '郵便番号'
  NOTION_BUYER_VEHICLE_PROP?: string;          // default '車両'
  NOTION_BUYER_DEAL_ID_PROP?: string;          // default '商談ID'（読み取り専用。照合にのみ使う）
  NOTION_BUYER_SELLER_RELATION_PROP?: string;  // default '出品者'（出品者リストへの relation）
  NOTION_SELLER_LISTING_ID_PROP?: string;      // default '掲載ID'（出品者リスト側の掲載ID列）
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
  contactMemoProp: string;
  addressProp: string;
  prefectureProp: string;
  zipProp: string;
  vehicleProp: string;
  dealIdProp: string;
  sellerRelationProp: string;
  sellerListingIdProp: string;
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
    contactMemoProp: env.NOTION_BUYER_CONTACT_MEMO_PROP || 'コンタクトメモ',
    addressProp: env.NOTION_BUYER_ADDRESS_PROP || '住所',
    prefectureProp: env.NOTION_BUYER_PREFECTURE_PROP || '都道府県',
    zipProp: env.NOTION_BUYER_ZIP_PROP || '郵便番号',
    vehicleProp: env.NOTION_BUYER_VEHICLE_PROP || '車両',
    dealIdProp: env.NOTION_BUYER_DEAL_ID_PROP || '商談ID',
    sellerRelationProp: env.NOTION_BUYER_SELLER_RELATION_PROP || '出品者',
    sellerListingIdProp: env.NOTION_SELLER_LISTING_ID_PROP || '掲載ID',
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
  desiredPrice: '希望価格',   // 値下げ依頼フォーム
  message: 'Message',        // お問い合わせフォーム
} as const;

/**
 * 既存行の `エントリー情報` と同じ体裁でエントリー内容を1つのテキストにまとめる。
 * 専用プロパティに載らない項目はここに集約するので、フォームに項目が増えても値が落ちない。
 *
 * 値下げ依頼 / お問い合わせは項目が少ないので、既存運用の書式に合わせた最小構成にする
 *   値下げ依頼   … 通知タイプ / 掲載ID / 車両 / 希望価格
 *   お問い合わせ … 通知タイプ / 掲載ID / 車両 / Message：<本文>
 */
function buildEntryInfo(
  fields: Record<string, unknown>,
  listingId: string | null,
  vehicle: string | null,
  entryType: BuyerEntryType,
): string {
  const lines: string[] = [`通知タイプ：${ENTRY_TYPE_LABEL[entryType]}`];
  if (listingId) lines.push(`掲載ID：${listingId}`);
  if (vehicle) lines.push(`車両：${vehicle}`);
  const push = (label: string, key: string) => {
    const v = fields[key];
    if (v !== null && v !== undefined && String(v).trim() !== '') lines.push(`${label}：${String(v).trim()}`);
  };

  if (entryType === 'discount') {
    push('希望価格', F.desiredPrice);
    return lines.join('\n');
  }
  if (entryType === 'inquiry') {
    const msg = String(fields[F.message] ?? '').trim();
    if (msg) lines.push('Message：', msg);
    return lines.join('\n');
  }

  // ── 購入エントリー ──
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
  const KNOWN = new Set<string>([
    'match_key', 'Match Key', '利用規約', '車両',
    F.name, F.kana, F.phone, F.email, F.zip, F.address, F.prefecture, F.city,
    F.plateWanted, F.plateNo, F.etc, F.garageCert, F.arcAid, F.shopWanted, F.shopItems,
    F.payment, F.channel, F.listingId, F.consent, F.desiredPrice, F.message,
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
  entryType: BuyerEntryType,
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

  // ⚠️ 以下のオプション系は**購入エントリーのフォームにしか存在しない**。
  // 値下げ依頼 / お問い合わせで書くと「聞いていないのに 無し」という誤情報になるため、
  // 購入エントリーのときだけ書く。
  if (entryType === 'entry') {
    // チェックが外れたチェックボックスは**フォーム送信に含まれない**（クライアント側の
    // collectFields が unchecked を落とす）。「キーがあるときだけ書く」にすると未チェック時に
    // Notion が空欄のままになる（実際に本番の行が空欄で起票された）。購入エントリーでは
    // これらの項目は必ず存在するので、キーの有無に関わらず 有り/無し を書く（存在しない = 無し）。
    props['希望ナンバー'] = { select: { name: toAriNashi(fields[F.plateWanted]) } };
    props['車庫証明取得代行'] = { select: { name: toAriNashi(fields[F.garageCert]) } };
    props['ETCセットアップ'] = { select: { name: toAriNashi(fields[F.etc]) } };
    const plateNo = pick(F.plateNo);
    if (plateNo && !/^(on|true|1|有り|あり)$/i.test(plateNo)) props['希望ナンバー 番号'] = richText(plateNo);

    // 表記が違う select は対応表で正規化し、**既知の値に解決できたときだけ**書く。
    // 未知の値を渡すと Notion が選択肢を新規作成してしまい、運用中のDBを汚すため。
    const payment = PAYMENT_MAP[pick(F.payment) ?? ''];
    if (payment) props['支払い方法'] = { select: { name: payment } };
    const channel = CHANNEL_MAP[pick(F.channel) ?? ''];
    if (channel) props['認知経路'] = { select: { name: channel } };
  }

  props[cfg.memoProp] = richText(buildEntryInfo(fields, input.listingId ?? null, input.vehicle ?? null, entryType));
  return props;
}

// ─── 商談ID（{掲載ID}-T{エントリー順}）と重複照合 ─────────────

/**
 * 通知タイプの優先度。**低い方を高い方が上書きしてよい**。
 * お問い合わせ(1) < 値下げ依頼(2) < 購入エントリー(3)。
 * 実データに表記ゆれがあるので既知の綴りを全て拾う（不明は 0 = 常に上書きされる側）。
 */
const ENTRY_PRIORITY: Record<string, number> = {
  'お問い合わせ': 1, '問い合わせ': 1, '問合せ': 1, 'クルマのお問い合わせ': 1,
  '値下げ依頼': 2, '値下げ交渉': 2,
  '購入エントリー': 3, '[Garage]購入オファー': 3,
};
/** この writer が扱うフォーム種別。Notion の「通知タイプ」に書く文字列と対応する。 */
export type BuyerEntryType = 'entry' | 'discount' | 'inquiry';
/** 種別 → Notion の通知タイプ表記（既存運用の表記に合わせる）。 */
export const ENTRY_TYPE_LABEL: Record<BuyerEntryType, string> = {
  entry: '購入エントリー',
  discount: '値下げ依頼',
  inquiry: 'クルマのお問い合わせ',
};
/** 後方互換（購入エントリー）。 */
export const BUYER_ENTRY_TYPE = ENTRY_TYPE_LABEL.entry;

function priorityOf(entryInfo: string | null | undefined): number {
  const m = String(entryInfo ?? '').match(/通知タイプ[：:]\s*(.+)/);
  if (!m) return 0;
  const key = m[1].trim().split(/\s/)[0];
  return ENTRY_PRIORITY[key] ?? 0;
}

/**
 * 商談ID をパースする。実データには `10369 -T3` ` 10380-T1` のような**空白混じり**があるため、
 * 空白を全て落としてから判定する（starts_with の Notion フィルタだけでは取りこぼす）。
 */
function parseDealId(v: string | null | undefined): { listingId: string; seq: number } | null {
  const s = String(v ?? '').replace(/\s+/g, '');
  const m = s.match(/^(.+)-T(\d+)$/i);
  return m ? { listingId: m[1], seq: Number(m[2]) } : null;
}

interface NotionRow { id: string; properties: Record<string, any>; }

function plain(prop: any): string {
  if (!prop) return '';
  switch (prop.type) {
    case 'title': return (prop.title || []).map((t: any) => t.plain_text).join('').trim();
    case 'rich_text': return (prop.rich_text || []).map((t: any) => t.plain_text).join('').trim();
    case 'email': return (prop.email || '').trim();
    case 'phone_number': return (prop.phone_number || '').trim();
    default: return '';
  }
}

/**
 * 同じ掲載IDの行を集める。商談ID の空白ゆれで Notion 側 filter が当てにならないので、
 * `contains 掲載ID` で粗く絞ってからクライアント側で厳密に判定する。
 */
async function listRowsForListing(cfg: Cfg, listingId: string): Promise<NotionRow[]> {
  const out: NotionRow[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 5; i++) {
    const body: Record<string, unknown> = {
      filter: { property: cfg.dealIdProp, rich_text: { contains: listingId } },
      page_size: 100,
    };
    if (cursor) body.start_cursor = cursor;
    const q = await notionApi(cfg, `/databases/${cfg.dbId}/query`, 'POST', body);
    out.push(...((q.results || []) as NotionRow[]));
    if (!q.has_more) break;
    cursor = q.next_cursor;
  }
  return out.filter((r) => parseDealId(plain(r.properties[cfg.dealIdProp]))?.listingId === listingId);
}

/** 掲載IDの次の商談ID（既存の最大 T番号 + 1）。既存が無ければ T1。 */
function nextDealId(rows: NotionRow[], cfg: Cfg, listingId: string): string {
  let max = 0;
  for (const r of rows) {
    const d = parseDealId(plain(r.properties[cfg.dealIdProp]));
    if (d && d.seq > max) max = d.seq;
  }
  return `${listingId}-T${max + 1}`;
}

/**
 * 同一人物の判定。掲載IDで絞った行の中から探す。
 * 1人が複数の車にエントリーするため、必ず掲載IDで絞った集合に対してのみ使う。
 *
 * 強度の違う識別子を段階的に使う:
 *   1. LINE User ID 完全一致 … 最も強い。氏名が違っても同一人物とみなす
 *   2. メール一致 … ただし**双方に氏名があって食い違う場合は別人として扱う**。
 *      実データに「同じメールで 今野正利 / 今野遼太」という家族とみられるケースがあり、
 *      メール単独一致で寄せると別人の取引を上書きしてしまうため。
 *   3. 氏名一致（空白差は無視）
 */
function findSamePerson(
  rows: NotionRow[],
  cfg: Cfg,
  who: { lineUserId?: string | null; email?: string | null; name?: string | null },
): NotionRow | null {
  const norm = (v: string | null | undefined) => String(v ?? '').trim().toLowerCase();
  const squash = (v: string | null | undefined) => String(v ?? '').replace(/[\s　]+/g, '');
  const luid = norm(who.lineUserId), mail = norm(who.email), name = squash(who.name);

  if (luid) {
    const hit = rows.find((r) => norm(plain(r.properties[cfg.lineUserIdProp])) === luid);
    if (hit) return hit;
  }
  if (mail) {
    const hit = rows.find((r) => {
      if (norm(plain(r.properties[cfg.emailProp])) !== mail) return false;
      const rowName = squash(plain(r.properties[cfg.titleProp]));
      if (name && rowName && name !== rowName) return false; // 同メール別名義は別人扱い
      return true;
    });
    if (hit) return hit;
  }
  if (name) {
    const hit = rows.find((r) => squash(plain(r.properties[cfg.titleProp])) === name);
    if (hit) return hit;
  }
  return null;
}

/** コンタクトメモへ「いつ上書きしたか」を追記（既存運用の書式 `M/D 内容（担当）`・新しい行が先頭）。 */
function prependContactMemo(existing: string, line: string): string {
  const body = String(existing ?? '').trim();
  return body ? `${line}\n${body}` : line;
}

/** JST の M/D。 */
function jstMonthDay(nowMs: number): string {
  const d = new Date(nowMs + 9 * 60 * 60 * 1000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

// ─── 既存行の探索（重複行を作らないための照合） ─────────────────

async function queryRow(cfg: Cfg, filter: Record<string, unknown>): Promise<NotionRow | null> {
  try {
    const q = await notionApi(cfg, `/databases/${cfg.dbId}/query`, 'POST', { filter, page_size: 1 });
    return (q.results?.[0] as NotionRow) ?? null;
  } catch {
    return null;
  }
}

async function queryPageId(cfg: Cfg, filter: Record<string, unknown>): Promise<string | null> {
  return (await queryRow(cfg, filter))?.id ?? null;
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

// ─── 「出品者」リレーション（購入者リスト → 出品者リスト） ─────────

interface SellerRelation {
  /** 購入者リスト側の relation プロパティ名 */
  prop: string;
  /** リレーション先＝出品者リストの database_id */
  dbId: string;
}

/**
 * リレーション先の DB は **env ではなくリレーション定義から引く**。
 * `NOTION_SELLER_DB_ID` は test では test 用の出品者リストを指すが、(Dev)購入者リストの
 * 「出品者」は**本番の出品者リスト**を向いている。env から引くと別DBのページIDを渡すことになり
 * Notion に弾かれる（relation は対象DBのページしか受け付けない）。
 * スキーマは変わらないので isolate 単位でキャッシュする。
 */
const sellerRelationCache = new Map<string, SellerRelation | null>();

async function resolveSellerRelation(cfg: Cfg): Promise<SellerRelation | null> {
  const cached = sellerRelationCache.get(cfg.dbId);
  if (cached !== undefined) return cached;
  let out: SellerRelation | null = null;
  try {
    const db = await notionApi(cfg, `/databases/${cfg.dbId}`, 'GET');
    const p = db?.properties?.[cfg.sellerRelationProp];
    if (p?.type === 'relation' && p.relation?.database_id) {
      out = { prop: cfg.sellerRelationProp, dbId: p.relation.database_id };
    }
    sellerRelationCache.set(cfg.dbId, out);   // プロパティが無いという結論もキャッシュしてよい
  } catch {
    return null;                              // 一時的な失敗はキャッシュしない（次回引き直す）
  }
  return out;
}

/** 空白を全て落とす。掲載IDには実データで末尾スペースがある（出品者リストに `"10389 "`）。 */
const squashWs = (v: string) => String(v ?? '').replace(/[\s　]+/g, '');

/**
 * 掲載ID に一致する出品者リストの行を引く。
 * 空白ゆれで `equals` が当てにならないので `contains` で粗く絞り、クライアント側で厳密比較する
 * （`contains:'10504'` は `105041` にも当たるため、この絞り込みだけで確定させない）。
 */
async function findSellerPageId(cfg: Cfg, rel: SellerRelation, listingId: string): Promise<string | null> {
  try {
    const q = await notionApi(cfg, `/databases/${rel.dbId}/query`, 'POST', {
      filter: { property: cfg.sellerListingIdProp, rich_text: { contains: listingId } },
      page_size: 50,
    });
    const want = squashWs(listingId);
    const hit = ((q.results || []) as NotionRow[])
      .find((r) => squashWs(plain(r.properties[cfg.sellerListingIdProp])) === want);
    return hit?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * 「出品者」に入れる relation プロパティを組み立てる（該当が無ければ空 = 書かない）。
 *
 * **既に入っている行は触らない。** 運用が手で直した紐付け（再掲載で掲載IDが変わった等）を
 * 機械的に上書きしないため。空欄のときだけ埋める。
 */
async function sellerRelationPatch(
  cfg: Cfg,
  listingId: string,
  existing?: NotionRow | null,
): Promise<Record<string, unknown>> {
  if (!listingId) return {};
  const rel = await resolveSellerRelation(cfg);
  if (!rel) return {};
  if (existing && ((existing.properties?.[rel.prop]?.relation as unknown[]) || []).length) return {};
  const pageId = await findSellerPageId(cfg, rel, listingId);
  return pageId ? { [rel.prop]: { relation: [{ id: pageId }] } } : {};
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
  /** フォーム種別。省略時は購入エントリー（後方互換）。 */
  entryType?: BuyerEntryType;
}

/**
 * 購入エントリー送信時の起票/更新。
 *
 * 購入者リストには**購入エントリー以外**（クルマのお問い合わせ / 値下げ依頼 等）も起票されるため、
 * 作る前に必ず重複を見る。照合は **掲載ID ＋ 同一人物**（LINE User ID / メール / 氏名のいずれか）。
 * 1人が複数の車にエントリーするので、掲載IDで絞った集合の中でのみ人物照合する。
 *
 * 見つかったとき:
 *   - 既存の通知タイプの優先度 <= 購入エントリー(3) なら**上書き**し、コンタクトメモに
 *     「M/D 購入エントリーで上書き（AI）」を追記する（既存運用の書式に合わせ新しい行を先頭へ）。
 *   - 既存の方が優先度が高い場合は上書きしない（現状 購入エントリーが最上位なので通常起きない）。
 *   - 商談ID は**既存の値を維持**する（エントリー順を表す通し番号なので振り直さない）。
 *
 * 見つからないとき: 新規作成し、**商談ID = {掲載ID}-T{既存最大+1}** を採番する。
 *
 * どの経路でも「出品者」リレーションを掲載ID一致の出品者リスト行へ張る（既存運用と同じ紐付け）。
 * 既に入っている行は触らない。
 *
 * 返り値: Notion pageId（失敗・未設定なら null）。
 */
export async function createOrUpdateBuyerRow(env: BuyerNotionEnv, input: CreateBuyerInput): Promise<string | null> {
  const cfg = notionBuyerConfig(env);
  if (!cfg) return null;
  const entryType: BuyerEntryType = input.entryType ?? 'entry';
  const typeLabel = ENTRY_TYPE_LABEL[entryType];
  const myPriority = ENTRY_PRIORITY[typeLabel] ?? 0;
  const props = buildBuyerProps(input.formData, input, cfg, entryType);
  const listingId = (input.listingId ?? '').trim();

  // 1) 自分が過去に起票した行（match_key）は最優先で引き当てる（同一エントリーの再送信）。
  const byMatchKey = await queryRow(cfg, byRichText(cfg.matchKeyProp, input.matchKey));
  if (byMatchKey) {
    await notionApi(cfg, `/pages/${byMatchKey.id}`, 'PATCH', {
      properties: { ...props, ...(await sellerRelationPatch(cfg, listingId, byMatchKey)) },
    });
    return byMatchKey.id;
  }

  // 掲載IDが無いと車両を特定できず、別取引へ誤って紐付ける危険があるので照合も採番もしない。
  if (!listingId) {
    const createProps: Record<string, unknown> = { ...props };
    createProps[cfg.matchKeyProp] = richText(input.matchKey);
    createProps[cfg.titleProp] = title(input.name || input.matchKey);
    createProps[cfg.linkStatusProp] = { select: { name: cfg.linkStatusUnlinked } };
    const created = await notionApi(cfg, `/pages`, 'POST', { parent: { database_id: cfg.dbId }, properties: createProps });
    return created.id ?? null;
  }

  const rows = await listRowsForListing(cfg, listingId);

  // 2) 同じ掲載ID × 同一人物 の既存行（お問い合わせ / 値下げ依頼 で先に起票されている場合を含む）
  const dup = findSamePerson(rows, cfg, { lineUserId: null, email: input.email, name: input.name });
  if (dup) {
    const prevInfo = plain(dup.properties[cfg.memoProp]);
    // 優先度: お問い合わせ(1) < 値下げ依頼(2) < 購入エントリー(3)。
    // 既存の方が上位なら**格下げしない**（例: 購入エントリー済みの人が後から問い合わせても上書きしない）。
    if (priorityOf(prevInfo) > myPriority) {
      // 格下げはしないが、「出品者」が空なら埋めるだけはしておく（追記のみで既存値は壊さない）。
      const relOnly = await sellerRelationPatch(cfg, listingId, dup);
      if (Object.keys(relOnly).length) await notionApi(cfg, `/pages/${dup.id}`, 'PATCH', { properties: relOnly });
      return dup.id;
    }
    const prevType = (String(prevInfo).match(/通知タイプ[：:]\s*(.+)/)?.[1] ?? '').trim().split(/\s/)[0];
    const from = prevType && prevType !== typeLabel ? `${prevType}を` : '';
    const note = `${jstMonthDay(Date.now())} ${from}${typeLabel}で上書き（AI）`;
    await notionApi(cfg, `/pages/${dup.id}`, 'PATCH', {
      properties: {
        ...props,
        ...(await sellerRelationPatch(cfg, listingId, dup)),
        [cfg.matchKeyProp]: richText(input.matchKey),
        [cfg.contactMemoProp]: richText(prependContactMemo(plain(dup.properties[cfg.contactMemoProp]), note)),
      },
    });
    return dup.id;
  }

  // 3) 新規作成。商談ID を採番する（掲載IDごとの通し番号）。
  const createProps: Record<string, unknown> = { ...props };
  createProps[cfg.matchKeyProp] = richText(input.matchKey);
  createProps[cfg.titleProp] = title(input.name || input.matchKey);
  createProps[cfg.linkStatusProp] = { select: { name: cfg.linkStatusUnlinked } };
  createProps[cfg.dealIdProp] = richText(nextDealId(rows, cfg, listingId));
  Object.assign(createProps, await sellerRelationPatch(cfg, listingId));

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
