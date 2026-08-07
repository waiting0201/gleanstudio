# 11 — 階段規劃

10 個階段。每一階段有明確的完成條件 —— 「做完了沒」應該是機械可答的問題，不是判斷題。

**現況：Phase 3 完成，Phase 4（聯絡表單）與 Phase 5（後台）可以開始。**

---

## Phase 0 — harness 與密鑰盤點

**現在這一階段。** 只有文件，沒有應用程式碼。

- [x] `CLAUDE.md` 索引
- [x] `docs/00` ~ `docs/11` 共 12 篇
- [x] `.claude/settings.json`
- [x] `.claude/skills/port-a-page/SKILL.md`
- [x] `.claude/skills/parity-check/SKILL.md`
- [ ] **reCAPTCHA secret 已輪替**（[09-known-issues](09-known-issues.md) 2.3）
- [ ] **SendGrid API key 已輪替**（同上 2.4）
- [ ] 確認 `reference/old/` 過去沒有被推上公開 remote
- [x] `master` 第一個 commit（`339f9fb`）

---

## Phase 1 — golden 基準擷取 ✅ 完成（2026-08-07）

**有時效性**（舊後台每多上線一天基準就多漂移一天），**而且是 Phase 2 的硬前置** —— `Articles.LegacyOrder` 的值只能從這裡取得，見 [ADR-012](10-decisions.md)。

- [x] `scripts/capture-golden.mjs` 可用
- [x] `tests/golden/` 涵蓋 [03-url-contract](03-url-contract.md) §8 全部項目（**35 頁 / 6.4 MB**）
- [x] `manifest.json` 記錄狀態碼、headers、SHA-256、時間戳
- [x] **manifest 記錄資料快照的 `dataDigest`**（[08-verification](08-verification.md) §2）
- [x] 邊界情境全部探測，結果見 [03-url-contract](03-url-contract.md) §9
- [x] `data/export/legacy-order.json` 已產生（文章顯示順序）
- [x] golden 已進版控

---

## Phase 2 — 資料與媒體 ✅ 完成（2026-08-07）

**不需要 Azure 存取** —— 資料與圖片本機都有且完整（[05-migration-runbook](05-migration-runbook.md) §0）。

- [x] `scripts/export-mssql.mjs` 從本機 Docker SQL Server 匯出 9 張表
- [x] `Articles.LegacyOrder` 由 Phase 1 的 `legacy-order.json` 填入（[04-data-model](04-data-model.md) §5）
- [x] 大型 `Description` 用分段 append 寫入，最長敘述 78.7 KB（上限 100 KB，[ADR-016](10-decisions.md)）
- [x] `data/export/manifest.json` 已進版控
- [x] **`data/export/anomalies.json` 已逐條讀過**（3 筆，全部由 `LegacyOrder` 處理，無 `homepage-latest-tie`）
- [x] `db/migrations/0000_init.sql` 已補上 `STRICT` / `CHECK` / `DESC` 索引
- [x] 本機 D1 各表列數符合：Articles 9、Projects 87、ArticleTypes 3、Lims 9、AdminLims 6、Admins 1、Teams 1、Services 0、Abouts 1
- [x] 含中文的富文本欄位逐字相符（9 篇 `Description` + `Abouts`）
- [x] 24 個圖檔上 R2，key 為 `Upload/{Entity}/{ID}/{Photo}`
- [x] `scripts/verify-media.mjs` 全綠（本機 + 遠端）
- [x] **遠端 D1 與 R2 已建立並與本機一致**
      D1 `f311b46f-d288-4a5f-9bb8-38e5aea73558`（APAC）／R2 `gleanstudio-media`（APAC）

**驗證指令**（兩支都支援 `--remote`）：

```bash
node scripts/verify-d1.mjs    [--remote]
node scripts/verify-media.mjs [--remote]
```

---

## Phase 3 — 前台移植（最大的一階段）✅ 完成（2026-08-07）

**第一個看得見的里程碑** —— `wrangler dev` 已能跑出完整前台。

**parity：Level B 31/31（gating 全綠）、Level A 29/31**。
跑 `npm run preview` 會 build → 重啟 wrangler → 跑 parity。

- [x] `src/layouts/Site.astro` + 4 個 partial 元件（Styles / Header / Footer / Scripts）
- [x] Astro 專案骨架、Drizzle schema、D1 查詢層
- [x] `scripts/parity-diff.mjs`（Level A/B + 資料快照綁定 + 明列豁免 + 刻意分歧）
- [x] 10 個前台 action 全部移植：`/`、`/Home/Index`、`About`、`Team`、`Gallery`、`Project`、`Services`、`Service`（×3 分類）、`Articles`（含分頁與分類）、`ArticleDetail`（×9 篇）、`Contact`（GET）
- [x] `/Home/Project` 分組順序已對齊 —— 起因是 `projects-order.json` 的 key 沒有解 HTML entity（`&#39;`），一筆對不上就讓整個分組順序偏掉
- [x] `src/components/Pager.astro` 逐字重現（含 bug，[03-url-contract](03-url-contract.md) §5.1）
- [x] `/` 與 `/Home/Index` 輸出 byte-identical
- [x] `src/middleware.ts` 大小寫 rewrite（含 §5.6 的連結大小寫還原）
- [x] `src/pages/Upload/[entity]/[id]/[photo].ts` R2 服務（200 / 206 / 304 都實測過）
- [x] `public/Content` + `public/Scripts` 已複製；28 個被引用的資源全部 200
- [x] **`compressHTML: false` 已設定**
- [x] **日期用 en-US 格式化，輸出如 `20 July 2026`**
- [x] 每個 golden fixture 的 Level B 通過
- [x] Level A 差異已審閱：剩 2 頁，列在 [08-verification](08-verification.md) §7a
- [x] **Workers Assets 大小寫敏感度已實測** —— 敏感，接受落差（[08](08-verification.md) §5.4、[09](09-known-issues.md) 4.10）

**過程中發現、原本不在計畫裡的事**：

- `Articles` 需要**兩個**排序相容性欄位，不是一個（[ADR-017](10-decisions.md)、`db/migrations/0002`）
- 小寫路徑會改變整頁的站內連結（[03-url-contract](03-url-contract.md) §5.6）
- 順序資料現在可以離線從 golden 重建：`npm run order:derive`

---

## Phase 4 — 聯絡表單 🚧 程式完成，等 key 輪替

`npm run parity:contact` 4 個情境全綠。

- [x] GET `/Home/Contact` 的 Level B 通過（Phase 3 一併完成）
- [x] POST 驗證邏輯與 5 個欄位的繁中錯誤訊息一致（`src/lib/contact.ts`）
- [x] 驗證失敗回 **200** 並重新渲染表單（不是 4xx）
- [x] 成功回 **302** 到 `/` —— `RedirectToAction("Index")` 在預設路由下產生的是 `/`
- [x] reCAPTCHA 判定條件 `success && action === 'login' && score > 0.5`，secret 讀 `env.RECAPTCHA_SECRET`，fail closed
- [x] 寄信行為原樣保留（收件人是訪客自己的信箱，[09-known-issues](09-known-issues.md) §3.1）
- [x] `tests/derived/` 的期望 markup 已產生並進版控
- [ ] **`tests/derived/` 由人審閱** ← 這一項只有人能勾
- [ ] **reCAPTCHA secret 已輪替並 `wrangler secret put RECAPTCHA_SECRET`**
      —— 沒設就是每一筆送出都被判定驗證碼錯誤（而且畫面上不會有任何提示，見 1.15）
- [ ] SendGrid key 已輪替並設定（**先與業主確認 §3.1 的收件人要不要一起修**）
- [ ] 302 那條分支用真的 token 走一次（排在 Phase 7 soak）

**照抄舊站時發現的兩件事**（都寫進 [09-known-issues](09-known-issues.md) §1）：

- 1.15 「驗證碼錯誤」**從來沒有顯示過** —— `AddModelError("", …)` 是模型層級錯誤，而 view 沒有 `ValidationSummary`。captcha 失敗時使用者看到的是一張值都還在、沒有任何提示的表單
- 1.16 伺服器端 Email 驗證只檢查「一個 `@`、不在頭尾」，`a@b` 會過。頁面上的 `data-val-*` 屬性從來沒生效過 —— `_Scripts.cshtml` 沒載 jquery.validate.unobtrusive

---

## Phase 5 — 後台重建 🚧 進行中

完成條件見 [06-admin-spec](06-admin-spec.md) §12。介面設計方向見同文件 §10。

**已完成 —— 驗證與外殼**

- [x] 設計系統（Tailwind v4，`src/styles/admin.css`）。色票取自前台 CSS，不是另外調的
- [x] Tailwind **沒有滲進凍結的前台**：接上之後 parity 仍是 Level B 31/31、Level A 29/31
- [x] PBKDF2 登入 + `MustChangePassword` 強制換密碼流程（本機端到端跑過）
- [x] KV session，登出真的 `destroy()`（實測登出後同一個 cookie 進不去）
- [x] 權限註冊表 30 個路由 + CI 斷言：`npm run verify:permissions`
- [x] 導覽列由**實際權限**產生 —— 實測現任管理員看不到「團隊成員」（3.3 浮出來了）
- [x] 403 原地渲染，`/Error/Validation` 回 403
- [x] `weypro` 後門與 `AdminID = 888` 從未被移植進來

**已完成 —— 變更的基礎建設與第一個實體**

- [x] Hono 掛在 `/api/admin/*`，middleware 鏈 **session → CSRF → 權限** 定義一次
- [x] CSRF double-submit token 綁 session，登入與換密碼表單也帶
- [x] 刪除是 POST（舊站是 `[HttpGet]`）
- [x] `src/lib/media.ts` —— magic bytes 驗證、10 MB 上限、檔名慣例不變、寫新的再刪舊的
- [x] 富文本編輯器擋 base64 內嵌，圖片走 R2（`src/components/admin/RichText.astro`）
- [x] **文章** 的列表 / 新增 / 修改 / 刪除，新文章的 `LegacyOrder` 與 `LegacyTypeOrder` 都接在最後
- [x] `npm run smoke:admin` —— 18 項端到端，會真的建一筆再刪掉，跑完 parity 仍然全綠

- [x] **ArticleTypes / Services / Teams / Abouts** —— 一份宣告式定義（`src/lib/admin/entities.ts`）餵給共用的列表、表單與 API。舊系統把這段 CRUD 寫了七遍
- [x] 上下移動排序，`Sort*` 對應到 `update` 權限（舊系統的對應表根本沒涵蓋 `Sort*`）
- [x] `npm run smoke:admin` 擴充到 31 項

- [x] **Projects**（87 筆）—— 依分類篩選 + 搜尋，`Type`/`Place`/`Title` 掛 `datalist` 防打錯字，新增排在 `LegacyOrder` 最後
- [x] **Admins** —— 密碼重設、權限矩陣勾選、以及兩道自我保護（不能刪自己、不能關掉自己的超級使用者）
- [x] `npm run smoke:admin` —— **47 項**端到端

**Phase 5 剩下的**

- [ ] Abouts 的圖片欄位在公開站沒有被引用過（`/Home/About` 只用 Description）—— 要確認是不是該拿掉
- [ ] **部署前要先建遠端 KV namespace**：`wrangler kv namespace create SESSION`，再把 id 填進 `wrangler.jsonc`
- [ ] 遠端 D1 的順序補值（`db/seed/0002-order-backfill.sql`）
- [ ] **部署前要先建遠端 KV namespace**：`wrangler kv namespace create SESSION`，再把 id 填進 `wrangler.jsonc`

**過程中發現**

- 舊系統的密碼只有 **6 個字元**。新的換密碼流程要求 12 字元，所以搬過來的密碼**沒有一組能當成新密碼重用** —— 這正是想要的結果
- `@astrojs/cloudflare` 的 session 設定有個坑：自己設 `driver` 會讓登入當下 500，而 GET 完全正常。見 [06-admin-spec](06-admin-spec.md) §11

---

## Phase 6 — CI/CD

- [ ] `ci.yml` 綠燈（含 parity Level B gating）
- [ ] `deploy-preview.yml` 能從 PR 產出可達的 preview URL
- [ ] CI 對 preview D1 套用 migration
- [ ] `deploy-production.yml` 需人工核准
- [ ] Cloudflare API token 權限正確（**含 D1 與 R2** —— 內建範本不含，[07-deployment](07-deployment.md) §3）
- [ ] Worker secrets 已設定

---

## Phase 7 — staging soak

- [ ] 部署到 `gleanstudio.workers.dev`（或 `new.gleanstudio.com.tw`），**使用正式資料**
- [ ] parity 套件打**已部署的 URL**，不只本機
- [ ] Level C 視覺比對在 375 / 768 / 1440 跑過
- [ ] 編輯者在新後台實際改一筆內容，確認前台渲染正常
- [ ] **D1 → Azure SQL 反向回退腳本已寫好並測過**（[07-deployment](07-deployment.md) §5）
- [ ] 至少跑 3 天

---

## Phase 8 — 切換

步驟見 [07-deployment](07-deployment.md) §4。

**前置：DNS 換手**（[12-dns-cutover](12-dns-cutover.md)）—— **等 Phase 7 soak 通過之後才做**。開發期間新站跑在 `workers.dev`，不動正式網域。做完時網站還在 Azure，訪客無感。

⚠️ 有 ≥24 小時的 TTL 前置期，**至少留 3 個工作天**，不要排在切換當天。

- [ ] Cloudflare zone 已建立（**Add a site**，不是 Transfer domain —— [Cloudflare Registrar 不支援 .tw](https://developers.cloudflare.com/registrar/top-level-domains/)）
- [ ] HiNet 完整 DNS 記錄已匯出並與盤點結果對照
- [ ] **DNS TTL 提前 ≥24 小時降到 60 秒**（無法事後補做）
- [ ] NS 已改指 Cloudflare，解析結果與切換前一致
- [ ] 回退用的 A 記錄值已記錄（`23.97.79.119`）

**切換本身**

- [ ] 內容凍結，舊後台停用
- [ ] 用正式站資料重跑 Phase 2（需要 Azure 存取）
- [ ] 用新資料重跑 parity
- [ ] Worker route + DNS 切換
- [ ] 13 條 URL smoke test + `/Upload/*` 抽驗 + gtag 確認
- [ ] **新後台前 48 小時維持唯讀**（保住 60 秒無損回退）
- [ ] **Azure App Service 保持運行並付費 30 天**

---

## Phase 9 — 待辦清償

把 [09-known-issues](09-known-issues.md) 第 1 節與第 3 節逐條與業主 triage，每條給 ship / fix / won't-fix。

建議優先順序：

1. [ ] **聯絡表單**（3.1）—— 業務影響最大，且改動不碰 markup
2. [ ] 分頁掉參數（1.1）
3. [ ] 富文本未過濾（1.4）
4. [ ] `lang="en"`（1.3）
5. [ ] Bootstrap 版本錯配（1.2）
6. [ ] Gallery 與 Team 的去留（1.5 / 1.6）
7. [ ] Azure SQL 密碼輪替（2.1）—— 遷移完成後
8. [ ] 舊 Azure App Service 下線 —— 切換滿 30 天後

---

## 相依關係

```
Phase 0 ──▶ Phase 1 ──▶ Phase 2 ──▶ Phase 3 ──┬──▶ Phase 4 ──┐
                                               └──▶ Phase 5 ──┼──▶ Phase 6 ──▶ Phase 7 ──▶ Phase 8 ──▶ Phase 9
                                                              │
                                  golden 供 Phase 3-7 驗證 ────┘
```

**Phase 1 → Phase 2 是硬相依**，不只是排程建議：`Articles.LegacyOrder` 的值來自 Phase 1 從正式站擷取的顯示順序（[ADR-012](10-decisions.md)）。

Phase 4 與 Phase 5 可以並行。
