/**
 * 舊站的 @item.CreateDate.ToString("dd MMMM yyyy") 沒有指定 CultureInfo，
 * Web.config 也沒有 <globalization>，所以跟著伺服器 culture 走。
 * 正式站實測輸出 `20 July 2026` —— 英文月份名。
 *
 * ⚠️ 用 zh-TW 格式化會靜默破壞 /、/Home/Articles、/Home/ArticleDetail 三頁的 parity。
 * 見 docs/03-url-contract.md §5.4
 */
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Razor 的 `@x` 走 HttpUtility.HtmlEncode，它跟一般的 HTML 跳脫不一樣：
 * **160–255 的字元也會編成數值參考**，所以 `·`（U+00B7）輸出的是 `&#183;`。
 * 中文（> 255）不受影響。
 *
 * Astro 的 `{x}` 只跳脫 & < > " '，兩者在瀏覽器裡等價，但 byte 不同 ——
 * 要拿 Level A 就得照做。用法是 `set:html={htmlEncode(x)}`，這是安全的：
 * 所有具語法意義的字元都在這裡跳掉了。見 docs/08-verification.md §7
 */
export function htmlEncode(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else if (ch === "'") out += '&#39;';
    else if (cp >= 160 && cp < 256) out += `&#${cp};`;
    else out += ch;
  }
  return out;
}

/** `dd MMMM yyyy` en-US，以 UTC 解讀 —— 舊站不做時區轉換，我們多做就會位移日期。 */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${day} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
