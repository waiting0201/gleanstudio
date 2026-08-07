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

涵蓋範圍見 [03-url-contract](03-url-contract.md) §8：約 30 頁、~500 KB。

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

### 5.2 內容漂移

見 §2 的資料快照綁定。緩解了，但沒有消除 —— 這是快照式基準的固有性質。

### 5.3 錯誤與邊界路徑

實測 `/Home/ArticleDetail?ArticleID=<不存在>` → **500**（`NullReferenceException` + `customErrors="Off"` 的 ASP.NET 黃頁）。

**不重現黃頁。** 新站回 **404**，記為刻意分歧，見 [09-known-issues](09-known-issues.md) §4。

其他未探測的邊界：`?p=999`（超出範圍的頁碼）、`?ArticleTypeID=<不存在>`、格式錯誤的 GUID。這些**可以**對正式站探測，Phase 1 擷取 golden 時應該一併抓，不要留到移植完才發現行為不同。

### 5.4 Workers Assets 的大小寫敏感度

沒有任何文件說明 Workers Assets 對路徑大小寫是否敏感。**Phase 3 用 `wrangler dev` 實測**，不要假設。

若確實敏感，`/content/css/style.css`（小寫）會 404 而舊站是 200。選項是 `run_worker_first: ["/content/*", "/scripts/*"]`（很醜，而且無法乾淨地只表達「小寫變體」）或接受落差。**建議接受**並記在 [09-known-issues](09-known-issues.md) —— 站內只會產生大小寫正確的資源網址。

### 5.5 排序並列

見 [04-data-model](04-data-model.md) §5。`ImportSeq` 釘住了目前這份資料的順序，但那是把觀察到的結果固定下來，不是從規則推導出來的。資料改變時要重新檢查。

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

## 7. Level A 豁免清單

任何無法達成 byte parity 而決定接受的情況，都要記在這裡，附上原因與日期。空著代表沒有豁免。

（目前無）
