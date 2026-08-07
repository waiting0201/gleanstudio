# 02 — 新系統架構

相關：[03-url-contract](03-url-contract.md)｜[04-data-model](04-data-model.md)｜[07-deployment](07-deployment.md)｜[10-decisions](10-decisions.md)

---

## 1. 全貌

**一個 Worker，包辦全部。** 前台、後台、API、媒體服務都在同一個 Cloudflare Worker 裡。

```
                    ┌─────────────────────────────────────────────┐
   請求  ──────────▶│  Cloudflare Workers（單一 Worker）           │
                    │                                             │
                    │  ① Workers Assets                           │
                    │     /Content/**  /Scripts/**  → 直接回應     │
                    │     （在 Worker 執行前就攔下）                │
                    │                                             │
                    │  ② src/middleware.ts                        │
                    │     URL 大小寫正規化（rewrite，非 redirect）  │
                    │                                             │
                    │  ③ Astro 檔案路由                            │
                    │     /Home/**       → 前台頁面 ────┐          │
                    │     /backend/**    → 後台頁面 ────┤          │
                    │     /Upload/**     → R2 媒體 ─────┤          │
                    │     /api/**        → Hono ───────┤          │
                    └───────────────────────────────────┼──────────┘
                                                        │
                              ┌─────────────────────────┼──────────┐
                              ▼             ▼           ▼          ▼
                            D1 (DB)    R2 (MEDIA)  KV (SESSION)  外部
                            9 張表      圖片        後台 session   reCAPTCHA
                                                                  SendGrid
```

## 2. 為什麼是這個組合

| 選擇 | 理由 |
|---|---|
| **Astro SSR** | 檔案路由直接對應 `/Home/About` 這種網址且**保留大小寫**，不需要任何 rewrite 設定；Astro 元件可以直接塞原始 HTML，是把 Razor markup 逐字搬過來最省力的路徑（Vue/JSX 都要先轉語法） |
| **Hono 掛 `/api`** | 後台的 middleware 鏈（session → 權限 → CSRF → zod 驗證）用 Hono 表達比在十幾個 Astro endpoint 各寫一次乾淨。**只用在後台 API**，前台不碰 |
| **D1** | Cloudflare 原生，免費額度涵蓋這個規模（9 張表、~100 筆資料），無外部服務 |
| **R2** | 同上；key 可與舊路徑逐字相同，遷移是純複製 |
| **KV + Astro Sessions API** | 有伺服器端撤銷能力。JWT 沒有 —— 管理員被移除或權限被撤銷後，有效的 token 仍然能用到過期 |
| **單一 Worker** | 一個部署產物、一組 binding。拆成獨立 API Worker 要多一組 service binding、第二份 `wrangler.jsonc`、第二個 CI job，就為了一個給少數編輯者用的後台，不划算 |

完整取捨紀錄在 [10-decisions](10-decisions.md)。

---

## 3. 目錄結構

```
src/
├── middleware.ts              URL 大小寫正規化
├── layouts/
│   └── Site.astro             ← Views/Shared/_Layout.cshtml
├── components/
│   ├── Header.astro           ← _Header.cshtml（吃 articleTypes prop）
│   ├── Footer.astro           ← _Footer.cshtml
│   ├── Styles.astro           ← _Styles.cshtml
│   ├── Scripts.astro          ← _Scripts.cshtml
│   ├── Pager.astro            ← Infrastructure/Paging/CustomPager.cs
│   └── pages/                 每個 Razor view 一個檔
│       ├── HomeIndexPage.astro
│       ├── HomeAboutPage.astro
│       └── …
├── pages/                     只有路由，每個檔約 4 行
│   ├── index.astro                        → /
│   ├── Home/
│   │   ├── Index.astro                    → /Home/Index
│   │   ├── About.astro                    → /Home/About
│   │   ├── Articles.astro                 → /Home/Articles
│   │   ├── ArticleDetail.astro            → /Home/ArticleDetail
│   │   ├── Services.astro  Service.astro
│   │   ├── Project.astro   Team.astro
│   │   ├── Gallery.astro
│   │   └── Contact.astro                  → GET + POST
│   ├── Upload/[entity]/[id]/[photo].ts    → R2
│   ├── backend/**                         → 後台
│   ├── Error/Validation.astro             → 403
│   └── api/[...path].ts                   → Hono
├── api/
│   └── app.ts                 Hono app 建構
├── db/
│   ├── schema.ts              Drizzle，單一真相來源
│   └── queries.ts             前台查詢
└── lib/
    ├── query.ts               大小寫不敏感的 searchParams 讀取
    ├── media.ts               上傳處理（取代舊系統複製 7 次的邏輯）
    ├── contact.ts             聯絡表單邏輯
    └── auth/
        ├── permissions.ts     ROUTE_PERMISSIONS 註冊表
        └── password.ts        PBKDF2 雜湊與驗證

public/
├── Content/                   從 reference/ 逐字複製（css/ + 有用到的 images/ + svg/）
└── Scripts/                   jquery-latest.js, jquery.zoom.js, nav.js
```

### Razor → Astro 對照

| Razor | Astro | 備註 |
|---|---|---|
| `Views/Shared/_Layout.cshtml` | `src/layouts/Site.astro` | `<html lang="en">` 照抄 |
| `_Styles.cshtml` | `src/components/Styles.astro` | 單行 `<link>` |
| `_Header.cshtml` | `src/components/Header.astro` | 吃 `articleTypes` prop |
| `_Footer.cshtml` | `src/components/Footer.astro` | 靜態 |
| `_Scripts.cshtml` | `src/components/Scripts.astro` | Popper 2.9.2 + Bootstrap 5.0.1 + gtag，含 `integrity` 全部照抄 |
| `CustomPager.cs` | `src/components/Pager.astro` | 連 bug 一起重現，見 [03](03-url-contract.md) §5.1 |
| `BaseController.OnActionExecuting` | `src/db/queries.ts#getArticleTypes()` | 每頁明確呼叫 |
| `Views/Home/*.cshtml` | `src/components/pages/*Page.astro` | 一對一 |

`_Styles` 與 `_Scripts` 都只有一兩行，直接內嵌進 `Site.astro` 也說得通 —— 但保持一對一讓移植結果可以逐檔對照 Razor 原始碼審閱，這個價值高於省下兩個檔案。

---

## 4. Hono 的掛載方式

```ts
// src/pages/api/[...path].ts
export const prerender = false;
import type { APIRoute } from 'astro';
import { app } from '../../api/app';

export const ALL: APIRoute = (ctx) =>
  app.fetch(ctx.request, undefined, ctx.locals.cfContext);
```

`src/api/app.ts` 建立 Hono app，用 `@astrojs/cloudflare/hono` 的 `cf()` middleware 把 `env` 與 `executionCtx` 接進 Hono context。

**舊站沒有任何 `/api/*` 路徑**，所以掛在這裡不可能牴觸 [03-url-contract](03-url-contract.md) 的凍結範圍。

### 唯一的例外：`POST /Home/Contact` 不走 Hono

它必須在那個確切的網址回傳 **HTML**（驗證失敗 200 重新渲染表單、成功 302 轉 `/`），所以在 `.astro` 頁面內處理：frontmatter 判斷 `Astro.request.method === 'POST'` 並 `await Astro.request.formData()`，共用邏輯放 `src/lib/contact.ts`。

繞道 Hono 的話，不是得改網址、就是得在 Hono handler 裡渲染 Astro 輸出，兩個都更糟。

---

## 5. R2 媒體服務

舊網址 `~/Upload/{Entity}/{ID}/{Photo}` 完全不變。

```ts
// src/pages/Upload/[entity]/[id]/[photo].ts
export const prerender = false;
import { env } from 'cloudflare:workers';

const ENTITIES = new Map(
  ['Abouts','ArticleTypes','Articles','Services','Teams'].map(e => [e.toLowerCase(), e])
);
const ID    = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^\d+$/i;
const PHOTO = /^\d{14}\.(jpe?g|png|gif|webp)$/i;

export const GET: APIRoute = async ({ params, request }) => {
  const entity = ENTITIES.get(String(params.entity).toLowerCase());
  if (!entity || !ID.test(params.id!) || !PHOTO.test(params.photo!))
    return new Response(null, { status: 404 });

  const key = `Upload/${entity}/${params.id!.toLowerCase()}/${params.photo}`;
  const obj = await env.MEDIA.get(key, {
    onlyIf: request.headers,   // If-None-Match / If-Modified-Since
    range:  request.headers,   // Range
  });
  if (!obj) return new Response(null, { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  if (!('body' in obj)) return new Response(null, { status: 304, headers });
  return new Response(obj.body, { status: obj.range ? 206 : 200, headers });
};
```

要點：

- **R2 key 就是舊路徑本身。** 遷移是純複製；「這張圖在不在」永遠可以用一行 `wrangler r2 object get` 回答；真要回退到舊系統也不需要轉換 key
- 路徑片段做大小寫不敏感比對，但查 R2 之前正規化回正式大小寫 —— **R2 key 本身是大小寫敏感的**
- `immutable` 是安全的，因為後台換圖時是寫入**新的**時間戳檔名並更新資料庫欄位，同一個網址永遠不會對應到不同的 bytes
- `public/Content` 與 `public/Scripts` 由 Workers Assets 在 Worker 之前處理掉，`/Upload/*` 不匹配任何資產所以會落到這個路由。理論上不需要 `run_worker_first`，但**第一次跑 `wrangler dev` 要親眼確認**

---

## 6. 執行環境設定

### `astro.config.mjs`

```js
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  output: 'server',
  adapter: cloudflare(),
  site: 'https://gleanstudio.com.tw',
  trailingSlash: 'ignore',   // 預設值，且與 IIS 行為相符（實測 /Home/About/ → 200）
  build: { format: 'preserve' },
  compressHTML: false,       // ⚠️ 不可省略，見 03-url-contract §3.4
});
```

### Bindings

| Binding | 型別 | 用途 |
|---|---|---|
| `DB` | D1 | 9 張表 |
| `MEDIA` | R2 | `Upload/**` |
| `SESSION` | KV | 後台 session（Astro Sessions API 預設名稱） |
| `ASSETS` | Assets | `public/` 靜態檔 |

完整 `wrangler.jsonc` 在 [07-deployment](07-deployment.md) §1。

### 版本注意事項

Astro Cloudflare adapter 近期有兩處變動，從記憶寫容易出錯：

- **`Astro.locals.runtime` 在 adapter v13（Astro 6）已移除。** binding 改從 `import { env } from "cloudflare:workers"` 取得，執行 context 從 `Astro.locals.cfContext` 取得
- `wrangler.jsonc` 的統一進入點是 `"main": "@astrojs/cloudflare/entrypoints/server"`

建立專案時以當下的官方文件為準，不要照抄這裡的版本號。

---

## 7. 免費方案的影響

專案跑在 **Workers 免費方案**，CPU 上限 10 ms。這對架構有一個實質影響：

**密碼雜湊只能用 Web Crypto 的 PBKDF2-SHA256，最多 100,000 次迭代**（Workers 的硬上限，超過會丟 `NotSupportedError`）。scrypt 在 `N=16384` 需要 50–100 ms CPU，免費方案跑不完。

這低於 OWASP 目前建議的 600,000 次，但仍然遠優於現況（`nvarchar(20)` 明碼）。細節見 [06-admin-spec](06-admin-spec.md) §3，待辦記在 [09-known-issues](09-known-issues.md)。

其餘架構不受免費方案限制 —— 前台每個請求只有 1–2 個 D1 查詢，遠低於 10 ms。
