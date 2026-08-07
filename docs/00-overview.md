# 00 — 專案總覽

## 這個專案在做什麼

把禾勤藝術有限公司的官方網站 `gleanstudio.com.tw` 從 **ASP.NET MVC 5**（.NET Framework 4.8 + EF6 + SQL Server，跑在 Azure App Service）遷移到 **Cloudflare Workers**（Astro SSR + Hono + D1 + R2）。

**核心約束：公開前台一個 byte 都不能變。** 使用者明確要求「畫面 + URL 全都不變」。這不是「視覺上看起來一樣」，而是渲染出來的 HTML 與網址都要逐字相同 —— 包含既有的 bug 與怪癖。詳見 [03-url-contract](03-url-contract.md)。

---

## 舊系統現況

| 項目 | 內容 |
|---|---|
| 網域 | `gleanstudio.com.tw`（實測 A 記錄 → Azure） |
| 主機 | Azure App Service，IIS 10.0，`X-AspNetMvc-Version: 5.2` |
| 資料庫 | Azure SQL（主機與帳號見 `Web.Release.config`，公開文件不轉錄）|
| Solution | 3 個專案：`Gleanstudio`（Web）、`Gleanstudio.Models`（EF6 + Repository）、`Gleanstudio.Service`（Service 層） |
| 框架 | .NET Framework 4.8、MVC 5.2.7、Razor 3、EF 6.5.1 |
| 前端 | Bootstrap 5.1.1（編進單一 `style.css`，268 KB）、jQuery 1.11.1 |
| 內容規模 | 9 張表，Projects 87 筆、Articles 9 篇、ArticleTypes 3 個分類 |

原始碼在 [reference/old/](../reference/old/)，**唯讀**。.NET Framework 4.8 + IIS Express 無法在 macOS 執行，永遠不要嘗試 build 或 run —— 讀它，不要跑它。

---

## 新系統

| 項目 | 選擇 |
|---|---|
| 執行環境 | Cloudflare Workers（**免費方案**） |
| 框架 | Astro SSR（`output: 'server'`）+ `@astrojs/cloudflare` |
| API | Hono，掛在 `/api`，僅供後台使用 |
| 資料庫 | Cloudflare D1（SQLite） |
| 媒體 | Cloudflare R2，key 與舊路徑逐字相同 |
| Session | Astro Sessions API + Workers KV |
| CI/CD | GitHub Actions → Cloudflare |

架構理由見 [02-architecture](02-architecture.md)，每個決策的取捨見 [10-decisions](10-decisions.md)。

---

## 範圍

### 做

- 前台 10 個 action、13 條 URL 逐字移植，HTML 與網址完全不變
- 資料從 SQL Server 搬到 D1，圖片搬到 R2
- 後台重建：保留 Admins / Lims / AdminLims 多管理員權限模型，介面重做，移除 SmartAdmin 佈景
- 密碼從明碼改為雜湊，移除寫死的後門帳號
- GitHub Actions CI/CD，含 preview 與 production 兩套環境
- 三層 parity 驗證機制（byte / DOM / 視覺）

### 不做

- 不改前台的視覺設計、版型、文案、網址
- 不修前台已知的 markup 層 bug（分頁掉參數、Bootstrap 版本錯配、`lang="en"`）—— 清單見 [09-known-issues](09-known-issues.md)，留待第 9 階段與業主逐條處置
- 不修聯絡表單的寄信缺陷（使用者本輪決定原樣保留，理由與風險見 [09-known-issues](09-known-issues.md) §3）
- 不移植 4 個已停用的 view（`CulturalRelic`、`Research`、`Exhibition`、`Digital`）
- 不做多語系（舊站沒有，新站也不加）
- 不改 `reference/old/` 的任何一個檔案

---

## 這一輪（Phase 0）的交付物

只有 harness 與文件，**沒有任何應用程式碼**：

- `CLAUDE.md` —— 索引
- `docs/00` ~ `docs/12` —— 13 篇架構文件
- `.claude/settings.json` 與兩個 skill

`package.json`、`astro.config.mjs`、`wrangler.jsonc`、`src/`、`scripts/`、`.github/` 都還不存在。它們的完整內容寫在對應文件裡，等後續階段照著建立。

階段劃分與每階段的完成條件見 [11-roadmap](11-roadmap.md)。

---

## 需要立刻處理的事

**4 組憑證外洩在 [reference/old/](../reference/old/) 的原始碼裡**，其中兩組與遷移無關、可以立刻輪替。完整清單與處置方式見 [09-known-issues](09-known-issues.md) §2。這件事的優先度高於任何開發工作。

---

## 給接手的人（含 AI agent）

從 [CLAUDE.md](../CLAUDE.md) 的文件索引找到你要的那一篇，不要一次讀完全部。

三個最容易踩到的地雷：

1. **改前台任何一頁之前先讀 [03-url-contract](03-url-contract.md)。** 那份文件是契約，不是參考資料。
2. **`reference/old/` 唯讀。** `.claude/settings.json` 已經用 permissions deny 擋住寫入，但別去繞過它。
3. **日期要用 en-US 格式化**（`20 July 2026`），不是 zh-TW。這是最容易靜默破壞 parity 的一個細節。
