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

/** `dd MMMM yyyy` en-US，以 UTC 解讀 —— 舊站不做時區轉換，我們多做就會位移日期。 */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${day} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
