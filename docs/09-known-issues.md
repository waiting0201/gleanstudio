# 09 — 已知問題

分四類：**刻意保留**（因為 markup 凍結）、**安全債**、**已知壞掉但本輪不修**、**刻意分歧**。

每一類的處理時機不同。第 2 節最急。

---

## 1. 刻意保留 —— markup 凍結的直接後果

使用者選擇「畫面 + URL 全都不變」，所以這些**照抄**。它們不是待修的 bug，是契約的一部分。第 9 階段會與業主逐條 triage（ship / fix / won't-fix）。

| # | 問題 | 位置 | 影響 |
|---|---|---|---|
| 1.1 | 分頁連結全部指向 `/Home/Articles`，掉了 `p` 與 `ArticleTypeID` | [Articles.cshtml:85](../reference/old/Gleanstudio/Views/Home/Articles.cshtml#L85) 的 `generatePageUrl: page => Url.Action("Articles")` | 分頁實際上不能用；分類篩選也會在換頁時消失 |
| 1.2 | CSS 是 Bootstrap 5.1.1，JS 從 CDN 載 5.0.1 | [_Scripts.cshtml:3](../reference/old/Gleanstudio/Views/Shared/_Scripts.cshtml#L3) | 版本錯配，元件行為可能與樣式預期不符 |
| 1.3 | `<html lang="en">` 但內容是繁體中文 | [_Layout.cshtml](../reference/old/Gleanstudio/Views/Shared/_Layout.cshtml) | 螢幕閱讀器與搜尋引擎的語言判斷錯誤 |
| 1.4 | 所有富文本經 `@Html.Raw` 未過濾 | Abouts.Description、Articles.Description、ArticleTypes.SubTitle/Description | **儲存型 XSS 風險**。目前只有可信的管理員能寫入，所以是低機率高衝擊 |
| 1.5 | `/Home/Gallery` 整頁是寫死的 placeholder | [Gallery.cshtml](../reference/old/Gleanstudio/Views/Home/Gallery.cshtml) | 三張 `gallery-pic-N.jpg` 配「遊走千年史古模樣文物-文物名稱」這種假標題 |
| 1.6 | `/Home/Team` 與 `/Home/Gallery` 沒有任何導覽連結 | `_Header.cshtml` 裡的連結被註解掉 | 網址可達但使用者找不到 |
| 1.7 | 聯絡表單沒有 JS 就完全送不出去 | 送出鈕是 `<div id="btnSubmit">`，靠 jQuery 觸發 submit | 非真正的 submit button |
| 1.8 | 聯絡表單沒有 anti-forgery token | [Contact.cshtml](../reference/old/Gleanstudio/Views/Home/Contact.cshtml) | 只靠 reCAPTCHA v3 擋 |
| 1.15 | **「驗證碼錯誤」永遠不會顯示** | [HomeController.cs:216](../reference/old/Gleanstudio/Controllers/HomeController.cs#L216) 的 `AddModelError("", …)` 是模型層級錯誤，而 Contact.cshtml 沒有 `@Html.ValidationSummary` | reCAPTCHA 判定失敗時，使用者看到的是一張值都還在、**沒有任何錯誤標示**的表單。按幾次都一樣，沒有任何線索。Phase 4 照抄 |
| 1.16 | 伺服器端 Email 驗證極寬鬆 | .NET 4.5+ 的 `EmailAddressAttribute` 只檢查「一個 `@`、不在頭尾」 | `a@b` 會通過。頁面上的 `data-val-email` 帶著嚴格的 client-side 規則，但 `_Scripts.cshtml` **沒有載入 jquery.validate.unobtrusive** —— 所有 `data-val-*` 屬性從來沒生效過 |
| 1.9 | `<meta keywords>` / `<meta description>` 全站固定 | `_Layout.cshtml` | 只有 `<title>` 逐頁變化 |
| 1.10 | 分頁器的 `<nav class="Page navigation example">` | `ContainerDivClasses` 設成三個 class | 是把 Bootstrap 範例的 `aria-label` 貼錯位置的產物 |
| 1.11 | 分頁範圍邏輯拿 `PageSize`（6）當視窗大小 | [CustomPager.cs:43-45](../reference/old/Gleanstudio/Infrastructure/Paging/CustomPager.cs#L43-L45) | 目前只有 2 頁不會觸發。**文章超過 42 篇後輸出會變，golden 要重抓** |
| 1.12 | `Content/images/` 13 MB 未最佳化，多數檔案沒被引用 | | 只搬實際引用到的 |
| 1.14 | **上傳的原圖沒有壓縮，最大 10.1 MB** | `Upload/Articles/…`（5 個檔超過 2 MB，合計 40.2 MB） | 前台 `<img>` 直接送原圖，沒有縮圖也沒有 `srcset`。`/Home/Articles` 列表頁一次載入多張 MB 級圖片 |
| 1.13 | **文章內文內嵌 base64 圖片** | `Articles.Description`（Summernote） | 9 篇有 7 篇超過 100 KB，最大 **1.73 MB**。單一新聞頁 1.8 MB 對使用者很糟；也逼近 [D1 的 2 MB 單列上限](https://developers.cloudflare.com/d1/platform/limits/)。抽出來存 R2 會改變渲染的 HTML，所以現在不能動 —— 見 [ADR-016](10-decisions.md)、[04-data-model](04-data-model.md) §5a |

---

## 2. 安全債 —— 4 組外洩憑證 🔴

> **2026-08-07 狀態更新。** reCAPTCHA 與 SendGrid 的 Worker secret 已設定，
> **但用的是舊程式碼裡那兩把原值（使用者決定），不是輪替後的新值。**
>
> 所以這兩條**沒有清償，只是被接上了**：
>
> - **SendGrid**：那把 key 有完整寄件權限。任何拿到舊原始碼的人都能以該帳號寄信，
>   寄件網域是代理商的 `notification@weypro.com`。這個風險與新站無關，**現在就存在**
> - **reCAPTCHA**：外洩的 secret 可以被拿去驗證別人網站的 token，消耗配額
>
> ⚠️ **Phase 7 soak 之前必須處理兩件事**（見 [11-roadmap](11-roadmap.md) Phase 7）：
> 1. 輪替這兩把 key
> 2. **§3.1 的收件人缺陷** —— 現在 key 設好了，一旦部署，聯絡表單會真的開始寄信，
>    而收件人是**訪客自己填的信箱**，不是禾勤。舊站因為沒有 await 很可能從未真的寄出，
>    新站會。也就是說：訪客會開始收到一封他們從來沒收過、寄件人是陌生網域的信
>
> 在那之前新站沒有部署，所以目前沒有實際影響。

**這一節的優先度高於任何開發工作。**

原始碼裡有 4 組憑證。`reference/` 在這個 repo 是 gitignored，但這份程式碼是從別的地方複製過來的 —— **必須確認它過去有沒有被推上公開 remote**。

| # | 憑證 | 位置 | 處置 |
|---|---|---|---|
| 2.1 | **Azure SQL 管理帳號密碼**（正式站） | [Web.Release.config:13](../reference/old/Gleanstudio/Web.Release.config#L13) | 遷移完成**後**輪替 —— Phase 8 重新同步時還要用 |
| 2.2 | 本機 `sa` 密碼 | `Web.config:12` + `Gleanstudio.Models/App.config` + `Gleanstudio.Service/App.config` | 隨舊系統下線一併作廢 |
| 2.3 | **reCAPTCHA secret** | [HomeController.cs:237](../reference/old/Gleanstudio/Controllers/HomeController.cs#L237) | **立刻輪替** —— 遷移不需要它 |
| 2.4 | **SendGrid API key** | `Commons/Librarys.cs` | **立刻輪替** —— 遷移不需要它 |

另外，正式站的設定本身也有問題：

- `customErrors mode="Off"` —— 完整堆疊追蹤直接吐給訪客（實測 `/Home/ArticleDetail?ArticleID=<不存在>` 回 500 黃頁）
- `compilation debug="true"` 在 `Web.config`（`Web.Release.config` 有轉成 `false`）
- 檔案上傳沒有任何副檔名或 content-type 白名單，上限 100 MB，寫進網頁可直接存取的 `~/Upload/`

新系統的對應處置見 [06-admin-spec](06-admin-spec.md) §8。

---

## 3. 已知壞掉，但本輪決定不修 🟠

### 3.1 聯絡表單很可能從來沒有送達過禾勤

[HomeController.cs:212](../reference/old/Gleanstudio/Controllers/HomeController.cs#L212)：

```csharp
var response = Librarys.SendGridExecute(entity.Email, "禾勤藝術", "禾勤藝術聯絡我們", sb.ToString());
```

**三個缺陷疊在一起：**

1. **收件人是 `entity.Email`** —— 訪客自己填的信箱，不是公司。禾勤根本不在收件人裡
2. **`SendGridExecute` 是 `async Task`，但呼叫端沒有 `await`**，接著立刻 `RedirectToAction("Index")`。回傳的 `Task` 被丟棄；在 ASP.NET 上請求結束後那個 continuation 可能根本不會執行
3. **寄件網域是 `notification@weypro.com`** —— 這是代理商的網域，不是 `gleanstudio.com.tw`，SPF/DKIM 幾乎確定不通過

**合理推斷：這張表單從未成功把任何一筆客戶詢問送到禾勤手上。**

**本輪決定：原樣保留**（使用者 2026-08-07 決定）。這不是渲染層的怪癖，而是一個業務層面的缺陷 —— 忠實重現它，等於上線一張證明送不出任何東西的聯絡表單。

**列為第 9 階段的第一項待辦。** 屆時的建議做法：

- 收件人改成 `glean1218@gmail.com`（這是禾勤自己印在 Contact 頁上的信箱，不是猜的），`Reply-To` 設為訪客信箱
- 確實 `await` 寄送
- 寄件網域改成 DNS 能驗證的（`gleanstudio.com.tw` 設 SPF/DKIM/DMARC），否則收件人改對了也照樣進垃圾桶
- 既然已經在 Workers 上，可以考慮改用 Cloudflare Email Sending 取代 SendGrid，順便省掉輪替 SendGrid key 的事

**這三點改動不會動到任何 markup 或 URL** —— 可見行為（成功 302 到 `/`、失敗 200 重新渲染表單）完全相同，純粹是伺服器端的正確性修正。

### 3.2 Service 層的 `IResult` 被完全忽略

`BaseService` 的每個變更方法都回傳 `IResult`，把例外吞進 `result.Exception`。**controller 完全不檢查回傳值**，所以寫入失敗是靜默的。

新系統不重現這個模式（Drizzle 直接丟例外），但值得知道舊資料可能因此有缺漏。

### 3.3 現任管理員無法維護團隊成員

`AdminID = 1` 的 `AdminLims` 涵蓋 LimID 3、4、5、6、8、9，**沒有 7（Teams）**。見 [04-data-model](04-data-model.md) §7。

既有狀態，照樣移植。要不要補是業主的決定。

### 3.4 免費方案的密碼雜湊強度

PBKDF2-SHA256 @ 100,000 次迭代，低於 OWASP 建議的 600,000。這是 Workers 免費方案 10 ms CPU 限制的直接後果 —— 平台對 PBKDF2 迭代數的硬上限就是 100,000，而 scrypt 在免費方案跑不完。

仍然遠優於現況（`nvarchar(20)` 明碼）。

**升級路徑**：改用 Workers Paid（$5/月）後切換到 `node:crypto` 的 scrypt。雜湊字串已帶演算法前綴，可在登入成功時漸進式重算。見 [06-admin-spec](06-admin-spec.md) §3。

### 3.5 `Articles.LegacyOrder` 是相容性欄位

為了釘住排序並列而存在（見 [04-data-model](04-data-model.md) §5），不是領域概念。等 1.1 的分頁 bug 被清償、markup 解凍之後，可以改用 `CreateDate DESC, ArticleID` 這種真正決定性的排序並移除它。

---

## 4. 刻意分歧 —— 新舊行為不同且是有意的

| # | 情境 | 舊 | 新 | 理由 |
|---|---|---|---|---|
| 4.1 | `/Home/ArticleDetail?ArticleID=<不存在>` | 500 + ASP.NET 黃頁 | **404** | 重現一個洩漏堆疊追蹤的錯誤頁沒有價值，404 才是正確語意 |
| 4.1b | `/Home/Service?ArticleTypeID=<不存在>` | **500** + 黃頁 | **404** | 同 4.1。Phase 1 探測時發現 |
| 4.1c | `/Home/Articles?p=0` | **500** + 黃頁 | **200**（視為 `p=1`） | `ToPagedList(0, 6)` 丟例外。`?p=abc` 舊站已經是回退成 `p=1`，`?p=0` 沒有理由不一致 |
| 4.2 | 後台權限不足 | 轉址到 `/Error/Validation`，而該路由不存在 → 404 | 原地渲染 **403** | 舊行為讓「沒權限」與「網址打錯」無法區分 |
| 4.3 | 後台登出 | GET | **POST** | GET 登出可被 CSRF |
| 4.4 | 後台刪除 | `[HttpGet]` | **POST + CSRF token** | 同上 |
| 4.5 | 超級使用者 | 寫死的 `weypro` 後門 → `AdminID = 888` | `Admins.IsSuperAdmin` 欄位 | 可稽核、可撤銷 |
| 4.6 | 管理員密碼 | `nvarchar(20)` 明碼 | PBKDF2 雜湊 + `MustChangePassword` | |
| 4.7 | 上傳驗證 | 無 | magic bytes + 10 MB 上限 | |
| 4.8 | 權限比對 | `Key.Contains()` 子字串 | 精確比對 + CI 斷言 | 見 [06-admin-spec](06-admin-spec.md) §5 |
| 4.9 | `Sort*` 操作的權限 | 完全沒被涵蓋 | 對應到 `update` | |
| 4.10 | 資源路徑小寫（如 `/content/css/style.css`） | IIS 服務（200） | **404**（Phase 3 已實測） | Workers Assets 大小寫敏感。站內不會產生小寫資源網址，影響僅限手打網址。見 [08-verification](08-verification.md) §5.4 |
| 4.11 | `/upload/...`（小寫路徑） | IIS 服務（200） | **404** | middleware 的正規化表只涵蓋 10 條 `/Home/*`（[03-url-contract](03-url-contract.md) §3.3）。同 4.10，站內只產生 `/Upload/` |
| 4.12 | 跨站 POST 到 `/Home/Contact` | 接受（沒有 anti-forgery token，見 1.8） | **403** | Astro 預設開 `security.checkOrigin`，`Origin` 對不上就擋。**新站比舊站嚴，但合法流程零影響** —— 瀏覽器送同源表單一定會帶 `Origin`。等於在不動 markup 的前提下補上了 1.8 缺的那層防護，所以保留 |
| 4.13 | 聯絡表單寄信 | 一定呼叫 SendGrid（雖然三個缺陷疊起來很可能從未送達） | 有設 `SENDGRID_API_KEY` 才寄 | ⚠️ **2026-08-07 已用舊 key 設定**，見下方 §2 的狀態更新。程式端的閘門還在，但現在是開的 |

---

## 5. 第 9 階段的 triage 清單

上線穩定後，把第 1 節與第 3 節逐條與業主過一遍，每條給一個結論：**ship / fix / won't-fix**。

建議的優先順序：

1. **3.1 聯絡表單** —— 業務影響最大，而且改動不碰 markup
2. **1.1 分頁掉參數** —— 使用者實際會踩到
3. **1.4 富文本未過濾** —— 安全性
4. **1.3 `lang="en"`** —— 一個字元的修正
5. **1.2 Bootstrap 版本錯配** —— 對齊到 5.1.1
6. **1.5 / 1.6 Gallery 與 Team** —— 決定是要補內容、加導覽，還是直接下架
7. **1.13 文章內嵌 base64 圖片** —— 抽到 R2 可讓最大的頁面從 1.8 MB 降到約 20 KB，但會動到 markup
8. **1.14 原圖未壓縮** —— 10 MB 的 JPG 可壓到數百 KB；加 Cloudflare Images 或建置期縮圖都會動到 `<img>` markup
