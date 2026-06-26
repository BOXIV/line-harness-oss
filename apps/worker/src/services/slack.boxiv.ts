// BOXIV-only: Slack chat.postMessage ヘルパー。
// 出品フォーム連携の「フォーム通知（親）／連携完了・72hエスカレ（スレッド返信）」に使う。
// bot=claude-sellentry (SELLENTRY_SLACK_BOT_TOKEN), 投稿先=SLACK_LISTING_LINK_CHANNEL_ID(#pj-lightning-sell)。

export interface SlackEnv {
  SELLENTRY_SLACK_BOT_TOKEN?: string;
  SLACK_LISTING_LINK_CHANNEL_ID?: string;
}

export interface SlackWebhookEnv {
  // 催促メール/SMS の送信状況を監視する Slack Incoming Webhook URL（未設定なら投稿しない）。
  SLACK_REMINDER_WEBHOOK_URL?: string;
}

export interface SlackPostResult {
  ok: boolean;
  ts?: string;       // 投稿メッセージの ts（親メッセージならスレッドキーとして保存）
  error?: string;
}

/**
 * Slack の text フィールド(mrkdwn 解釈)へユーザー入力を安全に埋め込むための最小エスケープ。
 * `<` `>` `&` を実体参照に置換すれば `<!channel>`/`<!here>` 等のブロードキャストメンションや
 * `<url|表示文字>` のリンクすり替えを打ち消せる（フォーム入力の氏名/メール等に適用する）。
 */
export function escapeSlackText(s: string | null | undefined): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * コンパクトな Slack カード attachment を組み立てる（color サイドバー + 太字タイトル + 2列フィールド）。
 * 箇条書き(•)や生の `*` を使わず、見出しは太字レンダリング、各項目はラベル太字＋値の2列で表示する。
 * 値は呼び出し側で escapeSlackText 済みを渡す（mrkdwn インジェクション防止）。空値の項目は除外する。
 * 本体テキストが長い場合は本文を渡さず、呼び出し側でスレッド返信に分ける（タイムラインを圧迫しない）。
 */
export function buildSlackCard(opts: {
  title: string;
  color: string;
  fields: Array<{ label: string; value: string | null | undefined }>;
  // true の場合、attachment 内のタイトル section を出さない。
  // 本体 text（= fallback = title）にタイトルを出す呼び出しで、attachment 内と二重に
  // 表示されるのを防ぐ用途。fallback は通知用フォールバックとして title のまま保持する。
  omitTitleBlock?: boolean;
}): Record<string, unknown> {
  const fields = opts.fields
    .filter((f) => f.value != null && String(f.value).trim() !== '')
    .map((f) => ({ type: 'mrkdwn', text: `*${f.label}*\n${f.value}` }));
  const blocks: Record<string, unknown>[] = [];
  // omitTitleBlock でも fields が空なら空 attachment を避けるためタイトルを残す。
  if (!opts.omitTitleBlock || fields.length === 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${opts.title}*` } });
  }
  if (fields.length > 0) blocks.push({ type: 'section', fields });
  return { color: opts.color, fallback: opts.title, blocks };
}

/**
 * #pj-lightning-sell へ投稿。threadTs を渡すとそのスレッドへ返信。
 * 未設定なら ok=false（呼び出し側はログのみ・非致命）。throw しない。
 */
export async function slackPost(
  env: SlackEnv,
  text: string,
  opts: { threadTs?: string | null; attachments?: unknown[] } = {},
): Promise<SlackPostResult> {
  if (!env.SELLENTRY_SLACK_BOT_TOKEN || !env.SLACK_LISTING_LINK_CHANNEL_ID) {
    return { ok: false, error: 'slack not configured' };
  }
  const body: Record<string, unknown> = {
    channel: env.SLACK_LISTING_LINK_CHANNEL_ID,
    text, // attachments 指定時も通知用フォールバックとして必須
    unfurl_links: false,
    unfurl_media: false,
  };
  if (opts.threadTs) body.thread_ts = opts.threadTs;
  if (opts.attachments && opts.attachments.length > 0) body.attachments = opts.attachments;
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SELLENTRY_SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });
    const j = (await res.json()) as { ok?: boolean; ts?: string; error?: string };
    if (!j.ok) return { ok: false, error: j.error || `http ${res.status}` };
    return { ok: true, ts: j.ts };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 既存メッセージ(ts)を chat.update で書き換える。
 * フォーム送信通知の「（LINE連携待ち）」を連携完了時に「（LINE連携済み）」へ更新する用途。
 * ts/token/channel いずれか未設定なら ok=false（呼び出し側はログのみ・非致命）。throw しない。
 */
export async function slackUpdate(
  env: SlackEnv,
  ts: string | null | undefined,
  text: string,
  opts: { attachments?: unknown[] } = {},
): Promise<SlackPostResult> {
  if (!env.SELLENTRY_SLACK_BOT_TOKEN || !env.SLACK_LISTING_LINK_CHANNEL_ID || !ts) {
    return { ok: false, error: 'slack update not configured (token/channel/ts)' };
  }
  const body: Record<string, unknown> = {
    channel: env.SLACK_LISTING_LINK_CHANNEL_ID,
    ts,
    text,
  };
  if (opts.attachments && opts.attachments.length > 0) body.attachments = opts.attachments;
  try {
    const res = await fetch('https://slack.com/api/chat.update', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SELLENTRY_SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });
    const j = (await res.json()) as { ok?: boolean; ts?: string; error?: string };
    if (!j.ok) return { ok: false, error: j.error || `http ${res.status}` };
    return { ok: true, ts: j.ts };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Slack Incoming Webhook へテキストを 1 件 POST する（監視チャンネル向け）。
 * chat.postMessage と違い bot token は不要で、URL 自体が宛先チャンネルを内包する。
 * url 未設定/失敗でも throw しない（呼び出し側はログのみ・非致命）。
 */
export async function slackWebhookPost(
  url: string | undefined,
  text: string,
): Promise<SlackPostResult> {
  if (!url) return { ok: false, error: 'webhook url not configured' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text }),
    });
    // Incoming Webhook は成功時 200 / body は "ok"。失敗はボディに理由（invalid_payload 等）。
    if (res.ok) return { ok: true };
    const t = await res.text().catch(() => '');
    return { ok: false, error: `http ${res.status}: ${t.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
