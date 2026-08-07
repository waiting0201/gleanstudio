# 12 — DNS 切換到 Cloudflare

把 `gleanstudio.com.tw` 的 DNS 解析交給 Cloudflare。**網域註冊繼續留在 HiNet**，續約、擁有權、聯絡人全部不動。

**狀態**：⬜ 未開始。網域管理權已取得（2026-08-07）。

**執行時機**：**等新站做好、Phase 7 soak 通過之後才做**（2026-08-07 決定）。開發期間新站跑在 `gleanstudio.workers.dev`，不需要動到正式網域。

⚠️ **但要把前置時間算進時程**：Step 2 的降 TTL 要提前 ≥24 小時，加上 HiNet 介面可能有的變數（§3 Step 3），保守估至少留 3 個工作天，不要排在切換當天。

相關：[07-deployment](07-deployment.md) §4｜[11-roadmap](11-roadmap.md) Phase 8

---

## 1. 先釐清：不是「轉移網域」

| | 需要嗎 | .com.tw 可行嗎 |
|---|---|---|
| 轉移註冊商到 Cloudflare Registrar | ❌ 不需要 | ❌ [不支援 .tw](https://developers.cloudflare.com/registrar/top-level-domains/) |
| NS 指向 Cloudflare（DNS 代管） | ✅ **這個** | ✅ 可行 |

在 Cloudflare 要走的是 **Add a site**，不是 Transfer domain。後者對 `.com.tw` 永遠會失敗，那不是錯誤，是這個 TLD 不在支援清單裡。

Cloudflare Workers 的 route 與自訂網域要求整個 zone 託管在 Cloudflare，所以這一步是必要的。

---

## 2. 現況盤點（2026-08-07）

```
NS     admns1.hinet.net / admns2.hinet.net
A      gleanstudio.com.tw  → 23.97.79.119
CNAME  www                 → gleanstudio.azurewebsites.net
TXT    google-site-verification=d2f4ap73QsLCRD4Edmu_C2vrMzOrEII3S0Ny4RvOjAk
```

**沒有 MX** —— 這個網域不收發郵件，所以 NS 搬遷不會弄壞任何信箱。這是這次切換風險低的主因。

也沒有 AAAA、CAA、DMARC、DKIM，除了 `www` 之外沒有偵測到其他子網域。

⚠️ 以上是**從外部查詢**得到的。AXFR 被拒（正常），所以看不到完整 zone。**登入 HiNet 後第一件事是把 DNS 管理介面的完整記錄列出來對照** —— 可能有沒對外公開、但內部在用的記錄。

---

## 3. 執行順序

### Step 1 — 在 Cloudflare 建 zone

1. Cloudflare Dashboard → **Add a site** → `gleanstudio.com.tw`
2. 選 Free 方案
3. Cloudflare 會自動掃描並帶入記錄 —— **不要相信掃描結果，逐筆對照 §2 與 HiNet 介面的實際清單**
4. 確認三筆記錄都在，值完全一致
5. **A 記錄設成 DNS only（灰雲），指向 `23.97.79.119`**

第 5 點很重要：切換 NS 的當下不要同時改變流量路徑。一次只動一件事，這樣出問題時能立刻知道是哪一步。

記下 Cloudflare 指派的兩台 NS（形如 `xxxx.ns.cloudflare.com`）。

### Step 2 — 降 TTL ⚠️ 至少提前 24 小時

在 **HiNet 現有的 DNS 介面**把所有記錄的 TTL 降到 60 秒。

**這一步無法事後補做。** TTL 必須在舊值仍然生效的期間就先降低，否則萬一要還原，全球的遞迴 DNS 會抱著舊答案不放好幾個小時。這一步決定了 [07-deployment](07-deployment.md) §5 那條「60 秒無損回退」路徑成不成立。

等 ≥24 小時再做 Step 3。

### Step 3 — 改 NS

[domain.hinet.net](https://domain.hinet.net) → 會員專區 → 我的網域 → `gleanstudio.com.tw` → 名稱伺服器（NS）修改

```
移除：  admns1.hinet.net
        admns2.hinet.net

填入：  xxxx.ns.cloudflare.com
        yyyy.ns.cloudflare.com
```

**若 HiNet 介面找不到這個選項**：多半是網域搭配了 HiNet 自家的 DNS 代管或虛擬主機服務而被綁定。打 HiNet 客服（0800-080-412）說明要「指定自訂名稱伺服器」，這是標準需求。真的完全不給改的話，見 §6。

### Step 4 — 驗證

```bash
dig +short NS gleanstudio.com.tw
# 期望：xxxx.ns.cloudflare.com / yyyy.ns.cloudflare.com

dig +short A gleanstudio.com.tw          # 期望 23.97.79.119（不變）
dig +short CNAME www.gleanstudio.com.tw  # 期望 gleanstudio.azurewebsites.net（不變）
dig +short TXT gleanstudio.com.tw        # 期望 google-site-verification=…（不變）

curl -s -o /dev/null -w '%{http_code}\n' https://gleanstudio.com.tw/   # 期望 200
```

**這一步做完，網站行為應該與切換前完全相同。** 訪客不會有任何感覺。

NS 變更在各地遞迴 DNS 完全生效可能要數小時 —— TLD 層的 NS 記錄有自己的 TTL，不受我們控制。這段期間新舊 NS 會同時被查詢，所以 Step 1 的第 4 點（記錄先建好）是必要的。

### Step 5 — 之後才是網站切換

Step 1–4 只是把 DNS 換手，網站還在 Azure。真正把流量導到 Worker 是另一件事，見 [07-deployment](07-deployment.md) §4：加 Worker route `gleanstudio.com.tw/*`，把 A 記錄改成 proxied。

**兩件事分開做，中間隔開。** DNS 換手穩定運行一段時間之後，再動網站。

---

## 4. 還原

| 情境 | 做法 | 時間 |
|---|---|---|
| Step 3 之後發現問題 | NS 改回 `admns1.hinet.net` / `admns2.hinet.net` | 數小時（受 TLD NS 的 TTL 影響） |
| Step 5 之後發現問題 | 刪掉 Worker route，或 A 記錄改回 DNS only | **約 60 秒**（前提是 Step 2 有做） |

Step 5 的還原比 Step 3 快，因為那時 DNS 已經在 Cloudflare 手上，我們自己控制 TTL。**這也是為什麼要分兩階段做。**

---

## 5. 檢查清單

**Step 1 — 建 zone**
- [ ] 走 Add a site，不是 Transfer domain
- [ ] 登入 HiNet 匯出完整 DNS 記錄清單，與 §2 對照
- [ ] Cloudflare 的自動掃描結果逐筆核對，補上掃描沒抓到的
- [ ] A 記錄設為 DNS only（灰雲）
- [ ] 記下指派的兩台 NS

**Step 2 — 降 TTL**
- [ ] HiNet 所有記錄 TTL → 60 秒
- [ ] 記錄執行時間，等 ≥24 小時

**Step 3 — 改 NS**
- [ ] HiNet NS 改成 Cloudflare 的兩台

**Step 4 — 驗證**
- [ ] `dig NS` 回 Cloudflare
- [ ] A / CNAME / TXT 三筆解析值與切換前一致
- [ ] 網站回 200
- [ ] Google Search Console 驗證未失效

---

## 6. 若 HiNet 完全不給改 NS

到了這一步才需要，正常情況不會用到。三個選項，按建議順序：

**A. 轉到別的 .com.tw 受理註冊機構** —— 網址不變，SEO 全保。代價是 TWNIC 的轉移程序。

**B. Cloudflare partial（CNAME）setup** —— 不改 NS，[但只有 Business 或 Enterprise 方案可用](https://developers.cloudflare.com/dns/zone-setups/partial-setup/)，約 $200/月，且 apex 需要原 DNS 供應商支援 CNAME flattening。對這個規模不划算。

**C. 改用不需要 NS 控制權的平台** —— Azure Static Web Apps、Vercel、Netlify 只需要一筆 A 或 CNAME。代價是推翻 [ADR-002](10-decisions.md) 與 [ADR-003](10-decisions.md)，D1/R2 要換等價服務。但**前台移植的成果全部保留** —— [03-url-contract](03-url-contract.md) 的凍結契約、golden 基準、parity 機制都與執行環境無關。禾勤本來就在 Azure，Azure Static Web Apps 會是阻力最小的替代路徑。

**不列入考慮**：只上 `workers.dev` 不綁自訂網域 —— 等於放棄既有網址與全部 SEO，違背 [ADR-001](10-decisions.md) 的整個前提。
