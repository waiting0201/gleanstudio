/**
 * IIS 的路徑比對不分大小寫，Astro 分。實測 https://gleanstudio.com.tw/home/about
 * 回 200（直接服務，不是轉址），所以這裡用 rewrite 不用 redirect ——
 * 發一個舊站從來不發的 301 也是破壞契約。見 docs/03-url-contract.md §3.3
 *
 * 站內沒有任何地方產生小寫網址，這只影響外部連結、舊書籤與手打網址。
 *
 * 四類路徑各有各的處理方式，因為它們壞掉的原因不一樣：
 *
 *   /Home/*        Astro 路由敏感 → rewrite，**而且要還原整頁的站內連結**（§5.6）
 *   /backend/*     同上，但後台沒有 markup 契約，不動連結
 *   /Upload/*      路由本身已經處理 entity/id/photo 的大小寫，只差最前面那段
 *   /Content/*     Workers Assets 敏感，**而且它在 Worker 之前**就處理掉命中的請求 ——
 *   /Scripts/*     沒命中才會落到這裡，所以要用 env.ASSETS 重新取一次
 */
import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import { ensureCsrfToken } from './lib/auth/csrf';
import { FLASH_KEY, type Flash } from './api/app';

const CANONICAL = new Map(
  [
    '/Home/Index', '/Home/About', '/Home/Articles', '/Home/ArticleDetail',
    '/Home/Services', '/Home/Service', '/Home/Project', '/Home/Team',
    '/Home/Gallery', '/Home/Contact',
  ].map((p) => [p.toLowerCase(), p]),
);

/**
 * 後台與 /Error 的正規大小寫。用 `import.meta.glob` 在 build 時列舉實際檔案，
 * 不手工維護清單 —— 之後新增一頁自動涵蓋，不會漂移。
 *
 * 前台那 10 條刻意不併進來：它們多一道站內連結還原，而這裡的頁面不需要。
 */
const OTHER_PAGES = new Map(
  Object.keys({
    ...import.meta.glob('./pages/backend/**/*.astro'),
    ...import.meta.glob('./pages/Error/**/*.astro'),
  })
    .map((f) => f.replace(/^\.\/pages/, '').replace(/\.astro$/, ''))
    .map((p) => [p.toLowerCase(), p] as const),
);

/** Workers Assets 服務的兩個目錄。`public/` 底下就只有這兩個第一層資料夾。 */
const ASSET_ROOTS = new Map([['content', 'Content'], ['scripts', 'Scripts']]);

export const onRequest = defineMiddleware(async (ctx, next) => {
  const path = ctx.url.pathname.replace(/\/+$/, '') || '/';
  const lower = path.toLowerCase();

  // ── 靜態資源：大小寫打錯 ───────────────────────────────
  // 命中的請求根本不會進 Worker（Workers Assets 先攔），所以走到這裡就代表
  // 「大小寫錯了」或「真的不存在」。兩種候選都試：只有第一段錯（/content/css/…），
  // 或整條都被打成小寫。試不到就照常往下走，讓 Astro 回它的 404。
  const assetRoot = ASSET_ROOTS.get(lower.split('/')[1] ?? '');
  if (assetRoot && env.ASSETS) {
    const tail = path.slice(1 + assetRoot.length);
    for (const candidate of new Set([`/${assetRoot}${tail}`, `/${assetRoot}${tail.toLowerCase()}`])) {
      if (candidate === path) continue;
      const res = await env.ASSETS.fetch(new URL(candidate + ctx.url.search, ctx.url));
      if (res.status !== 404) return res;
    }
  }

  // ── 後台：CSRF token 與 flash 訊息 ─────────────────────
  // ⚠️ 這兩件事**一定要在這裡做，不能在元件裡做**。元件渲染時 header 已經
  //    送出去了，session.set() 會被 Astro 丟掉（只留一行 warning）——
  //    token 會渲染得出來但沒存進 session，於是每一次 POST 都 403；
  //    flash 則是永遠清不掉。兩個都不會讓頁面看起來壞掉。
  // 比對用 lower —— /Backend/Main/Login 也要拿得到 token，不然下面 rewrite 過去
  // 之後表單會渲染出一個空的 token，每一次 POST 都 403，而畫面看起來完全正常。
  if (lower.startsWith('/backend')) {
    ctx.locals.csrf = await ensureCsrfToken(ctx.session as never);
    const flash = (await ctx.session?.get(FLASH_KEY)) as Flash | undefined;
    if (flash) {
      ctx.locals.flash = flash;
      ctx.session?.delete(FLASH_KEY);
    }
  }

  // ── 後台 / Error：rewrite，不動連結 ────────────────────
  //
  // ⚠️ **這裡一定要用 `next(url)`，不能用 `ctx.rewrite(url)`。**
  //
  // `ctx.rewrite()` 會把回應的 **Set-Cookie 丟掉**。登入時 `session.regenerate()`
  // 換一組新的 session id（防 session fixation），那個 id 只能靠 Set-Cookie 傳給
  // 瀏覽器 —— header 沒發出去，瀏覽器還拿著舊 id，而舊 id 已經沒有登入資料了。
  // 於是下一頁判定「沒登入」又導回登入頁：**登入其實成功了，看起來卻像密碼錯了。**
  // 2026-08-08 由使用者在正式站上用 /backend/main/login 回報。
  //
  // `next(url)` 是沿著同一條鏈往下走，Astro 的 session 後處理仍在外層，cookie 發得出來。
  //
  // 底下 /Upload 與前台那兩處仍然是 `ctx.rewrite()`，因為它們不碰 session ——
  // 前台那一處還需要拿到 Response 才能改寫站內連結，換不得。
  const other = OTHER_PAGES.get(lower);
  if (other && other !== path) return next(other + ctx.url.search);

  // ── /Upload/*：只有最前面那段要正規化 ──────────────────
  // entity / id / photo 的大小寫由路由自己處理（src/pages/Upload/…），
  // 它已經把 entity 對回正式大小寫、id 轉小寫，因為 R2 的 key 是大小寫敏感的。
  if (lower.startsWith('/upload/') && !path.startsWith('/Upload/')) {
    return ctx.rewrite('/Upload' + path.slice('/upload'.length) + ctx.url.search);
  }

  const canonical = CANONICAL.get(lower);
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
