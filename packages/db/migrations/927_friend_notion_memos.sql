-- 927_friend_notion_memos.sql
-- BOXIV: Notion の「取引メモ」を LINE Connect 側に取り込んで、個別チャットの
-- ユーザー情報カラムに出す。
--
-- Notion がマスターで、LINE Connect からは書き戻さない（顧客ステータスと同じ扱い）。
-- 反映経路も同じ 2 つ:
--   (a) Notion DB オートメーション(Send webhook) → /api/notion/automation（即時）
--   (b) 12 時間ごとの reconcile cron（取りこぼしの自己修復）
--
-- friends に列を足さず別テーブルにする理由:
--   1 人が出品者行と購入者行の**両方**に連携し得る（出品者として売り、購入者として買う）。
--   メモはその行ごとに別物なので、source ごとに 1 行持てる形にする。
--   friends.metadata に入れる手もあるが、metadata は連携ピッカーが丸ごと書き換えるので
--   同期の書き込みと競合する。
--
-- page_id を持つのは「どの行のメモか」を後から確認できるようにするため
-- （同じ DB に複数行がある人で、連携先の行が切り替わったときの追跡用）。
CREATE TABLE IF NOT EXISTS friend_notion_memos (
  friend_id  TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  source     TEXT NOT NULL CHECK (source IN ('seller', 'buyer')),
  memo       TEXT,
  page_id    TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (friend_id, source)
);
