---
name: port-a-page
description: 把舊站的一個 Razor view 移植成 Astro 頁面。當任務是「移植 /Home/XXX」「把某個 .cshtml 轉成 .astro」或 Phase 3 的任何一頁時使用。這個流程會重複 11 次，每次都照著走。
---

# 移植一個前台頁面

前台的 HTML 與 URL 已凍結（[docs/03-url-contract.md](../../../docs/03-url-contract.md)）。這不是「做一個長得像的頁面」，是**重現輸出**。

## 1. 先讀契約那一列

打開 [docs/03-url-contract.md](../../../docs/03-url-contract.md)，找到這一頁的列，確認：

- URL 與查詢參數的**確切**拼法與大小寫
- 期望的狀態碼
- `<title>` 的確切文字（§6 有完整對照表）
- 這一頁有沒有列在 §5 的怪癖清單裡

## 2. 讀 Razor 原始檔

`reference/old/Gleanstudio/Views/Home/{Name}.cshtml`，以及 [HomeController.cs](../../../reference/old/Gleanstudio/Controllers/HomeController.cs) 對應的 action。

要弄清楚的三件事：

- **ViewBag 傳了什麼進來** —— 舊站幾乎所有資料都走 ViewBag，view 再轉型回來
- **有沒有 `@Html.Raw`** —— 富文本要原樣輸出，不要轉義
- **有沒有 inline `onclick` 或 `@section scripts`**

⚠️ 不要修 bug。看到明顯壞掉的東西（例如分頁 URL 掉參數），先查 [docs/09-known-issues.md](../../../docs/09-known-issues.md) —— 多半是刻意保留的。

## 3. 寫兩個檔

**整頁元件**：`src/components/pages/{Name}Page.astro`
**route 檔**：`src/pages/Home/{Name}.astro`，約 4 行，只 import 並使用整頁元件

frontmatter 裡把 ViewBag 換成明確的 typed 查詢：

```astro
---
import Site from '../../layouts/Site.astro';
import { getArticleTypes, getArticles } from '../../db/queries';
import { getParam } from '../../lib/query';

const articleTypes = await getArticleTypes();          // ← BaseController 的全域注入
const articleTypeId = getParam(Astro.url, 'ArticleTypeID');   // 大小寫不敏感
---
```

## 4. 三個最容易錯的地方

| 陷阱 | 正確做法 |
|---|---|
| 日期格式 | **en-US**，`dd MMMM yyyy` → `20 July 2026`。用 zh-TW 會靜默破壞 parity |
| HTML 空白 | `compressHTML: false` 必須已設定，且要重現 Razor 的縮排 |
| 查詢參數大小寫 | 用 `getParam()`，ASP.NET 接受 `?articleid=` |

## 5. 比對

```bash
npm run preview                    # 不要用 npm run dev
npm run parity -- /Home/{Name}
```

Level B（DOM）必須通過。Level A（byte）的差異要逐條看過 —— 判斷是真回歸還是內容漂移，用 `parity-check` skill。

## 6. 收尾

- [ ] 在 [docs/11-roadmap.md](../../../docs/11-roadmap.md) Phase 3 勾掉這一頁
- [ ] 若發現契約文件沒記到的怪癖，**補進 [docs/03-url-contract.md](../../../docs/03-url-contract.md) §5**
- [ ] 若接受了某個 Level A 差異，記進 [docs/08-verification.md](../../../docs/08-verification.md) §7 並寫原因

## 不要移植的東西

`CulturalRelic.cshtml`、`Research.cshtml`、`Exhibition.cshtml`、`Digital.cshtml` —— 對應的 action 已被註解掉，路由不可達。它們依賴一個已不存在的 `Services.ServiceType` 欄位。
