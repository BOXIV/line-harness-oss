-- 928_diagnosis_leads_souba_check.sql
-- BOXIV: 診断フォームを「愛車相場チェック・Battery劣化診断」の統合フォームにする（2609 キャンペーン）。
--
-- 最初の 1 問（お車の種類）でルートが分かれる:
--   ルートA（Tesla Model 3 / Y）= VIN → spec_API → 劣化診断つき（従来どおり）
--   ルートB（その他のテスラ／テスラ以外のEV／VIN不明）= 車種・グレード・初度登録年月を入力 → 相場のみ
--
-- ルートB には VIN が無いが、vin の NOT NULL は外さない（テーブル作り直しを避ける）。
-- ルートB の vin は空文字で入れ、重複判定は vin が空でない時だけ vin を見る（routes/diagnosis-form.boxiv.ts）。
-- 次回車検（shaken_month）は両ルートとも必須のまま（温度と出品提案の時期を決めるキー項目）。
-- 後追いバックフィルの対象は status='API取得不可' AND is_tesla=1 のままで、ルートB（is_tesla=0）は拾われない。
ALTER TABLE diagnosis_leads ADD COLUMN car_type TEXT;          -- tesla_m3 | tesla_my | tesla_other | other_ev（旧フォームの行は NULL）
ALTER TABLE diagnosis_leads ADD COLUMN diagnosis_kind TEXT;    -- 劣化診断 | 相場のみ
ALTER TABLE diagnosis_leads ADD COLUMN entry_source TEXT;      -- richmenu | greeting | ad_souba（不明は NULL）
ALTER TABLE diagnosis_leads ADD COLUMN car_model TEXT;         -- ルートBで選んだ車種（Notion の車種名。例: Nissan SAKURA）
ALTER TABLE diagnosis_leads ADD COLUMN grade TEXT;             -- ルートBのグレード（「わからない」は NULL）
ALTER TABLE diagnosis_leads ADD COLUMN grade_is_free INTEGER NOT NULL DEFAULT 0; -- 1 = 候補に無く自由入力した
ALTER TABLE diagnosis_leads ADD COLUMN first_reg_month TEXT;   -- 初度登録 YYYY-MM（年か月が不明なら NULL）
ALTER TABLE diagnosis_leads ADD COLUMN first_reg_raw TEXT;     -- 選択そのもの（例: "2019以前 / 不明"）
