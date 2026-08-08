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
→ npm run build（= wrangler types → astro check → astro build）→ wrangler dev
→ parity（Level B 為 gating）
→ parity:contact
→ bootstrap 一個 CI 帳號 → smoke:admin
```

#### 型別檢查

`npm run build` 是 `wrangler types && astro check && astro build`。

- **`wrangler types`** 由 `prebuild` 觸發，從 `wrangler.jsonc` 產生 `worker-configuration.d.ts`。**那個檔不進版控** —— 進版控只會製造「忘了重新產生」的 diff
- **secret 不在 `wrangler.jsonc` 裡**（也不該在），所以 `wrangler types` 產不出它們的型別。在 `src/env.d.ts` 的 `declare global` 裡補宣告，順便讓「這個專案需要哪些 secret」有一個看得到的地方
  ⚠️ 一定要在 `declare global` 內 —— 那個檔有 `export {}`，是 module，module 裡的 `declare namespace` 不會併進全域

**2026-08-07 第一次跑 `astro check` 時有 27 個錯誤** —— 這個專案在那之前從來沒做過型別檢查。修完是 0 error / 0 warning。其中一個發現值得記：`session.cookie` 的型別把 `httpOnly` **排除**在可設欄位之外（Astro 自己強制），所以設定檔裡那一行一直是無效的。線上實測回的是 `HttpOnly; Secure; SameSite=Lax`，屬性本身成立，但**是靠 Astro 的預設，不是靠我們的設定**。

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

### 只有一個環境 —— 沒有 preview

**決定（2026-08-07）**：`wrangler.jsonc` 沒有 `env` 區塊，頂層就是正式環境；沒有 `deploy-preview.yml`。

理由是下面那一節 —— 多環境在這個 stack 上有一個安靜的失敗模式，而要正確處理它得引入 build 時的 `CLOUDFLARE_ENV`、額外的 D1 / R2 / KV、以及一支只對同 repo PR 有效的 workflow。這個專案（一個網站、三個編輯者）換不到那個複雜度。

真正的驗證在別處：**CI 每個 PR 都會用乾淨的 D1 跑完整套 parity 與後台端到端**，那比一個 preview 網址有用。Phase 7 的 soak 則是直接部署到 `workers.dev` 用正式資料跑，也不需要 preview 環境。

日後若真的要加，先讀下一節。

### ⚠️ 環境是在 build 時決定的，不是部署時（若日後要加 preview）

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

### ⚠️ 部署那一步不用 `wrangler-action`

smoke 要打「這一次部署出來的網址」，所以得拿到它。實測 `cloudflare/wrangler-action@v4`：

- `deployment-url` output → **空的**
- `command-output` output → 也拿不到

兩次部署都卡在解析。而 wrangler 自己明明就把網址印在 stdout：

```
Deployed gleanstudio triggers (0.66 sec)
  https://gleanstudio.waiting0201.workers.dev
```

所以部署那一步改成直接 `npx wrangler deploy 2>&1 | tee`，自己接輸出。認證方式一樣（wrangler 本來就讀 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`），只是少一層轉手、也少一個會沉默失敗的地方。

migration 那一步仍然用 action —— 它不需要回傳值。

### `deploy-production.yml` — 目前只有 `workflow_dispatch`

```
environment: production（required reviewer，且限定 master 分支）
→ 檢查 API token
→ build
→ check-deploy-config.mjs --expect production
→ d1 migrations apply gleanstudio --remote
→ deploy
→ smoke job：parity 套件打線上 URL
```

**目前刻意只有 `workflow_dispatch`。** Cloudflare 的資源還沒建齊，讓每次 push 都排一個待核准的部署只會累積雜訊。Phase 7 soak 開始時改成 `push: branches: [master]`。

**順序：build → migration → deploy。** 先建置再動資料庫 —— build 失敗的話資料庫完全沒被碰過。

**推論**：migration 與 deploy 之間有一段時間是**新 schema 跑舊程式碼**，所以**每個 migration 都必須向前相容**。這條規則寫在這裡，不要當作口耳相傳的常識。

---

### 機密防護關卡

`ci.yml` 的第一個 job 是 `guard`，`verify` 依賴它。**這個 repo 是 public**，任何 commit 都對全世界公開。舊系統的明碼憑證躺在 `reference/`（gitignored），這一關確保它們不會因為某次 `git add -f`、`.gitignore` 被改、或有人把值抄進文件而外洩。

檢查項目：`reference/` 沒有檔案進版控、`.dev.vars` / `.env` / `Admins.json` / `admin-hashes.json` 不在版控裡、以及帶值的密碼指派、連線字串、SendGrid key 格式。

⚠️ **檢查規則刻意不寫死任何實際憑證字串** —— 檢查指令本身若含祕密，就是另一次外洩。用形狀比對，不用值比對。（`tsurumaru` 專案實際犯過這個錯，見它的 `docs/06-verification.md`。）

同一件事還有一個變體，我們也踩了：**註解裡不要寫出規則的實際範例**。第一版的 guard 為了說明「為什麼要加 `-i`」，在註解裡寫了一個連線字串的樣子 —— 然後它命中自己，CI 直接紅。

⚠️ **這兩條規則一定要 `-i`。** `git grep -E` 預設區分大小寫，而舊系統的設定檔把鍵名寫成大寫開頭。用一個假的洩漏檔實測時，三條規則只有一條命中；加了 `-i` 才 3/3。**寫完 guard 一定要用假資料正向測一次**，否則它只是一段會通過的裝飾。（`tsurumaru` 那份也少了 `-i`。）

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
| `RECAPTCHA_SECRET` | 目前是**舊值**，待輪替 |
| `SENDGRID_API_KEY` | 目前是**舊值**，待輪替 |
| `CONTACT_TO` | 聯絡表單收件人，可逗號分隔多個。**沒設就不寄** |

⚠️ `CONTACT_TO` 現在是開發者的信箱（測試用）。**Phase 8 換正式網域時要改成禾勤的信箱** —— 見 [11-roadmap](11-roadmap.md) Phase 8。用 secret 而不是 `vars`，是因為這個 repo 是公開的，不想把個人信箱放進版控。

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

⚠️ **上表第一列的實際時間比這裡寫的更好，第二列則更糟。** 兩點更新（2026-08-08）：

1. **DNS 已經在 Cloudflare 且 apex 已 proxied**，所以回退是**刪 Worker route**，秒級生效，
   不必動 DNS、也不依賴 TTL 有沒有先降。見 [13-cutover-worksheet](13-cutover-worksheet.md) §0。
2. **D1 → Azure SQL 的反向腳本決定不寫**，因為 Azure SQL 會刪掉。
   代價是第二列從「有資料損失但做得到」變成**做不到** —— 編輯者一在新後台寫入就沒有回頭路，
   而且 **Azure SQL 一刪，連第一列也一起消失**（舊站靠它跑）。
   所以「App Service 保持 30 天」那句話必須同樣套用在 Azure SQL 上。
   完整說明見 [13-cutover-worksheet](13-cutover-worksheet.md) §4。

回退用的 A 記錄值：**`23.97.79.119`**（2026-08-07 盤點，Azure App Service `gleanstudio.azurewebsites.net`）。切換前再確認一次。
