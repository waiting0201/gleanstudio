# Gleanstudio

禾勤藝術官網 `gleanstudio.com.tw` 從 ASP.NET MVC 5（.NET Framework 4.8 + EF6 + Azure SQL）遷移到 Cloudflare Workers（Astro SSR + Hono + D1 + R2）。

舊系統原始碼在 [reference/old/](reference/old/)，唯讀參考用。

---

## 三條不能違反的規則

1. **[reference/old/](reference/old/) 唯讀，永遠不要 build 或 run。**
   .NET Framework 4.8 + IIS Express 無法在 macOS 執行。讀它，不要跑它。
   `.claude/settings.json` 已用 permissions deny 擋住寫入 —— 不要繞過。

2. **公開前台的 HTML 與 URL 已凍結。**
   任何 markup 變更都必須先更新 `tests/golden/` 並在 PR 說明理由。
   改前台任何一頁之前先讀 [docs/03-url-contract.md](docs/03-url-contract.md)。

3. **密鑰只能透過 `wrangler secret`，不得進 git。**
   舊程式碼裡有 4 組外洩憑證待處理，見 [docs/09-known-issues.md](docs/09-known-issues.md) §2。

---

## 現在做到哪

**Phase 3 進行中**（前台移植）。Astro 專案骨架、版型、資料層、parity 工具都好了；
**Level B parity 20/32**。Project 的分組順序尚未對齊；Contact 與 Articles（含 Pager）尚未移植。
→ [docs/11-roadmap.md](docs/11-roadmap.md)

---

## 文件索引

| 我要… | 讀 |
|---|---|
| 了解整體背景與範圍 | [docs/00-overview.md](docs/00-overview.md) |
| 查舊系統某個 controller / view 的行為 | [docs/01-legacy-inventory.md](docs/01-legacy-inventory.md) |
| 知道系統怎麼組起來、為何選這個 stack | [docs/02-architecture.md](docs/02-architecture.md) |
| **改前台任何一頁** | [docs/03-url-contract.md](docs/03-url-contract.md) ← **必讀** |
| 動資料表 / 寫 query | [docs/04-data-model.md](docs/04-data-model.md) |
| 搬資料或圖片 | [docs/05-migration-runbook.md](docs/05-migration-runbook.md) |
| 做後台 / 權限 / 登入 | [docs/06-admin-spec.md](docs/06-admin-spec.md) |
| 部署、CI、環境變數 | [docs/07-deployment.md](docs/07-deployment.md) |
| 驗證前台是否與舊站一致 | [docs/08-verification.md](docs/08-verification.md) |
| 看已知 bug 與待辦 | [docs/09-known-issues.md](docs/09-known-issues.md) |
| 查某個技術決策為什麼這樣定 | [docs/10-decisions.md](docs/10-decisions.md) |
| 看階段規劃與完成條件 | [docs/11-roadmap.md](docs/11-roadmap.md) |
| 把 DNS 從 HiNet 換到 Cloudflare | [docs/12-dns-cutover.md](docs/12-dns-cutover.md) |

---

## 常用指令


```bash
# 資料（已可用）
npm run export             # 本機 SQL Server → data/export/
npm run hash               # 明碼密碼 → PBKDF2 雜湊
npm run seed:build         # → db/seed/0001-data.sql
npm run db:migrate         # wrangler d1 migrations apply --local（加 :remote 走遠端）
npm run db:seed            # 灌資料（加 :remote 走遠端）
npm run media:upload       # 圖片 → R2（加 :remote）

# 驗證（已可用，都支援 --remote）
npm run golden             # 從正式站擷取 golden 基準 → tests/golden/
npm run verify:d1
npm run verify:media

# 前台（已可用）
npm run dev                # astro dev
npm run build
npm run preview            # build → 重啟 wrangler dev → 跑 parity（一律用這個驗證）
npm run parity             # 只跑比對；npm run parity -- /Home/About 指定單頁
                           # 加 --level a 看 byte 差異細節
```

舊資料庫在本機 Docker 容器 `sqlserver`（`localhost:1433`，資料庫 `gleanstudio`）。
sa 密碼在 `docker inspect sqlserver` 的環境變數，**不是** `Web.config` 裡那組。

---

## 目錄地圖

```
CLAUDE.md          這個檔
docs/              13 篇架構文件（繁體中文）
reference/old/     舊 ASP.NET 系統 —— 唯讀，gitignored
.claude/           settings.json + 2 個 skill

scripts/           匯出 / seed / 上傳 / golden / 驗證（已有）
db/migrations/     D1 migration（已有）
db/seed/           產生物，gitignored
tests/golden/      從正式站抓的 HTML 基準（進版控，35 頁）
data/              資料庫匯出 —— gitignored，只有 manifest 與 legacy-order 進版控
wrangler.jsonc     D1 / R2 binding（已有；Phase 3 補 main 與 assets）

以下在 Phase 3 之後才會出現：
src/pages/         Astro 路由，檔名逐字對應舊網址（Home/About.astro → /Home/About）
src/components/    版型元件；pages/ 子目錄放整頁元件
src/db/            Drizzle schema + 查詢
src/lib/           auth / media / contact / query 工具
public/Content/    從 reference/ 逐字複製的 CSS 與圖
```

---

## 專案慣例

- **GUID 一律小寫**（正式站輸出的就是小寫）
- **日期用 en-US 格式化**，輸出如 `20 July 2026`（不是 zh-TW —— 這是最容易靜默破壞 parity 的細節）
- D1 的 datetime 存 ISO8601 UTC 字串，渲染時用 UTC，不做時區轉換
- R2 key 用 `Upload/{Entity}/{ID}/{Photo}`，與舊路徑逐字相同
- 文件與 UI 文案寫繁體中文
- `astro.config.mjs` 必須設 `compressHTML: false`
- `Articles` 排序一律 `ORDER BY CreateDate DESC, LegacyOrder` —— 有兩組日期並列
- **`wrangler dev` 不會可靠地重載新 build 的 chunk** —— 改完一定要重啟，用 `npm run preview`
- **不要用 `LENGTH()` 比對內容完整性** —— 它數 code point，JS `.length` 數 UTF-16 單位，內文有 🔗 就會差 1。要比就比整串或雜湊

---

## 已知問題

舊程式碼有 4 組外洩憑證（其中 reCAPTCHA 與 SendGrid 應立刻輪替）；聯絡表單很可能從未成功送達過禾勤；前台有多個因 markup 凍結而刻意保留的 bug。

→ [docs/09-known-issues.md](docs/09-known-issues.md)
