/**
 * 從正式站的 HTML 讀出「顯示順序」。
 *
 * 有兩處順序無法從資料庫推導，只能從 oracle 讀（見 docs/04-data-model.md §5）：
 *   1. /Home/Articles 的文章順序 —— CreateDate 並列，而且**篩不篩分類的順序不同**
 *   2. /Home/Project 的三層分組順序 —— 舊 controller 根本沒有 ORDER BY
 *
 * 解析邏輯放在這裡，讓 capture-golden.mjs（打正式站）與 derive-order.mjs
 * （只讀 tests/golden/）用同一份，不會各自漂移。
 */

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

/**
 * Razor 的 @Html 輸出會 HTML 編碼，而資料庫裡是原文。
 * .NET 的 HttpUtility.HtmlEncode 把 160–255 的字元也編成數值參考
 * （所以 `·` 會變成 `&#183;`），單引號則是 `&#39;` —— 不解碼就對不上鍵。
 */
export function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return NAMED[body.toLowerCase()] ?? m;
  });
}

/** 一頁文章列表裡的 ArticleID，依出現順序。 */
export function parseArticleIds(html) {
  return [...html.matchAll(/ArticleDetail\?ArticleID=([0-9a-f-]{36})/gi)].map((m) => m[1].toLowerCase());
}

/** 這一頁的「下一頁」還能按嗎 —— 停用時 href 是 javascript:;（見 docs/03-url-contract.md §5.1）*/
export function hasNextPage(html) {
  if (!/arrow-page-next\.svg/.test(html)) return false;
  return !/disabled page-item"><a class="page-link" href="javascript:;"><img src="\/Content\/images\/svg\/arrow-page-next\.svg"/.test(html);
}

/**
 * /Home/Project 的 <li> 排名，key 是 `Type|Place|Title|SubTitle`。
 *
 * 粒度必須到 SubTitle（<li>）。Title 之內的 <li> 順序在舊站是 OrderBy(Sort)，
 * 但 Sort 並列時又落回實體順序 —— 一樣只能從 oracle 取。
 */
export function parseProjectOrder(html) {
  const order = {};
  let rank = 0;
  let type = null, place = null, title = null;
  const re = /<h2 class="text-center mb-4">【([^<]*)】<\/h2>|<h5 class="mb-1">([^<]*)<\/h5>|<p class="mb-1 fw-bold">([^<]*)<\/p>|<li>([^<]*)<\/li>/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1] !== undefined) { type = decodeEntities(m[1]); place = null; title = null; }
    else if (m[2] !== undefined) { place = decodeEntities(m[2]); title = null; }
    else if (m[3] !== undefined) { title = decodeEntities(m[3]); }
    else if (m[4] !== undefined && type !== null && place !== null && title !== null) {
      order[`${type}|${place}|${title}|${decodeEntities(m[4])}`] = ++rank;
    }
  }
  return order;
}
