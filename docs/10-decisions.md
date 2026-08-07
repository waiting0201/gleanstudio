# 10 — 技術決策紀錄

ADR 格式。每一則：**決定 / 背景 / 理由 / 代價**。

已定案的不再討論；要推翻某一則，新增一則標記 supersedes，不要改舊的。

---

## ADR-001 前台 HTML 與 URL 完全凍結

**決定**：公開前台的渲染輸出與網址逐字不變，包含既有 bug。不做語意化網址，不做 301。

**背景**：`gleanstudio.com.tw` 已上線多年，網址形如 `/Home/ArticleDetail?ArticleID={guid}`，已被搜尋引擎索引、被外部連結引用。

**理由**：使用者明確決定（2026-08-07）。凍結讓「移植對不對」成為機械可驗證的問題 —— 有正式站當 oracle，byte diff 就是答案。若同時改網址與 markup，每一個差異都要人工判斷是「有意的改動」還是「移植出錯」，驗證成本會爆炸。

**代價**：網址會一直醜下去；已知 markup bug 隨之上線；`ImportSeq` 這種只為 parity 存在的欄位。全部記在 [09-known-issues](09-known-issues.md)，留待第 9 階段清償。

---

## ADR-002 Astro SSR 而非 Nuxt 或純 Hono

**決定**：Astro（`output: 'server'`）+ `@astrojs/cloudflare`。

**理由**：

- 檔案路由**保留大小寫**，`src/pages/Home/About.astro` 直接就是 `/Home/About`，不需要任何 rewrite 設定
- Astro 元件可以直接放原始 HTML —— 在 ADR-001 的前提下，這是把 Razor markup 搬過來最省力的路徑。Vue template 要轉 `v-for`/`v-if` 語法，每一次轉換都是一次引入差異的機會
- 查詢字串不參與路由，用 `Astro.url.searchParams` 讀，這比動態路由片段更貼近 MVC 的 model binding 行為

**否決 Nuxt 3**：markup 要轉成 Vue template，與 ADR-001 的逐字要求相衝突。

**否決純 Hono + JSX**：路由、表單、後台互動全部要自己刻。後台有 7 個實體 CRUD，這個量級值得一個框架。

**代價**：多一層框架建置；Astro Cloudflare adapter 近期 API 有變動（`Astro.locals.runtime` 在 v13 移除），要跟著文件走不能憑記憶。

---

## ADR-003 單一 Worker，Hono 掛在 `/api`

**決定**：一個 Worker 包辦前台、後台、API、媒體。Hono 用 `src/pages/api/[...path].ts` 掛在 `/api`，**只服務後台**。

**理由**：

- 一個部署產物、一組 binding。拆成獨立 API Worker 要多一組 service binding、第二份 `wrangler.jsonc` env 矩陣、第二個 CI job、重複的 D1/R2/KV 設定 —— 為了一個給少數編輯者用的後台，不划算
- 舊站沒有任何 `/api/*` 路徑，所以掛在那裡不可能牴觸 ADR-001
- Hono 的價值在後台的 middleware 鏈（session → 權限 → CSRF → zod 驗證）。前台沒有這些需求，不需要 Hono

**例外**：`POST /Home/Contact` **不走 Hono**。它必須在那個確切網址回傳 HTML（失敗 200 重新渲染、成功 302），所以在 `.astro` 頁面的 frontmatter 直接處理。繞道 Hono 不是得改網址、就是得在 Hono handler 裡渲染 Astro 輸出，兩者都更糟。

---

## ADR-004 `/` 與 `/Home/Index` 用兩個 route 檔共用元件

**決定**：整頁放 `src/components/pages/HomeIndexPage.astro`，`src/pages/index.astro` 與 `src/pages/Home/Index.astro` 各 4 行引用它。

**背景**：實測正式站 `curl /` 與 `curl /Home/Index` 輸出 byte-identical，都是 200，都沒有轉址。

**理由**：Astro 元件不產生任何包裹 markup，所以輸出相同是結構上保證的。

**否決 middleware `context.rewrite('/Home/Index')`**：Astro 文件明確寫著「middleware 在沒有匹配路由時是否執行由 adapter 決定」。把全站最重要的那條 URL 押在未定義行為上不划算。rewrite 只用在大小寫補救（ADR-005），那裡失敗只是美觀問題。

**代價**：兩個 4 行的重複檔案。微不足道。

---

## ADR-005 URL 大小寫用 rewrite 不用 redirect

**決定**：middleware 把已知路徑的大小寫變體 rewrite 到正式大小寫。

**背景**：實測 IIS 對 `/home/about` 回 **200**（直接服務，不轉址）。Astro 大小寫敏感會 404。

**理由**：rewrite 才是行為忠實的選擇 —— IIS 在使用者打的那個網址上回 200，不是把他導去別的地方。用 redirect 會發出舊站從來不發的 301。

**代價**：靜態資源涵蓋不到 —— Workers Assets 在 Worker 之前就處理掉了，middleware 看不到。這個落差記在 [09-known-issues](09-known-issues.md) 4.10，Phase 3 要實測確認。

---

## ADR-006 D1 + R2，不用 Postgres

**決定**：Cloudflare D1（SQLite）存 9 張表，R2 存圖片。

**理由**：Cloudflare 原生，免費額度涵蓋這個規模（Projects 87 筆是最大的表），無外部服務、無額外月費。

**否決 Postgres + Hyperdrive**：型別可以 1:1 對應（`uuid`、`timestamp`、`boolean`）確實比較乾淨，但要多一個外部服務，而且 Hyperdrive 需要付費方案。這個資料規模用不到關聯式資料庫的餘裕。

**否決沿用 SQL Server**：等於保留一台舊主機，違背搬上 Cloudflare 的初衷。

**代價**：型別要手工對應（見 [04-data-model](04-data-model.md) §1）；SQLite 不強制 `nvarchar` 長度，要在 Zod 層補。

---

## ADR-007 R2 key 與舊路徑逐字相同

**決定**：R2 key 就是 `Upload/{Entity}/{ID}/{Photo}`，與舊系統的實體路徑一模一樣。

**理由**：

- 遷移變成純複製，沒有轉換邏輯就沒有轉換 bug
- 「這張圖在不在」永遠可以用一行 `wrangler r2 object get` 回答
- 真要回退到舊系統，路徑仍然解析得到，不需要反向轉換

**代價**：key 裡帶著 `Upload/` 這個來自 ASP.NET 的字眼。無所謂。

---

## ADR-008 用 Drizzle，不全手寫 SQL

**決定**：Drizzle ORM，`src/db/schema.ts` 為單一真相來源。兩個刁鑽查詢用 `sql` 逃生艙。

**理由**：後台有 7 個 CRUD 實體，這正是手寫 SQL 會腐爛的地方 —— 舊系統已經示範過，同一段上傳邏輯複製了 7 次。Drizzle 給型別化 select（欄位改名 build 時就爆）與自動 migration。

**否決全手寫**：後台操作面太寬，手工維護不安全。
**否決前台單獨手寫**：分裂成兩套慣用法的代價高於收益。

**代價**：`0000_init.sql` 產生後要手動補 `STRICT`、`CHECK`、`DESC` 索引（drizzle-kit 不產生這些）。要加一個 `PRAGMA table_info` 的漂移測試。

---

## ADR-009 Session 用 KV，不用 JWT

**決定**：Astro Sessions API + Workers KV。session 只存 `{ adminId, username, isSuper, issuedAt }`。

**理由**：**JWT 沒有伺服器端撤銷能力。** 管理員被移除或權限被撤銷後，有效 token 仍能用到過期。對有權限矩陣的後台這是錯的取捨。

「把權限 blob 簽在 cookie 裡」有同樣問題，加上 `AdminLims` 可能逼近 4 KB cookie 上限，還等於重新發明框架已提供的東西。

KV 的最終一致性在這裡無關緊要：session 登入時寫一次，由同一使用者讀取，後台流量每分鐘個位數。

**明確排除**：**不把權限矩陣快取進 session**。舊系統把 `Session["AdminLims"]` 整包塞進去，造成改權限要重新登入才生效。每請求查 D1（一次索引查詢 ~1 ms）或以 `AdminID` 為 key 快取但寫入時明確失效。

---

## ADR-010 PBKDF2 @ 100k，因為用免費方案

**決定**：Web Crypto PBKDF2-SHA256，100,000 次迭代，格式 `pbkdf2$100000$<salt>$<hash>`。

**背景**（已查證）：

- Workers 對 PBKDF2 迭代數有 **100,000 的硬上限**，超過丟 `NotSupportedError`（workerd#1346）
- Web Crypto 的 `deriveBits` 只支援 HKDF 與 PBKDF2，沒有 scrypt 或 Argon2
- `node:crypto` 在 `nodejs_compat` 下可用（含 `scrypt`），但 scrypt 在 `N=16384` 要 50–100 ms CPU
- **免費方案 CPU 上限 10 ms** → scrypt 跑不完

**理由**：使用者選擇免費方案（2026-08-07）。100,000 低於 OWASP 建議的 600,000，但那是平台上限，不是我們的選擇。仍然遠優於 `nvarchar(20)` 明碼。

**升級路徑**：改用 Workers Paid 後切到 scrypt。雜湊字串已帶演算法前綴，可在登入成功時漸進式重算。記在 [09-known-issues](09-known-issues.md) 3.4。

---

## ADR-011 權限比對改為精確，並加 CI 斷言

**決定**：用 `ROUTE_PERMISSIONS` 明確註冊表 + 精確 SQL 比對，取代 `Key.Contains()`。加 `uq_lims_parent_key` 唯一索引與 CI 斷言。

**背景**：舊系統用 `action.Replace("Add","")` 加 `Key.Contains(controller)` 子字串比對。以目前 9 筆 Lims 資料**碰巧**安全，但新增一筆叫 `Article` 的 Lims 就會靜默吃掉 `Articles` 的權限。

**理由**：把舊系統默默容忍的歧義變成大聲、可修的錯誤。CI 斷言「每個 `ROUTE_PERMISSIONS` 項目恰好解析到一個 `LimID`」，配合唯一索引，也是發現「正式資料有沒有在依賴那個馬虎比對」的方式。

**順帶修正**：`Sort*` 操作對應到 `update` —— 舊系統的對應表根本沒涵蓋它。

**代價**：新增 action 時要記得加註冊表項目。CI 會擋，所以忘不掉。

---

## ADR-012 新增 `Articles.ImportSeq` 釘住排序並列

**決定**：新增 `ImportSeq INTEGER`，匯出時由 `ROW_NUMBER() OVER (ORDER BY (SELECT NULL))` 填入，所有 `Articles` 排序查詢加上 `, ImportSeq`。

**背景**：3 篇文章 `CreateDate` 都是 `2026-01-01`，落在 `/Home/Articles?p=2`。`ORDER BY CreateDate DESC` 對並列的順序在兩個引擎都未定義。正式站目前的順序**無法由任何欄位推導**（`ArticleID` 升降冪、`Photo` 時間戳都對不上），是 SQL Server 的實體掃描順序。

**理由**：在 ADR-001 之下，parity 必須包含排序。這是唯一能忠實重現的做法。

**代價**：一個純相容性的欄位。新後台寫入時要設 `MAX(ImportSeq) + 1`。markup 解凍後可移除，記在 [09-known-issues](09-known-issues.md) 3.5。

---

## ADR-013 媒體來源：本機 `reference/`，切換前才用正式站

**決定**：Phase 2 從 [reference/old/Gleanstudio/Upload/](../reference/old/Gleanstudio/Upload/) 上傳；Phase 8 切換前改從正式站重抓。

**背景**（實測）：DB 的 14 筆 `Photo` 參照**全部**在本機找得到，零破圖。本機 DB 的圖檔名與正式站首頁引用的完全相符。

**理由**：不需要為了開發而動用 Azure 存取權，也不需要對正式站發大量請求。

**但書**：本機是快照不是鏡像。舊後台在開發期間仍然上線，編輯者可能發佈新內容。所以切換前必須重新同步 —— **那時才需要 Azure 存取**。

**代價**：Phase 8 多一個 15 分鐘的重新同步步驟，以及 Azure SQL 防火牆的前置作業。

---

## ADR-014 `compressHTML: false`

**決定**：關掉 Astro 的 HTML 壓縮。

**理由**：Razor 逐字輸出原始碼的空白，Astro 預設壓縮。開著壓縮的話每一頁的空白都不同，[08-verification](08-verification.md) 的 Level A byte parity 直接不可能達成。

**代價**：傳輸量略增。有 gzip/brotli，實務上可忽略。

**這是這類移植最常見的「靜默失去 byte parity」原因**，所以獨立成一則 ADR 而不是埋在設定檔註解裡。

---

## ADR-015 harness 的 `.claude/` 只放三樣東西

**決定**：建 `.claude/settings.json` 與兩個 skill（`port-a-page`、`parity-check`）。不建 Cloudflare 相關 skill、不建 hooks、不建 subagent 定義、不建重述 URL 契約的 skill。

**理由**：

- `settings.json` 的 deny 規則硬性防住失敗代價最大的一件事（改壞唯一一份參考原始碼），allow 規則讓移植過程不被權限提示打斷
- `port-a-page` 是會重複 11 次的流程，寫一次避免 11 次各做各的
- `parity-check` 封裝最容易做錯的判斷：**這個 diff 是真的回歸，還是內容漂移該重新 baseline**

**不建的理由**：

- Cloudflare/wrangler/部署 skill —— 全域已有 `cloudflare`、`wrangler`、`workers-best-practices`，維護得比我們寫的好
- hooks —— `reference/old/` 的防護已由 permissions deny 涵蓋，更簡單
- 重述 URL 契約的 skill —— 那是文件不是流程。複製會產生第二個真相來源，然後漂移
