// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  output: 'server',
  adapter: cloudflare(),
  site: 'https://gleanstudio.com.tw',

  // 實測 https://gleanstudio.com.tw/Home/About/ 回 200 且不轉址，
  // 'ignore' 才與 IIS 行為相符。'never' 會發出舊站從來不發的 301。
  trailingSlash: 'ignore',

  // ⚠️ 不可省略。Astro 預設壓縮 HTML，Razor 不壓 ——
  // 開著壓縮的話每一頁的空白都不同，byte parity 直接不可能達成。
  // 見 docs/03-url-contract.md §3.4
  compressHTML: false,

  build: { format: 'preserve' },

  // 後台 session —— KV 而不是 JWT，因為需要伺服器端撤銷能力：
  // 管理員被移除或權限被撤銷之後，一枚有效的 token 仍然能用到過期。
  // 見 docs/06-admin-spec.md §2
  // ⚠️ **不要自己設 driver。** @astrojs/cloudflare 只有在 session.driver 沒被
  //    設定時才會幫你接上 KV（binding 預設就叫 SESSION），而且是用
  //    sessionDrivers.cloudflareKVBinding({ binding }) 把 binding 名稱包進去的。
  //    手寫 `driver: 'cloudflareKVBinding'` + 另一個 options 欄位不會走那條路，
  //    driver 收到的 opts 是 undefined，登入當下就 500（讀 opts.base 炸掉）。
  session: {
    ttl: 8 * 60 * 60,
    cookie: { name: 'gleanstudio_session', sameSite: 'lax', httpOnly: true, secure: true },
  },

  // ⚠️ Tailwind 只透過 Vite plugin 掛上，**不加 Astro 的 tailwind integration** ——
  // integration 會注入一份全域樣式，前台每一頁的 <head> 都會多一個 <link>，
  // 凍結的 markup 立刻掉。這裡改成只有 src/layouts/Admin.astro 去 import
  // src/styles/admin.css，Astro 就只會把它注進有用到的頁面。
  // 見 docs/06-admin-spec.md §11
  vite: { plugins: [tailwindcss()] },
});
