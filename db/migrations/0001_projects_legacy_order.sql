-- /Home/Project 的分組順序來自舊站的實體掃描順序，無法從欄位推導。
-- 與 Articles.LegacyOrder 同一個模式，見 docs/04-data-model.md §5
ALTER TABLE Projects ADD COLUMN LegacyOrder INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_projects_legacyorder ON Projects(LegacyOrder);
