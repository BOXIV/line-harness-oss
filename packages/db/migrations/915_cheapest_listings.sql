-- 915_cheapest_listings.sql
-- BOXIV: 友だち追加あいさつ2枚目「今販売中のお得なEV」用の最安車両キャッシュ。
-- 日次 cron が lightning.boxiv.co.jp を巡回して更新する（送信時は静的テンプレのまま）。
CREATE TABLE IF NOT EXISTS cheapest_listings (
  rank        INTEGER PRIMARY KEY,                 -- 1..3（安い順）
  listing_id  TEXT NOT NULL,                       -- 掲載ID（URL末尾）
  title       TEXT NOT NULL,                       -- og:title から車名
  price       INTEGER NOT NULL,                    -- 車両本体価格（円）
  mileage_km  INTEGER,                             -- 説明文から取れた場合のみ
  url         TEXT NOT NULL,                       -- 掲載ページURL
  image_url   TEXT,                                -- og:image（ソーシャルカバー・横長）
  fetched_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- 汎用の市場統計（現状は tesla_under_3m = 300万円以下のテスラ台数）
CREATE TABLE IF NOT EXISTS market_stats (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
