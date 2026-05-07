/**
 * Notion API クライアント（撮影予約システム用）
 *
 * 出品者の顧客情報は Notion データベースに格納されており、
 * LINE ユーザID または Notion ページID から顧客情報を取得する。
 *
 * Notion 公式 REST API v1 を直接叩く（SDK不要、fetchのみ）。
 * Notion-Version: 2022-06-28 固定。
 *
 * DB プロパティ名はハードコードではなく env で設定可能。
 * 未設定時はデフォルト名（日本語）を使用する。
 */

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export interface NotionEnv {
  NOTION_API_KEY?: string;
  NOTION_DATABASE_ID?: string;
  // プロパティ名（未設定時デフォルト）
  NOTION_PROP_LINE_USER_ID?: string;  // default: "LINEユーザID"
  NOTION_PROP_NAME?: string;          // default: "名前"
  NOTION_PROP_PREFECTURE?: string;    // default: "都道府県"
  NOTION_PROP_VEHICLE?: string;       // default: "車両情報"
  NOTION_PROP_PHONE?: string;         // default: "電話番号"
  NOTION_PROP_ADDRESS?: string;       // default: "住所"
}

export interface NotionCustomer {
  pageId: string;
  lineUserId: string | null;
  customerName: string | null;
  prefecture: string | null;
  vehicleInfo: string | null;
  phone: string | null;
  address: string | null;
}

function getPropNames(env: NotionEnv) {
  return {
    lineUserId: env.NOTION_PROP_LINE_USER_ID || 'LINEユーザID',
    name: env.NOTION_PROP_NAME || '名前',
    prefecture: env.NOTION_PROP_PREFECTURE || '都道府県',
    vehicle: env.NOTION_PROP_VEHICLE || '車両情報',
    phone: env.NOTION_PROP_PHONE || '電話番号',
    address: env.NOTION_PROP_ADDRESS || '住所',
  };
}

/**
 * Notion プロパティ値から文字列を抽出する汎用ヘルパー。
 * title / rich_text / select / multi_select / phone_number / email / url / number に対応。
 */
function extractString(prop: unknown): string | null {
  if (!prop || typeof prop !== 'object') return null;
  const p = prop as Record<string, unknown>;
  const type = p.type as string | undefined;
  if (!type) return null;

  const val = p[type];
  if (val == null) return null;

  if (type === 'title' || type === 'rich_text') {
    if (Array.isArray(val)) {
      return val
        .map((item: unknown) => {
          if (item && typeof item === 'object' && 'plain_text' in item) {
            return String((item as Record<string, unknown>).plain_text ?? '');
          }
          return '';
        })
        .join('')
        .trim() || null;
    }
    return null;
  }

  if (type === 'select') {
    if (val && typeof val === 'object' && 'name' in val) {
      return String((val as Record<string, unknown>).name ?? '') || null;
    }
    return null;
  }

  if (type === 'multi_select') {
    if (Array.isArray(val)) {
      return val
        .map((item: unknown) => {
          if (item && typeof item === 'object' && 'name' in item) {
            return String((item as Record<string, unknown>).name ?? '');
          }
          return '';
        })
        .filter(Boolean)
        .join(', ') || null;
    }
    return null;
  }

  if (type === 'phone_number' || type === 'email' || type === 'url') {
    return typeof val === 'string' ? val : null;
  }

  if (type === 'number') {
    return typeof val === 'number' ? String(val) : null;
  }

  return null;
}

/**
 * Notion APIレスポンスのページオブジェクトから NotionCustomer を組み立てる。
 */
function pageToCustomer(page: Record<string, unknown>, env: NotionEnv): NotionCustomer {
  const props = getPropNames(env);
  const properties = (page.properties as Record<string, unknown>) || {};
  return {
    pageId: String(page.id || ''),
    lineUserId: extractString(properties[props.lineUserId]),
    customerName: extractString(properties[props.name]),
    prefecture: extractString(properties[props.prefecture]),
    vehicleInfo: extractString(properties[props.vehicle]),
    phone: extractString(properties[props.phone]),
    address: extractString(properties[props.address]),
  };
}

/**
 * Notion DB を LINE ユーザID で検索して顧客情報を取得する。
 * 複数マッチした場合は最初の1件を返す。
 */
export async function queryCustomerByLineUserId(
  lineUserId: string,
  env: NotionEnv,
): Promise<NotionCustomer | null> {
  if (!env.NOTION_API_KEY || !env.NOTION_DATABASE_ID) return null;

  const props = getPropNames(env);

  // まず rich_text としてfilterを試みる
  const filterBodies = [
    { property: props.lineUserId, rich_text: { equals: lineUserId } },
    { property: props.lineUserId, title: { equals: lineUserId } },
  ];

  for (const filter of filterBodies) {
    try {
      const res = await fetch(`${NOTION_API}/databases/${env.NOTION_DATABASE_ID}/query`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.NOTION_API_KEY}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ filter, page_size: 1 }),
      });
      if (!res.ok) {
        // rich_text でエラーなら title にフォールバック
        continue;
      }
      const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
      if (data.results && data.results.length > 0) {
        return pageToCustomer(data.results[0], env);
      }
    } catch (err) {
      console.error('Notion query error:', err);
    }
  }
  return null;
}

/**
 * Notion ページIDから顧客情報を取得する。
 */
export async function getCustomerByPageId(
  pageId: string,
  env: NotionEnv,
): Promise<NotionCustomer | null> {
  if (!env.NOTION_API_KEY) return null;
  try {
    const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
      headers: {
        Authorization: `Bearer ${env.NOTION_API_KEY}`,
        'Notion-Version': NOTION_VERSION,
      },
    });
    if (!res.ok) return null;
    const page = (await res.json()) as Record<string, unknown>;
    return pageToCustomer(page, env);
  } catch (err) {
    console.error('Notion getPage error:', err);
    return null;
  }
}
