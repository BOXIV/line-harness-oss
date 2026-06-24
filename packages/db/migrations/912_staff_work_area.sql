-- 912_staff_work_area.sql
-- BOXIV: 撮影スタッフの稼働エリア。
-- 撮影スタッフ(role='staff')が稼働するエリアを staff 単位で持つ。権限発行(スタッフ作成)時に
-- マネージャー以上が設定し、以降も「スタッフ管理」から変更できる。スタッフ自身はシフト登録時に
-- エリアを選ばず、この work_area が自動適用される。
-- 値はエリアID（shutoken / chubu / kinki / kanto_suburban / kyushu / other）。NULL=未設定。
ALTER TABLE staff_members ADD COLUMN work_area TEXT;
