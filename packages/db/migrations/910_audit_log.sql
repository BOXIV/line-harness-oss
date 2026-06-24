-- 910_audit_log.sql
-- BOXIV: 監査ログ（管理画面操作の変更証跡）。
-- 認証ミドルウェア直後の audit-log ミドルウェアが、成功した admin 変更操作
-- (POST/PUT/PATCH/DELETE × 2xx) を 1 行ずつ自動記録する。
-- actor 系は FK を張らない（参照先 staff 削除や env-owner 合成 ID でもログを保全するため）。

CREATE TABLE IF NOT EXISTS audit_log (
  id               TEXT PRIMARY KEY,                  -- crypto.randomUUID()
  line_account_id  TEXT,                              -- アカウントスコープ（NULL=全体/未指定）
  actor_id         TEXT,                              -- staff_members.id / 'env-owner' / NULL(system)
  actor_name       TEXT,                              -- 操作時点のスナップショット
  actor_role       TEXT,                              -- 操作時点のスナップショット（owner/admin/manager/staff）
  action           TEXT NOT NULL,                     -- マシンコード 例: staff.role_update / friend.message_send
  summary          TEXT NOT NULL,                     -- 人が読む日本語一文 例: スタッフの権限を変更
  target_type      TEXT,                              -- friend / staff / template / scenario ...
  target_id        TEXT,
  target_label     TEXT,                              -- 対象の名称スナップショット（解決できた場合）
  method           TEXT NOT NULL,                     -- HTTP メソッド
  path             TEXT NOT NULL,                     -- リクエストパス
  status           INTEGER,                           -- HTTP ステータス
  detail           TEXT NOT NULL DEFAULT '{}',        -- JSON（資格情報・個人情報マスク済みリクエスト本文）
  created_at       TEXT NOT NULL
                     DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor      ON audit_log (actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action     ON audit_log (action);
CREATE INDEX IF NOT EXISTS idx_audit_log_target     ON audit_log (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_account    ON audit_log (line_account_id);
