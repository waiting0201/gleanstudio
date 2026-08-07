PRAGMA defer_foreign_keys = true;

-- ── 權限 ─────────────────────────────────────────────
CREATE TABLE Lims (
  LimID     INTEGER PRIMARY KEY AUTOINCREMENT,
  "Key"     TEXT,
  Value     TEXT,
  Icon      TEXT,
  Sort      INTEGER NOT NULL DEFAULT 0,
  ParentID  INTEGER REFERENCES Lims(LimID)
) STRICT;
CREATE INDEX idx_lims_parent_sort ON Lims(ParentID, Sort);
-- 新增：讓 06 的精確權限查詢可證明無歧義
CREATE UNIQUE INDEX uq_lims_parent_key ON Lims(ParentID, "Key");

CREATE TABLE Admins (
  AdminID            INTEGER PRIMARY KEY AUTOINCREMENT,
  Name               TEXT,
  Username           TEXT NOT NULL,
  PasswordHash       TEXT NOT NULL,          -- 取代明碼 Password
  Email              TEXT,
  IsSuperAdmin       INTEGER NOT NULL DEFAULT 0 CHECK (IsSuperAdmin       IN (0,1)),
  MustChangePassword INTEGER NOT NULL DEFAULT 0 CHECK (MustChangePassword IN (0,1)),
  CreatedAt          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UpdatedAt          TEXT
) STRICT;
CREATE UNIQUE INDEX uq_admins_username ON Admins(Username);   -- 舊系統沒有

CREATE TABLE AdminLims (
  AdminLimID TEXT PRIMARY KEY,
  AdminID    INTEGER NOT NULL REFERENCES Admins(AdminID) ON DELETE CASCADE,
  LimID      INTEGER NOT NULL REFERENCES Lims(LimID),
  IsAdd      INTEGER NOT NULL DEFAULT 0 CHECK (IsAdd    IN (0,1)),
  IsUpdate   INTEGER NOT NULL DEFAULT 0 CHECK (IsUpdate IN (0,1)),
  IsDelete   INTEGER NOT NULL DEFAULT 0 CHECK (IsDelete IN (0,1))
) STRICT;
CREATE UNIQUE INDEX uq_adminlims_admin_lim ON AdminLims(AdminID, LimID);
CREATE INDEX        idx_adminlims_admin    ON AdminLims(AdminID);

-- ── 內容 ─────────────────────────────────────────────
CREATE TABLE ArticleTypes (
  ArticleTypeID TEXT PRIMARY KEY,
  Title         TEXT NOT NULL,
  SubTitle      TEXT,
  Summary       TEXT,
  Description   TEXT,
  BgClass       TEXT,
  Photo         TEXT,
  Sort          INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX idx_articletypes_sort ON ArticleTypes(Sort);

CREATE TABLE Articles (
  ArticleID     TEXT PRIMARY KEY,
  ArticleTypeID TEXT NOT NULL REFERENCES ArticleTypes(ArticleTypeID),
  Title         TEXT NOT NULL,
  Photo         TEXT NOT NULL,
  Description   TEXT NOT NULL,
  CreateDate    TEXT NOT NULL,
  LegacyOrder   INTEGER NOT NULL DEFAULT 0    -- 新增，見 §5
) STRICT;
CREATE INDEX idx_articles_createdate      ON Articles(CreateDate DESC, LegacyOrder);
CREATE INDEX idx_articles_type_createdate ON Articles(ArticleTypeID, CreateDate DESC, LegacyOrder);

CREATE TABLE Services (
  ServiceID     TEXT PRIMARY KEY,
  ArticleTypeID TEXT NOT NULL REFERENCES ArticleTypes(ArticleTypeID) ON DELETE CASCADE,
  Title         TEXT NOT NULL,
  Photo         TEXT NOT NULL,
  Sort          INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX idx_services_type_sort ON Services(ArticleTypeID, Sort);

CREATE TABLE Teams (
  TeamID  TEXT PRIMARY KEY,
  Title   TEXT NOT NULL,
  Summary TEXT NOT NULL,
  Name    TEXT NOT NULL,
  EnName  TEXT,
  Photo   TEXT NOT NULL,
  Sort    INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX idx_teams_sort ON Teams(Sort);

CREATE TABLE Projects (
  ProjectID TEXT PRIMARY KEY,
  Type      TEXT NOT NULL,
  Place     TEXT NOT NULL,
  Title     TEXT NOT NULL,
  SubTitle  TEXT,
  Sort      INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX idx_projects_group ON Projects(Type, Place, Title, Sort);

CREATE TABLE Abouts (
  AboutID     INTEGER PRIMARY KEY,   -- 非 AUTOINCREMENT，程式一律用 1
  Description TEXT,
  Photo       TEXT
) STRICT;
