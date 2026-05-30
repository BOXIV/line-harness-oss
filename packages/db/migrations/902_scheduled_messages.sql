-- 902_scheduled_messages.sql
-- BOXIV: 個別チャットからの単発送信予約。指定時刻に 1 メッセージを push する。
-- 既存の reminders 系（複数ステップのキャンペーン）とは別建て。

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id            TEXT PRIMARY KEY,
  friend_id     TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  scheduled_at  TEXT NOT NULL,                                       -- ISO datetime (JST 含む文字列)
  message_type  TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex')),
  content       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'scheduled'
                  CHECK (status IN ('scheduled', 'sent', 'cancelled', 'failed')),
  sent_at       TEXT,
  error         TEXT,
  created_by    TEXT,                                                -- staff_member.id (NULL = system)
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_scheduled_messages_status_at
  ON scheduled_messages (status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_friend
  ON scheduled_messages (friend_id);
