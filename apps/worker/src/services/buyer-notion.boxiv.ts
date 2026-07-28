// BOXIV-only: 購入者リスト(Notion) への書き込み。
// 出品者側 listing-notion.boxiv.ts の購入者版。フローは同じ2段:
//   1. 購入エントリー送信時点で起票（未連携・match_key キー）
//   2. LINE 連携で lineUserId / 連携ステータス を PATCH
//
// 照合キーは match_key。LINE 連携前は lineUserId が無いため、Notion 購入者DB に
// `match_key`(rich_text) / `LINE User ID`(rich_text) / `連携ステータス`(select) を
// 追加しておく必要がある（購入者DBは元々ステータス同期のみで書き込み口が無かった）。
//
// 購入エントリーは車両ごと（/car/details/{掲載ID}#entry）なので、掲載ID と車両サマリを
// 行に残す。同一購入者が複数車両にエントリーした場合は match_key が別なので別行になる。
//
// 必要 env:
//   NOTION_API_KEY, NOTION_BUYER_DB_ID

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export interface BuyerNotionEnv {
  NOTION_API_KEY?: string;
  NOTION_BUYER_DB_ID?: string;
  NOTION_BUYER_MATCH_KEY_PROP?: string;        // default 'match_key'
  NOTION_BUYER_LINE_USER_ID_PROP?: string;     // default 'LINE User ID'
  NOTION_BUYER_TITLE_PROP?: string;            // default '名前'
  NOTION_BUYER_PHONE_PROP?: string;            // default '[Form]電話番号'
  NOTION_BUYER_EMAIL_PROP?: string;            // default '[Form]メールアドレス'
  NOTION_BUYER_MEMO_PROP?: string;             // default 'その他詳細備考'
  NOTION_BUYER_LISTING_ID_PROP?: string;       // default '掲載ID'
  NOTION_BUYER_ZIP_PROP?: string;              // default '郵便番号'
  NOTION_BUYER_STATUS_PROP?: string;           // default 'ステータス'
  NOTION_BUYER_STATUS_VALUE?: string;          // default '0_LINE登録'（連携時に付与）
  NOTION_BUYER_LINK_STATUS_PROP?: string;      // default '連携ステータス'
  NOTION_BUYER_LINK_STATUS_UNLINKED?: string;  // default '1_フォーム入力'
  NOTION_BUYER_LINK_STATUS_LINKED?: string;    // default '3_連携済'
}

interface Cfg {
  apiKey: string;
  dbId: string;
  matchKeyProp: string;
  lineUserIdProp: string;
  titleProp: string;
  phoneProp: string;
  emailProp: string;
  memoProp: string;
  listingIdProp: string;
  zipProp: string;
  statusProp: string;
  statusValue: string;
  linkStatusProp: string;
  linkStatusUnlinked: string;
  linkStatusLinked: string;
}

export function notionBuyerConfig(env: BuyerNotionEnv): Cfg | null {
  const dbId = env.NOTION_BUYER_DB_ID;
  if (!env.NOTION_API_KEY || !dbId) return null;
  return {
    apiKey: env.NOTION_API_KEY,
    dbId,
    matchKeyProp: env.NOTION_BUYER_MATCH_KEY_PROP || 'match_key',
    lineUserIdProp: env.NOTION_BUYER_LINE_USER_ID_PROP || 'LINE User ID',
    titleProp: env.NOTION_BUYER_TITLE_PROP || '名前',
    phoneProp: env.NOTION_BUYER_PHONE_PROP || '[Form]電話番号',
    emailProp: env.NOTION_BUYER_EMAIL_PROP || '[Form]メールアドレス',
    memoProp: env.NOTION_BUYER_MEMO_PROP || 'その他詳細備考',
    listingIdProp: env.NOTION_BUYER_LISTING_ID_PROP || '掲載ID',
    zipProp: env.NOTION_BUYER_ZIP_PROP || '郵便番号',
    statusProp: env.NOTION_BUYER_STATUS_PROP || 'ステータス',
    statusValue: env.NOTION_BUYER_STATUS_VALUE || '0_LINE登録',
    linkStatusProp: env.NOTION_BUYER_LINK_STATUS_PROP || '連携ステータス',
    linkStatusUnlinked: env.NOTION_BUYER_LINK_STATUS_UNLINKED || '1_フォーム入力',
    linkStatusLinked: env.NOTION_BUYER_LINK_STATUS_LINKED || '3_連携済',
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

type NotionType = 'title' | 'select' | 'status' | 'number' | 'date' | 'phone_number' | 'email' | 'rich_text' | 'checkbox';
function notionValue(type: NotionType, value: unknown): unknown {
  if (value === null || value === undefined || value === '') return null;
  switch (type) {
    case 'title': return { title: [{ type: 'text', text: { content: String(value) } }] };
    case 'select': return { select: { name: String(value) } };
    case 'status': return { status: { name: String(value) } };
    case 'number': return { number: Number(value) };
    case 'date': return { date: { start: String(value) } };
    case 'phone_number': return { phone_number: String(value) };
    case 'email': return { email: String(value) };
    case 'checkbox': return { checkbox: Boolean(value) };
    case 'rich_text':
    default: return richText(value);
  }
}

// ─── 購入エントリー値の正規化 ────────────────────────────────────

/** 「〇〇月〇〇日」等の自由入力を ISO 日付にする。年は省略されるので直近の未来日に寄せる。 */
function deliveryDateToIso(v: unknown, baseMs: number): string | null {
  const s = String(v ?? '');
  const iso = s.match(/(\d{4})\D{1,3}(\d{1,2})\D{1,3}(\d{1,2})/);
  if (iso) return `${iso[1]}-${String(Number(iso[2])).padStart(2, '0')}-${String(Number(iso[3])).padStart(2, '0')}`;
  const md = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (!md) return null;
  const month = Number(md[1]);
  const day = Number(md[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const base = new Date(baseMs);
  // 年跨ぎ: 指定月日が既に過ぎているなら翌年扱い（納車希望日は未来日のため）
  const year = month < base.getMonth() + 1 ? base.getFullYear() + 1 : base.getFullYear();
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** チェックボックス系の入力（"希望する" / "on" / true 等）を真偽に寄せる。 */
function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim();
  if (!s) return false;
  return !/^(off|false|0|いいえ|不要|なし|無し|無)$/i.test(s);
}

/** 都道府県 + 市町村区 を1つの納車先文字列にまとめる。 */
function joinDeliveryArea(pref: unknown, city: unknown): string | null {
  const s = [pref, city].map((v) => String(v ?? '').trim()).filter(Boolean).join(' ');
  return s || null;
}

interface FieldMapEntry { prop: string; type: NotionType; xf?: (v: unknown) => unknown }

/**
 * 購入エントリーフォーム（/car/details/{ID}#entry）のラベル → 購入者リストのプロパティ。
 * マップ外のラベルは備考(memoProp)へ集約するので、フォームに項目が増えても値は失われない。
 */
const FIELD_MAP: Record<string, FieldMapEntry> = {
  'お名前 (カナ)': { prop: '[Form]名前(カタカナ)', type: 'rich_text' },
  'ご住所': { prop: '[Form]購入者住所', type: 'rich_text' },
  '希望ナンバー': { prop: '[Form]希望ナンバー', type: 'rich_text' },
  '土日祝日納車': { prop: '[Form]土日祝日納車', type: 'checkbox', xf: toBool },
  '車庫証明取得代行': { prop: '[Form]車庫証明代行', type: 'checkbox', xf: toBool },
  'BOXIV shop 20%オフ': { prop: '[Form]アクセサリー希望', type: 'rich_text' },
};

/** 連絡先・掲載ID・キー類は専用プロパティ側で扱うので備考に流さない。 */
const SKIP_FORM_LABELS = new Set([
  'Match Key', 'match_key', '同意ボタン', '利用規約', '掲載ID', '車両',
  'お名前 (漢字)', 'お名前', '電話番号', 'メールアドレス', '郵便番号',
  '納車先の指定', '市町村区', '納車希望日',
]);

/** 購入エントリー全項目 → 購入者リストのプロパティ。lineUserId は含めない（別途 PATCH）。 */
function buildBuyerProps(
  formData: Record<string, unknown>,
  contact: { phone?: string | null; email?: string | null },
  cfg: Cfg,
  baseMs: number,
): Record<string, unknown> {
  const fields = { ...(formData || {}) };
  const props: Record<string, unknown> = {};
  if (contact.phone) props[cfg.phoneProp] = { phone_number: contact.phone };
  if (contact.email) props[cfg.emailProp] = { email: contact.email };
  const memo: string[] = [];

  // 納車希望日（自由入力なので日付にできなければ備考へ）
  if (fields['納車希望日']) {
    const d = deliveryDateToIso(fields['納車希望日'], baseMs);
    if (d) props['[Form]納車希望日'] = { date: { start: d } };
    else memo.push(`納車希望日: ${fields['納車希望日']}`);
  }

  // 納車先（都道府県 + 市町村区）
  const area = joinDeliveryArea(fields['納車先の指定'], fields['市町村区']);
  if (area) props['[Form]納車先'] = richText(area);

  for (const [label, raw] of Object.entries(fields)) {
    if (raw === null || raw === undefined || raw === '') continue;
    if (SKIP_FORM_LABELS.has(label)) continue;
    const map = FIELD_MAP[label];
    if (map) {
      const val = map.xf ? map.xf(raw) : raw;
      const nv = notionValue(map.type, val);
      if (nv) props[map.prop] = nv;
      else memo.push(`${label}: ${raw}`);
    } else {
      memo.push(`${label}: ${raw}`);
    }
  }

  if (memo.length) props[cfg.memoProp] = richText(memo.join('\n'));
  return props;
}

async function queryPageId(cfg: Cfg, prop: string, value: string): Promise<string | null> {
  try {
    const q = await notionApi(cfg, `/databases/${cfg.dbId}/query`, 'POST', {
      filter: { property: prop, rich_text: { equals: value } }, page_size: 1,
    });
    return q.results?.[0]?.id || null;
  } catch {
    return null;
  }
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
  /** 車両サマリ（メーカー 車種 グレード 年式）。掲載IDと合わせて備考に残す */
  vehicle?: string | null;
}

/**
 * 購入エントリー送信時の起票/更新。match_key で照合し、無ければ新規作成（未連携）。
 * 既存（再送信）の場合はフォーム項目のみ更新し、title/連携状態は保持する。
 * 返り値: Notion pageId（失敗・未設定なら null）。
 */
export async function createOrUpdateBuyerRow(env: BuyerNotionEnv, input: CreateBuyerInput): Promise<string | null> {
  const cfg = notionBuyerConfig(env);
  if (!cfg) return null;
  const props = buildBuyerProps(input.formData, { phone: input.phone, email: input.email }, cfg, Date.now());
  if (input.zip) props[cfg.zipProp] = richText(input.zip);
  if (input.listingId) props[cfg.listingIdProp] = richText(input.listingId);
  if (input.vehicle) props['[Form]希望車両'] = richText(input.vehicle);

  const existing = await queryPageId(cfg, cfg.matchKeyProp, input.matchKey);
  if (existing) {
    await notionApi(cfg, `/pages/${existing}`, 'PATCH', { properties: props });
    return existing;
  }

  const createProps: Record<string, unknown> = { ...props };
  createProps[cfg.matchKeyProp] = richText(input.matchKey);
  createProps[cfg.titleProp] = notionValue('title', input.name || input.matchKey);
  createProps[cfg.linkStatusProp] = notionValue('select', cfg.linkStatusUnlinked);

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
 * LINE 連携時に lineUserId / 連携ステータス(連携済) / 運用ステータス を PATCH する。
 * match_key で引き当て → 無ければ lineUserId で（既存行）→ それも無ければ最小行を作成。
 * 返り値: Notion pageId（失敗・未設定なら null）。
 */
export async function linkBuyerRow(env: BuyerNotionEnv, input: LinkBuyerInput): Promise<string | null> {
  const cfg = notionBuyerConfig(env);
  if (!cfg) return null;

  let pageId = input.knownPageId || null;
  if (!pageId) pageId = await queryPageId(cfg, cfg.matchKeyProp, input.matchKey);
  if (!pageId) pageId = await queryPageId(cfg, cfg.lineUserIdProp, input.lineUserId);

  // 必須 = lineUserId + 連携ステータス(連携済)。運用ステータスは別 PATCH の best-effort
  // （プロパティ名の空白差異・選択肢不一致で失敗しても、連携追記そのものは確定させる）。
  const props: Record<string, unknown> = {
    [cfg.lineUserIdProp]: richText(input.lineUserId),
    [cfg.linkStatusProp]: notionValue('select', cfg.linkStatusLinked),
  };

  async function setOperationalStatus(pid: string): Promise<void> {
    if (!cfg) return;
    const v = notionValue('status', cfg.statusValue);
    if (!v) return;
    try {
      await notionApi(cfg, `/pages/${pid}`, 'PATCH', { properties: { [cfg.statusProp]: v } });
    } catch {
      /* non-fatal: プロパティ名差異等。連携追記は確定済みなので無視 */
    }
  }

  if (pageId) {
    await notionApi(cfg, `/pages/${pageId}`, 'PATCH', { properties: props });
    await setOperationalStatus(pageId);
    return pageId;
  }

  // orphan link（エントリー送信が無いまま連携された）→ 最小行を作成
  const createProps: Record<string, unknown> = { ...props };
  createProps[cfg.matchKeyProp] = richText(input.matchKey);
  createProps[cfg.titleProp] = notionValue('title', input.displayName || input.lineUserId);
  const created = await notionApi(cfg, `/pages`, 'POST', { parent: { database_id: cfg.dbId }, properties: createProps });
  if (created.id) await setOperationalStatus(created.id);
  return created.id ?? null;
}
