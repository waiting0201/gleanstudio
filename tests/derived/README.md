# tests/derived — 推導出來的期望輸出

**這裡的檔案不是量到的，是推理出來的。** 由 `scripts/parity-contact.mjs` 從
`tests/golden/Home-Contact.html`（真的 GET 回應）套上 ASP.NET MVC 的重新渲染規則產生。

不能對正式站發 `POST /Home/Contact` —— 會寄出真實郵件、消耗 reCAPTCHA 配額。
所以這是全站唯一一處沒有 oracle 的驗證，可信度**低於** `tests/golden/`。
見 [docs/08-verification.md](../../docs/08-verification.md) §5.1。

進版控的用意就是讓那份推理能被人讀、被 diff。**產生器改了要重新審閱這裡的 diff，
不要只看測試有沒有綠。**

| 檔案 | 情境 |
|---|---|
| `Home-Contact--POST-empty.html` | 全部空白 —— 五個 Required 全部觸發 |
| `Home-Contact--POST-bad-email.html` | Email 格式錯誤 —— 只有 Email 有錯，其餘值回填 |
| `Home-Contact--POST-whitespace.html` | 姓名只有空白 —— RequiredAttribute 對字串是 Trim().Length != 0，所以算沒填 |
| `Home-Contact--POST-captcha-failed.html` | 欄位全部合法但 captcha 失敗 —— 值全部回填，**沒有任何錯誤標示**（1.15）。 Email 用 a@b 順便證明伺服器端的規則有多寬鬆（1.16） |

## 沒有涵蓋到的分支

「欄位全部合法 + reCAPTCHA 通過 → 302 到 `/` 並寄信」需要真的 reCAPTCHA token，
本機驗不了。它只依賴 `verifyCaptcha()` 回傳 true，判定條件
（`success && action === 'login' && score > 0.5`）與舊站逐字相同。
**Phase 7 soak 時用輪替後的 key 實際走一次。**
