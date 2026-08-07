# 06 — 後台規格

**範圍**：後台的**介面**重做（丟掉 SmartAdmin 佈景），但**權限模型保留** —— Admins / Lims / AdminLims 三張表與其語意原封不動。

後台不在 [03-url-contract](03-url-contract.md) 的凍結範圍內，但路由形狀仍然沿用舊的 `/backend/{controller}/{action}`，因為編輯者有書籤，換掉沒有任何好處。

相關：[01-legacy-inventory](01-legacy-inventory.md) §4-5｜[04-data-model](04-data-model.md) §7｜[09-known-issues](09-known-issues.md)

---

## 1. 路由

| 路由 | Method | 說明 |
|---|---|---|
| `/backend/Main/Login` | GET, POST | 介面重做 |
| `/backend/Main/Logout` | **POST** | 舊站是 GET。**改掉** —— GET 登出可被 CSRF |
| `/backend/Main/Index` | GET | 儀表板 |
| `/backend/WebMs/{ArticleTypes,Articles,Services,Teams,Projects}` | GET | 列表，每頁 20 |
| `/backend/WebMs/{Add,Edit}{Entity}` | GET | 表單 |
| `/backend/WebMs/Abouts` | GET | 單列（`AboutID = 1`） |
| `/backend/SettingMs/Admins`, `AddAdmins`, `EditAdmins` | GET | |
| `/backend/Forbidden` | GET | **403**，原地渲染 |
| `/Error/Validation` | GET | **403** 別名，見 §7 |
| `/api/admin/**` | POST | Hono 處理所有變更操作，**含刪除**（舊站是 `[HttpGet]`） |

Astro 頁面負責渲染，Hono 負責變更。表單 POST 到 `/api/admin/*`，handler 完成後回 303 導回列表。

---

## 2. Session

**用 Astro Sessions API + Workers KV。** Sessions API 自 `astro@5.7.0` 起穩定，Cloudflare adapter 會自動設定 KV driver，binding 預設名稱 `SESSION`（可用 `sessionKVBindingName` 改），namespace 可由 Wrangler 在部署時建立。

```ts
await ctx.session.regenerate();                       // 登入時輪替 id —— 防 session fixation
ctx.session.set('admin', { adminId, username, isSuper, issuedAt });
```

Cookie：`httpOnly`、`secure`、`sameSite=lax`，TTL 8 小時。

### ⚠️ 不要把權限矩陣快取進 session

舊系統把 `Session["AdminLims"]`（一個 EF 延遲載入集合）整包塞進 session，結果是**改了權限要重新登入才生效**。不要重蹈覆轍。

每個請求直接查 D1（一次走索引的查詢，約 1 ms），或用 KV 以 `AdminID` 為 key 快取但在寫入時明確失效。

### 另外要修的

舊站的 `Logout` 只設 `IsLogin = false` 並移除 `Username`，把 `AdminID` 與 `AdminLims` 留在 session 裡。新站呼叫 `session.destroy()`。

### 為什麼不用 JWT

**沒有伺服器端撤銷能力。** 管理員被移除、或權限被撤銷之後，一枚有效的 token 仍然能用到過期。對一個有權限矩陣的後台來說這是錯的取捨。

「把權限 blob 簽在 cookie 裡」有同樣的撤銷問題，而且 `AdminLims` 集合可能逼近 4 KB 的 cookie 上限，還等於重新發明框架已經提供的東西。

KV 的最終一致性在這裡不是問題：session 在登入時寫一次，之後由同一個使用者讀取，後台流量是每分鐘個位數請求。

---

## 3. 密碼雜湊

### 平台限制（已查證，非憑記憶）

| 事實 | 影響 |
|---|---|
| Web Crypto 的 PBKDF2 在 Workers **硬性限制 100,000 次迭代**，超過丟 `NotSupportedError`（cloudflare/workerd#1346） | 上限就在這裡 |
| Web Crypto 的 `deriveBits`/`deriveKey` 只支援 HKDF 與 PBKDF2 | 沒有 scrypt、沒有 Argon2 |
| `node:crypto` 在 `nodejs_compat` 下可用，`crypto.scrypt` 不受 PBKDF2 上限限制 | 但 scrypt 在 `N=16384` 需要 ~16 MB 記憶體與 50–100 ms CPU |
| **本專案跑在 Workers 免費方案，CPU 上限 10 ms** | **scrypt 跑不完** |

### 決定：PBKDF2-SHA256 @ 100,000 迭代

```
格式：pbkdf2$100000$<saltBase64>$<hashBase64>
salt：16 bytes 隨機（crypto.getRandomValues）
輸出：32 bytes
比對：constant-time
```

實作放 `src/lib/auth/password.ts`。

**誠實說明**：100,000 次低於 OWASP 目前對 PBKDF2-SHA256 建議的 600,000 次，而 Workers 不允許再高。這是免費方案的直接後果。

即便如此，這仍然是對現況（`nvarchar(20)` 明碼、字串相等比對）的巨大改善。

**升級路徑**：改用 Workers Paid（$5/月）之後可切換到 `node:crypto` 的 scrypt（`N=16384, r=8, p=1`），格式 `scrypt$16384$8$1$<salt>$<hash>`，需要 `"compatibility_flags": ["nodejs_compat"]`。雜湊字串前綴已經帶了演算法名稱，所以可以做漸進式遷移（登入成功時順手重算）。這條待辦記在 [09-known-issues](09-known-issues.md)。

---

## 4. 移除後門帳號

舊站的 `weypro` / `weypro12ab` → `AdminID = 888` 繞過所有權限檢查。

**直接刪除，不留相容層。** 改用 `Admins.IsSuperAdmin` 欄位 —— 一樣可以繞過 `AdminLims` 檢查，但它是一筆真實、可稽核、可撤銷的資料列。

`scripts/bootstrap-admin.mjs` 用來建立或提升一個超級管理員，密碼從 stdin 讀取，只寫入雜湊。**不准出現在原始碼裡，也不准放進 `vars`。**

匯入時檢查有沒有 `AdminID = 888` 的資料列（幾乎確定沒有 —— 888 是憑空捏造的，從未被寫進資料庫），確認後刪除相關程式碼。

---

## 5. 權限比對：精確化

### 舊做法的問題

[CheckSessionAttribute.cs:51-58](../reference/old/Gleanstudio/Filters/CheckSessionAttribute.cs#L51-L58)：

```csharp
ac = ac.Replace("Add", "").Replace("Edit", "").Replace("Delete", "");
Lims lim = limsService.Get().Where(a => a.Key.Contains(controller)).FirstOrDefault();
int limid = limsService.Get().Where(a => a.Key.Contains(ac) && a.ParentID == lim.LimID)…
```

`Replace` 會移除 action 名稱中**任何位置**的 `Add`/`Edit`/`Delete`（一個叫 `AddressEdit` 的 action 會被切成 `ress`），而 `Key.Contains(...)` 是子字串比對 —— 任何 Key 是另一個 Key 的子字串就會靜默授予錯誤權限。

以目前 9 筆 `Lims` 資料而言碰巧安全（見 [04-data-model](04-data-model.md) §7），但那是運氣。

### 新做法：明確註冊表

```ts
// src/lib/auth/permissions.ts
export type Verb = 'view' | 'add' | 'update' | 'delete';

export const ROUTE_PERMISSIONS = {
  'WebMs/ArticleTypes':       { parent: 'WebMs', child: 'ArticleTypes', verb: 'view'   },
  'WebMs/AddArticleTypes':    { parent: 'WebMs', child: 'ArticleTypes', verb: 'add'    },
  'WebMs/EditArticleTypes':   { parent: 'WebMs', child: 'ArticleTypes', verb: 'update' },
  'WebMs/DeleteArticleTypes': { parent: 'WebMs', child: 'ArticleTypes', verb: 'delete' },
  'WebMs/SortArticleTypes':   { parent: 'WebMs', child: 'ArticleTypes', verb: 'update' },
  // …Articles / Services / Teams / Projects / Abouts 同樣四到五行
  'SettingMs/Admins':         { parent: 'SettingMs', child: 'Admins', verb: 'view'   },
  'SettingMs/AddAdmins':      { parent: 'SettingMs', child: 'Admins', verb: 'add'    },
  'SettingMs/EditAdmins':     { parent: 'SettingMs', child: 'Admins', verb: 'update' },
  'SettingMs/DeleteAdmins':   { parent: 'SettingMs', child: 'Admins', verb: 'delete' },
} as const satisfies Record<string, { parent: string; child: string; verb: Verb }>;
```

注意 `Sort*` 對應到 `update` —— **舊系統的 Add/Edit/Delete 對應表根本沒有涵蓋 `Sort*`**，等於排序操作只要有檢視權限就能做。這裡補上。

解析是單一的精確比對查詢，per-isolate memoize：

```sql
SELECT c.LimID FROM Lims c
JOIN Lims p ON p.LimID = c.ParentID
WHERE p."Key" = ?1 AND c."Key" = ?2 AND p.ParentID IS NULL;
```

再查 `AdminLims` 的 `(AdminID, LimID)`，動詞對應欄位：`view` = 資料列存在；`add`/`update`/`delete` = 對應旗標為 1。

### CI 斷言

**每一個 `ROUTE_PERMISSIONS` 項目都必須恰好解析到一個 `LimID`。** 解析到 0 個或多個就讓 build 失敗。

這把舊系統默默容忍的歧義，變成一個大聲、可修的錯誤。配合 [04-data-model](04-data-model.md) 的 `uq_lims_parent_key` 唯一索引，這也是你會發現「正式的 Lims 資料有沒有在依賴那個馬虎比對」的方式。

在 Hono middleware（`/api/admin/*`）與 Astro 後台頁面兩處都要執行檢查。

---

## 6. 現況權限資料

匯入後應該長這樣（見 [04-data-model](04-data-model.md) §7 的完整 Lims 樹）：

唯一的管理員 `AdminID = 1` 持有 LimID **3, 4, 5, 6, 8, 9** 的全權限，**沒有 LimID 7（Teams）**。

也就是說：**現任管理員無法從後台維護團隊成員。** 這是既有狀態，不是移植造成的，照樣保留。要不要補給他，是業主的決定，記在 [09-known-issues](09-known-issues.md)。

---

## 7. 403 與那個從未存在的頁面

舊系統權限不足時 `RedirectResult("/Error/Validation")`，而這個路由**從未被實作** —— 實測正式站 `/Error/Validation` 回 **404**。結果是「權限不足」與「網址打錯」在使用者眼中完全一樣。

新系統兩件事一起做：

1. **原地渲染 `src/pages/backend/Forbidden.astro`，狀態碼 403**，不要轉址
2. 另外建 `src/pages/Error/Validation.astro` 也回 403，讓任何殘留的硬編碼引用能優雅降級

---

## 8. 檔案上傳

舊系統把同一段上傳邏輯在 `WebMsController` 裡複製了 **7 次**。新系統收斂成一個 helper：

```ts
// src/lib/media.ts
putEntityPhoto(
  entity: MediaEntity,
  id: string,
  file: File,
  previousPhoto?: string
): Promise<string>   // 回傳新檔名供呼叫端寫入資料庫
```

| 項目 | 舊 | 新 |
|---|---|---|
| 副檔名/型別檢查 | **完全沒有** | **magic bytes** 驗證，不只看副檔名 |
| 大小上限 | 100 MB（`maxRequestLength`） | 10 MB |
| 檔名 | `yyyyMMddHHmmss.{ext}` | **不變** |
| 舊檔處理 | 刪除 | 刪除 |
| 縮圖 | 無 | 無（維持現狀） |

**檔名慣例刻意不動** —— 資料庫欄位格式因此不變，而且真要回退到舊系統，路徑仍然解析得到。

---

## 9. CSRF

舊系統**任何地方都沒有** anti-forgery token，而且刪除是 GET。

新系統：所有變更操作加 double-submit token 並綁定 session。刪除一律 POST。

---

## 10. 完成條件

- [ ] PBKDF2 登入可用，`MustChangePassword` 流程可走完
- [ ] KV session 正常，登出真的清空
- [ ] 權限註冊表的 CI 斷言全綠
- [ ] 7 個實體的 CRUD + 排序完整
- [ ] 上傳走 `media.ts`，magic byte 驗證有效
- [ ] 所有變更操作有 CSRF 保護，刪除是 POST
- [ ] 403 原地渲染，`/Error/Validation` 不再 404
- [ ] `weypro` 後門與 `AdminID = 888` 相關程式碼已完全移除
