-- 通知経路の冪等化テーブル。
-- 値下げ依頼/お問い合わせ (/buyer-form/lead) はクライアントの二重送信（同一内容の多重 POST）を
-- Notion 側の重複判定でしか吸収しておらず、Slack 通知が毎 POST 飛んで重複する
-- （実障害 2026-08-18: 値下げ依頼 2 件がどちらも 2 連投）。
-- dedupe_key = 経路プレフィックス + 内容の SHA-256。短時間ウィンドウ内の同一キーは処理をスキップする。
CREATE TABLE IF NOT EXISTS notify_dedupe (
  dedupe_key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL -- epoch ms（claim 時刻。ウィンドウ判定と掃除に使う）
);
