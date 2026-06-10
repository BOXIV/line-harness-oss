-- 905_listing_entries.sql
-- BOXIV: 出品フォーム送信を「LINE 連携前」から記録する台帳（正本）。
--
-- これまで Notion 起票は reconcile-daemon が form_submit と line_link を Slack 上で突合し、
-- 「ペア成立後（= LINE 連携後）」に行を作っていた。本テーブルを正本にすることで:
--   1. form_submit 時点で 1 行作成（status='form_only'）→ Notion へ即ミラー起票（未連携）
--   2. LINE 連携で line_user_id を追記（status='linked'）→ Notion 行へ PATCH
--   3. 催促 CRON が status='form_only' を経過時間で抽出し、メール/SMS で連携を促す
-- 起票キーは match_key（クライアント生成 UUID）。LINE 連携前は line_user_id が無いので
-- match_key を一意キーにする（Notion 側にも match_key プロパティを追加して同じキーで照合）。
CREATE TABLE IF NOT EXISTS listing_entries (
  match_key       TEXT PRIMARY KEY,
  form_data       TEXT NOT NULL DEFAULT '{}',          -- フォーム全項目の JSON（ラベル→値）
  name            TEXT,                                 -- お名前
  phone           TEXT,                                 -- 電話番号（SMS 催促用）
  email           TEXT,                                 -- メールアドレス（メール催促用）
  line_user_id    TEXT,                                 -- LINE 連携で追記
  display_name    TEXT,                                 -- LINE プロフィール表示名（連携時）
  notion_page_id  TEXT,                                 -- Notion ミラー行の page id
  status          TEXT NOT NULL DEFAULT 'form_only',    -- form_only | linked
  reminder_count  INTEGER NOT NULL DEFAULT 0,           -- 催促送信回数（上限ガード用）
  email_sent_at   TEXT,                                 -- 直近メール催促時刻（ISO8601）
  sms_sent_at     TEXT,                                 -- 直近SMS催促時刻（次段）
  return_to       TEXT,                                 -- 連携リンクの return_to（許可ホストのみ）
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  linked_at       TEXT,                                 -- LINE 連携完了時刻
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_listing_entries_status ON listing_entries(status);
CREATE INDEX IF NOT EXISTS idx_listing_entries_line_user_id ON listing_entries(line_user_id);
CREATE INDEX IF NOT EXISTS idx_listing_entries_created_at ON listing_entries(created_at);
