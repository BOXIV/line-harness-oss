// BOXIV-only: Slack chat.postMessage ヘルパー。
// 出品フォーム連携の「フォーム通知（親）／連携完了・72hエスカレ（スレッド返信）」に使う。
// bot=claude-sellentry (SELLENTRY_SLACK_BOT_TOKEN), 投稿先=SLACK_LISTING_LINK_CHANNEL_ID(#pj-lightning-sell)。

export interface SlackEnv {
  SELLENTRY_SLACK_BOT_TOKEN?: string;
  SLACK_LISTING_LINK_CHANNEL_ID?: string;
}

export interface SlackPostResult {
  ok: boolean;
  ts?: string;       // 投稿メッセージの ts（親メッセージならスレッドキーとして保存）
  error?: string;
}

/**
 * #pj-lightning-sell へ投稿。threadTs を渡すとそのスレッドへ返信。
 * 未設定なら ok=false（呼び出し側はログのみ・非致命）。throw しない。
 */
export async function slackPost(
  env: SlackEnv,
  text: string,
  opts: { threadTs?: string | null } = {},
): Promise<SlackPostResult> {
  if (!env.SELLENTRY_SLACK_BOT_TOKEN || !env.SLACK_LISTING_LINK_CHANNEL_ID) {
    return { ok: false, error: 'slack not configured' };
  }
  const body: Record<string, unknown> = {
    channel: env.SLACK_LISTING_LINK_CHANNEL_ID,
    text,
    unfurl_links: false,
    unfurl_media: false,
  };
  if (opts.threadTs) body.thread_ts = opts.threadTs;
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
