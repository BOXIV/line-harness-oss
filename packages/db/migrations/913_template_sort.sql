-- 913_template_sort.sql
-- BOXIV: テンプレート管理の手動並び替え。
-- templates.sort_order: カテゴリ内の表示順。0 = 未並び替え（従来どおり作成日新しい順で先頭側）。
-- 並び替え保存時に 1..n を振る。
-- template_categories: カテゴリ（templates.category の自由文字列）の表示順マスタ。
-- 行は GET /api/template-categories が既存カテゴリから遅延生成する。
-- sort_order 999999 = 未並び替え（名前順で末尾に付く）。
ALTER TABLE templates ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS template_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 999999,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
