-- 917_diagnosis_leads_spec_retry.sql
-- （916 は未マージの feat/buyer-line-connect が使用済みのため 917 を採番）
-- BOXIV: バッテリー劣化診断リードの spec_API 取得を「失敗しても後から補完できる」形にする。
--
-- 914 の実装は spec_API を 1 回だけ叩き、失敗すると status='API取得不可' のまま
-- NULL が残って誰も再取得しなかった。さらに失敗理由をどこにも残していなかったため、
-- 事後に原因（タイムアウト / 5xx / 認証 / 形式変更）を切り分けられなかった。
--   実例: lead 537809e3-…（2026-08-01）。同じ VIN を後から叩くと 200 OK ＝一過性障害。
--
-- 追加する 3 列で「何回試したか・最後にいつ試したか・何で失敗したか」を残し、
-- cron の後追いバックフィル（services/diagnosis-spec-backfill.boxiv.ts）が
-- 指数バックオフで再取得して D1 と Notion を補完する。
-- spec_attempts は「取得サイクル数」（フォーム送信時=1 / バックフィル1回=1）。
-- バックオフ段数の指標であり、1 サイクル内の HTTP 試行回数は spec_error の "attemptN/M" に残る。
ALTER TABLE diagnosis_leads ADD COLUMN spec_error TEXT;
ALTER TABLE diagnosis_leads ADD COLUMN spec_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE diagnosis_leads ADD COLUMN spec_last_try_at TEXT;

-- バックフィルの候補抽出（status='API取得不可' を古い試行順に拾う）用。
CREATE INDEX IF NOT EXISTS idx_diagnosis_leads_spec_retry
  ON diagnosis_leads(status, spec_last_try_at);
