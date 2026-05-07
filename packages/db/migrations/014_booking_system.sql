-- Migration 014: 撮影予約システム
--
-- BOXIV Lightning 撮影予約Webアプリ向けの新規テーブル。
-- 出品者がLINEから撮影日程を予約 → 管理者が承認するフロー。
--
-- 詳細仕様: listing/schedule-adjustment/booking-system-spec.html
--
-- Apply with:
--   npx wrangler d1 execute line-harness-test --remote \
--     --file=packages/db/migrations/014_booking_system.sql

-- スタッフ対応可能日（シフト）
-- スタッフは1日1エリアでシフトを入れる。120分スロット単位。
CREATE TABLE IF NOT EXISTS staff_availability (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  staff_id TEXT NOT NULL REFERENCES staff_members(id),
  date TEXT NOT NULL,            -- YYYY-MM-DD
  start_time TEXT NOT NULL,      -- HH:MM (例: "10:00")
  end_time TEXT NOT NULL,        -- HH:MM (例: "12:00")
  area TEXT NOT NULL,            -- shutoken / chubu / kinki / kanto_suburban / kyushu / other
  is_booked INTEGER DEFAULT 0,   -- 0=空き / 1=予約済み
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_staff_avail_date_area ON staff_availability(date, area);
CREATE INDEX IF NOT EXISTS idx_staff_avail_staff ON staff_availability(staff_id, date);

-- 撮影予約申請
-- 起点はNotion（または手動）から作成された招待トークン。
-- 出品者がリンクにアクセスして日程を選び、管理者が承認する。
CREATE TABLE IF NOT EXISTS booking_requests (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  friend_id TEXT REFERENCES friends(id),                -- LINE認証後にリンク
  staff_id TEXT REFERENCES staff_members(id),           -- アサインされたスタッフ（変更可能）
  invite_token TEXT UNIQUE NOT NULL,                    -- 専用招待トークン
  notion_page_id TEXT,                                  -- Notion参照元（Phase 2）
  customer_name TEXT,                                   -- お客様名
  prefecture TEXT NOT NULL,                             -- 都道府県
  area TEXT NOT NULL,                                   -- エリアID（自動判定）
  vehicle_info TEXT,                                    -- 車両情報（JSON）
  slot_id TEXT REFERENCES staff_availability(id),       -- 通常エリア: 選択スロット
  -- 「その他の県」用: 希望日時3候補（Phase 2で利用）
  candidate_1_date TEXT, candidate_1_start TEXT, candidate_1_end TEXT,
  candidate_2_date TEXT, candidate_2_start TEXT, candidate_2_end TEXT,
  candidate_3_date TEXT, candidate_3_start TEXT, candidate_3_end TEXT,
  selected_candidate INTEGER,                           -- 「その他」承認時に選ばれた候補番号
  plate_number TEXT,                                    -- ナンバープレート下4桁（1-3桁は0埋め）
  status TEXT DEFAULT 'pending_invite',                 -- pending_invite / pending / approved / rejected / cancelled
  approved_by TEXT REFERENCES staff_members(id),
  approved_at TEXT,
  notes TEXT,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_booking_req_status ON booking_requests(status);
CREATE INDEX IF NOT EXISTS idx_booking_req_friend ON booking_requests(friend_id);
CREATE INDEX IF NOT EXISTS idx_booking_req_staff ON booking_requests(staff_id);
CREATE INDEX IF NOT EXISTS idx_booking_req_token ON booking_requests(invite_token);
