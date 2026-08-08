#!/usr/bin/env node
/**
 * 後台截圖 —— **設計用的眼睛**，不是測試。
 *
 *   npm run preview          # 先讓 wrangler dev 起來（它順便跑 parity，沒關係）
 *   npm run shot:admin       # 全部畫面 → tmp/shots/1440/
 *
 *   npm run shot:admin -- /backend/WebMs/Articles      # 只截一頁
 *   npm run shot:admin -- --width 375,768,1440         # 三個寬度
 *   npm run shot:admin -- --fold                       # 只截第一屏（預設是整頁）
 *
 * 為什麼要有這支：改 src/styles/admin.css 的時候看不到結果，就只能靠推理寫
 * CSS，那不是做設計。docs/08-verification.md §3 的 Level C 一直寫著要用瀏覽器
 * 截圖，但從來沒接起來。這支是最小的那一半 —— 只截圖，不比對。
 *
 * ⚠️ **這支完全唯讀。** 不寫資料庫、不送任何表單（登入除外）。要驗行為請跑
 * npm run smoke:admin —— 那支會真的建資料再刪掉。
 *
 * 帳密從 gitignored 的 data/export/Admins.json 讀，或用 SHOT_USERNAME /
 * SHOT_PASSWORD 覆蓋。**不印出來。**
 */
import { readFile, mkdir, rm } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};

const BASE = flag('--base', 'http://localhost:8787').replace(/\/$/, '');
const OUT = flag('--out', 'tmp/shots');
const CHROME = process.env.CHROME
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WIDTHS = flag('--width', '1440').split(',').map((w) => Number(w.trim()));
const FULL_PAGE = !argv.includes('--fold');
// 位置引數（不是 --flag、也不是 flag 的值）＝ 只截這幾頁
const ONLY = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));

/**
 * 要看的畫面。
 *
 * `from` 的那幾筆沒有固定網址（Edit 頁要帶 ?id=），所以先開列表、抓第一個
 * 編輯連結 —— 比去查 D1 拿一個 ID 簡單，也維持這支腳本唯讀。
 */
const SHOTS = [
  { name: '01-login',         path: '/backend/Main/Login', anon: true },
  { name: '02-dashboard',     path: '/backend/Main/Index' },
  { name: '03-articles',      path: '/backend/WebMs/Articles' },
  { name: '04-article-types', path: '/backend/WebMs/ArticleTypes' },
  { name: '05-services',      path: '/backend/WebMs/Services' },
  { name: '06-teams',         path: '/backend/WebMs/Teams' },
  { name: '07-projects',      path: '/backend/WebMs/Projects' },
  { name: '08-abouts',        path: '/backend/WebMs/Abouts' },
  { name: '09-admins',        path: '/backend/SettingMs/Admins' },
  { name: '10-add-article',   path: '/backend/WebMs/AddArticles' },
  { name: '11-edit-article',  from: '/backend/WebMs/Articles' },
  { name: '12-add-admin',     path: '/backend/SettingMs/AddAdmins' },
  { name: '13-forbidden',     path: '/backend/Forbidden' },
];

const targets = ONLY.length
  ? SHOTS.filter((s) => ONLY.some((o) => s.path === o || s.name === o))
  : SHOTS;
if (ONLY.length && targets.length === 0) {
  console.error(`找不到 ${ONLY.join(' ')}。可用的：\n  ${SHOTS.map((s) => s.path ?? `${s.name}（從 ${s.from} 推出來）`).join('\n  ')}`);
  process.exit(2);
}

// ── 前置檢查：伺服器要在，Chrome 要在 ────────────────────────────
try {
  await fetch(`${BASE}/backend/Main/Login`, { signal: AbortSignal.timeout(5000) });
} catch {
  console.error(`❌ 連不上 ${BASE} —— 先跑 npm run preview 讓 wrangler dev 起來。`);
  process.exit(2);
}

const admin = process.env.SHOT_USERNAME
  ? { Username: process.env.SHOT_USERNAME, Password: process.env.SHOT_PASSWORD ?? '' }
  : await readFile('data/export/Admins.json', 'utf8')
      .then((t) => JSON.parse(t)[0])
      .catch(() => {
        console.error('❌ 讀不到 data/export/Admins.json（gitignored）。');
        console.error('   改用 SHOT_USERNAME=… SHOT_PASSWORD=… npm run shot:admin');
        process.exit(2);
      });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--font-render-hinting=none'],
});

let shot = 0;
try {
  for (const width of WIDTHS) {
    const dir = `${OUT}/${width}`;
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });

    const page = await browser.newPage();
    await page.setViewport({ width, height: 900, deviceScaleFactor: 2 });

    // ── 登入一次，之後所有頁面共用同一個 session ────────────────
    await page.goto(`${BASE}/backend/Main/Login`, { waitUntil: 'networkidle0' });
    await page.type('#username', admin.Username);
    await page.type('#password', admin.Password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => {}),
      page.click('button[type=submit]'),
    ]);

    if (page.url().includes('/Login')) {
      console.error(`❌ 登入失敗（還停在 ${page.url()}）。帳密對不上，或 D1 裡沒有這個帳號。`);
      process.exit(2);
    }
    /* MustChangePassword = 1 的帳號會被 Index 彈到 ChangePassword，於是除了那一頁
       之外全部截到同一張圖。smoke:admin 會暫時把它設成 0 再還原；這支不碰資料庫，
       所以在這裡擋下來，把還原用的指令一起印出去。 */
    if (page.url().includes('/ChangePassword')) {
      console.error(`❌ ${admin.Username} 的 MustChangePassword = 1，所有頁面都會彈到強制改密碼。`);
      console.error('   暫時關掉（記得截完改回 1）：');
      console.error(`   npx wrangler d1 execute gleanstudio --local --command "UPDATE Admins SET MustChangePassword = 0 WHERE Username = '${admin.Username}'"`);
      process.exit(2);
    }

    for (const target of targets) {
      let url = target.path;

      if (target.from) {
        await page.goto(BASE + target.from, { waitUntil: 'networkidle0' });
        url = await page.$eval('a[href*="/Edit"]', (a) => a.getAttribute('href')).catch(() => null);
        if (!url) {
          console.log(`  – ${target.name.padEnd(18)} 跳過：${target.from} 上沒有任何資料列`);
          continue;
        }
      }

      const res = await page.goto(BASE + url, { waitUntil: 'networkidle0' });
      if (target.anon) {
        /* 登入頁：帶著 session 進去會被導走，所以清掉 cookie 再拍，拍完復原。
           順序上放最後最省事，但清單順序是給人看的，寧可在這裡多繞一下。 */
        const cookies = await browser.cookies();
        await browser.deleteCookie(...cookies);
        await page.goto(BASE + url, { waitUntil: 'networkidle0' });
        await page.screenshot({ path: `${dir}/${target.name}.png`, fullPage: FULL_PAGE });
        await browser.setCookie(...cookies);
        console.log(`  ✓ ${target.name.padEnd(18)} ${url}`);
        shot++;
        continue;
      }

      // Forbidden 回 403，是預期的；其他非 2xx 要講出來，不要靜靜截一張錯誤頁
      const status = res?.status() ?? 0;
      const expected = target.name.includes('forbidden') ? 403 : 200;
      const note = status === expected ? '' : `  ⚠️ HTTP ${status}`;

      await page.screenshot({ path: `${dir}/${target.name}.png`, fullPage: FULL_PAGE });
      console.log(`  ✓ ${target.name.padEnd(18)} ${url}${note}`);
      shot++;
    }

    await page.close();
    console.log(`\n${width}px → ${dir}/\n`);
  }
} finally {
  await browser.close();
}

console.log(`共 ${shot} 張。用 open ${OUT} 打開來看。`);
