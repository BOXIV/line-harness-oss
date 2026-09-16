-- 925_listing_entries_flow.sql
-- BOXIV: 台帳の行が「どの入口から連携したか」を持つ（flow 列）。
--
-- source（seller | buyer）は「どの DB・どの人種か」で、Notion の書き込み先・分類タグ・催促 CRON が見る。
-- flow は「どの入口か」で、連携完了イベントの種別を決める（services/listing-entry.boxiv.ts の
-- LINK_COMPLETED_EVENT）。アプリ出品（app_listing）は Web 出品（listing_form）と同じ source='seller'
-- なので、source だけでは follow webhook の救済経路で両者を区別できない。
--
-- 値は services/line-login.boxiv.ts の FlowId と同じ語彙: listing_form | app_listing | buyer_form
--
-- ⚠️ 既定値を付けない。列ができる前の行には Web 出品と購入者が混ざっているため、
--    一律の既定値だと購入者の行が listing_form になる。既存行は source から埋め戻す。
--    NULL のまま残る行（このマイグレーションとコード反映の隙間に入った行）は、読む側が
--    source から補う（resolveEntryFlow）。
--
-- ⚠️ アプリ出品の行は match_key が boxivID（Portal の submit と同じ）で、Web の UUID と形で
--    区別できない。そのためこの migration より前に作られたアプリ起票行（本番には無い。
--    TEST のデバッグ画面由来のみ）は埋め戻しで listing_form のままになる。
--    以後の行はコードが flow='app_listing' を明示する。
ALTER TABLE listing_entries ADD COLUMN flow TEXT;  -- listing_form | app_listing | buyer_form

UPDATE listing_entries SET flow = 'buyer_form'   WHERE flow IS NULL AND source = 'buyer';
UPDATE listing_entries SET flow = 'listing_form' WHERE flow IS NULL AND source = 'seller';
