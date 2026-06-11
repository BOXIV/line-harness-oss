// BOXIV-only: 出品者リスト(Notion) への書き込み。
// 旧 reconcile-daemon（Slack 突合→ペア成立後に起票）の起票ロジックを Worker に移植し、
// 「form_submit 時点で起票（未連携）→ LINE 連携で追記（連携済）」の2段に分割する。
//
// 照合キーは match_key。LINE 連携前は lineUserId が無いため、Notion 出品者DB に
// `match_key`（rich_text）プロパティを追加して同じキーで行を引き当てる。
//
// 必要 env（既定は本番「出品者リスト」スキーマ。test DB 等は *_PROP で上書き）:
//   NOTION_API_KEY, NOTION_SELLER_DB_ID

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export interface ListingNotionEnv {
  NOTION_API_KEY?: string;
  NOTION_SELLER_DB_ID?: string;
  NOTION_DATABASE_ID?: string; // fallback
  NOTION_SELLER_MATCH_KEY_PROP?: string;        // default 'match_key'
  NOTION_SELLER_LINE_USER_ID_PROP?: string;     // default 'LINE User ID'
  NOTION_SELLER_TITLE_PROP?: string;            // default '名前'
  NOTION_SELLER_PHONE_PROP?: string;            // default '[Form]電話番号'
  NOTION_SELLER_EMAIL_PROP?: string;            // default '[Form]メールアドレス'
  NOTION_SELLER_MEMO_PROP?: string;             // default 'その他詳細備考'
  NOTION_SELLER_LISTING_ID_PROP?: string;       // default '掲載ID'
  NOTION_SELLER_ZIP_PROP?: string;              // default '郵便番号'
  NOTION_SELLER_STATUS_PROP?: string;           // default 'ステータス ' (末尾スペース)
  NOTION_SELLER_STATUS_VALUE?: string;          // default '0_LINE登録'（連携時に付与）
  NOTION_SELLER_LINK_STATUS_PROP?: string;      // default '連携ステータス'
  NOTION_SELLER_LINK_STATUS_UNLINKED?: string;  // default '1_フォーム入力'
  NOTION_SELLER_LINK_STATUS_LINKED?: string;    // default '3_連携済'
  NOTION_LISTING_ID_MIN?: string;               // default '10000'
  NOTION_LISTING_ID_MAX?: string;               // default '19999'
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
  listingIdMin: number;
  listingIdMax: number;
}

export function notionSellerConfig(env: ListingNotionEnv): Cfg | null {
  const dbId = env.NOTION_SELLER_DB_ID || env.NOTION_DATABASE_ID;
  if (!env.NOTION_API_KEY || !dbId) return null;
  return {
    apiKey: env.NOTION_API_KEY,
    dbId,
    matchKeyProp: env.NOTION_SELLER_MATCH_KEY_PROP || 'match_key',
    lineUserIdProp: env.NOTION_SELLER_LINE_USER_ID_PROP || 'LINE User ID',
    titleProp: env.NOTION_SELLER_TITLE_PROP || '名前',
    phoneProp: env.NOTION_SELLER_PHONE_PROP || '[Form]電話番号',
    emailProp: env.NOTION_SELLER_EMAIL_PROP || '[Form]メールアドレス',
    memoProp: env.NOTION_SELLER_MEMO_PROP || 'その他詳細備考',
    listingIdProp: env.NOTION_SELLER_LISTING_ID_PROP || '掲載ID',
    zipProp: env.NOTION_SELLER_ZIP_PROP || '郵便番号',
    statusProp: env.NOTION_SELLER_STATUS_PROP || 'ステータス ',
    statusValue: env.NOTION_SELLER_STATUS_VALUE || '0_LINE登録',
    linkStatusProp: env.NOTION_SELLER_LINK_STATUS_PROP || '連携ステータス',
    linkStatusUnlinked: env.NOTION_SELLER_LINK_STATUS_UNLINKED || '1_フォーム入力',
    linkStatusLinked: env.NOTION_SELLER_LINK_STATUS_LINKED || '3_連携済',
    listingIdMin: Number(env.NOTION_LISTING_ID_MIN || 10000),
    listingIdMax: Number(env.NOTION_LISTING_ID_MAX || 19999),
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

type NotionType = 'title' | 'select' | 'status' | 'number' | 'date' | 'phone_number' | 'email' | 'rich_text';
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
    case 'rich_text':
    default: return richText(value);
  }
}

// ─── フォーム値 正規化（reconcile-daemon から移植） ─────────────────────
function normalizeCarModel(v: unknown): string {
  const s = String(v).replace(/^(TESLA|テスラ|NISSAN|日産|BYD|Hyundai|ヒョンデ|BMW|ポルシェ|Porsche)\s*/i, '').trim();
  const m = s.match(/model\s*([ysx3])/i);
  if (m) return 'Model ' + m[1].toUpperCase();
  return s || String(v);
}
function warekiToDate(v: unknown): string | null {
  const w = String(v).match(/(令和|平成|昭和)\s*(\d+)\s*年\s*(\d+)?/);
  if (w) {
    const base = w[1] === '令和' ? 2018 : w[1] === '平成' ? 1988 : 1925;
    return `${base + Number(w[2])}-${String(w[3] ? Number(w[3]) : 1).padStart(2, '0')}-01`;
  }
  const g = String(v).match(/(\d{4})\D+(\d{1,2})/);
  if (g) return `${g[1]}-${String(Number(g[2])).padStart(2, '0')}-01`;
  return null;
}
function toNumber(v: unknown): number | null {
  const n = parseInt(String(v).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}
function normalizeLoan(v: unknown): string | null {
  const s = String(v);
  if (/オリコ|orico/i.test(s)) return 'オリコ';
  if (/ジャックス|jaccs/i.test(s)) return 'ジャックス';
  if (/プレミア/i.test(s)) return 'プレミアローン';
  if (/銀行/.test(s)) return '銀行系ローン';
  if (/^\s*(なし|無し|無|ローンなし)/.test(s)) return '無';
  if (/あり|有/.test(s)) return 'その他';
  return null;
}
function nashiToMu(v: unknown): string {
  const s = String(v).trim();
  return /^(なし|無し|無|ない|無い)$/.test(s) ? '無' : s;
}
function normalizeAutopilot(v: unknown): string | null {
  const s = String(v);
  if (/FSD|フルセルフ/i.test(s)) return 'FSD';
  if (/EAP|エンハンスト/i.test(s)) return 'EAP';
  if (/ベーシック|標準装備/.test(s)) return 'ベーシックオートパイロット(標準装備)';
  if (/^\s*(なし|無し|無|ない|無い)\s*$/.test(s)) return '無';
  return s.trim() ? 'その他' : null;
}
function sellTimingToEndDate(value: unknown, baseMs: number): string | null {
  const s = String(value || '');
  let months: number | null = null;
  const mm = s.match(/(\d+)\s*(?:ヶ月|か月|カ月|ヵ月|ケ月)/);
  const yy = s.match(/(\d+)\s*年/);
  if (mm) months = Number(mm[1]);
  else if (/半年/.test(s)) months = 6;
  else if (yy) months = Number(yy[1]) * 12;
  else if (/すぐ|即|今すぐ|なるべく早|至急|可能な限り早/.test(s)) months = 0;
  if (months === null) return null;
  const d = new Date(baseMs);
  const t = new Date(d.getFullYear(), d.getMonth() + months, d.getDate());
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

interface FieldMapEntry { prop: string; type: NotionType; xf?: (v: unknown) => unknown }
const FIELD_MAP: Record<string, FieldMapEntry> = {
  'メーカー/車種': { prop: '[Form]車種名', type: 'select', xf: normalizeCarModel },
  'グレード': { prop: '[Form]グレード', type: 'rich_text' },
  '出品地域': { prop: '[Form]出品地域', type: 'rich_text' },
  '走行距離': { prop: '[Form]走行距離', type: 'number', xf: toNumber },
  'ボディカラー': { prop: '[Form]ボディカラー', type: 'rich_text' },
  '当サービスを知ったきっかけ': { prop: '[Form]認知経路', type: 'select' },
  'ご住所': { prop: '[Form]出品者住所', type: 'rich_text' },
  '損傷箇所': { prop: '[Form]損傷箇所', type: 'rich_text', xf: nashiToMu },
  '修理歴の有無': { prop: '[Form]事故・修理歴', type: 'rich_text', xf: nashiToMu },
  '修理箇所': { prop: '[Form]事故・修理歴', type: 'rich_text', xf: nashiToMu },
  'オートパイロットパッケージ': { prop: '[Form]自動運転オプション', type: 'select', xf: normalizeAutopilot },
  'ローン残債': { prop: '[Form]ローン/リース', type: 'select', xf: normalizeLoan },
  'カタカナ': { prop: '[Form]名前(カタカナ)', type: 'rich_text' },
};
const SKIP_FORM_LABELS = new Set(['Match Key', 'match_key', '同意ボタン', 'お名前', '電話番号', 'メールアドレス']);

/** フォーム全項目 → 出品者リストのプロパティ（マップ外は備考に集約）。lineUserId は含めない（別途 PATCH）。 */
function buildSellerProps(
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

  const regRaw = (fields['初度登録年月'] as string) || [fields['初度登録年'], fields['初度登録月']].filter(Boolean).join('');
  if (regRaw) {
    const d = warekiToDate(regRaw);
    if (d) props['[Form]初度登録日'] = { date: { start: d } };
    else memo.push(`初度登録: ${regRaw}`);
  }
  delete fields['初度登録年月']; delete fields['初度登録年']; delete fields['初度登録月'];

  if (fields['売却希望時期']) {
    const end = sellTimingToEndDate(fields['売却希望時期'], baseMs);
    if (end) props['[Form]掲載終了予定日'] = { date: { start: end } };
    else memo.push(`売却希望時期: ${fields['売却希望時期']}`);
  }
  delete fields['売却希望時期'];

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

  props['出品タイプ'] = { select: { name: 'プレミアム出品' } };
  if (memo.length) props[cfg.memoProp] = richText(memo.join('\n'));
  return props;
}

async function nextListingId(cfg: Cfg): Promise<string | null> {
  try {
    const prefix = String(cfg.listingIdMin)[0];
    const q = await notionApi(cfg, `/databases/${cfg.dbId}/query`, 'POST', {
      filter: { property: cfg.listingIdProp, rich_text: { starts_with: prefix } },
      sorts: [{ property: cfg.listingIdProp, direction: 'descending' }],
      page_size: 20,
    });
    let best = 0;
    for (const p of q.results || []) {
      const s = (p.properties?.[cfg.listingIdProp]?.rich_text || []).map((t: any) => t.plain_text).join('');
      const n = parseInt(s.replace(/[^\d]/g, ''), 10);
      if (Number.isFinite(n) && n >= cfg.listingIdMin && n <= cfg.listingIdMax && n > best) best = n;
    }
    return best > 0 ? String(best + 1) : String(cfg.listingIdMin);
  } catch {
    return null;
  }
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

export interface CreateInput {
  matchKey: string;
  formData: Record<string, unknown>;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  zip?: string | null;
}

/**
 * form_submit 時の起票/更新。match_key で照合し、無ければ新規作成（未連携）。
 * 既存（再送信）の場合はフォーム項目のみ更新し、title/掲載ID/連携状態は保持する。
 * 返り値: Notion pageId（失敗・未設定なら null）。
 */
export async function createOrUpdateSellerRow(env: ListingNotionEnv, input: CreateInput): Promise<string | null> {
  const cfg = notionSellerConfig(env);
  if (!cfg) return null;
  const baseMs = Date.now();
  const props = buildSellerProps(input.formData, { phone: input.phone, email: input.email }, cfg, baseMs);
  if (input.zip) props[cfg.zipProp] = richText(input.zip);

  const existing = await queryPageId(cfg, cfg.matchKeyProp, input.matchKey);
  if (existing) {
    await notionApi(cfg, `/pages/${existing}`, 'PATCH', { properties: props });
    return existing;
  }

  const createProps: Record<string, unknown> = { ...props };
  createProps[cfg.matchKeyProp] = richText(input.matchKey);
  createProps[cfg.titleProp] = notionValue('title', input.name || input.matchKey);
  const lid = await nextListingId(cfg);
  if (lid) createProps[cfg.listingIdProp] = richText(lid);
  createProps[cfg.linkStatusProp] = notionValue('select', cfg.linkStatusUnlinked);

  const created = await notionApi(cfg, `/pages`, 'POST', { parent: { database_id: cfg.dbId }, properties: createProps });
  return created.id ?? null;
}

export interface LinkInput {
  matchKey: string;
  lineUserId: string;
  displayName?: string | null;
  knownPageId?: string | null;
}

/**
 * LINE 連携時に lineUserId / 連携ステータス(連携済) / 運用ステータス を PATCH する。
 * match_key で引き当て → 無ければ lineUserId で（移行期・既存行）→ それも無ければ最小行を作成。
 * 返り値: Notion pageId（失敗・未設定なら null）。
 */
export async function linkSellerRow(env: ListingNotionEnv, input: LinkInput): Promise<string | null> {
  const cfg = notionSellerConfig(env);
  if (!cfg) return null;

  let pageId = input.knownPageId || null;
  if (!pageId) pageId = await queryPageId(cfg, cfg.matchKeyProp, input.matchKey);
  if (!pageId) pageId = await queryPageId(cfg, cfg.lineUserIdProp, input.lineUserId);

  // 必須 = lineUserId + 連携ステータス(連携済)。運用ステータス('ステータス ')は別 PATCH の best-effort にする
  // （プロパティ名の末尾空白差異・選択肢不一致等で失敗しても、連携追記そのものは確定させるため）。
  const props: Record<string, unknown> = {
    [cfg.lineUserIdProp]: richText(input.lineUserId),
    [cfg.linkStatusProp]: notionValue('select', cfg.linkStatusLinked),
  };

  // 運用ステータスを best-effort で付与（失敗は握りつぶす＝非致命）。
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

  // orphan link（form_submit が無い）→ 最小行を作成
  const createProps: Record<string, unknown> = { ...props };
  createProps[cfg.matchKeyProp] = richText(input.matchKey);
  createProps[cfg.titleProp] = notionValue('title', input.displayName || input.lineUserId);
  const lid = await nextListingId(cfg);
  if (lid) createProps[cfg.listingIdProp] = richText(lid);
  const created = await notionApi(cfg, `/pages`, 'POST', { parent: { database_id: cfg.dbId }, properties: createProps });
  if (created.id) await setOperationalStatus(created.id);
  return created.id ?? null;
}
