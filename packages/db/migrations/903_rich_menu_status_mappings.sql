-- 903_rich_menu_status_mappings.sql
-- BOXIV: 顧客ステータス変更時にリッチメニューを自動切替するためのマッピング。
-- 例: 「商談中」(buyer source) → richMenuId X を friend に紐付ける。

CREATE TABLE IF NOT EXISTS rich_menu_status_mappings (
  id                TEXT PRIMARY KEY,             -- crypto.randomUUID()
  status_option_id  TEXT NOT NULL REFERENCES status_options(id) ON DELETE CASCADE,
  rich_menu_id      TEXT NOT NULL,                -- LINE Platform richMenuId
  rich_menu_name    TEXT,                         -- 表示用キャッシュ (LINE 側で削除された場合の参考)
  line_account_id   TEXT REFERENCES line_accounts(id) ON DELETE CASCADE,
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  -- line_account_id が NULL のときは「全アカウント共通マッピング」とみなす
  UNIQUE (status_option_id, line_account_id)
);

CREATE INDEX IF NOT EXISTS idx_rmsm_status
  ON rich_menu_status_mappings (status_option_id);

CREATE INDEX IF NOT EXISTS idx_rmsm_active
  ON rich_menu_status_mappings (is_active);
