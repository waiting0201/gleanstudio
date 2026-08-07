# 03 — URL 凍結契約

> **這份文件是契約，不是說明。** 前台的每一條 URL 與每一個 byte 的 HTML 都已凍結。
> 動任何一頁之前先讀這裡；要偏離契約，必須先更新 `tests/golden/` 並在 PR 說明理由。

相關：[02-architecture](02-architecture.md)｜[08-verification](08-verification.md)｜[09-known-issues](09-known-issues.md)

---

## 1. 契約範圍

**凍結**：公開前台 10 個 action、13 條可達 URL 的網址、查詢字串名稱、HTTP 狀態碼、以及渲染出來的 HTML。

**不凍結**：後台 `/backend/*`（介面重做，見 [06-admin-spec](06-admin-spec.md)）、`/api/*`（新增，舊站沒有）。

**凍結的理由**：舊站 `gleanstudio.com.tw` 已上線多年，網址已被搜尋引擎索引、被外部連結引用。使用者明確要求「畫面 + URL 全都不變」，因此不做語意化網址、不做 301 轉址。

---

## 2. URL 對照表

狀態碼欄位是 2026-08-07 對正式站 `https://gleanstudio.com.tw` 實測的結果。

| # | URL | Method | 狀態 | Astro 檔案 | golden fixture |
|---|---|---|---|---|---|
| 1 | `/` | GET | 200 | `src/pages/index.astro` | `root.html` |
| 2 | `/Home/Index` | GET | 200 | `src/pages/Home/Index.astro` | `home-index.html` |
| 3 | `/Home/About` | GET | 200 | `src/pages/Home/About.astro` | `home-about.html` |
| 4 | `/Home/Articles` | GET | 200 | `src/pages/Home/Articles.astro` | `home-articles.html` |
| 5 | `/Home/Articles?p={n}` | GET | 200 | 同上 | `home-articles-p2.html` |
| 6 | `/Home/Articles?p={n}&ArticleTypeID={guid}` | GET | 200 | 同上 | 每個分類一份 |
| 7 | `/Home/ArticleDetail?ArticleID={guid}` | GET | 200 | `src/pages/Home/ArticleDetail.astro` | 每篇文章一份 |
| 8 | `/Home/Team` | GET | 200 | `src/pages/Home/Team.astro` | `home-team.html` |
| 9 | `/Home/Gallery` | GET | 200 | `src/pages/Home/Gallery.astro` | `home-gallery.html` |
| 10 | `/Home/Project` | GET | 200 | `src/pages/Home/Project.astro` | `home-project.html` |
| 11 | `/Home/Services` | GET | 200 | `src/pages/Home/Services.astro` | `home-services.html` |
| 12 | `/Home/Service` | GET | 200 | `src/pages/Home/Service.astro` | `home-service.html` |
| 13 | `/Home/Service?ArticleTypeID={guid}` | GET | 200 | 同上 | 每個分類一份 |
| 14 | `/Home/Contact` | GET | 200 | `src/pages/Home/Contact.astro` | `home-contact.html` |
| 15 | `/Home/Contact` | **POST** | 302 或 200 | 同上 | 無法從正式站取得，見 §7 |
| 16 | `/Upload/{Entity}/{ID}/{Photo}` | GET | 200 | `src/pages/Upload/[entity]/[id]/[photo].ts` | 見 [02-architecture](02-architecture.md) |

`/Home/Contact` 的 POST：驗證通過 → `302` 轉到 `/`；驗證失敗 → **`200`** 並重新渲染表單（不是 4xx）。

---

## 3. 路由實作要點

### 3.1 Astro 檔案路由逐字對應

Astro 的 `src/pages/**` 直接對應 URL 路徑並**保留大小寫**，所以 `src/pages/Home/About.astro` → `/Home/About`。不需要任何 rewrite 設定。

**查詢字串不參與路由。** `?ArticleID={guid}` 不需要 `[id].astro` 這種動態片段，用 `Astro.url.searchParams` 在 frontmatter 讀就好 —— 這反而比動態路由更貼近 MVC 的 model binding 行為。

### 3.2 `/` 與 `/Home/Index` 必須輸出完全相同的 HTML

已對正式站驗證：`curl /` 與 `curl /Home/Index` 的輸出 byte-identical，兩邊都是 200，都沒有轉址。

**做法**：整頁（含 layout 包裹）放在 `src/components/pages/HomeIndexPage.astro`，兩個 route 檔各 4 行引用它：

```astro
---
// src/pages/index.astro 與 src/pages/Home/Index.astro 內容相同
import HomeIndexPage from '../components/pages/HomeIndexPage.astro';
---
<HomeIndexPage />
```

Astro 元件不會產生任何包裹用的 markup，所以輸出相同是結構上保證的。

**不要用 middleware `context.rewrite('/Home/Index')` 處理 `/`。** Astro 文件明確寫著「middleware 在沒有匹配路由時是否執行由 adapter 決定」，把全站最重要的那條 URL 押在未定義行為上不划算。middleware 只用在 §3.3 的大小寫補救，那裡失敗只是美觀問題。

### 3.3 大小寫：IIS 不敏感，Astro 敏感

實測 `https://gleanstudio.com.tw/home/about` → **200**（直接服務，不是轉址）。Astro 會 404。

站內沒有任何地方產生小寫網址，所以這只影響外部連結、舊書籤與手打網址。但既然契約是「URL 全都不變」，就要補：

```ts
// src/middleware.ts
import { defineMiddleware } from 'astro:middleware';

const CANONICAL = new Map(
  ['/Home/Index','/Home/About','/Home/Articles','/Home/ArticleDetail',
   '/Home/Services','/Home/Service','/Home/Project','/Home/Team',
   '/Home/Gallery','/Home/Contact']
  .map(p => [p.toLowerCase(), p])
);

export const onRequest = defineMiddleware(async (ctx, next) => {
  const p = ctx.url.pathname.replace(/\/+$/, '') || '/';
  const canonical = CANONICAL.get(p.toLowerCase());
  if (canonical && canonical !== p) {
    // IIS 是「直接服務」不是轉址，所以用 rewrite 不用 redirect
    return ctx.rewrite(new Request(new URL(canonical + ctx.url.search, ctx.url), ctx.request));
  }
  return next();
});
```

**查詢參數名稱也要大小寫不敏感** —— ASP.NET model binding 接受 `?articleid=`。加 `src/lib/query.ts` 的 `getParam(url, 'ArticleID')` 做不分大小寫掃描。

**尾斜線**：實測 `/Home/About/` → 200，不轉址。所以 `astro.config.mjs` 用 `trailingSlash: 'ignore'`（預設值）。設成 `'never'` 會發出舊站從來不發的 301。

~~**已知缺口**：靜態資源 `/content/css/style.css`（小寫）在新站會 404~~ —— **2026-08-07 已補齊。**

實測結果是 Workers Assets 確實大小寫敏感，但**沒命中的請求會落到 Worker**，所以 middleware 補得起來：用 `env.ASSETS.fetch()` 拿正規大小寫的路徑重取一次。詳見 [08-verification](08-verification.md) §5.4。

現在四類路徑都不分大小寫，各自的理由不同：

| 路徑 | 為什麼會壞 | 怎麼修 |
|---|---|---|
| `/Home/*` | Astro 路由敏感 | rewrite，**而且要還原整頁的站內連結**（§5.6） |
| `/backend/*` | 同上 | rewrite，不動連結（後台沒有 markup 契約）。⚠️ CSRF token 的判斷式也要跟著不分大小寫 |
| `/Upload/*` | 只有最前面那段 | rewrite 前綴；entity / id / photo 由 route 自己正規化 |
| `/Content/*`、`/Scripts/*` | Workers Assets 敏感，且在 Worker 之前 | 沒命中時用 `env.ASSETS` 重取 |

後台的正規大小寫用 `import.meta.glob` 在 build 時從實際檔案列舉，不手工維護清單。前台那 10 條刻意留成明列的常數 —— 它們多一道站內連結還原，而且是凍結契約的一部分。

回歸驗證：`npm run verify:url-case`（42 項，已接進 CI）。

### 3.4 `compressHTML: false` 是硬性要求

Astro 預設會壓縮 HTML，Razor 不會。開著壓縮的話每一頁的空白都會不同，byte parity 直接不可能達成。

```js
// astro.config.mjs
export default defineConfig({
  compressHTML: false,   // 不可省略
  trailingSlash: 'ignore',
  // …
});
```

這是這類移植最常見的「靜默失去 byte parity」原因。

---

## 4. 每頁的資料來源

所有前台頁面都會先取得 `ArticleTypes`（依 `Sort` 排序）—— 舊站是 `BaseController.OnActionExecuting` 全域注入 `ViewBag.ArticleTypes`，驅動 header 的「專業服務項目」下拉選單。新站沒有等價的全域 filter，改為每頁明確呼叫 `getArticleTypes()`。

| 頁面 | 額外資料 | 對應舊程式碼 |
|---|---|---|
| `/`、`/Home/Index` | `Abouts` (ID=1)；每個分類最新一篇 `Articles` | [HomeController.cs:41-54](../reference/old/Gleanstudio/Controllers/HomeController.cs#L41-L54) |
| `/Home/About` | `Abouts` (ID=1) | 同檔 L56-63 |
| `/Home/Articles` | `Articles` 依 `CreateDate DESC`，可選 `ArticleTypeID` 篩選，每頁 6 筆 | 同檔 L65-78 |
| `/Home/ArticleDetail` | 單筆 `Articles` + 其 `ArticleTypes` | 同檔 L80-88 |
| `/Home/Team` | `Teams` 依 `Sort` | 同檔 L90-96 |
| `/Home/Gallery` | **無** —— 整頁寫死 | 同檔 L98-103 |
| `/Home/Project` | `Projects` 三層分組 Type → Place → Title | 同檔 L105-127 |
| `/Home/Services` | 只用 `ArticleTypes` | 同檔 L129-134 |
| `/Home/Service` | 單一 `ArticleTypes` + 其 `Services` 子項依 `Sort` | 同檔 L136-153 |
| `/Home/Contact` | **無** —— 聯絡資訊寫死在 view | 同檔 L187-227 |

`/Home/Service` 在 `ArticleTypeID` 為 null 時取 `ArticleTypes.FirstOrDefault()`（即 `Sort` 最小的那筆）。

---

## 5. 必須逐字重現的 markup 怪癖

### 5.1 分頁器

實作在 [CustomPager.cs](../reference/old/Gleanstudio/Infrastructure/Paging/CustomPager.cs)，選項在 [Articles.cshtml:5-15](../reference/old/Gleanstudio/Views/Home/Articles.cshtml#L5-L15)。以下是 **2026-08-07 從正式站抓下來的原文**，重現時以這個為準，不要從 C# 反推。

第 1 頁（共 2 頁）：
```html
<nav class="Page navigation example"><ul class="pagination justify-content-center"><li class="disabled page-item"><a class="page-link" href="javascript:;"><img src="/Content/images/svg/arrow-page-back.svg"></a></li><li class="active"><a class="page-link" href="/Home/Articles">1</a></li><li><a class="page-link" href="/Home/Articles">2</a></li><li class="page-item"><a class="page-link" href="/Home/Articles"><img src="/Content/images/svg/arrow-page-next.svg"></a></li></ul></nav>
```

第 2 頁：
```html
<nav class="Page navigation example"><ul class="pagination justify-content-center"><li class="page-item"><a class="page-link" href="/Home/Articles"><img src="/Content/images/svg/arrow-page-back.svg"></a></li><li><a class="page-link" href="/Home/Articles">1</a></li><li class="active"><a class="page-link" href="/Home/Articles">2</a></li><li class="disabled page-item"><a class="page-link" href="javascript:;"><img src="/Content/images/svg/arrow-page-next.svg"></a></li></ul></nav>
```

必須重現的細節：

1. **`<nav>` 的 class 是 `Page navigation example`** —— 三個獨立 class，來自 `ContainerDivClasses = new[] { "Page", "navigation", "example" }`。這顯然是誰把 Bootstrap 範例的 `aria-label="Page navigation example"` 貼錯位置了，但它現在是契約的一部分。
2. **前後頁的 `<li>` 有 `page-item`，數字頁的 `<li>` 沒有。** 因為 `PagingOptions.NormalPageElementClass` 從未賦值（`null`），而 [CustomPager.cs:250](../reference/old/Gleanstudio/Infrastructure/Paging/CustomPager.cs#L250) 用 `IsNullOrWhiteSpace` 判斷後跳過。當前頁時 `<li>` 只有 `active`。
3. **停用狀態的 class 順序是 `disabled page-item`**，不是 `page-item disabled` —— [CustomPager.cs:198-203](../reference/old/Gleanstudio/Infrastructure/Paging/CustomPager.cs#L198-L203) 先加 `LiElementClasses` 再加 `disabled`，而 `TagBuilder.AddCssClass` 是**前插**。
4. **停用時 `href="javascript:;"`**，不是省略 `href`。
5. **所有 `href` 都是 `/Home/Articles`**，沒有 `p`、沒有 `ArticleTypeID`。這是 [Articles.cshtml:85](../reference/old/Gleanstudio/Views/Home/Articles.cshtml#L85) 的 `generatePageUrl: page => Url.Action("Articles")` 忽略 `page` 參數造成的既有 bug。**照抄**，理由見 [09-known-issues](09-known-issues.md)。
6. **首頁/末頁連結不輸出**（`DisplayLinkToFirstPage/LastPage = false`），頁碼統計與總筆數也不輸出。

分頁範圍邏輯（[CustomPager.cs:43-59](../reference/old/Gleanstudio/Infrastructure/Paging/CustomPager.cs#L43-L59)）也要照抄，包含 `if (list.PageCount > list.PageSize)` 這個拿 `PageSize`（6）當視窗大小的明顯筆誤。目前資料只有 2 頁（9 篇 ÷ 每頁 6），`2 > 6` 為 false，所以永遠走「全部頁碼都顯示」那條路。**文章數超過 42 篇（7 頁 × 6）之後這個分支才會啟動**，屆時輸出會變，golden 需要重抓。

### 5.2 `/Home/Service` 每 3 筆斷行

`Service.cshtml` 用 `@Html.Raw("</div><div class=\"d-lg-flex row justify-content-between g-0 mt-4\">")` 在每 3 個項目後硬切一列。這是不平衡的標籤輸出，Astro 這邊要用同樣的方式產生字串，不能靠巢狀元件 —— 否則 DOM 結構會不同。

### 5.3 `/Home/Project` 的三層分組

舊 controller 建立巢狀匿名型別，view 因為匿名型別是 `internal` 而改用反射讀取。新站直接用一般的巢狀資料結構，**輸出的 HTML 必須相同**。目前 `Projects` 有 87 筆，5 個 `Type`：文物修護、文物數位化、展示保存、教育推廣、視覺與展場設計。

### 5.4 日期格式是 en-US，不是 zh-TW

`@item.CreateDate.ToString("dd MMMM yyyy")` 沒有指定 `CultureInfo`，`Web.config` 也沒有 `<globalization>`，所以跟著伺服器 culture 走。正式站實際輸出 **`20 July 2026`** —— 英文月份名。

新站必須用 `en-US`（或 invariant）格式化，格式為 `dd MMMM yyyy`（兩位數日、完整英文月名、四位數年）。**用 zh-TW 格式化會靜默破壞 `/`、`/Home/Articles`、`/Home/ArticleDetail` 三頁的 parity。**

日期在 D1 存 ISO8601 UTC 字串，渲染時用 UTC 解讀，不做時區轉換 —— 舊站也沒做。

### 5.5 其他刻意保留的怪癖

- `<html lang="en">`，但內容是繁體中文（[_Layout.cshtml](../reference/old/Gleanstudio/Views/Shared/_Layout.cshtml)）
- `<meta name="keywords">` 與 `<meta name="description">` 全站固定，只有 `<title>` 會變
- CSS 是 Bootstrap **5.1.1**（編進 `style.css`），JS 從 CDN 載 Bootstrap **5.0.1**（[_Scripts.cshtml:3](../reference/old/Gleanstudio/Views/Shared/_Scripts.cshtml#L3)）—— 版本錯配，照抄含 `integrity` 屬性
- jQuery 檔名叫 `jquery-latest.js` 但其實是 1.11.1
- 富文本欄位全部走 `@Html.Raw` 未過濾
- 卡片點擊用 inline `onclick="location.href='…'"`

### 5.6 小寫路徑會改變**整頁**的站內連結 ⚠️

`Url.Action("About")` 的 controller 片段來自 `RouteData.Values["controller"]`，也就是**使用者實際打進來的字串**。所以 `/home/about` 這一頁的每一條站內連結都變成 `/home/About` —— controller 跟著小寫，action 名稱維持原本的大小寫。

`tests/golden/home-about~1a8370.html` 與 `Home-About.html` 的唯一差別就是這 12 條連結。

**做法**：不讓每個元件都帶一個前綴參數。`src/middleware.ts` 在 rewrite 之後於出口把 `"/Home/` 換成使用者打的片段 —— 只有非正規大小寫的請求會走到這條路徑，正常請求零成本。

### 5.7 `/Home/Articles` 有兩套排序

未篩選與依分類篩選是同一句 `OrderByDescending(CreateDate)`，但 SQL Server 對並列列的輸出順序在兩種計畫下不同，而兩張清單都在 golden 裡。需要兩個相容性欄位，見 [04-data-model](04-data-model.md) §5 與 [ADR-017](10-decisions.md)。

---

## 6. `<title>` 逐頁對照

`<title>` 是唯一逐頁變動的 `<head>` 內容，必須完全一致：

| 頁面 | `<title>` |
|---|---|
| `/`、`/Home/Index` | `禾勤藝術有限公司` |
| `/Home/About` | `關於禾勤 - 禾勤藝術有限公司` |
| `/Home/Articles` | `Art News - 禾勤藝術有限公司` |
| `/Home/ArticleDetail` | `{Articles.Title} - 禾勤藝術有限公司` |
| `/Home/Team` | `禾勤團隊 - 禾勤藝術有限公司` |
| `/Home/Gallery` | `文物修復放大鏡 - 禾勤藝術有限公司` |
| `/Home/Project` | `案例展示 - 禾勤藝術有限公司` |
| `/Home/Services` | `專業服務項目 - 禾勤藝術有限公司` |
| `/Home/Service` | `{ArticleTypes.Title} - 禾勤藝術有限公司` |
| `/Home/Contact` | `聯絡方式 - 禾勤藝術有限公司` |

---

## 7. 契約無法從正式站取得的部分

### 7.1 `POST /Home/Contact`

不能對正式站發 POST 測試 —— 會寄出真實郵件、消耗 reCAPTCHA 配額。它的期望 markup（驗證失敗時重新渲染、帶繁中錯誤訊息）只能從 [Contact.cshtml](../reference/old/Gleanstudio/Views/Home/Contact.cshtml) 與 `Models/Partial/Contact.cs` 的 DataAnnotations **手工推導**，存進 `tests/derived/` 並經人工審閱。

這是全站唯一一處「沒有 oracle、只能從原始碼推理」的地方，[08-verification](08-verification.md) 必須明講，不能讓它看起來跟其他頁一樣可信。

### 7.2 錯誤路徑

實測 `/Home/ArticleDetail?ArticleID=00000000-0000-0000-0000-000000000000` → **500**。原因是 [HomeController.cs:85](../reference/old/Gleanstudio/Controllers/HomeController.cs#L85) 對 null 取 `article.Title` 丟 `NullReferenceException`，加上 `customErrors mode="Off"` 直接吐 ASP.NET 黃頁。

**新站不重現黃頁。** 建議回 **404**，並在 [09-known-issues](09-known-issues.md) 記為刻意分歧。理由：重現一個洩漏堆疊追蹤的錯誤頁沒有任何價值，而 404 是這個情境的正確語意。

### 7.3 文章排序的並列 —— 順序本身也是契約 ⚠️

`/Home/Articles` 是跨分類的 `OrderByDescending(CreateDate)`，而資料裡有**兩組**並列（2026-08-07 實測）：2026-01-02 三篇（分屬不同分類）、2026-01-01 三篇（同分類）。並列順序在兩個引擎都未定義。

正式站目前的完整顯示順序（第 1 頁 6 筆、第 2 頁 3 筆）：

```
1  96aaa3f5-…   2026-07-20
2  2c22a9d8-…   2026-05-18
3  e016d09a-…   2026-01-15
4  18cacc7a-…   2026-01-02  ┐
5  51e3bd0a-…   2026-01-02  ├ 並列
6  21b3941f-…   2026-01-02  ┘
─────────────── 第 2 頁 ───────────────
7  4772b8a8-…   2026-01-01  ┐
8  22acb62c-…   2026-01-01  ├ 並列
9  d6d01a97-…   2026-01-01  ┘
```

**這個順序無法由任何欄位推導。** 曾經試過用 SQL Server 的實體掃描順序（`ROW_NUMBER() OVER (ORDER BY (SELECT NULL))`）—— 對 2026-01-01 那組碰巧吻合，對 2026-01-02 那組不吻合。

**做法：從 oracle 取。** `scripts/capture-golden.mjs` 逐頁爬 `/Home/Articles` 記下實際順序，寫進 `data/export/legacy-order.json`，seed 時填入 `Articles.LegacyOrder`，查詢用 `ORDER BY CreateDate DESC, LegacyOrder`。細節見 [04-data-model](04-data-model.md) §5。

**這使 Phase 1 成為 Phase 2 的硬前置** —— 沒有 golden 就沒有排序資料。

首頁「每個分類最新一篇」目前不受影響（三個分類的最新日期都唯一），但這個保證會隨資料改變，`anomalies.json` 每次匯出都要重看。

---

## 8. golden fixture 清單

**已擷取（2026-08-07，共 35 頁 / 6.4 MB）** —— `npm run golden` 產生，內容在 `tests/golden/`。

| 類別 | 頁數 | 狀態碼 |
|---|---|---|
| 固定路徑（`/`、`/Home/Index`、About、Team、Gallery、Project、Services、Service、Contact） | 9 | 200 |
| `/Home/Articles?p=1`、`?p=2` | 2 | 200 |
| `/Home/Service?ArticleTypeID={guid}` × 3 分類 | 3 | 200 |
| `/Home/Articles?ArticleTypeID={guid}` × 3 分類 | 3 | 200 |
| `/Home/ArticleDetail?ArticleID={guid}` × 9 篇 | 9 | 200 |
| 邊界情境（見 §9） | 9 | 200 × 5、500 × 3、404 × 1 |

⚠️ **實際大小是 6.4 MB，不是原本估的 500 KB。** 原因是 `Articles.Description` 內嵌了 Summernote 的 base64 圖片，最大一頁 1.78 MB。這也連帶影響 D1 的寫入方式，見 [04-data-model](04-data-model.md) §5a。

直接進版控。**進版控是重點** —— 基準必須能在 diff 裡被審閱。但要誠實承認：那幾個 1 MB 級的 base64 單行檔案，人類實際上審不動，只有工具讀得了。

擷取與重新 baseline 的規則見 [08-verification](08-verification.md)。

---

## 9. 邊界情境實測結果

2026-08-07 對正式站探測。這些**不在**「畫面完全不變」的承諾裡 —— 有些是舊站的當機，重現它們沒有價值。

| URL | 舊站 | 新站 | 說明 |
|---|---|---|---|
| `/Home/Articles?p=999` | **200** | 200 | 空列表 + 分頁器。要重現 |
| `/Home/Articles?p=abc` | **200** | 200 | model binding 回退成 `p=1`，輸出與 `?p=1` byte 相同。要重現 |
| `/Home/Articles?ArticleTypeID=<不存在>` | **200** | 200 | 空列表。要重現 |
| `/Home/Articles?p=0` | **500** | 建議 200（視為 `p=1`） | `ToPagedList(0, 6)` 丟例外。**刻意分歧** |
| `/Home/ArticleDetail?ArticleID=<不存在>` | **500** | 建議 404 | `article.Title` 對 null 取值。**刻意分歧** |
| `/Home/Service?ArticleTypeID=<不存在>` | **500** | 建議 404 | 同上，`articletype.Title`。**刻意分歧** |
| `/home/about`（小寫） | **200** | 200 | IIS 大小寫不敏感，需 middleware，見 §3.3 與 §5.6（連結大小寫也跟著變）|
| `/Home/About/`（尾斜線） | **200** | 200 | 不轉址，`trailingSlash: 'ignore'` |
| `/Error/Validation` | **404** | 403 | 舊站從未實作，見 [06-admin-spec](06-admin-spec.md) §7 |

三個 500 的共通模式：**舊站對找不到的資料一律當機**，而 `customErrors="Off"` 讓它直接吐 ASP.NET 黃頁與完整堆疊追蹤。新站不重現黃頁 —— 那是資訊洩漏，不是行為。全部記在 [09-known-issues](09-known-issues.md) §4。
