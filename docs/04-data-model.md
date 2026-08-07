# 04 — 資料模型

舊系統：SQL Server，資料庫 `gleanstudio`，schema `dbo`，EF6 Database-First（`Model1.edmx`）。
新系統：Cloudflare D1（SQLite），schema 定義在 `src/db/schema.ts`（Drizzle），migration 在 `db/migrations/`。

本文的欄位定義取自**本機 `gleanstudio` 資料庫的 `INFORMATION_SCHEMA`**（2026-08-07 實查），不是從 `.edmx` 推測。

相關：[03-url-contract](03-url-contract.md)｜[05-migration-runbook](05-migration-runbook.md)｜[06-admin-spec](06-admin-spec.md)

---

## 1. 型別對照

| SQL Server | D1 / SQLite | 慣例 |
|---|---|---|
| `uniqueidentifier` | `TEXT` | **一律小寫**、36 字元、含連字號。正式站 HTML 輸出的就是小寫（`ArticleTypeID=ff829f70-4d55-…`），匯入與寫入時都要正規化 |
| `int IDENTITY` | `INTEGER PRIMARY KEY AUTOINCREMENT` | SQLite 的 rowid 別名 |
| `int` | `INTEGER` | |
| `nvarchar(n)` | `TEXT` | SQLite 不強制長度，**改在 Zod 層強制**以保留舊系統的限制 |
| `nvarchar(max)` | `TEXT` | 富文本 HTML |
| `datetime` | `TEXT` ISO-8601 `YYYY-MM-DDTHH:MM:SS.SSSZ` | 字典序 = 時序。**逐字保存 SQL Server 的值當作 UTC，渲染時也用 UTC**，舊站沒有做任何時區轉換，我們多做就會位移顯示的日期 |
| `bit` | `INTEGER NOT NULL CHECK (x IN (0,1))` | |

所有表都用 `STRICT`。D1 支援，而且既然是手工移植 schema，讓 SQLite 在寫入時就拒絕字串型的 `Sort` 值，值得那一點匯入時的摩擦。

### ⚠️ 不要用 `LENGTH()` 判斷內容是否完整

SQLite 的 `LENGTH()` 數的是 **code point**，JavaScript 的 `.length` 數的是 **UTF-16 單位**。內文裡只要有一個 BMP 外的字元（實際資料中就有 🔗），兩者就會差 1 —— 看起來像資料被截斷，其實完全正常。

Phase 2 驗證時真的踩到這個：兩篇文章的長度「對不上」，追下去發現是這個計數差異，資料本身逐字相符。**要比就比整個字串或它的雜湊**，`scripts/verify-d1.mjs` 就是這樣做的。

---

## 2. 舊 schema 實況

### 2.1 各表列數（本機快照，2026-08-07）

| 表 | 列數 |
|---|---|
| Abouts | 1 |
| AdminLims | 6 |
| Admins | 1 |
| Articles | 9 |
| ArticleTypes | 3 |
| Lims | 9 |
| Projects | 87 |
| Services | **0** |
| Teams | 1 |

`Services = 0` 不是資料缺漏 —— 正式站 `/Home/Service` 確實沒有輸出任何 `Upload/Services/` 圖片，兩邊一致。磁碟上的 6 個 Services 圖檔是已刪除資料留下的孤兒檔。

### 2.2 索引現況

**9 張表只有主鍵索引，沒有任何其他索引。** 包含 `Admins.Username` 也沒有唯一索引 —— 唯一性只靠 `AjaxController.CheckUsername` 這個 client 端 AJAX 檢查，有 race condition。

### 2.3 外鍵與串聯行為

| 外鍵 | 子表 | 父表 | ON DELETE |
|---|---|---|---|
| `FK_AdminLims_Admins` | AdminLims | Admins | **CASCADE** |
| `FK_AdminLims_Lims` | AdminLims | Lims | NO ACTION |
| `FK_Articles_ArticleTypes` | Articles | ArticleTypes | NO ACTION |
| `FK_Lims_Lims` | Lims | Lims | NO ACTION（自我參照） |
| `FK_Services_ArticleTypes` | Services | ArticleTypes | **CASCADE** |

`Projects`、`Teams`、`Abouts` 無外鍵。

### 2.4 IDENTITY 欄位

只有 `Admins.AdminID` 與 `Lims.LimID`。**`Abouts.AboutID` 不是 IDENTITY** —— 程式碼一律寫死 `AboutID = 1`，是單列表。

---

## 3. D1 DDL

`db/migrations/0000_init.sql`：

```sql
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
```

### 刻意偏離逐字移植的地方

新舊 schema 的欄位差異只有以下這些（已用 `sqlite3` 載入 DDL 後與本機 `INFORMATION_SCHEMA` 逐欄比對確認）。每一處都在 [10-decisions](10-decisions.md) 留有紀錄：

| 變更 | 理由 |
|---|---|
| `Admins.Password` → `Admins.PasswordHash` | 舊欄位是 `nvarchar(20)` 明碼。**這是唯一被移除的舊欄位。** 見 [06-admin-spec](06-admin-spec.md) §3 |
| 新增 `Admins.IsSuperAdmin` | 取代寫死的 `AdminID = 888` 後門，改成可稽核、可撤銷的資料列 |
| 新增 `Admins.MustChangePassword` | 強制既有管理員首次登入時改密碼，見 [05-migration-runbook](05-migration-runbook.md) §4 |
| 新增 `Admins.CreatedAt` / `UpdatedAt` | 舊表沒有任何時間戳，稽核時無從追溯 |
| 新增 `Articles.LegacyOrder` | 釘住排序並列，見 §5 |
| 新增 `uq_admins_username` | 舊系統只靠 client 端檢查，有 race |
| 新增 `uq_lims_parent_key` | 讓權限查詢的精確比對可證明唯一。**若匯入時違反這個約束，那本身就是一個發現** |
| 新增 8 個查詢用索引 | 舊資料庫**只有主鍵索引**，見 §4 |

---

## 4. 索引與其對應的查詢

每個索引都對應一個實際查詢，沒有預防性索引。

### `idx_articletypes_sort`
**每一個前台請求都會打到** —— header 的「專業服務項目」下拉選單需要全部 `ArticleTypes` 依 `Sort` 排序。舊站是 `BaseController.OnActionExecuting` 全域注入。

```sql
SELECT * FROM ArticleTypes ORDER BY Sort;
```

### `idx_articles_type_createdate`
同時服務兩個熱查詢。

**(a) 文章列表（可選分類篩選）**：
```sql
SELECT * FROM Articles
WHERE (?1 IS NULL OR ArticleTypeID = ?1)
ORDER BY CreateDate DESC, LegacyOrder
LIMIT 6 OFFSET ?2;
```

**(b) 首頁「每個分類最新一篇」**。舊站是 EF 的 `GroupBy → OrderByDescending → FirstOrDefault`（[HomeController.cs:47-51](../reference/old/Gleanstudio/Controllers/HomeController.cs#L47-L51)），在 SQLite 改寫成相關子查詢：

```sql
SELECT a.* FROM Articles a
JOIN ArticleTypes t ON t.ArticleTypeID = a.ArticleTypeID
WHERE a.ArticleID = (
  SELECT a2.ArticleID FROM Articles a2
  WHERE a2.ArticleTypeID = a.ArticleTypeID
  ORDER BY a2.CreateDate DESC, a2.LegacyOrder LIMIT 1)
ORDER BY t.Sort;
```

### `idx_projects_group`
`/Home/Project` 要把 87 筆 `Projects` 一次分成 Type → Place → Title → Sort 四層。

### `idx_adminlims_admin` / `uq_adminlims_admin_lim`
後台每個請求都要查一次 `(AdminID, LimID)` 的權限。

---

## 5. 排序並列 —— `LegacyOrder` ⚠️

**問題**：`/Home/Articles` 是 `ORDER BY CreateDate DESC`，而資料裡有**兩組**並列（2026-08-07 實測）：

| CreateDate | 篇數 | 備註 |
|---|---|---|
| `2026-01-02` | 3 | **分屬不同分類** |
| `2026-01-01` | 3 | 同屬 `ff829f70-…` |

並列時的順序在 SQL Server 與 SQLite 都是**未定義**的。

⚠️ **注意這兩個檢查不能合併**：列表是跨分類排序，所以影響它的是 **`CreateDate` 單獨並列**；而首頁的「每分類最新一篇」才需要看 `(ArticleTypeID, CreateDate)`。`anomalies.json` 兩種都會列。

**曾經試過但行不通的做法**：用 `ROW_NUMBER() OVER (ORDER BY (SELECT NULL))` 取 SQL Server 的實體掃描順序。實測結果 —— 它對 2026-01-01 那組碰巧吻合，對 2026-01-02 那組**不吻合**。掃描順序不等於 `ORDER BY` 的並列輸出順序，這條路是死的。

**正確做法：從 oracle 取順序。** 正式站的實際輸出就是唯一可靠的來源。`scripts/capture-golden.mjs` 逐頁爬 `/Home/Articles`，把跨頁的顯示順序寫進 `data/export/legacy-order.json`：

```json
{
  "order": { "96aaa3f5-…": 1, "2c22a9d8-…": 2, "e016d09a-…": 3, "18cacc7a-…": 4, … }
}
```

seed 建構時把這個名次寫進 `Articles.LegacyOrder`，所有涉及 `Articles` 排序的查詢都加 `, LegacyOrder` 作為次要排序。

**這也意味著 Phase 1（golden 擷取）是 Phase 2（資料遷移）的前置**，不只是時效性考量 —— 沒有 golden 就沒有 `LegacyOrder`。

**但書**：

- `LegacyOrder` 只釘住擷取當下的順序。新文章由新後台寫入時設為 `MAX(LegacyOrder) + 1`
- 它是為 parity 而存在的相容性欄位，不是領域概念。等 [09-known-issues](09-known-issues.md) 的分頁 bug 被清償、markup 解凍之後，可改用 `CreateDate DESC, ArticleID` 這種真正決定性的排序並移除它
- **每次重新擷取都要重跑** —— 內容變動會改變名次

**首頁目前安全**：三個分類的最新日期都唯一，`anomalies.json` 沒有 `homepage-latest-tie`。但這個保證會隨資料改變，每次匯出都要重看。

---

## 5a. D1 的大小限制 ⚠️ 會影響 seed 做法

[D1 的平台限制](https://developers.cloudflare.com/d1/platform/limits/)裡有兩條直接影響這個專案：

| 限制 | 值 | 我們的狀況 |
|---|---|---|
| 單一 SQL 敘述長度 | **100 KB** | ❌ **9 篇文章有 7 篇超過** |
| 單一字串 / 單列大小 | 2 MB | ⚠️ 最大 1.73 MB，餘裕不多 |
| 資料庫大小（免費方案） | 500 MB | ✓ 目前約 6 MB（實測 `size_after` 6,443,008 bytes） |
| compound SELECT 項數 | **遠端比本機嚴** | ⚠️ 6 個 `UNION ALL` 的查詢在遠端被拒（`SQLITE_ERROR 7500 too many terms in compound SELECT`），本機 sqlite3 可過。驗證腳本要逐項分開查 |

原因：`Articles.Description` 是 Summernote 產生的 HTML，裡面**內嵌了 base64 圖片**。

```
1767 KB  base64 圖片 5 張   d6d01a97
1408 KB  base64 圖片 4 張   4772b8a8
1347 KB  base64 圖片 4 張   22acb62c
 826 KB  base64 圖片 4 張   18cacc7a
 430 KB  base64 圖片 2 張   21b3941f
 201 KB  base64 圖片 1 張   2c22a9d8
 122 KB  base64 圖片 1 張   96aaa3f5
   1 KB                    51e3bd0a
   0 KB                    e016d09a
                總計 6.0 MB
```

**所以「一個 INSERT 塞完一列」對 7 篇文章是不可能的。**

### 解法：分段 append

```sql
INSERT INTO Articles (ArticleID, …, Description, …) VALUES ('…', …, '', …);
UPDATE Articles SET Description = Description || '<第 1 段>' WHERE ArticleID = '…';
UPDATE Articles SET Description = Description || '<第 2 段>' WHERE ArticleID = '…';
…
```

每段控制在 **80 KB 以內**（跳脫後計算，留 20 KB 給敘述本身）。1.73 MB 的那篇約需 23 段，全部文章合計約 80 個敘述 —— 完全可接受。

這個做法對 `--local` 與 `--remote` 都適用，不需要改用 D1 REST API 的參數綁定，也就不必為兩種環境寫兩套。

### 為什麼不把 base64 圖片抽出來存 R2

那會把 `<img src="data:image/…">` 變成 `<img src="/Upload/…">`，**渲染出來的 HTML 就變了**，違反 [ADR-001](10-decisions.md#adr-001-前台-html-與-url-完全凍結)。

這件事本身是真的該修（1.7 MB 的新聞頁對使用者很糟），但它屬於 markup 變更，記在 [09-known-issues](09-known-issues.md) 留待第 9 階段。

**另外要注意 2 MB 的單列上限**：現況最大 1.73 MB，只剩 13% 餘裕。編輯者在那篇文章再貼一張圖就會超過而寫入失敗。這一點要寫進後台的上傳限制，見 [06-admin-spec](06-admin-spec.md) §8。

---

## 6. Drizzle vs 手寫 SQL

**用 Drizzle ORM**，`src/db/schema.ts` 為單一真相來源，`drizzle-kit generate` 產出到 `db/migrations/`，由 `wrangler d1 migrations apply` 套用。

**理由**：後台有 7 個 CRUD 實體，這正是手寫 SQL 會腐爛的地方 —— 舊系統已經示範過了，同一段上傳邏輯在 `WebMsController` 裡複製了 7 次。Drizzle 給的是型別化的 select（欄位改名在 build 時就爆）加上自動產生的 migration。

**為什麼不全部手寫 SQL**：後台的操作面太寬，手工維護不安全。

**為什麼前台查詢也不另外手寫**：§4 那兩個比較刁鑽的查詢用 Drizzle 的 `sql` 逃生艙（`db.get(sql\`…\`)`）表達比較清楚，但仍然走同一個進入點。分裂成兩套慣用法的代價高於收益。

### 接線注意事項

- `wrangler.jsonc` 設 `"migrations_dir": "db/migrations"`。drizzle-kit 也會寫一個 `meta/` 子目錄，而 `wrangler d1 migrations apply` 只認頂層的 `.sql`，所以可行 —— 但**第一次跑要親眼確認**，不要假設；不行的話改用 `migrations_pattern`。
- `0000_init.sql` 產生後要**手動補上** `STRICT`、`CHECK` 約束與 `DESC` 索引，drizzle-kit 不會產生這些。補完之後就不要再改這個檔。
- 加一個測試斷言每張表的 `PRAGMA table_info` 與 Drizzle schema 相符，讓 `schema.ts` 與實際套用的 migration 之間的漂移在 CI 就失敗，而不是在正式環境。

---

## 7. Lims 權限樹現況

匯入時要保留原樣，新後台的權限比對以此為準（見 [06-admin-spec](06-admin-spec.md) §5）。

| LimID | ParentID | Key | Value | Icon | Sort |
|---|---|---|---|---|---|
| 1 | – | `WebMs` | 網站管理 | `fa-briefcase` | 0 |
| 2 | – | `SettingMs` | 系統管理 | `fa-cog` | 5 |
| 3 | 1 | `ArticleTypes` | 文章分類維護 | – | 0 |
| 4 | 1 | `Articles` | 文章維護 | – | 5 |
| 5 | 1 | `Services` | 服務洽談維護 | – | 10 |
| 7 | 1 | `Teams` | 人員維護 | – | 15 |
| 8 | 1 | `Projects` | 案例維護 | – | 20 |
| 9 | 1 | `Abouts` | 關於禾勤 | – | 25 |
| 6 | 2 | `Admins` | 管理者維護 | – | 0 |

目前唯一的管理員（`AdminID = 1`）持有 LimID 3、4、5、6、8、9 的全權限（IsAdd/IsUpdate/IsDelete 皆為 1），**沒有 LimID 7（Teams）** —— 也就是說現任管理員無法從後台維護團隊成員。這是既有狀態，不是移植造成的，匯入時照樣保留。

**`Key.Contains` 子字串比對的現況**：以目前這 9 筆資料而言，[CheckSessionAttribute.cs:57-58](../reference/old/Gleanstudio/Filters/CheckSessionAttribute.cs#L57-L58) 的子字串比對**碰巧不會誤判** —— 沒有任何一個 Key 是另一個 Key 的子字串。但這是運氣，不是設計；新增一筆叫 `Article` 的 Lims 就會靜默地把 `Articles` 的權限也吃掉。新系統改用精確比對，見 [06-admin-spec](06-admin-spec.md) §5。
