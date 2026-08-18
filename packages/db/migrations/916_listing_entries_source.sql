-- 916_listing_entries_source.sql
-- BOXIV: 購入者エントリーを同じ台帳（listing_entries）で扱えるようにする。
--
-- 出品者フォーム（/listing-form/*）と購入者エントリー（/buyer-form/*）は
--   フォーム送信 → match_key で D1 起票 → Notion 即ミラー → LINE 連携で追記
-- という同一の2段フローなので、テーブルを分けず source 列で区別する。
-- これにより催促 CRON（listing-reminder）・follow webhook のレスキュー・
-- match_key 照合ロジックが購入者にもそのまま効く。
--
-- 既存行は全て出品者なので DEFAULT 'seller'（後方互換）。
ALTER TABLE listing_entries ADD COLUMN source TEXT NOT NULL DEFAULT 'seller';  -- seller | buyer

-- 催促 CRON は「未連携（form_only）」を source ごとに引く（通知先チャンネル・文面が異なる）。
CREATE INDEX IF NOT EXISTS idx_listing_entries_source_status ON listing_entries(source, status);
