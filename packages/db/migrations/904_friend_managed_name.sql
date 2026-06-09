-- 904_friend_managed_name.sql
-- BOXIV: 管理者が編集できる「管理名（表示名）」を friends に追加する。
-- display_name は LINE プロフィール由来で再同期（upsertFriend / friend-import backfill）に
-- 上書きされるため、管理画面で手動編集した名前は managed_name に保持し、display_name は触らない。
-- 表示は managed_name 優先 → 未設定なら displayName / Notion ラベル。

ALTER TABLE friends ADD COLUMN managed_name TEXT;
