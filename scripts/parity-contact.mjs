#!/usr/bin/env node
/**
 * `POST /Home/Contact` 的驗證 —— 全站唯一沒有 oracle 的地方。
 *
 *   npm run parity:contact
 *
 * 不能對正式站發 POST（會寄真信、燒 reCAPTCHA 配額），所以期望輸出是從
 * **原始碼推導**出來的：拿 `tests/golden/Home-Contact.html`（真的 GET 回應）
 * 當底，套上 ASP.NET MVC 重新渲染時會做的變換，寫進 `tests/derived/`。
 *
 * ⚠️ 這裡的「期望」不是量到的，是推理出來的。`tests/derived/` 進版控就是
 *    為了讓那份推理能被人讀、被 diff。見 docs/08-verification.md §5.1
 *
 * 推導依據（Views/Home/Contact.cshtml + MVC 的 InputExtensions）：
 *   1. 有錯的欄位 → class 前插 `input-validation-error`（TagBuilder.AddCssClass 是前插）
 *   2. 有錯的欄位 → <span> 的 class 換成 `field-validation-error` 並填入訊息
 *   3. 所有欄位一律回填 ModelState 的 AttemptedValue
 *   4. `AddModelError("", …)` 是模型層級錯誤，而這個 view 沒有 ValidationSummary
 *      —— 所以「驗證碼錯誤」不會出現在任何地方（docs/09-known-issues.md 1.15）
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { domSig, firstDiff } from './lib/dom-sig.mjs';
import { applyExemptions } from './lib/exemptions.mjs';

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const BASE = arg('--base', 'http://localhost:8787');
const GOLDEN = resolve('tests/golden/Home-Contact.html');
const DERIVED = resolve('tests/derived');

const enc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const FIELDS = ['Name', 'Email', 'Title', 'Phone', 'Message'];

/** 把 GET 的 golden 變換成「POST 重新渲染」的期望 markup。 */
function render(golden, values, errors) {
  let h = golden;
  for (const f of FIELDS) {
    const v = values[f] ?? '';
    const err = errors[f];

    if (f === 'Message') {
      h = h.replace(
        /(<textarea class=")form-control(" cols="20"[^>]*id="Message"[^>]*>)\n(<\/textarea>)/,
        (_m, a, b, c) => `${a}${err ? 'input-validation-error form-control' : 'form-control'}${b}\n${enc(v)}${c}`,
      );
    } else {
      const re = new RegExp(`(<input class=")form-control("[^>]*id="${f}"[^>]*value=")("\\s*/>)`);
      if (!re.test(h)) throw new Error(`golden 裡找不到 ${f} 的 <input> —— golden 換版了？`);
      h = h.replace(re, (_m, a, b, c) =>
        `${a}${err ? 'input-validation-error form-control' : 'form-control'}${b}${enc(v)}${c}`);
    }

    const span = new RegExp(`<span class="field-validation-valid" data-valmsg-for="${f}" data-valmsg-replace="true"></span>`);
    if (!span.test(h)) throw new Error(`golden 裡找不到 ${f} 的驗證訊息 <span>`);
    h = h.replace(span, err
      ? `<span class="field-validation-error" data-valmsg-for="${f}" data-valmsg-replace="true">${enc(err)}</span>`
      : `<span class="field-validation-valid" data-valmsg-for="${f}" data-valmsg-replace="true"></span>`);
  }
  return h;
}

const EMPTY = Object.fromEntries(FIELDS.map((f) => [f, '']));

/**
 * 三個情境涵蓋了 POST 的兩條可觀察分支。
 * 第三條（驗證通過 + captcha 通過 → 302）需要真的 reCAPTCHA token，
 * 本機驗不了 —— 見檔尾的說明。
 */
const CASES = [
  {
    slug: 'Home-Contact--POST-empty.html',
    note: '全部空白 —— 五個 Required 全部觸發',
    post: { ...EMPTY, GoogleCaptchaToken: '' },
    values: EMPTY,
    errors: {
      Name: '請輸入姓名', Email: '請輸入Email', Title: '請輸入主旨',
      Phone: '請輸入電話', Message: '請輸入訊息',
    },
  },
  {
    slug: 'Home-Contact--POST-bad-email.html',
    note: 'Email 格式錯誤 —— 只有 Email 有錯，其餘值回填',
    post: { Name: '王小明', Email: 'not-an-email', Title: '合作洽詢', Phone: '0912345678', Message: '您好，想詢問文物修護。', GoogleCaptchaToken: '' },
    values: { Name: '王小明', Email: 'not-an-email', Title: '合作洽詢', Phone: '0912345678', Message: '您好，想詢問文物修護。' },
    errors: { Email: 'Email格式錯誤' },
  },
  {
    slug: 'Home-Contact--POST-whitespace.html',
    note: '姓名只有空白 —— RequiredAttribute 對字串是 Trim().Length != 0，所以算沒填',
    post: { Name: '   ', Email: 'a@example.com', Title: '合作洽詢', Phone: '0912345678', Message: '您好', GoogleCaptchaToken: '' },
    values: { Name: '   ', Email: 'a@example.com', Title: '合作洽詢', Phone: '0912345678', Message: '您好' },
    errors: { Name: '請輸入姓名' },
  },
  {
    slug: 'Home-Contact--POST-captcha-failed.html',
    note: '欄位全部合法但 captcha 失敗 —— 值全部回填，**沒有任何錯誤標示**（1.15）。'
        + ' Email 用 a@b 順便證明伺服器端的規則有多寬鬆（1.16）',
    post: { Name: '王小明', Email: 'a@b', Title: '合作洽詢', Phone: '0912345678', Message: '您好', GoogleCaptchaToken: 'not-a-real-token' },
    values: { Name: '王小明', Email: 'a@b', Title: '合作洽詢', Phone: '0912345678', Message: '您好' },
    errors: {},
  },
];

// ── 產生 tests/derived/ ────────────────────────────────
const golden = (await readFile(GOLDEN, 'utf8')).replace(/\r\n/g, '\n');
await mkdir(DERIVED, { recursive: true });

for (const c of CASES) {
  await writeFile(`${DERIVED}/${c.slug}`, render(golden, c.values, c.errors), 'utf8');
}
await writeFile(`${DERIVED}/README.md`, `# tests/derived — 推導出來的期望輸出

**這裡的檔案不是量到的，是推理出來的。** 由 \`scripts/parity-contact.mjs\` 從
\`tests/golden/Home-Contact.html\`（真的 GET 回應）套上 ASP.NET MVC 的重新渲染規則產生。

不能對正式站發 \`POST /Home/Contact\` —— 會寄出真實郵件、消耗 reCAPTCHA 配額。
所以這是全站唯一一處沒有 oracle 的驗證，可信度**低於** \`tests/golden/\`。
見 [docs/08-verification.md](../../docs/08-verification.md) §5.1。

進版控的用意就是讓那份推理能被人讀、被 diff。**產生器改了要重新審閱這裡的 diff，
不要只看測試有沒有綠。**

| 檔案 | 情境 |
|---|---|
${CASES.map((c) => `| \`${c.slug}\` | ${c.note} |`).join('\n')}

## 沒有涵蓋到的分支

「欄位全部合法 + reCAPTCHA 通過 → 302 到 \`/\` 並寄信」需要真的 reCAPTCHA token，
本機驗不了。它只依賴 \`verifyCaptcha()\` 回傳 true，判定條件
（\`success && action === 'login' && score > 0.5\`）與舊站逐字相同。
**Phase 7 soak 時用輪替後的 key 實際走一次。**
`, 'utf8');

// ── 對本機發 POST 並比對 ───────────────────────────────
let failed = 0;

for (const c of CASES) {
  const body = new URLSearchParams(c.post);
  const res = await fetch(`${BASE}/Home/Contact`, {
    method: 'POST',
    body,
    // 瀏覽器送表單一定會帶 Origin。Astro 預設開 security.checkOrigin，
    // 沒帶就直接 403 —— 這是新站比舊站嚴的地方，見 docs/09-known-issues.md 4.12
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE },
    redirect: 'manual',
  });
  const actual = (await res.text()).replace(/\r\n/g, '\n');
  const expected = await readFile(`${DERIVED}/${c.slug}`, 'utf8');

  // 驗證失敗一律回 200 重新渲染，不是 4xx —— docs/03-url-contract.md §2
  const statusOk = res.status === 200;
  // derived 檔保留舊站原本的 markup（含 <!--main-->），豁免只在比對時套用
  const eSig = domSig(applyExemptions(expected)), aSig = domSig(actual);
  const domOk = eSig === aSig;

  if (statusOk && domOk) {
    console.log(`✓ ${c.slug}  ${c.note.split(' —— ')[0]}`);
  } else {
    failed++;
    console.log(`❌ ${c.slug}`);
    if (!statusOk) console.log(`   狀態碼 期望 200 / 實得 ${res.status}`);
    if (!domOk) {
      const d = firstDiff(eSig, aSig);
      console.log(`   DOM 第一處差異 @${d.index}`);
      console.log(`   期望 ${d.expected}`);
      console.log(`   實得 ${d.actual}`);
    }
  }
}

console.log(failed ? `\n❌ ${failed}/${CASES.length} 個情境未通過` : `\n✅ ${CASES.length} 個情境全部通過`);
process.exit(failed ? 1 : 0);
