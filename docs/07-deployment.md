# 07 — 部署與 CI/CD

相關：[02-architecture](02-architecture.md)｜[05-migration-runbook](05-migration-runbook.md)｜[11-roadmap](11-roadmap.md)

---

## 1. `wrangler.jsonc`

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "gleanstudio",
  "main": "@astrojs/cloudflare/entrypoints/server",
  "compatibility_date": "2026-08-01",
  "observability": { "enabled": true },

  "assets": { "directory": "./dist", "binding": "ASSETS" },

  "vars": {
    // 這兩個本來就出現在網頁原始碼裡，是公開值，不是密鑰
    "GA_MEASUREMENT_ID":  "G-G2CBNFFB3Q",
    "RECAPTCHA_SITE_KEY": "6LdbNcwcAAAAAND-6LKK67EUEnk6I-9rFboJkV5M"
  },

  "d1_databases": [
    { "binding": "DB", "database_name": "gleanstudio",
      "database_id": "<uuid>", "migrations_dir": "db/migrations" }
  ],
  "r2_buckets":    [{ "binding": "MEDIA",   "bucket_name": "gleanstudio-media" }],
  "kv_namespaces": [{ "binding": "SESSION", "id": "<kv-id>" }],

  "env": {
    "preview": {
      "d1_databases": [
        { "binding": "DB", "database_name": "gleanstudio-preview",
          "database_id": "<uuid>", "migrations_dir": "db/migrations" }
      ],
      "r2_buckets":    [{ "binding": "MEDIA",   "bucket_name": "gleanstudio-media-preview" }],
      "kv_namespaces": [{ "binding": "SESSION", "id": "<kv-id-preview>" }]
    },
    "production": {
      "routes": [
        { "pattern": "gleanstudio.com.tw/*", "zone_name": "gleanstudio.com.tw" }
      ]
    }
  }
}
```

**注意**：

- 沒有 `nodejs_compat` —— 免費方案用 Web Crypto 的 PBKDF2，不需要 `node:crypto`。日後升級到 Workers Paid 改用 scrypt 時才要加（見 [06-admin-spec](06-admin-spec.md) §3）
- `RECAPTCHA_SITE_KEY` 是公開值（本來就印在 HTML 裡），放 `vars` 而非 `secret`
- adapter 在 build 時也會管理一部分 `assets` 設定。**先跑一次 `astro build` 看它產出什麼**，再手動調 `html_handling` / `not_found_handling`

---

## 2. 三支 workflow

### `ci.yml` — 每個 PR 與 push

```
checkout
→ setup-node 24（cache: npm）
→ npm ci
→ npx wrangler types，若 worker-configuration.d.ts 有變動就失敗
→ astro check
→ tsc --noEmit
→ 單元測試
→ wrangler d1 migrations apply gleanstudio --local + seed
→ 權限註冊表斷言（06-admin-spec §5）
→ parity 套件對照 tests/golden/（Level B 為 gating）
→ astro build
```

```yaml
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
```

### `deploy-preview.yml` — PR

```yaml
- uses: actions/checkout@v6
- uses: actions/setup-node@v4
  with: { node-version: 24, cache: npm }
- run: npm ci && npm run build
- uses: cloudflare/wrangler-action@v3
  with:
    apiToken:  ${{ secrets.CLOUDFLARE_API_TOKEN }}
    accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    command: d1 migrations apply gleanstudio-preview --remote --env preview
- uses: cloudflare/wrangler-action@v3
  with:
    apiToken:  ${{ secrets.CLOUDFLARE_API_TOKEN }}
    accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    command: versions upload --env preview
```

`versions upload` 產生一個 per-version 的 preview URL 而不動到線上流量，把它貼成 PR comment。

⚠️ **fork 來的 PR 拿不到 secrets**，所以這支 workflow 只對同 repo 的 PR 有效。這件事要寫在這裡，而不是等別人踩到才發現。

### `deploy-production.yml` — push 到 `main` + `workflow_dispatch`

```
environment: production（需要人工核准）
→ d1 migrations apply gleanstudio --remote --env production
→ deploy --env production
→ smoke job：parity 套件打線上 URL
```

**migration 在 deploy 之前跑**，這樣新程式碼永遠不會遇到舊 schema。

**推論**：兩個步驟之間有幾秒鐘，**每個 migration 都必須與當下已部署的 Worker 向後相容**。這條規則寫在這裡，不要當作口耳相傳的常識。

---

## 3. Secrets 與變數

### GitHub repository secrets

| 名稱 | 用途 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 見下方權限說明 |
| `CLOUDFLARE_ACCOUNT_ID` | |

⚠️ **API token 要自訂，不能用內建範本。** Cloudflare 文件裡那個「Edit Cloudflare Workers」範本**不包含 D1 與 R2**，這是第一次部署最常見的失敗原因。需要的權限：

- Workers Scripts: Edit
- D1: Edit
- Workers R2 Storage: Edit
- Workers KV Storage: Edit
- Account Settings: Read

### Worker secrets

`wrangler secret put <NAME> --env production|preview`：

| 名稱 | 說明 |
|---|---|
| `RECAPTCHA_SECRET` | **輪替後的**新值 |
| `SENDGRID_API_KEY` | **輪替後的**新值 |

### 本機開發

`.dev.vars`（gitignored），並提交一份 `.dev.vars.example`。

### 絕對不放進任何地方

**Azure SQL 的憑證。** 它只在遷移時用到，由操作者以環境變數傳給 `scripts/export-mssql.mjs`，事後輪替。

---

## 4. 切換（Phase 8）

**前置條件：DNS 已經在 Cloudflare 手上。** 這是獨立的一件事，走 [12-dns-cutover](12-dns-cutover.md)，而且應該**提早很久**完成 —— 它有 24 小時的 TTL 前置期，也可能卡在 HiNet 的介面。DNS 換手做完時網站還在 Azure，訪客無感。

1. 確認 [12-dns-cutover](12-dns-cutover.md) 的檢查清單全綠，且 TTL 已降到 60 秒
2. 對編輯者宣告內容凍結，停用舊後台（Azure App Service 停機或 IP 限制 `/backend`）
3. 重跑 [05-migration-runbook](05-migration-runbook.md) §7 的正式站重新同步（D1 + R2），約 15 分鐘
4. 用新資料重跑 parity 套件
5. 加上 Worker route `gleanstudio.com.tw/*`，A 記錄從 DNS only（灰雲）切成 proxied 指向 Worker
6. Smoke test：13 條 URL 全跑一遍，加上抽驗幾個 `/Upload/*`，確認 gtag 仍然觸發
7. **Azure App Service 保持運行並付費 30 天。不要刪。**

---

## 5. 回退

| 情境 | 做法 | 資料損失 |
|---|---|---|
| **切換後、還沒有人用新後台** | 刪掉 Worker route，或把 A 記錄改回 DNS only 指向 `23.97.79.119`。舊系統原封不動，仍然連著 Azure SQL | 無。**60 秒內完成**（前提是 [12-dns-cutover](12-dns-cutover.md) Step 2 的 TTL 有先降） |
| **編輯者已經用過新後台** | 寫進 D1 的內容不在 Azure SQL 裡 | 有 |
| **問題出在我們的程式碼而非資料** | `wrangler rollback` / `wrangler versions deploy` 回到前一版 | 無。比改 DNS 快 |

**緩解措施**：切換後**前 48 小時新後台維持唯讀**，讓那條「60 秒無損回退」的路徑多活兩天。

48 小時之後若還需要回退，就需要一支 D1 → Azure SQL 的反向腳本。**那支腳本必須在 Phase 7 就寫好並測過**，不能等到事故當下才動手。

回退用的 A 記錄值：**`23.97.79.119`**（2026-08-07 盤點，Azure App Service `gleanstudio.azurewebsites.net`）。切換前再確認一次。
