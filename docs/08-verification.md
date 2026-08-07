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

~~**判定：接受落差**~~ —— **2026-08-07 推翻，已補齊。**

上面那個「會落到 Worker」的觀察就是缺的那塊拼圖，而且不必動 `run_worker_first`：
沒命中才會進 middleware，所以那段程式只在「大小寫打錯」或「檔案真的不存在」時跑，
正常請求連碰都碰不到。做法是用 `env.ASSETS.fetch()` 拿正規大小寫的路徑重取一次。

試兩個候選就夠涵蓋現實情況：**只有第一段錯**（`/content/css/…`）、
以及**整條都被打成小寫**。`public/` 底下除了 `Content` 與 `Scripts` 兩個第一層
資料夾之外全是小寫檔名，所以第二個候選對現有的每一個檔案都成立；
就算之後有人放進大寫檔名，第一個候選仍然接得住正常拼寫。兩個都不中就照常回 404。

### 5.4a 網址大小寫的回歸驗證

```bash
npm run verify:url-case          # 加 --base <url> 打已部署的站
```

42 項，涵蓋前台 / 後台 / `/Error` / 資源 / `/Upload`，每條都用小寫、全大寫、
交錯大小寫各打一次，另外單獨驗**後台用非正規大小寫進去時 CSRF token 發不發得出來**
—— 那一項壞掉的話畫面完全正常，只是每一次 POST 都 403。

⚠️ **一定要在 Linux 上跑。** macOS 的檔案系統不分大小寫，本機驗不出來 ——
跟 CI 第一次跑抓到「33/35 個 golden fixture 檔名大小寫錯」是同一個坑（§9）。
已接進 `ci.yml`，排在 parity 之後。

#### ⚠️ `/Upload/*` 那三項在 CI 需要先有物件

真正的圖片在 `reference/old/Gleanstudio/Upload`（gitignored），CI 上沒有，
所以 `npm run media:upload` 在 CI 跑不了、R2 是空的 —— 那三項會**連正規大小寫都 404**。
第一次上 CI 就是這樣紅的，但紅的原因與大小寫毫無關係。

修法是讓 CI 真的有物件可以打，不是讓檢查跳過（大小寫只有在 Linux 上驗才算數）：
`node scripts/seed-media-placeholder.mjs` 依版控裡的 `data/export/*.json` 推導 key，
在**本機** R2 放 1×1 佔位圖（14 個 key，與 `upload-r2.mjs` 同一套 key 規則）。
因為位元組數是假的，**CI 不跑 `verify:media`**；那支要比對來源檔，只能在本機跑。
帶 `--remote` 會直接被拒絕 —— 佔位圖絕不能蓋掉正式站的圖。

`verify-url-case.mjs` 現在也會在三項一起紅時多印一行，指出「是 R2 沒有物件」。

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

## 9. CI 上那個「CSRF 壞掉」的假象 —— 其實是沒讀 request body

**結論（2026-08-07）：找到了，是應用層的真 bug，不是測試環境問題。**

症狀：`smoke:admin` 的「沒有 CSRF token 被擋」在 CI 上失敗，`wrangler dev` 隨後崩潰。看起來像 CSRF 中介層壞了。

診斷過程值得記，因為前兩個假設都是錯的：

| 假設 | 為什麼被推翻 |
|---|---|
| 伺服器掛了 | 加了 `assertAlive`，那個時點**通過** —— 伺服器還活著 |
| 兩個行程搶 miniflare 的 SQLite | 看起來很像（崩潰緊跟在外部 `d1 execute` 之後），但只是相鄰，不是因果 |

**真正的答案要等到把實得的狀態碼印出來才出現**：

```
實得 500：Error: Network connection lost.
```

原本 Hono 的第一節 middleware 是「查 session，沒登入就直接回 401」——**那條路徑從來沒有讀取 request body**。在 workerd 上這會留下一條沒收乾淨的連線，而 HTTP keep-alive 會重用它，**下一個請求就收到 500**。

`smoke:admin` 剛好連續發兩個：先無 cookie（→401，body 未讀），再帶 cookie。所以每次都踩。

**修法**：把「讀 body」移到整條鏈的最前面，排在任何提早回應之前。

**macOS 上重現不出來**（同樣的序列跑 8 回合都正常），所以這是只有在 Linux 上跑才會現形的一類 —— 跟 §8 的檔名大小寫同一個家族。

**教訓：比較狀態碼的斷言，失敗時一定要印出實得值。** 只印一個 ✗ 讓這個 bug 多活了三輪 CI，而且把調查帶往兩個錯誤的方向。

---

## 9a. 原始紀錄：當時只知道「`wrangler dev` 崩潰過一次」

**2026-08-07，第二次 CI。** `wrangler dev` 在服務完一個請求之後就死了，stdout 只留一個空的 `[ERROR]` 與 wrangler 的通用崩潰提示。表現出來是 `smoke:admin` 的「沒有 CSRF token 被擋」失敗 —— **看起來像 CSRF 壞了，其實是伺服器已經不在了**。

第三次跑（中間只加了 log，沒有改任何行為）就全綠。**所以它沒有被修好，只是沒有重現。**

**一個尚未證實的懷疑**：`smoke-admin.mjs` 會在 `wrangler dev` 執行中另外開 `wrangler d1 execute --local`，兩個行程同時碰同一個 miniflare SQLite 檔。macOS 容忍，Linux 的檔案鎖與 WAL 行為不同。這符合「先成功好幾次、後來才爆」的形狀，但**沒有證據**，不要當成結論。

已經做的：

- CI 失敗時會印出 `~/.config/.wrangler/logs/*.log`，下次發生就有堆疊
- `smoke:admin` 在斷言失敗時會先確認伺服器還活著，訊息明確區分兩者

**還沒做**：真正的修法（如果懷疑成立）是讓煙霧測試不要跟 dev server 搶同一個檔 —— setup 的寫入移到啟動 dev 之前，權限撤銷改走後台自己的 Admins 表單，只留唯讀的斷言。**在有堆疊之前不要動手**，那會是拿猜測換掉一個能用的測試。

---

## 8. 擷取工具本身踩過的坑

**golden 檔名不能只靠大小寫區分。** macOS 的 APFS 預設不分大小寫，所以 `Home-About.html` 與 `home-about.html` 是同一個檔 —— `/Home/About` 與 `/home/about` 的擷取結果互相覆蓋，而這兩條正是用來驗證大小寫行為的。等於把要驗的東西自己抹掉，還會讓移植端看到假的失敗（「golden 說連結是 `/home/About`」）。

現在的做法：忽略大小寫後撞名時，補上路徑雜湊後綴（`home-about~1a8370.html`）。

**教訓**：驗證工具的 bug 會偽裝成被驗證對象的 bug。對不上時，先確認 oracle 本身是不是被自己的工具汙染了 —— 直接 `curl` 正式站比對最快。

### 第二次踩到同一件事：git 裡的檔名與 manifest 對不上

**CI 第一次跑就炸在這裡。**

`git ls-files` 顯示 `home-articles__p-1.html`（全小寫），而 `manifest.json` 寫的是 `Home-Articles__p-1.html`。**35 個 fixture 有 33 個對不上。**

macOS 的 APFS 不分大小寫，`readFile` 照樣開得起來 —— 所以整套 parity **從來沒有在區分大小寫的檔案系統上真的跑過**。這個問題在本機是隱形的，直到有一台 Linux 讀它。

修法：把 git 裡的檔名改回與 manifest 一致（macOS 上要繞暫存名，`git mv a tmp && git mv tmp A`，否則 git 看不到改名）。

**防止再犯**：`parity-diff.mjs` 開頭直接比對 `readdir()` 的結果與 manifest 的 slug，**逐字**，對不上就 exit 2。這樣它在 macOS 上也會失敗。

這跟上面那則是同一條教訓的第二次出現 —— 而且這次是「本機環境的寬容遮住了問題」，比工具本身的 bug 更難察覺。
