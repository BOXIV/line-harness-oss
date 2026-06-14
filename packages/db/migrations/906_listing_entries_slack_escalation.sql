-- 906_listing_entries_slack_escalation.sql
-- BOXIV: 出品フォーム催促エンジン刷新（10分/24h/48h スケジュール + 72h エスカレ + Slackスレッド化）。
--   slack_thread_ts : フォーム送信時に Worker が #pj-lightning-sell へ投稿した通知の ts。
--                     連携完了・72hエスカレ をこのスレッドに返信するためのキー。
--   escalated_at    : 72h 未連携エスカレ通知を送った時刻（重複エスカレ防止）。
-- reminder_count(=送信済ステップ数) / email_sent_at / sms_sent_at は 905 で既出。
ALTER TABLE listing_entries ADD COLUMN slack_thread_ts TEXT;
ALTER TABLE listing_entries ADD COLUMN escalated_at TEXT;
