-- 914_diagnosis_leads.sql
-- BOXIV: バッテリー劣化診断（牧場モデル）のリード台帳。
--
-- LIFF フォーム（/diagnosis-form）送信ごとに 1 行作成。spec_API（getVehicleSpecs）の
-- 取得結果を同じ行に追記する（取得不可でも行は必ず作る）。Notion リードリスト DB が
-- 確定したら notion_page_id にミラー行を紐付ける（v1 では未起票のこともある）。
CREATE TABLE IF NOT EXISTS diagnosis_leads (
  lead_id           TEXT PRIMARY KEY,                    -- 採番 (UUID)
  line_user_id      TEXT,                                -- LIFF getProfile（ブラウザ直開きでは NULL）
  display_name      TEXT,                                -- LINE プロフィール表示名
  name              TEXT NOT NULL,                       -- お名前
  email             TEXT NOT NULL,
  phone             TEXT NOT NULL,                       -- 数字のみ 10-11 桁
  vin               TEXT NOT NULL,                       -- 17 桁
  is_tesla          INTEGER NOT NULL DEFAULT 1,          -- WMI によるテスラ判定
  odometer_km       INTEGER NOT NULL,                    -- 走行距離（API に無いためフォーム必須）
  shaken_month      TEXT NOT NULL,                       -- 次回車検 YYYY-MM
  consent           INTEGER NOT NULL DEFAULT 0,
  consented_at      TEXT,                                -- 同意日時（送信時刻）
  utm               TEXT,                                -- 流入 (UTM/campaign JSON)
  -- 以下 spec_API 追記（取得不可は NULL のまま）
  spec_json         TEXT,                                -- specsResponse 生 JSON
  model             TEXT,                                -- my / m3 / ms / mx 等
  trim              TEXT,
  model_year        INTEGER,
  type_of_drive     TEXT,
  battery_soh       REAL,                                -- %
  degradation_pct   REAL,                                -- 100 - batterySoH
  battery_capacity_kwh REAL,
  battery_soh_at    TEXT,                                -- batterySoHTimestamp
  msrp              INTEGER,                             -- totalPrice
  production_date   TEXT,
  -- 運用
  notion_page_id    TEXT,
  status            TEXT NOT NULL DEFAULT '診断依頼',     -- 診断依頼 | API取得不可 | 非テスラ | 診断中 | 結果送付
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_diagnosis_leads_line_user_id ON diagnosis_leads(line_user_id);
CREATE INDEX IF NOT EXISTS idx_diagnosis_leads_status ON diagnosis_leads(status);
CREATE INDEX IF NOT EXISTS idx_diagnosis_leads_created_at ON diagnosis_leads(created_at);
