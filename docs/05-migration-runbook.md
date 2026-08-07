# 05 — 資料與媒體遷移 runbook

相關：[04-data-model](04-data-model.md)｜[08-verification](08-verification.md)｜[11-roadmap](11-roadmap.md)

---

## 0. 前提：資料與媒體本機都有，且完整

這一節的結論是 2026-08-07 實測得到的，不是假設。

**資料庫**：本機 Docker 容器 `sqlserver`（`mcr.microsoft.com/mssql/server:2022-latest`，對外 `localhost:1433`）裡有 `gleanstudio` 資料庫，9 張表齊全。

**媒體**：資料庫裡 14 筆 `Photo` 參照**全部**在 [reference/old/Gleanstudio/Upload/](../reference/old/Gleanstudio/Upload/) 找得到，**零破圖**。磁碟另有 10 個孤兒檔（4 篇已刪文章 + 6 筆已刪 Services 留下的）。

**與正式站的一致性**（交叉驗證）：

| 檢查項 | 結果 |
|---|---|
| 正式站首頁的 3 個 `ArticleTypes` 圖檔名 | 與本機 DB 的 `Photo` 欄位相符 |
| 正式站的 `Upload/Abouts/1/20250502083239.jpg` | 相符 |
| 正式站最新文章 `96aaa3f5-…/20260720160157.jpg` | 相符 |
| 正式站 `/Home/Service` 沒有任何 Services 圖片 | 與本機 `Services = 0` 相符 |
| 正式站 `/Home/Articles` 兩頁的文章順序 | 與本機 `ORDER BY CreateDate DESC` 相符 |

**所以 Phase 2 完全不需要碰 Azure。**

⚠️ **但書**：本機是**快照**，不是即時鏡像。舊後台在開發期間仍然上線，編輯者隨時可能發佈新內容。所以：

- 開發期間用本機資料 —— 沒問題
- **Phase 8 切換前必須重新取得一份正式站資料** —— 那時才需要 Azure 存取。見 §7

---

## 1. Step 1 — 密鑰處置（先做）

在動任何資料之前，先處理 [09-known-issues](09-known-issues.md) §2 列出的 4 組外洩憑證：

- **reCAPTCHA secret** 與 **SendGrid API key** —— **立刻輪替**。遷移完全不需要它們
- **Azure SQL `wadmin` 密碼** —— 遷移完成後輪替（Phase 8 重新同步時還要用）
- **本機 `sa` 密碼**（`twvsjp0205`，寫在 `Web.config`）—— 隨舊系統下線一併作廢。注意這組**在本機 Docker 容器無效**，容器的密碼在 `docker inspect sqlserver` 的 `MSSQL_SA_PASSWORD`

另外確認 `reference/old/` 過去有沒有被推上公開 remote。它在這個 repo 是 gitignored，但這份程式碼是從別的地方來的。

---

## 2. Step 2 — 從本機匯出

`scripts/export-mssql.mjs`，用純 JS 的 TDS 驅動（`mssql` 套件，不需要 ODBC）。

```bash
npm i -D mssql

# 容器密碼：docker inspect sqlserver --format '{{range .Config.Env}}{{println .}}{{end}}' | grep SA_PASSWORD
MSSQL_URL='mssql://sa:PASSWORD@localhost:1433/gleanstudio?encrypt=false&trustServerCertificate=true' \
  node scripts/export-mssql.mjs --out data/export
```

**行為**：對 9 張表各做一次查詢，寫出 `data/export/<Table>.json` 與 `data/export/manifest.json`（記錄每張表的列數、每個檔的 SHA-256、ISO 時間戳）。

**`Articles` 要特別處理** —— 必須帶出掃描順序，理由見 [04-data-model](04-data-model.md) §5：

```sql
SELECT *, ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS ImportSeq FROM Articles;
```

**正規化就在這一層做完**，不要留到後面：

- GUID → `.toLowerCase()`
- `datetime` → `.toISOString()`
- `bit` → `0` / `1`

**版控規則**：`data/` 進 `.gitignore`（裡面有明碼管理員密碼），但 `data/export/manifest.json` **要**進版控 —— parity 的宣稱只在特定資料快照下成立，沒有 manifest 就無從判斷 golden 是對照哪一份資料抓的。

### `anomalies.json`

同時產出 `data/export/anomalies.json`，內容包含：

| 檢查 | 為什麼重要 |
|---|---|
| 重複的 `(ArticleTypeID, CreateDate)` | 排序並列風險，見 [04-data-model](04-data-model.md) §5 |
| 重複的 `Admins.Username` | 新 schema 有 `uq_admins_username`，會擋下 |
| 違反 `(ParentID, Key)` 唯一的 `Lims` 列 | 新 schema 有 `uq_lims_parent_key`，會擋下 |
| 孤兒外鍵 | STRICT + FK 會擋下 |
| 不符 `^\d{14}\.[A-Za-z0-9]+$` 的 `Photo` 值 | R2 路由的 regex 會拒絕 |

**這個檔案要逐條讀過再往下走。** 每一條都是一個決定，不是警告。

已知目前的內容：`ff829f70-…` 分類有 3 筆 `CreateDate = 2026-01-01` 的文章 —— 這正是 `ImportSeq` 存在的原因，不需要額外處理，但要確認它仍然只影響 `/Home/Articles?p=2` 而不影響首頁。

---

## 3. Step 3 — 轉成 D1 seed SQL

`scripts/build-seed-sql.mjs` → `db/seed/0001-data.sql`

**插入順序**（外鍵相依）：

```
Lims → Admins → AdminLims → ArticleTypes → Articles → Services → Teams → Projects → Abouts
```

**三個容易踩的地雷**：

1. **不要寫 `BEGIN TRANSACTION` / `COMMIT`** —— D1 的 import 會拒絕
2. **每個 multi-VALUES `INSERT` 約 200 列一批。** `Articles.Description` 是 Summernote 產生的 `nvarchar(max)` HTML，很大；批次太大 D1 會回 "Statement too long"。總資料量很小（遠低於 5 GiB 的 `--file` 上限），所以這純粹是單一敘述長度的問題
3. **單引號要成對跳脫**，不要直接字串串接

`Admins` 的 `PasswordHash` 來自 Step 4，**絕對不要寫入明碼**。

---

## 4. Step 4 — 密碼雜湊

`scripts/hash-passwords.mjs` 讀匯出資料裡的明碼 `Password` 欄位，產生 PBKDF2 雜湊寫入 `data/export/admin-hashes.json`（gitignored）。

格式與參數見 [06-admin-spec](06-admin-spec.md) §3。

**同時設 `MustChangePassword = 1`。** 理由：舊的 `Password` 是 `nvarchar(20)` 明碼，而且存在一個帳密曾經進過版控的資料庫裡，必須視為已洩漏。設這個旗標可以讓現有編輯者不被鎖在外面（登入後強制改密碼），同時終結曝險。代價只是後台多一個畫面。

目前只有 1 個管理員帳號，所以這件事的操作成本接近零。

---

## 5. Step 5 — 灌進 D1

```bash
npx wrangler d1 create gleanstudio
# 把回傳的 database_id 填進 wrangler.jsonc

npx wrangler d1 migrations apply gleanstudio --local
npx wrangler d1 execute gleanstudio --local --file=db/seed/0001-data.sql
```

**驗證**（本機通過之後才碰 remote）：

```bash
# 逐表列數對照 manifest.json
npx wrangler d1 execute gleanstudio --local --command \
  "SELECT 'Articles', COUNT(*) FROM Articles
   UNION ALL SELECT 'Projects', COUNT(*) FROM Projects
   UNION ALL SELECT 'ArticleTypes', COUNT(*) FROM ArticleTypes
   UNION ALL SELECT 'Lims', COUNT(*) FROM Lims
   UNION ALL SELECT 'AdminLims', COUNT(*) FROM AdminLims
   UNION ALL SELECT 'Admins', COUNT(*) FROM Admins
   UNION ALL SELECT 'Teams', COUNT(*) FROM Teams
   UNION ALL SELECT 'Services', COUNT(*) FROM Services
   UNION ALL SELECT 'Abouts', COUNT(*) FROM Abouts"
```

預期（本機快照）：Articles 9、Projects 87、ArticleTypes 3、Lims 9、AdminLims 6、Admins 1、Teams 1、Services 0、Abouts 1。

**還要抽驗一筆含中文與 HTML 的 `Description` 有沒有原封不動地繞一圈回來** —— UTF-8 經過 JSON 再經過 SQL 字面值，是最可能默默壞掉的環節。

本機驗證通過後：

```bash
npx wrangler d1 migrations apply gleanstudio --remote
npx wrangler d1 execute gleanstudio --remote --file=db/seed/0001-data.sql
```

---

## 6. Step 6 — 媒體上 R2

**來源是 [reference/old/Gleanstudio/Upload/](../reference/old/Gleanstudio/Upload/)**（已驗證涵蓋所有 DB 參照）。

```bash
npx wrangler r2 bucket create gleanstudio-media

node scripts/upload-r2.mjs --dir reference/old/Gleanstudio/Upload \
  --bucket gleanstudio-media --local
# 本機驗證後
node scripts/upload-r2.mjs --dir reference/old/Gleanstudio/Upload \
  --bucket gleanstudio-media --remote
```

**key 與舊路徑逐字相同**：`Upload/Articles/{guid}/{yyyyMMddHHmmss}.jpg`。`contentType` 由副檔名決定，`cacheControl` 設 `public, max-age=31536000, immutable`。

總量約 40 MB，用 `wrangler r2 object put` 迴圈就夠。要是之後長大，再換成 `@aws-sdk/client-s3` 打 S3 相容 API。

**10 個孤兒檔一併上傳無妨**（省得日後有人恢復刪除的資料時找不到圖），但要在 manifest 標記它們是孤兒。

### `scripts/verify-media.mjs`

- D1 裡每一筆 `Photo` 都有對應的 R2 key
- 每個 R2 key 都有對應的 D1 資料列（沒有也無害，但要知道）
- byte 長度與來源檔相符

---

## 7. Step 7 — Phase 8 切換前的重新同步

**這是唯一需要 Azure 存取的步驟。**

正式站的資料庫是 Azure SQL：`tcp:weypro.database.windows.net,1433` / `gleanstudio` / `wadmin`（連線字串在 [Web.Release.config:13](../reference/old/Gleanstudio/Web.Release.config#L13)，同時也是待輪替的憑證之一）。

1. Azure Portal → SQL server `weypro` → Networking → Firewall rules → 加入這台機器的對外 IP（`curl -s https://ifconfig.me`）
2. 對編輯者宣告內容凍結，並停用舊後台（Azure App Service 停機，或對 `/backend` 做 IP 限制）
3. 用同一支 `scripts/export-mssql.mjs`，只換連線字串：

   ```bash
   MSSQL_URL='mssql://wadmin:PASSWORD@weypro.database.windows.net:1433/gleanstudio?encrypt=true' \
     node scripts/export-mssql.mjs --out data/export
   ```
4. 媒體改從正式站抓（`scripts/fetch-media.mjs`）：檔案清單**由 DB 匯出結果產生**，不是掃目錄；對每一筆 `GET https://gleanstudio.com.tw/{path}`，併發 4，404 記進 `media/missing.json`
   - 正式站抓不到的備援：Azure App Service Kudu（`https://<app>.scm.azurewebsites.net/api/zip/site/wwwroot/Upload/`）或 FTPS
   - **預期會有少數 DB 列指向已被刪除的檔案。舊站對這些會渲染破圖，新站也應該渲染破圖** —— 不要塞替代圖，那是 markup 變更
5. 重跑 Step 3 ~ 6
6. 重跑 parity 套件（[08-verification](08-verification.md)）

Step 2 ~ 6 全部是冪等的，可以放心重跑。

---

## 8. 完成條件

- [ ] reCAPTCHA 與 SendGrid key 已輪替
- [ ] `data/export/manifest.json` 存在且進版控
- [ ] `data/export/anomalies.json` 已逐條讀過
- [ ] 本機 D1 各表列數與 manifest 相符
- [ ] 含中文的富文本欄位抽驗無誤
- [ ] `verify-media.mjs` 全綠
- [ ] 遠端 D1 與 R2 內容與本機一致
