-- 909_chats_last_read.sql
-- オペレーターチャットの「未読数」表示用に最終既読時刻を追加する。
--   未読数 = この時刻以降に届いた incoming メッセージ件数（last_read_at が NULL の間は全 incoming）。
--   「既読にする」ボタン押下時・オペレーター返信時に now（JST）で更新し、未読数を 0 に戻す。
ALTER TABLE chats ADD COLUMN last_read_at TEXT;
