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

實作見 `.github/workflows/ci.yml`。

```
npm ci
→ 建本機 D1：migrate → seed（--no-accounts）→ 順序補值
→ 順序資料可從 golden 重建（git diff --exit-code）
→ verify-d1（--no-accounts）
→ 權限註冊表斷言（06-admin-spec §5）
→ astro build → wrangler dev
→ parity（Level B 為 gating）
→ parity:contact
→ bootstrap 一個 CI 帳號 → smoke:admin
```

#### CI 要跑 parity，就得有資料

parity 必須有一個灌好內容的資料庫才跑得動，而 `data/export/` 原本整個 gitignored。

拆法：**內容匯出進版控，帳號資料不進。**

| 進版控 | 不進 |
|---|---|
| `ArticleTypes / Articles / Services / Teams / Projects / Abouts / Lims` `.json` | `Admins.json`（有舊系統的**明碼**密碼） |
| 兩個順序檔 | `admin-hashes.json` |

`Articles.json` 6.1 MB，幾乎全是內文內嵌的 base64 圖片；其餘加起來 46 KB。

**為什麼不從 `tests/golden/` 反推內容？** 那會讓 9 頁 ArticleDetail 的 parity 變成循環論證 —— 拿 oracle 的輸出去餵資料庫，再跟同一份 oracle 比對，等於什麼都沒驗。內容匯出來自本機 SQL Server，golden 來自線上，兩者互相獨立，比對才有意義。

CI 需要管理者帳號時，用 `scripts/bootstrap-admin.mjs` 現場建一個，密碼取自 workflow 的 run id，跑完就沒了。**刻意只給 LimID 3,4,5,6,8,9（不給 7）**，重現正式資料的權限形狀，`smoke:admin` 才驗得到「沒權限的區塊被擋」。

```yaml
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
```

### ⚠️ 環境是在 build 時決定的，不是部署時

**這一段是踩過才知道的，而且失敗模式是安靜的。**

`@astrojs/cloudflare` 會在 `astro build` 時把 `wrangler.jsonc` 攤平成 `dist/server/wrangler.json`，並寫一份 `.wrangler/deploy/config.json` 把 wrangler 導過去。**攤平的結果不保留 `env` 區塊。**

於是：

```bash
astro build
wrangler versions upload --env preview    # ← 不會報錯
```

wrangler 在那份設定裡找不到 `preview` 這個環境，就**直接退回頂層綁定** —— 也就是把 PR 的 preview 版本綁上**正式的** D1 與 R2。實測輸出：

```
env.DB (gleanstudio)              D1 Database        ← 不是 gleanstudio-preview
env.MEDIA (gleanstudio-media)     R2 Bucket          ← 不是 …-preview
```

**正確做法**：環境用 `CLOUDFLARE_ENV` 在 build 時給，部署指令**不要**加 `--env`。

```bash
CLOUDFLARE_ENV=preview npm run build      # adapter 解析出 preview 的綁定
node scripts/check-deploy-config.mjs --expect preview
wrangler versions upload                  # 沒有 --env
```

adapter 連 worker 名稱都會換掉（`gleanstudio` → `gleanstudio-preview`），所以「有沒有生效」是看得出來的。

`scripts/check-deploy-config.mjs` 就是把這件事變成一道會擋下部署的檢查：驗 worker 名稱、D1 名稱、R2 名稱是否符合預期環境，以及有沒有還沒填的 placeholder。

**例外**：`d1 migrations apply` 讀的是根 `wrangler.jsonc`（那裡有 `env` 區塊），所以那一行**要**加 `--env preview`。為了不受 `.wrangler/deploy/config.json` 重導影響，明確加上 `--config wrangler.jsonc`，而且**排在 build 之前**。

### `deploy-preview.yml` — PR

實作見 `.github/workflows/deploy-preview.yml`。順序是 **migration → build（帶 `CLOUDFLARE_ENV`）→ 守門 → upload**。

`versions upload` 產生一個 per-version 的 preview URL 而不動到線上流量，workflow 會把它貼成 PR comment（同一個 PR 只留一則，後續 push 就地更新）。

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

### 機密防護關卡

`ci.yml` 的第一個 job 是 `guard`，`verify` 依賴它。**這個 repo 是 public**，任何 commit 都對全世界公開。舊系統的明碼憑證躺在 `reference/`（gitignored），這一關確保它們不會因為某次 `git add -f`、`.gitignore` 被改、或有人把值抄進文件而外洩。

檢查項目：`reference/` 沒有檔案進版控、`.dev.vars` / `.env` / `Admins.json` / `admin-hashes.json` 不在版控裡、以及帶值的密碼指派、連線字串、SendGrid key 格式。

⚠️ **檢查規則刻意不寫死任何實際憑證字串** —— 檢查指令本身若含祕密，就是另一次外洩。用形狀比對，不用值比對。（`tsurumaru` 專案實際犯過這個錯，見它的 `docs/06-verification.md`。）

2026-08-07 手動掃描時，發現三份文件轉錄了舊系統的後門密碼、四處轉錄了正式站 Azure SQL 的主機與帳號 —— 這一關就是為了不要再靠人記得掃。

---

## 3. Secrets 與變數

### GitHub repository secrets

| 名稱 | 用途 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 見下方權限說明 |
| `CLOUDFLARE_ACCOUNT_ID` | |

⚠️ **API token 要自訂，不能直接用內建範本。** 「Edit Cloudflare Workers」範本**不包含 D1**，這是第一次部署最常見的失敗原因。

以那個範本為基礎，加上 D1：

| 權限 | 用途 |
|---|---|
| Account → Workers Scripts → Edit | 部署 Worker |
| Account → D1 → Edit | 套用 migration |
| Account → Account Settings → Read | wrangler 解析帳號 |

範圍限縮到**這一個帳號**。

**不需要** R2 與 KV 的權限 —— CI 不碰它們：圖片由 `scripts/upload-r2.mjs` 手動上傳，KV namespace 由人手動建立一次。綁定是靠 id，部署時不需要對應的權限。

### token 錯誤難以分辨 —— CI 先預檢

wrangler 對「token 字串無效」與「token 有效但權限不足」**都回 `Invalid access token [code: 9109]`**，光看日誌分不出是哪一種。

兩支 deploy workflow 在動用 wrangler 之前先做三件事：

1. 長度與空白檢查 —— 貼上時被截斷或夾帶換行是最常見的原因
   （重設用 `printf '%s' '<token>' | gh secret set CLOUDFLARE_API_TOKEN`，避免尾端換行）
2. 打 `/user/tokens/verify` 判斷 token 字串本身有沒有效
3. 打 `/accounts/{id}/d1/database` 判斷這個 token 讀不讀得到這個帳號的 D1

這樣錯誤訊息會直接說是哪一關，不用猜。作法取自 `tsurumaru` 專案 —— 那邊已經部署成功並踩過這個坑。

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

**前置條件：DNS 已經在 Cloudflare 手上。** 這是獨立的一件事，走 [12-dns-cutover](12-dns-cutover.md)，**排在 Phase 7 soak 通過之後**。開發期間新站跑在 `workers.dev`，不必動到正式網域。

DNS 換手做完時網站還在 Azure，訪客無感 —— 但它有 ≥24 小時的 TTL 前置期，**至少留 3 個工作天**，不要排在切換當天。

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
