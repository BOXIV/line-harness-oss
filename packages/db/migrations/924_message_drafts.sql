-- 924_message_drafts.sql
-- BOXIV: 送信相手（友だち）ごとに貯めておける下書き。
-- チャット入力欄の ✏️ から挿入する。書き手は 2 通り:
--   - 管理画面のオペレーター（authVia=session → created_via='admin'）
--   - Claude の MCP / API キー経由の自動生成（authVia=api_key|env_key → created_via='api'）
-- 予約送信（scheduled_messages）と違い **自動では絶対に送らない**。
-- 人が挿入して送信するまで LINE には出ない。

CREATE TABLE IF NOT EXISTS message_drafts (
  id              TEXT PRIMARY KEY,
  friend_id       TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  title           TEXT,                                   -- 一覧で見分ける短い見出し（任意）
  content         TEXT NOT NULL,                          -- 本文（text メッセージ想定）
  created_via     TEXT NOT NULL DEFAULT 'admin'
                    CHECK (created_via IN ('admin', 'api')),
  created_by_id   TEXT,                                   -- staff_members.id（機械経由なら NULL のことがある）
  created_by_name TEXT,                                   -- 作成時点の名前を焼き付ける（messages_log.sent_by_name と同じ方針）
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

-- 一覧は「その友だちの下書きを新しい順」でしか引かない。
CREATE INDEX IF NOT EXISTS idx_message_drafts_friend ON message_drafts (friend_id, created_at DESC);
