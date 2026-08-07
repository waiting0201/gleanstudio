/**
 * 明列的 markup 豁免。**只放真的無法達成、且經過審閱的**，不要當成垃圾桶。
 * 每一條都要在 docs/08-verification.md §7 有對應紀錄。
 *
 * 只對「期望值」（golden / derived）套用，本機輸出不動 ——
 * 這樣「本機多了什麼」仍然會被抓到。
 */
export const EXEMPTIONS = [
  {
    // Astro 的編譯器會丟掉版型層的 HTML 註解（四種寫法都試過）。
    // 零渲染影響，見 src/layouts/Site.astro 的說明。
    // 連同它後面那個換行一起拿掉 —— 註解在 Razor 裡自成一行，只刪註解會留下
    // 一個本機不可能產生的空行，讓 Level A 的 byte 比對每一頁都失敗。
    id: 'astro-strips-main-comment',
    apply: (html) => html.replace('<!--main-->\n', ''),
  },
];

export const applyExemptions = (html) => EXEMPTIONS.reduce((h, e) => e.apply(h), html);
