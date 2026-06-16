-- BOXIV 907: Slack 受信通知のバースト集約（30秒デバウンス）+ 重複送信防止マーカー。
-- 旧 setTimeout ベースの scheduleBurstNotify（通知済みマーカー無し＝二重送信バグ）を廃し、
-- cron(1分)駆動の flush に置き換える。
--   messages_log.slack_notified_at : 通知済みマーカー（NULL=未通知）。一度まとめた行は再送しない。
--   slack_notify_buffers           : friend 単位のバースト状態（notify_after=最終受信+30秒）。

ALTER TABLE messages_log ADD COLUMN slack_notified_at TEXT;

-- 移行直後の一斉通知を防ぐ: 既存の受信メッセージは「通知済み」とみなす。
-- （reconcile-schema 経由で列だけ追加された場合に備え、flush 側にも created_at ガードあり）
UPDATE messages_log
   SET slack_notified_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
 WHERE direction = 'incoming' AND slack_notified_at IS NULL;

CREATE TABLE IF NOT EXISTS slack_notify_buffers (
  friend_id        TEXT PRIMARY KEY REFERENCES friends (id) ON DELETE CASCADE,
  line_account_id  TEXT,
  first_msg_at     TEXT NOT NULL,
  last_msg_at      TEXT NOT NULL,
  notify_after     TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_slack_notify_buffers_due ON slack_notify_buffers (notify_after);
