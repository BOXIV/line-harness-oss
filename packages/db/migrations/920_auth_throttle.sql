-- 920_auth_throttle.sql
-- BOXIV: 管理画面ログインの「試行元」単位のスロットル。
--
-- なぜ要るか:
--   919 時点の総当たり対策はアカウント単位（staff_id）でしか数えていなかった。
--   /api/auth/email/start と /verify は認証不要なので、**メールアドレスを知っている
--   だけの第三者がそのアカウントのスロットル枠を消費できる**。具体的には
--     - verify に無効コードを5回投げると、本人が受け取った正しいコードごと locked になる
--     - start を上限まで叩くと、本人が「コードを送る」を押しても無言で何も起きなくなる
--   どちらも本人には成功と区別できない形で起き、ログイン封じとして成立していた。
--
--   失敗を「攻撃者」に帰属させるには試行元（IP）単位のカウンタが要る。
--   middleware/rate-limit.ts は isolate ごとのメモリで、同じ攻撃者のリクエストが
--   別 isolate に散るため当てにならない（919 のヘッダコメントと同じ理由）。
--
-- 使い方:
--   単一 UPSERT + RETURNING で「窓の切り替え」と「加算」を 1 文で行う（read-then-write しない）。
--   窓をまたいでいれば count を 1 に戻し、そうでなければ +1 する。
CREATE TABLE IF NOT EXISTS auth_throttle (
  bucket            TEXT PRIMARY KEY,  -- 例: 'login_issue:ip:1.2.3.4' / 'login_fail:ip:1.2.3.4'
  count             INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL,     -- JST 文字列（jstNow と同形式）
  updated_at        TEXT NOT NULL
);

-- 期限切れ行の掃除用（放置しても機能は壊れないが、bucket が IP 単位なので溜まる）
CREATE INDEX IF NOT EXISTS idx_auth_throttle_updated ON auth_throttle (updated_at);
