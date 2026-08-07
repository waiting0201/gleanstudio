/**
 * IIS 的路徑比對不分大小寫，Astro 分。實測 https://gleanstudio.com.tw/home/about
 * 回 200（直接服務，不是轉址），所以這裡用 rewrite 不用 redirect ——
 * 發一個舊站從來不發的 301 也是破壞契約。見 docs/03-url-contract.md §3.3
 *
 * 站內沒有任何地方產生小寫網址，這只影響外部連結、舊書籤與手打網址。
 *
 * ⚠️ 靜態資源（/content/css/style.css）不走這裡 —— Workers Assets 在 Worker
 *    之前就處理掉了，middleware 看不到。見 docs/09-known-issues.md
 */
import { defineMiddleware } from 'astro:middleware';

const CANONICAL = new Map(
  [
    '/Home/Index', '/Home/About', '/Home/Articles', '/Home/ArticleDetail',
    '/Home/Services', '/Home/Service', '/Home/Project', '/Home/Team',
    '/Home/Gallery', '/Home/Contact',
  ].map((p) => [p.toLowerCase(), p]),
);

export const onRequest = defineMiddleware(async (ctx, next) => {
  const path = ctx.url.pathname.replace(/\/+$/, '') || '/';
  const canonical = CANONICAL.get(path.toLowerCase());
  if (!canonical || canonical === path) return next();

  const res = await ctx.rewrite(canonical + ctx.url.search);

  // 舊站的 Url.Action 用的是 RouteData.Values["controller"]，也就是**使用者
  // 實際打進來的**片段 —— 所以 /home/about 整頁的站內連結都變成 /home/About，
  // action 名稱維持原本的大小寫。golden 逐字記錄了這個行為
  // （tests/golden/home-about~1a8370.html 與 Home-About.html 的唯一差別）。
  // 站內元件不必為此帶一個前綴參數，在出口改字串就夠 —— 只有非正規大小寫的
  // 請求才會走到這裡。
  if (!res.headers.get('content-type')?.startsWith('text/html')) return res;
  const segment = path.split('/')[1];
  const html = (await res.text()).replaceAll('"/Home/', `"/${segment}/`);
  return new Response(html, res);
});
