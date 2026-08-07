#!/usr/bin/env node
/**
 * 網址大小寫不敏感 —— 舊站跑在 IIS，路徑比對本來就不分大小寫。
 *
 *   node scripts/verify-url-case.mjs [--base https://…]
 *
 * 需要一個跑著的伺服器（`npm run preview` 之後就有）。
 *
 * 四類路徑壞掉的原因不一樣，所以四類都要驗（見 src/middleware.ts 的開頭）：
 *
 *   /Home/*      Astro 路由敏感 → middleware rewrite，**而且要還原站內連結**
 *   /backend/*   同上，但不動連結。⚠️ CSRF token 也必須跟著發，不然表單看起來
 *                正常卻每一次 POST 都 403
 *   /Upload/*    路由自己處理 entity/id/photo，只差最前面那一段
 *   /Content/*   Workers Assets 敏感，而且它在 Worker 之前 —— 沒命中才落到
 *   /Scripts/*   middleware，要用 env.ASSETS 重新取一次
 *
 * 這支只問「同一個資源用不同大小寫拿不拿得到」，不比對內容 —— 內容是 parity 的事。
 */
const BASE = process.argv.includes('--base')
  ? process.argv[process.argv.indexOf('--base') + 1]
  : 'http://localhost:8787';

const mix = (s) => s.replace(/[a-z]/gi, (c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase()));

/** 每一條：正規網址 + 期望狀態碼。變體由正規網址推出來。 */
const CASES = [
  ['前台', '/Home/About', 200],
  ['前台', '/Home/Articles', 200],
  ['前台', '/Home/Contact', 200],
  ['後台', '/backend/Main/Login', 200],
  ['後台', '/backend/WebMs/Articles', 302],       // 未登入 → 導去登入頁
  ['後台', '/backend/SettingMs/Admins', 302],
  ['錯誤頁', '/Error/Validation', 403],
  ['資源', '/Content/css/style.css', 200],
  ['資源', '/Scripts/nav.js', 200],
];

let pass = 0, fail = 0;
const check = (label, ok, note = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(52)} ${note}`);
  ok ? pass++ : fail++;
};

const status = async (p) => {
  const r = await fetch(BASE + p, { redirect: 'manual' });
  return r.status;
};

console.log(`\n網址大小寫（${BASE}）\n`);

let group = '';
for (const [g, canonical, want] of CASES) {
  if (g !== group) { console.log(`${group ? '\n' : ''}${g}`); group = g; }

  const got = await status(canonical);
  check(canonical, got === want, got === want ? '' : `期望 ${want}，實得 ${got}`);

  for (const variant of new Set([canonical.toLowerCase(), canonical.toUpperCase(), mix(canonical)])) {
    if (variant === canonical) continue;
    const s = await status(variant);
    check(variant, s === want, s === want ? '' : `期望 ${want}，實得 ${s}`);
  }
}

/**
 * /Upload/* 另外處理 —— 需要一個真的存在的 key，所以從 /Home/Team 的 markup 撈。
 * 撈不到就直說跳過，不要靜靜地當作通過。
 */
console.log('\n上傳的圖片');
const teamHtml = await (await fetch(BASE + '/Home/Team')).text();
const upload = teamHtml.match(/\/Upload\/[A-Za-z]+\/[0-9a-f-]+\/\d+\.\w+/)?.[0];
if (!upload) {
  console.log('  ⚠️  /Home/Team 裡找不到 /Upload/… 連結，跳過（不計入通過）');
} else {
  for (const p of [upload, upload.toLowerCase(), mix(upload)]) {
    const s = await status(p);
    check(p, s === 200, s === 200 ? '' : `期望 200，實得 ${s}`);
  }
}

/**
 * 後台用非正規大小寫進去時，CSRF token 一樣要發得出來。
 * 這是最容易靜默壞掉的一項：token 是空的，畫面完全正常，但每一次 POST 都 403。
 */
console.log('\n後台的 CSRF token');
const csrfOf = (h) => h.match(/name="__csrf" value="([^"]+)"/)?.[1] ?? '';
for (const p of ['/backend/Main/Login', '/BACKEND/MAIN/LOGIN', mix('/backend/Main/Login')]) {
  const token = csrfOf(await (await fetch(BASE + p)).text());
  check(`${p} 發得出 token`, token.length === 43, token ? '' : 'token 是空的');
}

console.log(fail ? `\n❌ ${fail} 項未通過（${pass} 項通過）` : `\n✅ ${pass} 項全部通過`);
process.exit(fail ? 1 : 0);
