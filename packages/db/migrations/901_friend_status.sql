-- 901_friend_status.sql
-- BOXIV: 友だちごとに「ステータス」を 1 つ持たせる。
-- ステータスマスタは Notion 出品者DB / 購入者DB の Status プロパティから同期される。

CREATE TABLE IF NOT EXISTS status_options (
  id           TEXT PRIMARY KEY,           -- crypto.randomUUID()
  source       TEXT NOT NULL CHECK (source IN ('seller', 'buyer')),
  notion_id    TEXT NOT NULL,              -- Notion option id
  name         TEXT NOT NULL,
  color        TEXT,                       -- Notion color or hex
  sort_order   INTEGER NOT NULL DEFAULT 0,
  is_archived  INTEGER NOT NULL DEFAULT 0, -- Notion から消えた option は archived
  synced_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (source, notion_id)
);

CREATE INDEX IF NOT EXISTS idx_status_options_source ON status_options (source);

CREATE TABLE IF NOT EXISTS friend_status_assignments (
  friend_id          TEXT PRIMARY KEY REFERENCES friends (id) ON DELETE CASCADE,
  status_option_id   TEXT NOT NULL REFERENCES status_options (id) ON DELETE RESTRICT,
  assigned_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  assigned_by        TEXT                  -- staff_member.id, NULL = system
);

CREATE INDEX IF NOT EXISTS idx_friend_status_assignments_option
  ON friend_status_assignments (status_option_id);
