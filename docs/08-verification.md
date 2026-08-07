# 08 — 驗證

**核心命題：舊程式碼跑不起來，但不需要跑 —— 正式站就是 oracle。**

`https://gleanstudio.com.tw` 是活的（實測 200，IIS 10.0，`X-AspNetMvc-Version: 5.2`）。所以「新站輸出對不對」不需要靠閱讀 Razor 原始碼推理，直接抓正式站的 HTML 來比對。這比從原始碼推導強得多。

相關：[03-url-contract](03-url-contract.md)｜[05-migration-runbook](05-migration-runbook.md)

---

## 1. 本機環境驗證

```bash
npm run dev        # astro dev
npm run preview    # astro build && wrangler dev —— 貼近正式環境的形狀

npx wrangler d1 migrations apply gleanstudio --local
npx wrangler d1 execute gleanstudio --local --command "SELECT COUNT(*) FROM Articles"
# 本機 D1 狀態位置：.wrangler/state/v3/d1

npx wrangler r2 object put gleanstudio-media/Upload/Abouts/1/20250502083239.jpg \
  --file reference/old/Gleanstudio/Upload/Abouts/1/20250502083239.jpg --local
```

⚠️ **任何 parity 宣稱都要用 `npm run preview`，不要用 `npm run dev`。** `astro dev` 在資產服務與 HTML 輸出上與實際 build 出來的 Worker 有差異。

---

## 2. golden 基準擷取

`scripts/capture-golden.mjs` 對正式站爬一份固定 URL 清單，加上從資料庫匯出結果取得的每一個 `ArticleTypeID` 與 `ArticleID`，把**原始 bytes** 存進 `tests/golden/<slug>.html`，並記錄狀態碼與 headers。

涵蓋範圍見 [03-url-contract](03-url-contract.md) §8：**35 頁、6.4 MB**（比原估的 500 KB 大得多，因為文章內文有 base64 圖片）。

**直接進版控，這是重點** —— 基準必須能在 diff 裡被審閱。自動覆寫 golden 等於沒有基準。

### 與資料快照的綁定

`manifest.json` 除了狀態碼與 SHA-256，還要記下**當次資料庫匯出的 SHA-256**。parity runner 在本機 D1 的 hash 對不上時**直接拒絕比對**，而不是報一堆假的失敗。

理由：golden 是快照。編輯者一發佈新文章，Level A 就會在每一頁失敗，而且是合理的失敗。要把「內容漂移」和「真的壞了」區分開，唯一的辦法是把兩個快照綁在一起擷取。

### 重新 baseline 的規則

重新擷取 golden 是**一次刻意的、經審閱的 commit**，永遠不是自動覆寫。commit message 要說明是什麼內容變動觸發的。

---

## 3. 三層比對

`scripts/parity-diff.mjs` 打 `http://localhost:8787` 拿同樣的路徑，然後：

### Level A — byte diff

正規化 CRLF → LF 之後逐 byte 比對。

**這是可以達成的目標，不是理想。** 理由：我檢查過每一頁有沒有 per-request 的非決定性內容，結果是**沒有** —— 沒有 CSRF token、沒有時間戳、沒有 cache-buster，連 reCAPTCHA token 都是 client 端注入的。

前提是 `compressHTML: false`（見 [03-url-contract](03-url-contract.md) §3.4）。

**非 gating** —— 失敗會回報但不擋 PR。一個多餘的換行不該擋住合併。

### Level B — DOM 正規化 diff

用 `parse5` 解析，排序屬性、收斂無意義空白，比對樹狀結構。

**這一層是 CI 的 gating 層。** 掉了一個 `class` 會擋 PR，多了一個換行不會。

### Level C — 視覺

Playwright 在 375 / 768 / 1440 三個寬度，同時對正式站與本機截圖，用 `pixelmatch` 比對，閾值 ≤ 0.1%。

抓得到 markup 比對抓不到的東西：CSS 載入失敗、字型 fallback 差異。

**每階段手動跑，不進 CI** —— 慢，而且需要連外網打正式站。

---

## 4. CI 接線

`ci.yml` 在每個 PR 用本機 D1（由 `db/seed/` 灌入）跑 Level B，對照已進版控的 golden。

**一個頁面只有在它的 fixture 通過之後，才能在 [11-roadmap](11-roadmap.md) 標記完成。**

這讓「移植做完了沒」變成一個機械可答的問題，而不是判斷題 —— 這也是這整套 harness 最主要的價值。

---

## 5. 這套方法驗證不了的東西

這一節要誠實。以下五項不在 oracle 的涵蓋範圍內，不要讓它們看起來跟其他部分一樣可信。

### 5.1 `POST /Home/Contact`

**不能對正式站發 POST 測試** —— 會寄出真實郵件、消耗 reCAPTCHA 配額。

它的期望 markup（驗證失敗時重新渲染、帶繁中錯誤訊息、狀態碼 200）只能從 [Contact.cshtml](../reference/old/Gleanstudio/Views/Home/Contact.cshtml) 與 [Contact.cs](../reference/old/Gleanstudio.Models/Partial/Contact.cs) 的 DataAnnotations **手工推導**，存進 `tests/derived/`，並由人審閱。

這是全站唯一一處「沒有 oracle、從原始碼推理」的地方。

**Phase 4 的做法**（`npm run parity:contact`）：拿 `tests/golden/Home-Contact.html`（真的 GET 回應）當底，套上 MVC 重新渲染的三條變換規則產生期望值，寫進 `tests/derived/` 並進版控，再對本機發 POST 比 DOM。

| 情境 | 期望 |
|---|---|
| 全部空白 | 200，五個欄位都是 `input-validation-error` + 對應繁中訊息 |
| Email 格式錯誤 | 200，只有 Email 有錯，其餘值回填 |
| 姓名只有空白 | 200，`Required` 對字串是 `Trim().Length != 0` |
| 欄位合法但 captcha 失敗 | 200，值全部回填、**沒有任何錯誤標示** |

⚠️ **產生器與被測程式是同一個人的同一份推理**，測試綠不代表推理對。防線是 `tests/derived/` 進版控 —— 改產生器就要重讀那份 diff，不能只看測試結果。

**沒涵蓋到的分支**：驗證通過 + captcha 通過 → 302 到 `/` 並寄信。需要真的 reCAPTCHA token，本機驗不了，**Phase 7 soak 用輪替後的 key 實際走一次**。

### 5.2 內容漂移

見 §2 的資料快照綁定。緩解了，但沒有消除 —— 這是快照式基準的固有性質。

### 5.3 錯誤與邊界路徑

實測 `/Home/ArticleDetail?ArticleID=<不存在>` → **500**（`NullReferenceException` + `customErrors="Off"` 的 ASP.NET 黃頁）。

**不重現黃頁。** 新站回 **404**，記為刻意分歧，見 [09-known-issues](09-known-issues.md) §4。

**Phase 1 已把邊界情境全部探測並收進 golden**，結果見 [03-url-contract](03-url-contract.md) §9。額外發現兩個舊站也會 500 的情境：`?p=0` 與 `/Home/Service?ArticleTypeID=<不存在>`。三個 500 都是同一個模式 —— 舊站對找不到的資料一律當機。

### 5.4 Workers Assets 的大小寫敏感度 —— 已實測（2026-08-07）

**結論：大小寫敏感。** `wrangler dev` 實測：

| 路徑 | 結果 |
|---|---|
| `/Content/css/style.css` | 200，`text/css`，268 KB |
| `/content/css/style.css` | **404** |
| `/Scripts/nav.js` | 200 |

附帶觀察：資產沒命中時請求**會落到 Worker**（回的是 Astro 的 404 頁，不是 Workers Assets 的）。所以理論上 middleware 補得起來，但這需要把資產路徑也納入正規化表並改走 `ASSETS` binding。

**判定：接受落差**，記在 [09-known-issues](09-known-issues.md) 4.10。站內不會產生小寫資源網址，影響範圍只有手打網址。`run_worker_first` 沒有乾淨的方式只表達「小寫變體」，不值得。

### 5.5 排序並列

見 [04-data-model](04-data-model.md) §5。`LegacyOrder` 釘住了目前這份資料的順序，但那是把 oracle 觀察到的結果固定下來，不是從規則推導出來的。**資料一改就要重新擷取 golden 並重算**。

#### ⚠️ 「排出來的順序對」不等於「值有被填」

2026-08-07 遇到的真實情境：遠端 D1 套了 migration 但**沒有跑補值**，`LegacyTypeOrder` 整欄都是 0 —— 而 SQLite 對並列列的處理**碰巧**給出了與 golden 完全相同的順序。`verify-d1.mjs` 原本只比對排序結果，於是對一個半套的資料庫按了綠燈。

巧合不是保證。這正是 [ADR-012](10-decisions.md) 一開始就拒絕依賴的東西 —— 只是這次巧合出現在驗證工具這一側。

現在 `verify-d1.mjs` 另外直接驗**值本身**：產生器給的就是 1..N，所以

- `Articles.LegacyOrder` 必須是全域 1..N
- `Articles.LegacyTypeOrder` 必須在**每個分類內**各自是 1..N
- `Projects.LegacyOrder` 必須是 1..N

少一個都失敗。教訓：**驗證一個相容性欄位時，要驗那個欄位，不要只驗它造成的效果** —— 效果可能因為別的原因碰巧正確。

---

## 6. 每階段的驗證動作

| 階段 | 怎麼確認做完了 |
|---|---|
| 1 golden 擷取 | `tests/golden/` 涵蓋 [03](03-url-contract.md) §8 全部項目，manifest 含資料 hash |
| 2 資料 + 媒體 | 逐表列數對照 manifest；中文富文本抽驗；`verify-media.mjs` 全綠 |
| 3 前台移植 | 每個 golden fixture 的 Level B 通過；Level A 差異已審閱，不是零就是在本文件明列豁免 |
| 4 聯絡表單 | GET 的 Level B 通過；POST 對照 `tests/derived/` 人工審閱 |
| 5 後台 | 權限註冊表斷言全綠；7 個實體 CRUD 手動走一遍 |
| 6 CI/CD | 三支 workflow 綠燈；preview URL 可達 |
| 7 soak | parity 套件打**已部署的 URL**（不只本機）；編輯者實際改一筆內容確認渲染正常 |
| 8 切換 | 13 條 URL smoke test + `/Upload/*` 抽驗 + gtag 確認 |

---

## 7. 明列豁免清單

任何無法達成的 markup 差異都要記在這裡，附原因與日期。`scripts/parity-diff.mjs` 的 `EXEMPTIONS` 要與本節一一對應。

### astro-strips-main-comment（2026-08-07）

舊站每頁 body 都以 `<!--main-->` 開頭，**Astro 的編譯器會丟掉版型層的 HTML 註解**。已試過四種寫法全部無效：直接寫在版型、獨立成只含註解的元件、`<Fragment set:html>`、以及 `Astro.slots.render()` 後前綴。

實測出來的規律：**元件模板開頭且後面接元素**的註解才會保留 —— 這也是 `Header` / `Footer` / `Scripts` 的註解留得下來的原因。

**判定：接受。** 零渲染、零 SEO、零行為影響，且是全站唯一一處、內容固定。繼續跟編譯器纏鬥的報酬率太低。

Level B 比對時只從 **golden** 移除這個註解，本機不動 —— 這樣「本機多了什麼」仍然會被抓到。

⚠️ 豁免要連同註解後面的**換行**一起移除（`'<!--main-->\n'`）。只刪註解會留下一個本機不可能產生的空行，讓 Level A 的 byte 比對每一頁都失敗 —— 也就是讓 Level A 這個訊號整個失效。

---

## 7a. 已審閱並接受的 Level A 差異（2026-08-07）

Phase 3 結束時 **Level A 29/31、Level B 31/31**。剩下兩頁的差異都是 Astro 序列化器的正規化行為，不改模板就無法重現：

| 頁面 | 差異 | 判定 |
|---|---|---|
| `/Home/Gallery` | golden `<span class='zoom cursor' id='ex1'>`（單引號），本機輸出雙引號 | 接受。Astro 一律把屬性值序列化成雙引號，來源寫單引號也一樣。要重現只能把整段改成 `set:html` 字串，等於放棄模板 |
| `/Home/Contact` | golden `<input … value="" />`（.NET TagBuilder 的自閉合），本機 `<input … value="">` | 接受。Astro 對 void 元素一律不輸出 ` /`。同上，重現的代價是把整個表單變成字串 |

兩者在 DOM 層完全相同（Level B 通過），瀏覽器行為零差異。

**為了拿到這 29 頁，做過的事**（都是「照抄 Razor 的空白語意」，不是美化）：

- 版型的 `<slot />` 前後空白要精準 —— `_Layout.cshtml` 的 `@{ Html.RenderPartial(…) }` 與 `@RenderBody()` 對周圍空白的處理不同
- 每一頁 view 的**開頭換行數不同**（`@{ }` 區塊、`@model` 指示詞留下的殘餘不同）。`ArticleDetail` / `Contact` / `Gallery` 的 `<Site>` 開標籤後**刻意不換行**
- 迴圈的收尾空白屬於**迴圈之後**而不是每一圈 —— `Index` 的卡片群、`Project` 的分組都踩過
- `htmlEncode()`（`src/lib/format.ts`）重現 `HttpUtility.HtmlEncode` 把 160–255 字元編成數值參考的行為（`·` → `&#183;`）。Astro 的 `{x}` 不會這樣做
- `ArticleDetail` 的 `< BACK` 在舊 view 裡是裸的 `<`，Razor 原樣輸出，Astro 會跳脫 —— 用 `set:html` 還原

---

## 7b. 刻意分歧（parity 工具會略過）

`scripts/parity-diff.mjs` 的 `DIVERGENCES` 列出「我們決定不做那件事」的頁面。與豁免不同 —— 豁免是「輸出幾乎一樣」，這裡是**永遠不會相符**。

| 路徑 | 說明 |
|---|---|
| `/Error/Validation` | 舊站從未實作（404 黃頁），新站回 403 原地渲染。見 [06-admin-spec](06-admin-spec.md) §7、[09-known-issues](09-known-issues.md) 4.2 |

另有 3 頁因為舊站回 5xx 而略過（`p.status >= 500`），見 [09-known-issues](09-known-issues.md) §4。

**把它們留在紅燈裡不是誠實，是讓 gate 失去意義** —— 一個永遠紅的 gate 沒有人會看。

---

## 7c. 驗證腳本自己踩過的坑

**「目錄裡第一個 `.sqlite`」不是找本機 D1 的可靠方法。**

`verify-d1.mjs` 原本這樣挑檔案，一直沒事 —— 直到用 `CLOUDFLARE_ENV=preview` build 了一次，`.wrangler/state/v3/d1/` 就多出第二個（空的）資料庫，然後它挑到那一個，報出 `no such table: Lims`。**看起來像資料損壞，其實是挑錯檔。**

miniflare 的檔名是內部雜湊，不是 database id 或名稱的 sha256（試過都不是），逆向它只會得到一個脆弱的耦合。

現在的做法：挑**真的有 schema 的那一個**，**多於一個就報錯不猜**，並提供 `--db <路徑>` 手動指定。

這跟 §7 的教訓是同一條：**驗證工具的失敗會偽裝成被驗證對象的失敗。**

---

## 8. 擷取工具本身踩過的坑

**golden 檔名不能只靠大小寫區分。** macOS 的 APFS 預設不分大小寫，所以 `Home-About.html` 與 `home-about.html` 是同一個檔 —— `/Home/About` 與 `/home/about` 的擷取結果互相覆蓋，而這兩條正是用來驗證大小寫行為的。等於把要驗的東西自己抹掉，還會讓移植端看到假的失敗（「golden 說連結是 `/home/About`」）。

現在的做法：忽略大小寫後撞名時，補上路徑雜湊後綴（`home-about~1a8370.html`）。

**教訓**：驗證工具的 bug 會偽裝成被驗證對象的 bug。對不上時，先確認 oracle 本身是不是被自己的工具汙染了 —— 直接 `curl` 正式站比對最快。
