# 11 — 階段規劃

10 個階段。每一階段有明確的完成條件 —— 「做完了沒」應該是機械可答的問題，不是判斷題。

**現況：Phase 0 進行中。**

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

## Phase 1 — golden 基準擷取 ⚠️ 優先

**這一階段有時效性。舊後台每多上線一天，基準就多漂移一天。** 排在資料遷移之前。

- [ ] `scripts/capture-golden.mjs` 可用
- [ ] `tests/golden/` 涵蓋 [03-url-contract](03-url-contract.md) §8 的全部項目（約 30 頁）
- [ ] `manifest.json` 記錄狀態碼、headers、SHA-256、時間戳
- [ ] **manifest 同時記錄當次資料庫匯出的 SHA-256**（[08-verification](08-verification.md) §2）
- [ ] 邊界情境一併擷取：`?p=999`、`?ArticleTypeID=<不存在>`、格式錯誤的 GUID
- [ ] golden 已進版控

---

## Phase 2 — 資料與媒體

**不需要 Azure 存取** —— 資料與圖片本機都有且完整（[05-migration-runbook](05-migration-runbook.md) §0）。

- [ ] `scripts/export-mssql.mjs` 從本機 Docker SQL Server 匯出 9 張表
- [ ] `Articles` 帶出 `ImportSeq`（[04-data-model](04-data-model.md) §5）
- [ ] `data/export/manifest.json` 已進版控
- [ ] **`data/export/anomalies.json` 已逐條讀過**
- [ ] `db/migrations/0000_init.sql` 已補上 `STRICT` / `CHECK` / `DESC` 索引
- [ ] 本機 D1 各表列數符合：Articles 9、Projects 87、ArticleTypes 3、Lims 9、AdminLims 6、Admins 1、Teams 1、Services 0、Abouts 1
- [ ] 含中文的富文本欄位抽驗無誤
- [ ] 24 個圖檔上 R2，key 為 `Upload/{Entity}/{ID}/{Photo}`
- [ ] `scripts/verify-media.mjs` 全綠
- [ ] 遠端 D1 與 R2 與本機一致

---

## Phase 3 — 前台移植（最大的一階段）

**第一個看得見的里程碑** —— 做完就能在 `wrangler dev` 跑出完整前台。

- [ ] `src/layouts/Site.astro` + 5 個 partial 元件
- [ ] `src/components/Pager.astro` 逐字重現（含 bug，[03-url-contract](03-url-contract.md) §5.1）
- [ ] 11 個頁面元件 + 對應 route 檔
- [ ] `/` 與 `/Home/Index` 輸出 byte-identical
- [ ] `src/middleware.ts` 大小寫 rewrite
- [ ] `src/pages/Upload/[entity]/[id]/[photo].ts` R2 服務
- [ ] `public/Content` + `public/Scripts` 已複製（只搬有引用的圖）
- [ ] **`compressHTML: false` 已設定**
- [ ] **日期用 en-US 格式化，輸出如 `20 July 2026`**
- [ ] 每個 golden fixture 的 Level B 通過
- [ ] Level A 差異已審閱：不是零就是列在 [08-verification](08-verification.md) §7
- [ ] **Workers Assets 大小寫敏感度已實測**並記錄結果

---

## Phase 4 — 聯絡表單

- [ ] GET `/Home/Contact` 的 Level B 通過
- [ ] POST 驗證邏輯與 5 個欄位的繁中錯誤訊息一致
- [ ] 驗證失敗回 **200** 並重新渲染表單（不是 4xx）
- [ ] 成功回 **302** 到 `/`
- [ ] reCAPTCHA 用輪替後的 secret，判定條件 `Success && Action === 'login' && Score > 0.5`
- [ ] 寄信行為**原樣保留**（[09-known-issues](09-known-issues.md) §3.1）
- [ ] `tests/derived/` 的期望 markup 已由人審閱

---

## Phase 5 — 後台重建

完成條件見 [06-admin-spec](06-admin-spec.md) §10：

- [ ] PBKDF2 登入 + `MustChangePassword` 流程
- [ ] KV session，登出真的清空
- [ ] 權限註冊表 CI 斷言全綠
- [ ] 7 個實體 CRUD + 排序
- [ ] 上傳走 `media.ts`，magic byte 驗證
- [ ] 所有變更操作有 CSRF，刪除是 POST
- [ ] 403 原地渲染，`/Error/Validation` 不再 404
- [ ] `weypro` 後門與 `AdminID = 888` 程式碼完全移除

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

- [ ] **DNS TTL 提前 ≥24 小時降到 60 秒**（無法事後補做）
- [ ] 記錄目前的 A 記錄值以備回退
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
Phase 0 ─┬─▶ Phase 1（有時效性，越早越好）
         └─▶ Phase 2 ──▶ Phase 3 ──┬──▶ Phase 4 ──┐
                          ▲         └──▶ Phase 5 ──┼──▶ Phase 6 ──▶ Phase 7 ──▶ Phase 8 ──▶ Phase 9
                          │                        │
                     需要 Phase 1 的 golden ────────┘
```

Phase 4 與 Phase 5 可以並行。Phase 1 不依賴 Phase 2，而且**應該優先做** —— 它擷取的是一份會隨時間漂移的東西。
