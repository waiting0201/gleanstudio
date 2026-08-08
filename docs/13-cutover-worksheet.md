# 13 — 切換操作單（Phase 8）

把 `gleanstudio.com.tw` 的流量從 Azure 的舊站導到 Cloudflare Worker 的新站。

這份是**操作當下照著打的清單**，不是設計文件。背景與決策見 [07-deployment](07-deployment.md) §4、[12-dns-cutover](12-dns-cutover.md)、[11-roadmap](11-roadmap.md) Phase 8。

**盤點時間**：2026-08-08 01:08 UTC。下面每一格都附了出處指令，操作當天請重跑一次再對照。

---

## 0. 重大更正 —— DNS 換手已經做完了

[12-dns-cutover](12-dns-cutover.md) 開頭寫「狀態：⬜ 未開始」。**實測不是。**

```bash
dig +short NS gleanstudio.com.tw
# bella.ns.cloudflare.com.
# carlos.ns.cloudflare.com.
```

zone 已經在 Cloudflare 手上，而且 apex 與 `www` **都已經是 proxied（橘雲）**：

```bash
dig +short A gleanstudio.com.tw
# 104.21.48.155      ← Cloudflare 的 anycast IP，不是 Azure 的 23.97.79.119
# 172.67.154.66

curl -sI https://gleanstudio.com.tw/ | grep -iE '^(server|cf-ray|x-aspnetmvc)'
# server: cloudflare
# cf-ray: a27aa0b71c2ad88e-LAX
# x-aspnetmvc-version: 5.2      ← 但 origin 還是 Azure 的 ASP.NET MVC
```

也就是說：**流量早就在走 Cloudflare 邊緣，只是 origin 還指著 Azure。**

### 這件事改變了三個前提

| [12-dns-cutover](12-dns-cutover.md) 原本說 | 實際上 |
|---|---|
| Step 1–4（建 zone → 降 TTL → 改 NS → 驗證）待辦 | **已完成** |
| 要提前 ≥24 小時把 TTL 降到 60 秒，且「無法事後補做」 | **不再需要**。Cloudflare 對 proxied 記錄一律回 TTL 300，已經是我們控制的 |
| 「至少留 3 個工作天，不要排在切換當天」 | **不成立了**。前置期已經過去，切換可以當天做完 |

原本那個 86400 的 TTL 是 HiNet 舊 zone 的殘留 —— `admns1.hinet.net` 還留著一份舊記錄，但 TLD 的委派已經不指它，所以它不具權威、也不影響任何人。

```bash
dig @bella.ns.cloudflare.com gleanstudio.com.tw A +noall +answer
# gleanstudio.com.tw.  300  IN  A  172.67.154.66     ← 300 秒，不是 86400
```

### 連帶的好處：回退不必碰 DNS

因為 apex 已經 proxied，切換的動作是**加一條 Worker route**，回退是**刪掉那條 route**。
route 變更在 Cloudflare 邊緣是秒級生效的，完全不經過遞迴 DNS 的快取。

這比 [07-deployment](07-deployment.md) §5 描述的「60 秒無損回退」更好，而且**不依賴任何事前準備**。

---

## 1. 現況盤點（2026-08-08 實測）

| 項目 | 值 | 出處 |
|---|---|---|
| NS | `bella.ns.cloudflare.com` / `carlos.ns.cloudflare.com` | `dig +short NS gleanstudio.com.tw` |
| apex A（對外） | `104.21.48.155` / `172.67.154.66`（Cloudflare） | `dig +short A gleanstudio.com.tw` |
| apex AAAA | `2606:4700:3033::6815:309b` / `2606:4700:3034::ac43:9a42` | `dig +short AAAA gleanstudio.com.tw` |
| `www` | 同樣解到 Cloudflare IP（proxied） | `dig +short www.gleanstudio.com.tw` |
| TXT | `google-site-verification=d2f4ap73…` | `dig +short TXT gleanstudio.com.tw` |
| MX / CAA | **無** | `dig +short MX/CAA gleanstudio.com.tw` |
| 其他子網域 | 探測 `_dmarc mail m blog test staging dev cdn api backend` 全部查無 | — |
| origin | Azure，`x-aspnetmvc-version: 5.2` | `curl -sI https://gleanstudio.com.tw/` |
| 新站 | <https://gleanstudio.waiting0201.workers.dev> | — |
| Worker route | **尚未設定**（`wrangler.jsonc` 沒有 `routes`） | `grep routes wrangler.jsonc` |

⚠️ **有兩件事從外部查不到，操作前必須登入 Cloudflare Dashboard 確認並填進來：**

- [ ] apex A 記錄在 Cloudflare 上的 **origin 值**（預期 `23.97.79.119`）→ 實際：`____________`
- [ ] `www` 的記錄型別與值（預期 CNAME → `gleanstudio.azurewebsites.net`）→ 實際：`____________`

這兩個值是回退時要指回去的目標。**沒抄下來就不要開始切換。**

沒有 MX，所以整個切換過程不會影響任何信箱 —— 這是這次風險低的主因。

---

## 2. 切換前必須清償

- [~] ~~輪替 reCAPTCHA secret / SendGrid API key~~ —— **決定不輪替**（2026-08-08 業主決定）。
      兩把 key 沿用舊值，是明示接受的風險而非待辦，理由與曝險範圍見
      [09-known-issues](09-known-issues.md) §2 開頭。**不要再把它列回清單。**
- [x] **`CONTACT_TO` 已改成 `glean1218@gmail.com`**（2026-08-08）—— 這是禾勤自己印在
      Contact 頁上的信箱，也是整套 golden 裡唯一出現過的一個
- [~] ~~D1 → Azure SQL 反向回退腳本~~ —— **決定不做**（2026-08-08）。Azure SQL 會刪掉，
      寫一支把資料倒回一個即將消失的資料庫的腳本沒有意義。**連帶後果見 §4。**
- [ ] 編輯者在新後台實際改一筆內容，確認前台渲染正常
- [ ] 用**正式站當下的資料**重跑 [05-migration-runbook](05-migration-runbook.md) §7 的重新同步（D1 + R2），約 15 分鐘

```bash
wrangler secret put RECAPTCHA_SECRET
wrangler secret put SENDGRID_API_KEY
wrangler secret put CONTACT_TO
wrangler secret list          # 確認四個都在，值不會印出來
```

### 已經驗過的

- [x] parity 打已部署的 URL：**Level B 31/31**（2026-08-07）
- [x] `parity:contact` 打已部署的 URL：**4/4**（2026-08-08）
      —— 4 個情境都停在驗證失敗或 captcha 失敗，**不會寄出任何信**，可以安全地重跑

- [x] `smoke:admin` 打已部署的 URL：**48/48**（2026-08-08，重新部署 `28f6515` 之後）

      ```bash
      node scripts/smoke-admin.mjs --remote --base https://gleanstudio.waiting0201.workers.dev
      ```

      ⚠️ 它會在**正式** D1 建資料再刪掉。`finally` 保證清理，但中途 Ctrl-C 會留渣。
      跑完務必確認列數回到 Articles 9 / Projects 87 / Services 0 / Admins 1。

- [x] **deploy workflow 第一次全綠**（run `31231827474`，2026-08-08）——
      `deploy` + `smoke` 兩個 job 都成功，部署網址正確解析成
      `https://gleanstudio.waiting0201.workers.dev`，parity 打的是**這一次剛部署出來的**
      網址而非舊站，Level B 31/31。`8bb641c` 修掉的那步至此才真的驗證過。

---

## 3. 切換步驟

### Step 1 — 內容凍結

- [ ] 通知編輯者停止使用舊後台
- [ ] 停用舊後台（Azure App Service 停機，或對 `/backend` 加 IP 限制）

從這一刻起，舊站的資料不再變動 —— Step 2 的重新同步才有意義。

### Step 2 — 用當下的正式資料重跑遷移

```bash
npm run export            # 需要能連到來源資料庫
npm run seed:build && npm run seed:order
npm run db:migrate:remote
npm run db:seed:remote
npm run media:upload:remote
npm run verify:d1     -- --remote
npm run verify:media  -- --remote
```

### Step 3 — 用新資料重跑 parity

```bash
npm run golden                                                  # 重抓基準（舊站已凍結，此時抓才對得上）
npm run parity -- --base https://gleanstudio.waiting0201.workers.dev
npm run parity:contact -- --base https://gleanstudio.waiting0201.workers.dev
```

- [ ] Level B **31/31**。**沒有全綠就不要往下走。**

### Step 4 — 加 Worker route ← 這一步才是真的切換

在 `wrangler.jsonc` 加上：

```jsonc
"routes": [
  { "pattern": "gleanstudio.com.tw/*",     "zone_name": "gleanstudio.com.tw" },
  { "pattern": "www.gleanstudio.com.tw/*", "zone_name": "gleanstudio.com.tw" }
]
```

然後部署：

```bash
node scripts/check-deploy-config.mjs --expect production
npx wrangler deploy
```

⚠️ **`www` 要不要一起導，先決定。** 舊站的 `www` 是 CNAME 指向 Azure，新站沒有處理 `www` → apex 的正規化。兩個選項：
- **一起導**（上面的寫法）—— `www` 也吃 Worker，但要確認新站在 `www` 主機名下渲染正常
- **只導 apex**，`www` 維持指向 Azure —— 兩套系統並存，**不建議**，會出現同內容兩個來源

apex 與 `www` 都已經 proxied，所以**這一步不需要動任何 DNS 記錄**。

### Step 5 — Smoke

```bash
npm run parity         -- --base https://gleanstudio.com.tw     # 31 頁，比「13 條 URL」徹底
npm run parity:contact -- --base https://gleanstudio.com.tw
npm run verify:url-case -- --base https://gleanstudio.com.tw

curl -sI https://gleanstudio.com.tw/ | grep -i x-aspnetmvc      # 應該**沒有輸出**了
curl -s -o /dev/null -w '%{http_code}\n' https://gleanstudio.com.tw/Upload/Articles/…/….jpg
```

- [ ] parity Level B 31/31
- [ ] `x-aspnetmvc-version` 消失（代表 origin 真的換成 Worker 了）
- [ ] 抽驗幾個 `/Upload/*` 回 200
- [ ] 瀏覽器實際看一遍，確認 gtag（`G-G2CBNFFB3Q`）仍然觸發
- [ ] Google Search Console 的驗證未失效（TXT 沒動，應該沒事）

### Step 6 — 切換後 48 小時

- [ ] **新後台維持唯讀** —— 保住「刪 route 就回退、零資料損失」那條路
- [ ] **Azure App Service 保持運行並付費 30 天。不要刪。**

---

## 4. 回退

| 情境 | 做法 | 時間 | 資料損失 |
|---|---|---|---|
| 問題出在程式碼而非資料 | `wrangler rollback` 回上一版 | 最快 | 無 |
| 切換後、還沒有人用新後台 | 從 `wrangler.jsonc` 拿掉 `routes` 重新部署，或在 Dashboard 直接刪 route | **秒級**（不經過 DNS 快取） | 無 |
| 編輯者已經用過新後台 | **沒有回退路徑** —— 見下方 | — | 有 |

回退目標值（切換前再確認一次，見 §1 的空格）：apex origin `23.97.79.119`，`www` → `gleanstudio.azurewebsites.net`。

**不需要**把 NS 改回 HiNet。DNS 換手與網站切換是兩件事，回退只要回退後者。

### ⚠️ 回退視窗的終點是「Azure SQL 被刪掉」，不是 30 天

2026-08-08 決定**不寫** D1 → Azure SQL 的反向腳本，理由是 Azure SQL 反正要刪。這個決定是合理的，但它讓回退的形狀變了，必須寫下來：

**舊 ASP.NET 站是靠 Azure SQL 跑的。** 所以 ——

- Azure App Service 留著、Azure SQL 也留著 → 「刪 route 回舊站」成立，秒級、零損失
- **Azure SQL 一刪 → App Service 就算還開著也只會噴錯，回退路徑同時消失**

也就是說 [07-deployment](07-deployment.md) §4 那條「Azure App Service 保持運行並付費 30 天」，
**同一句話要套用到 Azure SQL 上**，否則留著 App Service 沒有任何意義。

而且因為沒有反向腳本，**編輯者一在新後台寫入，那筆內容就只存在於 D1**。
從那一刻起回退到舊站等於丟掉那些內容。這正是「切換後 48 小時新後台維持唯讀」
（§3 Step 6）存在的理由 —— 現在它從「多一層保險」變成**唯一的保險**。

- [ ] 切換前確認：Azure SQL 的刪除時程 ≥ App Service 的 30 天
- [ ] 決定 Azure SQL 實際刪除日 → `____________`。**過了這天就沒有回頭路。**

---

## 5. 這份操作單與 12-dns-cutover 的關係

[12-dns-cutover](12-dns-cutover.md) 描述的 Step 1–4 已經完成，那份文件現在是**歷史紀錄**，不是待辦。
它的 §6（HiNet 不給改 NS 時的備案）也已經用不到了。

實際要執行的只剩這份文件的 §3。
