// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

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
});
