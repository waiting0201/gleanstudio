-- /Home/Articles 有兩種排序，一個欄位表達不了。
--
-- 舊站兩種查詢都是 OrderByDescending(CreateDate)，但 SQL Server 對並列列的
-- 輸出順序在「有無 WHERE ArticleTypeID」兩種計畫下不一致。同一組 2026-01-01
-- 的資料列，未篩選時是 4772b8a8 → 22acb62c，篩選後是 22acb62c → 4772b8a8。
--
-- LegacyOrder     = 未篩選清單的順序（/Home/Articles）
-- LegacyTypeOrder = 分類篩選後的順序（/Home/Articles?ArticleTypeID=…），每類各自從 1 起算
--
-- 兩者都只能從 oracle 讀，見 docs/04-data-model.md §5、docs/10-decisions.md ADR-012
ALTER TABLE Articles ADD COLUMN LegacyTypeOrder INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_articles_type_legacytypeorder ON Articles(ArticleTypeID, CreateDate DESC, LegacyTypeOrder);
