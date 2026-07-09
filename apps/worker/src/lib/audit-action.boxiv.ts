// BOXIV: 監査ログ用。HTTP メソッド + パス（+ リクエスト本文）から
// 「何の変更か」を機械コード(action) と日本語(summary) に解決する。
// 認証直後の audit-log ミドルウェアから呼ばれる。漏れを防ぐため、
// 既知ルートはキュレートし、未知ルートは resource 辞書 + 動詞で汎用ラベル化する。

export interface AuditResolution {
  /** true なら記録しない（GET/ノイズ系/対象外） */
  skip?: boolean;
  action: string;
  summary: string;
  targetType?: string | null;
  targetId?: string | null;
  targetLabel?: string | null;
  /** 機密マスク済みリクエスト本文 */
  detail?: unknown;
}

// ─── 機密 / PII マスク ───
// detail には監査に必要な構造情報だけを残し、資格情報と個人情報・自由記述
// (メッセージ本文 / メール / 電話 / 住所 等) は値をマスクして残さない。
// - 資格情報: キー名に部分一致（camelCase 境界 channelAccessToken / channelSecret も拾う）
// - PII/自由記述: キー名をトークン分割して語一致（detail / context 等の誤爆を避ける）
// 監査ログでは過剰マスク（誤って隠す）より漏洩の方が重大なので、広めに倒す。
const SECRET_RE =
  /(secret|token|password|passwd|authorization|credential|api[_-]?key|access[_-]?key|private[_-]?key)/i;
const PII_TOKENS = new Set([
  'email', 'mail', 'phone', 'tel', 'telephone', 'mobile', 'fax',
  'address', 'addr', 'zip', 'postal',
  // 'message' は除外（messageType 等の構造フィールドを過剰マスクしないため）。
  // 実本文フィールドは content / messageContent / altText に集約され content/text で拾える。
  'content', 'text', 'body', 'note', 'notes', 'memo', 'comment', 'comments',
]);

function keyTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase 分割
    .split(/[\s_-]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

function isSensitiveKey(key: string): boolean {
  if (SECRET_RE.test(key)) return true;
  return keyTokens(key).some((t) => PII_TOKENS.has(t));
}

function redactValue(v: unknown, depth = 0): unknown {
  if (depth > 3) return '…';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redactValue(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? '***' : redactValue(val, depth + 1);
    }
    return out;
  }
  if (typeof v === 'string' && v.length > 500) return v.slice(0, 500) + '…';
  return v;
}

export function redactBody(body: unknown): unknown {
  try {
    return redactValue(body);
  } catch {
    return {};
  }
}

// ─── 辞書 ───
const RESOURCE_JA: Record<string, string> = {
  friends: '友だち',
  tags: 'タグ',
  templates: 'テンプレート',
  'template-categories': 'テンプレカテゴリ',
  scenarios: 'シナリオ',
  broadcasts: '一斉配信',
  automations: 'オートメーション',
  'rich-menus': 'リッチメニュー',
  'rich-menu-status': 'リッチメニュー自動切替',
  reminders: 'リマインダ',
  scoring: 'スコアリング',
  'scoring-rules': 'スコアリングルール',
  conversions: 'CV計測ポイント',
  affiliates: '流入経路',
  webhooks: 'Webhook',
  'incoming-webhooks': '受信Webhook',
  'outgoing-webhooks': '送信Webhook',
  notifications: '通知ルール',
  'notification-rules': '通知ルール',
  forms: 'フォーム',
  users: 'UUID',
  'line-accounts': 'LINEアカウント',
  staff: 'スタッフ',
  operators: '対応担当者',
  chats: 'チャット',
  'scheduled-messages': '送信予約',
  'tracked-links': '計測リンク',
  'ad-platforms': '広告プラットフォーム',
  'status-options': '顧客ステータス定義',
  'booking-requests': '撮影予約',
  'booking-invites': '撮影予約招待',
  'staff-availability': 'スタッフシフト',
  calendar: 'カレンダー連携',
  admin: 'システム管理',
};

// サブアクション語 → 助詞込みの述語（summary = resourceJa + 述語）
const SUBACTION_JA: Record<string, string> = {
  send: 'を送信',
  'send-segment': 'をセグメント配信',
  enroll: 'に友だちを登録',
  unenroll: 'の友だち登録を解除',
  steps: 'のステップを更新',
  reorder: 'の並び順を変更',
  default: 'を既定に設定',
  rebind: 'の自動切替を再適用',
  approve: 'を承認',
  reject: 'を却下',
  cancel: 'をキャンセル',
  duplicate: 'を複製',
  copy: 'を複製',
  sync: 'を同期',
  'regenerate-key': 'のAPIキーを再生成',
  'import-followers': 'を一括インポート',
  'backfill-profiles': 'のプロフィールを補完',
  bulk: 'を一括更新',
  link: 'を友だちに紐付け',
  unlink: 'の友だち紐付けを解除',
  image: 'の画像を更新',
  toggle: 'の有効/無効を切替',
  activate: 'を有効化',
  deactivate: 'を無効化',
  notion: 'のNotion連携を更新',
  'notion-link': 'のNotion連携を更新',
};

const VERB_JA: Record<string, string> = { POST: '作成', PUT: '更新', PATCH: '更新', DELETE: '削除' };
const VERB_CODE: Record<string, string> = {
  POST: 'create',
  PUT: 'update',
  PATCH: 'update',
  DELETE: 'delete',
};

function isId(s: string): boolean {
  return (
    /^\d+$/.test(s) || // 数値 id
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-/.test(s) || // uuid
    /^[A-Za-z0-9_-]{20,}$/.test(s) || // ULID / ランダム長文字列 / LINE userId
    (s.length >= 8 && /\d/.test(s)) // 数字を含む 8 文字以上の不透明 id（u_… 等）。アクション語は数字を含まない
  );
}

function labelFromBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  for (const k of ['name', 'title', 'displayName', 'managedName', 'label']) {
    const v = b[k];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 80);
  }
  return null;
}

function isNoise(method: string, segs: string[]): boolean {
  const last = segs[segs.length - 1];
  // 既読化 / ローディング表示 / URL ラップ / プレビューは「変更」ではない
  if (last === 'read' || last === 'loading' || last === 'wrap' || last === 'preview') return true;
  // メディア/画像のステージングアップロードは送信操作の前段でノイズ
  if (segs[1] === 'images' || segs[1] === 'media') return true;
  return false;
}

export function resolveAuditAction(method: string, path: string, body: unknown): AuditResolution {
  const m = method.toUpperCase();
  const segs = path.split('/').filter(Boolean); // ['api', resource, ...]
  const detail = redactBody(body);
  const base = { detail };

  if (segs[0] !== 'api' || !segs[1]) return { skip: true, action: '', summary: '' };
  if (isNoise(m, segs)) return { skip: true, action: '', summary: '' };

  const resource = segs[1] || '';
  const resourceJa = RESOURCE_JA[resource] || resource;
  const rest = segs.slice(2);

  let targetId: string | null = null;
  let actionWord: string | null = null;
  for (const seg of rest) {
    if (isId(seg)) {
      if (!targetId) targetId = seg;
    } else {
      actionWord = seg; // 末尾の語が勝つ（例 .../:id/send → 'send'）
    }
  }

  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};

  // ─── キュレート（汎用では不自然/重要なもの） ───
  if (resource === 'friends' && actionWord === 'messages' && m === 'POST') {
    return { ...base, action: 'friend.message_send', summary: '友だちにメッセージを送信', targetType: 'friend', targetId, targetLabel: labelFromBody(body) };
  }
  if (resource === 'chats' && actionWord === 'send' && m === 'POST') {
    return { ...base, action: 'chat.message_send', summary: 'チャットでメッセージを送信', targetType: 'chat', targetId, targetLabel: labelFromBody(body) };
  }
  if (resource === 'friends' && actionWord === 'tags' && m === 'POST') {
    return { ...base, action: 'friend.tag_add', summary: '友だちにタグを付与', targetType: 'friend', targetId, targetLabel: labelFromBody(body) };
  }
  if (resource === 'friends' && actionWord === 'tags' && m === 'DELETE') {
    return { ...base, action: 'friend.tag_remove', summary: '友だちのタグを解除', targetType: 'friend', targetId };
  }
  if (resource === 'friends' && !actionWord && (m === 'PUT' || m === 'PATCH')) {
    if ('displayName' in b || 'managedName' in b || 'name' in b) {
      return { ...base, action: 'friend.rename', summary: '友だちの表示名を変更', targetType: 'friend', targetId, targetLabel: labelFromBody(body) };
    }
    return { ...base, action: 'friend.update', summary: '友だち情報を更新', targetType: 'friend', targetId };
  }
  if (resource === 'staff' && (m === 'PUT' || m === 'PATCH')) {
    const sid = targetId ?? rest[0] ?? null; // PUT /api/staff/:id は必ず id を持つ
    if ('role' in b) {
      return { ...base, action: 'staff.role_update', summary: 'スタッフの権限を変更', targetType: 'staff', targetId: sid, targetLabel: typeof b.role === 'string' ? `権限: ${b.role}` : labelFromBody(body) };
    }
    return { ...base, action: 'staff.update', summary: 'スタッフ情報を更新', targetType: 'staff', targetId: sid };
  }
  if (resource === 'admin' && actionWord === 'reconcile-schema') {
    return { ...base, action: 'admin.reconcile_schema', summary: 'システムのスキーマ整合を実行', targetType: 'admin', targetId: null };
  }
  // CV計測ポイント（conversions 配下のコレクション・セグメント）
  if (resource === 'conversions' && actionWord === 'points') {
    if (m === 'DELETE') return { ...base, action: 'conversions.point_delete', summary: 'CV計測ポイントを削除', targetType: 'conversion_point', targetId };
    if (m === 'PUT' || m === 'PATCH') return { ...base, action: 'conversions.point_update', summary: 'CV計測ポイントを更新', targetType: 'conversion_point', targetId, targetLabel: labelFromBody(body) };
    return { ...base, action: 'conversions.point_create', summary: 'CV計測ポイントを作成', targetType: 'conversion_point', targetId, targetLabel: labelFromBody(body) };
  }
  // リッチメニュー自動切替（rich-menus/auto-switch/:statusOptionId の紐付け/解除）
  if (resource === 'rich-menus' && actionWord === 'auto-switch') {
    if (m === 'DELETE') return { ...base, action: 'rich_menu_status.unbind', summary: 'リッチメニュー自動切替を解除', targetType: 'rich_menu_status', targetId };
    return { ...base, action: 'rich_menu_status.bind', summary: 'リッチメニュー自動切替を設定', targetType: 'rich_menu_status', targetId };
  }

  // ─── 汎用: 既知サブアクション ───
  if (actionWord && SUBACTION_JA[actionWord]) {
    return {
      ...base,
      action: `${resource}.${actionWord.replace(/-/g, '_')}`,
      summary: `${resourceJa}${SUBACTION_JA[actionWord]}`,
      targetType: resource,
      targetId,
      targetLabel: labelFromBody(body),
    };
  }
  // ─── 汎用: 未知サブアクション（CRUD 動詞で create/update/delete を区別し潰れを防ぐ） ───
  if (actionWord) {
    const word = actionWord.replace(/-/g, '_');
    const verb = VERB_JA[m];
    if (verb) {
      return {
        ...base,
        action: `${resource}.${word}_${VERB_CODE[m]}`,
        summary: `${resourceJa}（${actionWord}）を${verb}`,
        targetType: resource,
        targetId,
        targetLabel: m === 'DELETE' ? null : labelFromBody(body),
      };
    }
    return {
      ...base,
      action: `${resource}.${word}`,
      summary: `${resourceJa}: ${actionWord}`,
      targetType: resource,
      targetId,
      targetLabel: labelFromBody(body),
    };
  }
  // ─── 汎用: 標準 CRUD ───
  const verb = VERB_JA[m] || '変更';
  const verbCode = VERB_CODE[m] || 'change';
  return {
    ...base,
    action: `${resource}.${verbCode}`,
    summary: `${resourceJa}を${verb}`,
    targetType: resource,
    targetId,
    targetLabel: m === 'DELETE' ? null : labelFromBody(body),
  };
}
