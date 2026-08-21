-- 922_template_source.sql
-- BOXIV: テンプレートを「出品者向け / 購入者向け / 共通」で分けて管理する。
-- 語彙は友だち側の分類と揃える（worker: services/source-tag.boxiv.ts / web: lib/friend-source.ts）。
--   'seller' = 出品者向け / 'buyer' = 購入者向け / 'common' = どちらにも使う
-- 既定は 'common'。未分類のテンプレを勝手にどちらかへ寄せない（誤った相手に送る事故を作らない）。
-- CHECK 制約は入れない: ALTER TABLE では付けられず、schema.sql 側にだけ書くと
-- 「新規作成した DB」と「migration を積んだ DB」でスキーマが食い違う（promote-d1 の履歴乖離）。
-- 値の妥当性は worker 側（routes/templates.ts の isTemplateSource）で担保する。
ALTER TABLE templates ADD COLUMN source TEXT NOT NULL DEFAULT 'common';

-- 既存テンプレの初期振り分け。カテゴリ命名がフロー段階＝相手を表しているのでそれを根拠にする。
--   s02_〜s13_ = 出品者フロー（価格提案・撮影・掲載・引取）
--   b04_・b05_ = 購入者フロー（購入エントリー・オリコ審査）
UPDATE templates SET source = 'seller' WHERE category GLOB 's[0-9][0-9]_*';
UPDATE templates SET source = 'buyer'  WHERE category GLOB 'b[0-9][0-9]_*';
UPDATE templates SET source = 'seller'
  WHERE category IN ('sell-flow', 'listing', 'premium-listing', 'app-listing', 'schedule-adjustment');
-- friend-add（友だち追加の挨拶）は出品者・購入者の両方に送るので 'common' のまま残す。

CREATE INDEX IF NOT EXISTS idx_templates_source ON templates (source);
