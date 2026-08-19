-- 919_staff_email_login.sql
-- BOXIV: 管理画面ログインを「APIキー貼り付け」から「メール6桁コード」へ移すためのデータ層。
--
-- このマイグレーションは認証の挙動を変えない（テーブルを足すだけ）。実際に使い始めるのは
-- Worker 側に /api/auth/email/* を足すフェーズ。途中で止めても誰も締め出されない。
--
-- staff_members 自体は変更しない。api_key が TEXT UNIQUE NOT NULL のため列の増減に
-- テーブル再作成が要り、900 でやったのと同じ「作り直しの巻き添えで列が消える」事故
-- （work_area が 900 で落ちて 912 で戻した）を繰り返したくない。
-- メールアドレスは staff_members.email をそのまま使う。

-- ── ログイン用チャレンジ（6桁コード） ────────────────────────────────────────
-- 平文コードは保存しない。SHA-256(code + ':' + id) の hex だけを持つ。
-- id をソルト代わりに混ぜているのは、同じ 6 桁（10^6 通りしかない）でも行ごとに
-- ハッシュが変わるようにして、DB 閲覧者が総当たり表 1 枚で全行を逆引きできないようにするため。
--
-- 総当たり対策はこのテーブルで行う（middleware/rate-limit.ts は isolate ごとの
-- メモリなので Worker では当てにならない）。検証は
--   UPDATE ... SET attempts = attempts + 1
--   WHERE id = ? AND attempts < max_attempts AND used_at IS NULL AND expires_at > ?
-- の単一文で meta.changes を見るアトミック実装にする。
CREATE TABLE IF NOT EXISTS staff_login_challenges (
  id             TEXT PRIMARY KEY,               -- crypto.randomUUID()
  staff_id       TEXT NOT NULL,                  -- staff_members.id（FK は張らない: 削除後も証跡を残す）
  email          TEXT NOT NULL,                  -- 発行時点の宛先スナップショット（後でメール変更されても追える）
  code_hash      TEXT NOT NULL,                  -- SHA-256(code + ':' + id) の hex
  purpose        TEXT NOT NULL DEFAULT 'login',  -- 'login' = 本人がメールで受け取る / 'admin_issued' = 管理者による救済発行
  issued_by_id   TEXT,                           -- 救済発行時の発行者 staff_members.id（'login' では NULL）
  issued_by_name TEXT,                           -- 同 名前スナップショット
  attempts       INTEGER NOT NULL DEFAULT 0,     -- コード検証の試行回数（失敗も成功も加算）
  max_attempts   INTEGER NOT NULL DEFAULT 5,
  expires_at     TEXT NOT NULL,                  -- JST 文字列（jstNow と同形式）
  used_at        TEXT,                           -- 消費済み＝単回。NULL の間だけ有効
  request_ip     TEXT,                           -- 発行元 IP（cf-connecting-ip）。濫用調査用
  created_at     TEXT NOT NULL
                   DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

-- 「この人の未使用チャレンジ」を引く（発行レート制限 / 直近1件の再利用判定）
CREATE INDEX IF NOT EXISTS idx_staff_login_challenges_staff
  ON staff_login_challenges (staff_id, created_at DESC);
-- 期限切れの掃除用
CREATE INDEX IF NOT EXISTS idx_staff_login_challenges_expires
  ON staff_login_challenges (expires_at);

-- ── セッション ───────────────────────────────────────────────────────────────
-- トークンは `lhs_<id>.<secret>` の形。DB には secret の SHA-256 だけを保存し、
-- 平文トークンは発行時のレスポンス以外どこにも残さない。
--
-- JWT にしないのは「無効化を押した次の操作から締め出せる」ことを要件に置いたため。
-- 検証は staff_sessions ⨝ staff_members の 1 クエリで、毎回 is_active と role を引き直す。
--
-- 既存の API キーは `lh_` + 32hex なので、新プレフィクス `lhs_` とは衝突しない。
CREATE TABLE IF NOT EXISTS staff_sessions (
  id             TEXT PRIMARY KEY,               -- トークン前半。lhs_<id> の <id>
  staff_id       TEXT NOT NULL,                  -- staff_members.id（FK は張らない: 削除は routes/staff.ts の cascade で処理）
  secret_hash    TEXT NOT NULL,                  -- SHA-256(secret) の hex
  issued_via     TEXT NOT NULL DEFAULT 'email_code', -- 'email_code' / 'admin_issued'
  user_agent     TEXT,
  ip             TEXT,
  created_at     TEXT NOT NULL,
  last_used_at   TEXT,
  expires_at     TEXT NOT NULL,                  -- 絶対期限（JST 文字列）
  revoked_at     TEXT,                           -- 失効済み。NULL の間だけ有効
  revoked_reason TEXT                            -- logout / staff_disabled / role_changed / email_changed / staff_deleted / admin
);

-- 「このスタッフの生きているセッションを全部失効させる」用（無効化・ロール変更・メール変更）
CREATE INDEX IF NOT EXISTS idx_staff_sessions_staff
  ON staff_sessions (staff_id, revoked_at);
-- 期限切れの掃除用
CREATE INDEX IF NOT EXISTS idx_staff_sessions_expires
  ON staff_sessions (expires_at);

-- ── 監査ログに「どの経路で認証されたか」を残す ───────────────────────────────
-- 現在の audit_log は actor_id/actor_name/actor_role しか持たないため、
-- 「本人のセッション」「共有 API キー」「env の最上位キー」の区別が付かない。
-- 旧方式を止める判断（直近7日で旧キー経由が0件か）を実データで下すために必要。
-- ⚠️ SQLite の ADD COLUMN は IF NOT EXISTS を取れないので、この 2 行だけ冪等ではない。
--    1 行目の適用後・2 行目の適用前に落ちると、履歴に 919 が記録されないまま
--    再実行が duplicate column で止まり、以降の promote が一切進まなくなる。
--    復旧: worker の POST /api/admin/reconcile-schema で列を揃え（PRAGMA 確認つきで冪等）、
--          _boxiv_migrations に 919 を手で記録してから promote を再開する。
--          reconcile 側の EXPECTED にもこの 2 列を登録してある。
ALTER TABLE audit_log ADD COLUMN actor_via TEXT;         -- 'session' / 'api_key' / 'env_key'
ALTER TABLE audit_log ADD COLUMN actor_session_id TEXT;  -- staff_sessions.id（session 経路のみ）

CREATE INDEX IF NOT EXISTS idx_audit_log_actor_via ON audit_log (actor_via, created_at DESC);
