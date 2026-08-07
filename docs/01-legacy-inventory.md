# 01 — 舊系統盤點

舊系統原始碼在 [reference/old/](../reference/old/)，**唯讀**。.NET Framework 4.8 + IIS Express 無法在 macOS 執行 —— 讀它，不要跑它。

這份文件的目的是讓你不必反覆翻舊程式碼就能回答「舊站這一頁到底做了什麼」。移植時仍要開原始檔對照，但方向由這裡給。

相關：[03-url-contract](03-url-contract.md)｜[04-data-model](04-data-model.md)｜[06-admin-spec](06-admin-spec.md)

---

## 1. Solution 結構

`Gleanstudio.sln` 有 3 個專案：

| 專案 | 內容 |
|---|---|
| `Gleanstudio` | Web 專案。前台 `Controllers/` + `Views/`，後台 `Areas/backend/`，資產 `Content/`、`Scripts/`，上傳檔 `Upload/` |
| `Gleanstudio.Models` | EF6 Database-First（`Model1.edmx`）產生的實體 + 泛型 Repository |
| `Gleanstudio.Service` | 極薄的 Service 層，每個實體一個類別 |

框架：.NET Framework 4.8、MVC 5.2.7、Razor 3、EF 6.5.1、PagedList 1.17。

---

## 2. 路由

[App_Start/RouteConfig.cs](../reference/old/Gleanstudio/App_Start/RouteConfig.cs) 只註冊一條預設路由，**沒有任何自訂路由或 attribute routing**：

```csharp
routes.MapRoute(
    name: "Default",
    url: "{controller}/{action}/{id}",
    defaults: new { controller = "Home", action = "Index", id = UrlParameter.Optional }
);
```

所以所有網址都是 `/{Controller}/{Action}` 形式，詳細資料靠查詢字串傳 GUID。這就是 [03-url-contract](03-url-contract.md) 那些不好看的網址的來源。

`Global.asax.cs` 依序註冊 Areas → Routes → Bundles。

`App_Helpers/DashRouteHandler.cs` 有一個把 controller/action 去連字號的 route handler，但**沒有被接上** —— `RouteConfig` 沒用到它。移植時忽略。

後台 area 由 `Areas/backend/backendAreaRegistration.cs` 註冊為 `backend/{controller}/{action}/{id}`。

---

## 3. 前台

### 3.1 BaseController 的全域注入

[Controllers/BaseController.cs](../reference/old/Gleanstudio/Controllers/BaseController.cs) 在 `OnActionExecuting` 對**每一個**前台請求注入：

```csharp
ViewBag.ArticleTypes = articletypesService.Get().OrderBy(o => o.Sort);
```

這驅動 header 的「專業服務項目」下拉選單。新系統沒有等價的全域 filter，改為每頁明確呼叫 `getArticleTypes()` —— 用 middleware + locals 硬做一個全域注入，比在 11 個地方明寫還糟。

### 3.2 HomeController 各 action

全部在 [Controllers/HomeController.cs](../reference/old/Gleanstudio/Controllers/HomeController.cs)。資料一律透過 **ViewBag** 傳遞，view 端再轉型回來：

```razor
@{ IQueryable<ArticleTypes> articletypedatas = (IQueryable<ArticleTypes>)ViewBag.ArticleTypes; }
```

只有兩個 view 用強型別 model：`ArticleDetail`（`@model Articles`）與 `Contact`（`@model Contact`）。

| Action | 行數 | 做的事 |
|---|---|---|
| `Index` | L41-54 | `Abouts.GetByID(1)`；每個分類最新一篇文章（`GroupBy` → `OrderByDescending(CreateDate)` → `FirstOrDefault`），再依 `ArticleTypes.Sort` 排序 |
| `About` | L56-63 | `Abouts.GetByID(1)`，整頁內容就是那一個富文本欄位 |
| `Articles` | L65-78 | `OrderByDescending(CreateDate)`，可選 `ArticleTypeID` 篩選，`ToPagedList(p, 6)` |
| `ArticleDetail` | L80-88 | `GetByID(ArticleID)`。**沒有 null 檢查** —— 不存在的 ID 會在 `article.Title` 丟 `NullReferenceException` |
| `Team` | L90-96 | `Teams` 依 `Sort` |
| `Gallery` | L98-103 | 什麼都不查，整頁寫死 |
| `Project` | L105-127 | `Projects` 建成三層巢狀匿名型別 Type → Place → Title |
| `Services` | L129-134 | 什麼都不查，只用 BaseController 注入的 `ArticleTypes` |
| `Service` | L136-153 | 單一 `ArticleTypes`；`ArticleTypeID` 為 null 時取 `ArticleTypes.FirstOrDefault()`（`Sort` 最小者） |
| `Contact` GET | L187-192 | 只設 title |
| `Contact` POST | L194-227 | 見 §3.6 |

**已停用的 action**：`CulturalRelic`、`Research`、`Exhibition`、`Digital`（L155-185 全部被註解掉）。它們曾經依賴一個已不存在的 `Services.ServiceType` 欄位，被通用的 `Services` / `Service` + `ArticleTypes` 模型取代。對應的 4 個 `.cshtml` 還留在磁碟上，**不移植**。

### 3.3 版型與局部檢視

```
Views/_ViewStart.cshtml        → Layout = "~/Views/Shared/_Layout.cshtml"
Views/Shared/_Layout.cshtml    21 行
Views/Shared/_Header.cshtml    86 行   導覽列
Views/Shared/_Footer.cshtml    44 行
Views/Shared/_Styles.cshtml     1 行
Views/Shared/_Scripts.cshtml   14 行
```

[_Layout.cshtml](../reference/old/Gleanstudio/Views/Shared/_Layout.cshtml) 全文很短，值得整段記住：

```razor
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="robots" content="all,follow">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>@ViewBag.Title</title>
    <meta name="keywords" content="禾勤藝術有限公司,文物修復,物件研究詮釋,展覽策劃,展場設計">
    <meta name="description" content="禾勤藝術藉著持續的創新與改善，培養負責、主動積極且有效率的工作團隊，提昇公司競爭力。">
    @{ Html.RenderPartial("_Styles"); }
</head>

<body>
    @{ Html.RenderPartial("_Header"); }
    @RenderBody()
    @{ Html.RenderPartial("_Footer"); }
    @{ Html.RenderPartial("_Scripts");}
    @RenderSection("scripts", required: false)
</body>
</html>
```

注意：`lang="en"` 但內容是繁中；`keywords` 與 `description` 全站固定，只有 `<title>` 會變。兩者都照抄。

[_Styles.cshtml](../reference/old/Gleanstudio/Views/Shared/_Styles.cshtml) 只有一行：

```razor
<link href="~/Content/css/style.css" rel="stylesheet">
```

[_Scripts.cshtml](../reference/old/Gleanstudio/Views/Shared/_Scripts.cshtml)：Popper 2.9.2（jsdelivr，含 SRI）→ Bootstrap **5.0.1** JS（jsdelivr，含 SRI）→ `~/Scripts/jquery-latest.js` → `~/Scripts/nav.js` → Google Analytics gtag `G-G2CBNFFB3Q`。

Popper 那一行的 `@("@popperjs")` 是為了逃脫 Razor 的 `@` 符號，移植到 Astro 時直接寫 `@popperjs` 即可。

### 3.4 Razor 用到的功能

移植時會遇到的，就這些：

- `ViewBag` 當主要資料通道，view 端轉型回具體型別
- `Html.RenderPartial` —— 只在 layout 用，其他地方沒有 partial
- `@RenderBody()`、`@RenderSection("scripts", required: false)`；`@section scripts{}` 只有 `Contact`（reCAPTCHA）與 `Gallery`（jquery.zoom）用到
- `@Url.Action(...)`，含路由值物件：`@Url.Action("ArticleDetail", new { item.ArticleID })`
- `@Html.Raw(...)` 處理 CMS 富文本，**未經任何過濾**
- `Html.TextBoxFor` / `TextAreaFor` / `ValidationMessageFor` —— 只在 Contact
- 自訂 `@Html.Pager(...)`，見 §3.5
- `~/` 波浪號路徑寫在原始 `<img src>` / `<link href>` 屬性裡
- inline `onclick="location.href='@Url.Action(...)'"` 做卡片點擊
- `@Html.Raw("</div><div class=\"…\">")` 在 `Service.cshtml` 每 3 項硬切一列
- `Project.cshtml` 用**反射**讀取 controller 建的匿名型別（因為匿名型別是 `internal`，view 綁不到）

### 3.5 分頁器

實作 [Infrastructure/Paging/CustomPager.cs](../reference/old/Gleanstudio/Infrastructure/Paging/CustomPager.cs)，選項類別 [PagingOptions.cs](../reference/old/Gleanstudio/Infrastructure/Paging/PagingOptions.cs)，呼叫端在 [Articles.cshtml:5-15](../reference/old/Gleanstudio/Views/Home/Articles.cshtml#L5-L15)。

底層分頁是 `PagedList` 的 `.ToPagedList(pageNumber, pageSize)` —— 前台每頁 6 筆，後台每頁 20 筆。

**逐字要重現的 markup 細節、以及從正式站抓下來的實際輸出，全部在 [03-url-contract](03-url-contract.md) §5.1。** 移植分頁器時看那一節，不要從這裡的 C# 反推。

### 3.6 聯絡表單

[Views/Home/Contact.cshtml](../reference/old/Gleanstudio/Views/Home/Contact.cshtml) 是全站唯一的 POST 端點。

**表單**：手寫 `<form id="form" method="post" action="@Url.Action("Contact")">`，沒有用 `Html.BeginForm`，**沒有 anti-forgery token**。送出鈕是 `<div id="btnSubmit">` 由 jQuery 觸發 `$("#form").submit()` —— **不是真的 submit button，所以關掉 JS 表單就完全送不出去**。

reCAPTCHA v3 在 `@section scripts` 載入，site key `6LdbNcwcAAAAAND-6LKK67EUEnk6I-9rFboJkV5M`，action 名稱是 `login`（在聯絡表單上用 `login` 這個 action 名很奇怪，但驗證端也是比對 `login`，照抄）。token 塞進隱藏欄位 `GoogleCaptchaToken`。

**model**（[Gleanstudio.Models/Partial/Contact.cs](../reference/old/Gleanstudio.Models/Partial/Contact.cs)）不是 EF 實體，是純 DataAnnotations view model：

| 欄位 | 驗證 | 錯誤訊息 |
|---|---|---|
| `Name` | Required | `請輸入姓名` |
| `Email` | Required + EmailAddress | `請輸入Email` / `Email格式錯誤` |
| `Title` | Required | `請輸入主旨` |
| `Phone` | Required | `請輸入電話` |
| `Message` | Required | `請輸入訊息` |

**伺服器端流程**（[HomeController.cs:194-227](../reference/old/Gleanstudio/Controllers/HomeController.cs#L194-L227)）：

1. `ModelState.IsValid` 不過 → `ModelState.AddModelError("", "")`（加一個空訊息）→ 回 `View()`，狀態碼 **200**
2. reCAPTCHA 驗證：POST 到 `https://www.google.com/recaptcha/api/siteverify`，要求 `Success && Action == "login" && Score > 0.5`。不過 → `ModelState.AddModelError("", "驗證碼錯誤")` → 回 `View()`
3. 都過 → 組純文字信件內容（姓名/Email/主旨/聯絡電話/訊息）→ `Librarys.SendGridExecute(...)` → `RedirectToAction("Index")`，**302**

**寄信這一段有三個疊在一起的缺陷**，本輪決定原樣保留，完整說明在 [09-known-issues](09-known-issues.md) §3。

頁面左側的聯絡資訊全部寫死在 view，不來自資料庫：臺中市大雅區龍善三街148號 / 臺南市北區公園路427巷29號 / 0987119558 / `glean1218@gmail.com` / 週一~五 09：30 ~ 17：30。

### 3.7 前台資產

**CSS**：只載一支 `Content/css/style.css`，268,341 bytes。由 `Content/scss/style.scss` + `globle.scss` 編譯而來，Bootstrap 5.1.1 已編進去。

⚠️ **SCSS 無法重新編譯** —— `globle.scss` 第一行是 `@import "../../node_modules/bootstrap/scss/bootstrap";`，但 repo 裡**沒有 `package.json` 也沒有 `node_modules`**。所以 `style.css` 是既成事實，直接原樣複製到 `public/Content/css/`，不要嘗試重建。

品牌色（宣告在 `globle.scss`）：

```scss
$primary-color:   #b9826d;   // r-bg-primary
$secondary-color: #cb9d57;   // r-bg-secondary
$third-color:     #9faaa7;   // r-bg-third
```

這三個 class 名稱**存在資料庫的 `ArticleTypes.BgClass` 欄位裡**，view 直接輸出。

字型由 CSS 內的 `@import` 從 Google Fonts 載入：Noto Sans TC (300)、Cinzel、Noto Serif TC (500)。內文 `"Noto Serif TC", serif; 15px; #272726`。

**JS**：只有 3 支自有檔案 —— `jquery-latest.js`（其實是 **jQuery 1.11.1**）、`jquery.zoom.js`（只有 Gallery 用）、`nav.js`（110 bytes，切換 `.hamburger` 的 `.active`）。

**Bundle**：`App_Start/BundleConfig.cs` 的 10 個 bundle **全部是後台專用**（SmartAdmin 佈景）。前台完全沒有 bundle，就是普通的 `<link>` / `<script>`，不壓縮不合併。

**圖片**：`Content/images/` 約 13 MB，未最佳化。但**實際被 live view 引用的只有** `logo.png`、`Content/images/svg/*`（11 個圖示）、以及 `gallery-pic-1..3.jpg`。其餘是當初靜態稿留下的殘骸，移植時只搬有用到的。

`Content/css/` 底下的 `globle.css`、`style_mobile.css` 與各自的 `.map` **沒有被任何 view 引用**，不搬。

### 3.8 上傳檔案的路徑慣例

前台只**讀**後台寫入的檔案，慣例是：

```
~/Upload/{Entity}/{ID}/{Photo}
```

其中 `Photo` 是存在資料庫欄位裡的檔名，格式 `yyyyMMddHHmmss.{副檔名}`。

| 路徑樣式 | 出現在 |
|---|---|
| `~/Upload/ArticleTypes/{ArticleTypeID}/{Photo}` | Index、Services |
| `~/Upload/Articles/{ArticleID}/{Photo}` | Index、Articles |
| `~/Upload/Abouts/{AboutID}/{Photo}`（ID 永遠是 1） | Index |
| `~/Upload/Services/{ServiceID}/{Photo}` | Service |
| `~/Upload/Teams/{TeamID}/{Photo}` | Team |
| `~/Upload/Projects/{ProjectID}/{Photo1..4}` | **已註解掉**，`Projects` 表也沒有 Photo 欄位 |

新系統的 R2 key 與這個路徑逐字相同，見 [02-architecture](02-architecture.md) §5。

### 3.9 沒有多語系

完全沒有 i18n 基礎建設：沒有 `<globalization>`、沒有 `.resx`、沒有 `CultureInfo` 操作、沒有語言切換。所有文案硬寫在 `.cshtml` 與 C# 字串裡。

看起來像雙語的部分其實是**逐筆資料**：`ArticleTypes.Title`（中）+ `SubTitle`（英，經 `@Html.Raw` 所以可含 `<br>`）、`Teams.Name` + `EnName`。

日期 `CreateDate.ToString("dd MMMM yyyy")` **沒有指定 CultureInfo**，跟著伺服器 culture 走 —— 正式站實測輸出 `20 July 2026`，是 en-US。這個細節在 [03-url-contract](03-url-contract.md) §5.4 有完整說明，是最容易靜默破壞 parity 的地方。

---

## 4. 後台

Area `backend`，路由 `backend/{controller}/{action}/{id}`，佈景是 SmartAdmin（新系統不沿用）。

| Controller | 職責 |
|---|---|
| `BaseController` | `OnActionExecuted` 把整棵 `Lims` 樹讀進 `ViewBag.SiteLinks` 供側邊選單使用 |
| `MainController` | `Login` GET/POST、`Logout`、`Index`（儀表板） |
| `SettingMsController` | 管理員 CRUD + 權限勾選（`AdminLims`） |
| `WebMsController` | 730 行，7 個實體的 CRUD + `Sort*` 批次排序 |
| `AjaxController` | 只有 `CheckUsername`，回 `{valid:bool}` 供 BootstrapValidator 遠端檢查 |

`WebMsController` 涵蓋 ArticleTypes、Articles、Services、Teams、Projects（無圖）、Abouts（單列）。共通手法：`TryUpdateModel(entity, string[] allowed)` 白名單繫結、建立時指派 `Guid.NewGuid()`、`Sort*` 批次呼叫 `SpecificUpdate(entity, new[]{"Sort"})` 後一次 `SaveChanges()`、`ArticleTypesDropDownList()` 建 `ViewBag.ArticleTypeID`。Summernote 承載的欄位加 `[ValidateInput(false)]`。

**檔案上傳邏輯在 `WebMsController` 裡複製了 7 次**，每次都是：`Server.MapPath("~/Upload/{Entity}/{Id}")` → 沒有就建目錄 → 刪掉舊檔 → 改名為 `DateTime.Now.ToString("yyyyMMddHHmmss") + 原副檔名` → `SaveAs`。刪除時 `Directory.Delete(savePath, true)`。**沒有副檔名白名單、沒有 content-type 檢查、沒有大小限制、沒有縮圖**，而 `Web.config` 允許 100 MB。

新後台的規格見 [06-admin-spec](06-admin-spec.md)。

---

## 5. 認證與授權

**登入**（`MainController.ValidateUser`）：

- 用 **Session**，不是 Forms Auth。`Web.config` 沒有 `<authentication>`、`<authorization>`、`<sessionState>`、`machineKey`
- **寫死的後門超級使用者**：帳號 `weypro`（密碼寫死在 [CheckSessionAttribute.cs](../reference/old/Gleanstudio/Filters/CheckSessionAttribute.cs)，**這裡不轉錄** —— 見本檔開頭的說明）→ `Session["AdminID"] = 888`，繞過所有權限檢查
- 一般登入：查 `Username` 後 `admin.Password != password` **明碼字串比對**，沒有雜湊、沒有 salt、沒有鎖定、沒有 timing-safe 比較
- 成功後設 `Session["IsLogin"]`、`["Username"]`、`["AdminID"]`、`["AdminLims"]`（把 EF 的延遲載入集合直接塞進 session）
- `Logout` 只設 `IsLogin = false` 並移除 `Username`，**`AdminID` 與 `AdminLims` 留在 session 裡**

**授權**（[Filters/CheckSessionAttribute.cs](../reference/old/Gleanstudio/Filters/CheckSessionAttribute.cs)）：

```csharp
ac = ac.Replace("Add", "").Replace("Edit", "").Replace("Delete", "");
Lims lim = limsService.Get().Where(a => a.Key.Contains(controller)).FirstOrDefault();
int limid = limsService.Get().Where(a => a.Key.Contains(ac) && a.ParentID == lim.LimID)…
```

四個結構性問題：

1. **`Replace` 而不是 `StartsWith`** —— 會移除 action 名稱中**任何位置**的 `Add`/`Edit`/`Delete`
2. **`Key.Contains(...)` 子字串比對** —— 任何 Key 是另一個 Key 的子字串就會靜默授予錯誤權限。以目前 9 筆資料而言碰巧安全（見 [04-data-model](04-data-model.md) §7），但那是運氣
3. **`lim.LimID` 沒有 null 檢查** —— 找不到對應 Lims 就 NRE
4. **拒絕時導向 `/Error/Validation`，而這個路由從未實作** —— 實測正式站回 404。所以權限不足的表現跟打錯網址一模一樣

`Sort*` action 沒有被 Add/Edit/Delete 的對應涵蓋。列表的讀取權限只靠 `AdminLims` 資料列存在與否。

**選單層過濾**：`App_Helpers/HtmlHelperExtensions.cs` 的 `SiteMenuAsUnorderedList` / `buildMenuItems` 讀 `Session["AdminLims"]` 隱藏無權限的選單項。

所以 `Lims` 同時是側邊選單樹**和**權限目錄：第一層是 controller，第二層是 action/頁面，`AdminLims` 給的是「資料列存在 = 可檢視」加上 Add/Update/Delete 三個旗標。

---

## 6. Repository / Service 抽象

兩層很薄的手工封裝，**沒有 DI 容器** —— controller 在建構式裡直接 `new`。

- `Gleanstudio.Models/Interface/IRepository.cs` → `Insert`、`Update`、`SpecificUpdate(entity, string[] props)`、`Delete`、`GetByID`、`IQueryable<TEntity> Get()`、`SaveChanges()`、`ExeLog()`
- `Gleanstudio.Models/Repository/GenericRepository.cs` → 包 `GleanstudioEntities` + `DbSet<TEntity>`。`Update` 是 Attach + `State = Modified`；`SpecificUpdate` 關掉 `ValidateOnSaveEnabled` 只標記指定屬性為 `IsModified`（供 `Sort*` 批次用）
- `Gleanstudio.Service/BaseService.cs` → 每個變更方法回傳 `IResult`（`ID` / `Success` / `Message` / `Exception` / `InnerResults`），例外被吞進 `result.Exception`

⚠️ **controller 完全忽略回傳的 `IResult`**，所以寫入失敗是靜默的。

具體 service 全部是 ~20 行、零領域邏輯的子類別：`AboutsService`、`AdminLimsService`、`AdminsService`、`ArticleTypesService`、`ArticlesService`、`LimsSerivce`（**類別名稱有錯字**）、`ProjectsService`、`ServicesService`、`TeamsService`。

Unit of work 是手動的：controller 建一個 `GleanstudioEntities db` 傳給所有 service，讓單次 `SaveChanges()` 一起提交。但 `BaseController` 與 `CheckSessionAttribute` 用的是無參數建構式，各自開自己的 context。

新系統用 Drizzle 取代整層，見 [04-data-model](04-data-model.md) §6。

---

## 7. 工具類

**`App_Helpers/`**
- `Settings.cs` —— 有 `config:` 前綴慣例的 appSettings 讀取器。`Company`、`Project`、`EnableTiles`、`EnableLoader` 這幾個 key **在 `Web.config` 裡不存在**，所以是 null / false
- `HtmlHelperExtensions.cs` —— `AssemblyVersion`、`Copyright`、`RouteIf`、`RenderPartialIf`、`ValidationBootstrap`、`RemoveHtmlTag`（用 `Encoding.Default` 依 byte 數截斷，會切壞多位元組字元）、以及權限感知的 `SiteMenuAsUnorderedList`
- `StringExtensions.cs`、`DashRouteHandler.cs`（未接上）、`ViewExtensions.cs`

**`Commons/Librarys.cs`**
- `ByteArrayToFile`
- `SendMail` —— `SmtpClient` 寫死 GoDaddy `relay-hosting.secureserver.net:25`。**呼叫端已註解掉**
- `SendGridExecute` —— SendGrid v9 非同步寄送，**API key 寫死在原始碼**，寄件人 `notification@weypro.com`

**`Infrastructure/Paging/`** —— 見 §3.5

**驗證** —— DataAnnotations 只用在 `Models/Partial/Contact.cs`。EF 實體完全沒有屬性標註，後台驗證靠 client 端 BootstrapValidator 加上 `TryUpdateModel` 白名單。

---

## 8. Web.config 與外部整合

**appSettings**：只有 `webpages:Version`、`webpages:Enabled=false`、`ClientValidationEnabled=true`、`UnobtrusiveJavaScriptEnabled=true`、`config:CurrentTheme=fixed-navigation`。

**production 不安全的設定**：`compilation debug="true"`、`customErrors mode="Off"`（完整堆疊追蹤直接吐給訪客）。`Web.Release.config` 把 `debug` 轉成 `false` 並插入 Force HTTPS 的 rewrite 規則，但 `customErrors` 的轉換是註解掉的 —— 所以正式站確實會顯示黃頁，實測 `/Home/ArticleDetail?ArticleID=<不存在>` 回 500 就是這個原因。

**上傳限制**：`maxRequestLength="102400"`（100 MB）、`maxAllowedContentLength="104857600"`、`executionTimeout="600"`。

**外部整合**（全部寫死在原始碼，不在 config）：

1. **SendGrid** —— `Commons/Librarys.cs`，API key 是字面值，寄件人 `notification@weypro.com`
2. **SMTP (GoDaddy)** —— `Commons/Librarys.cs`，呼叫端已註解
3. **Google reCAPTCHA v3** —— `Controllers/HomeController.cs`，secret 是字面值
4. **Google Analytics** —— gtag `G-G2CBNFFB3Q`
5. **Google Fonts** —— 由 `style.css` 內的 `@import` 載入

外洩憑證的完整清單與處置見 [09-known-issues](09-known-issues.md) §2。
