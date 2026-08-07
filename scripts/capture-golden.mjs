#!/usr/bin/env node
/**
 * 從正式站擷取 golden 基準。
 *
 * 正式站是 oracle —— 舊程式碼跑不起來，但不需要跑。見 docs/08-verification.md
 *
 * 除了 HTML 之外，這支腳本還負責一件事：把 /Home/Articles 的**實際顯示順序**
 * 寫進 data/export/legacy-order.json。CreateDate 並列時的順序無法從資料庫推導，
 * 只能從 oracle 讀。見 docs/04-data-model.md §5
 *
 *   node scripts/capture-golden.mjs
 *   node scripts/capture-golden.mjs --origin https://gleanstudio.com.tw --out tests/golden
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ORIGIN = arg('--origin', 'https://gleanstudio.com.tw');
const OUT = resolve(arg('--out', 'tests/golden'));
const EXPORT_DIR = resolve(arg('--export', 'data/export'));
const DELAY_MS = Number(arg('--delay', '250'));

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** URL → 檔名。查詢字串裡的 GUID 只留前 8 碼，檔名才讀得懂。 */
function slugFor(path) {
  const [p, q] = path.split('?');
  let s = p.replace(/^\//, '').replace(/\//g, '-') || 'root';
  if (q) {
    const params = new URLSearchParams(q);
    const parts = [];
    for (const [k, v] of params) {
      parts.push(`${k.toLowerCase()}-${/^[0-9a-f-]{36}$/i.test(v) ? v.slice(0, 8) : v}`);
    }
    s += '__' + parts.join('_');
  }
  return s.toLowerCase() + '.html';
}

const fetched = [];
async function capture(path, { note } = {}) {
  const url = ORIGIN + path;
  const res = await fetch(url, { redirect: 'manual' });
  const body = Buffer.from(await res.arrayBuffer());
  const slug = slugFor(path);
  await writeFile(`${OUT}/${slug}`, body);

  fetched.push({
    path,
    slug,
    status: res.status,
    contentType: res.headers.get('content-type'),
    location: res.headers.get('location') ?? undefined,
    bytes: body.length,
    sha256: sha256(body),
    note,
  });
  console.log(`  ${String(res.status).padEnd(4)} ${String(body.length).padStart(7)}B  ${path}`);
  await sleep(DELAY_MS);
  return body.toString('utf8');
}

// ── 探索：文章順序與分類 ──────────────────────────────────
/** 逐頁抓 /Home/Articles，取得跨頁的實際顯示順序。這就是 legacy order。 */
async function crawlArticleOrder() {
  const order = [];
  for (let p = 1; p <= 50; p++) {
    const html = await capture(`/Home/Articles?p=${p}`, { note: p === 1 ? 'articles-page-1' : undefined });
    const ids = [...html.matchAll(/ArticleDetail\?ArticleID=([0-9a-f-]{36})/gi)].map((m) => m[1].toLowerCase());
    if (ids.length === 0) break;
    order.push(...ids);
    // 沒有「下一頁」的可用連結就停
    if (!/arrow-page-next\.svg/.test(html) || /disabled page-item"><a class="page-link" href="javascript:;"><img src="\/Content\/images\/svg\/arrow-page-next\.svg"/.test(html)) break;
  }
  return order;
}

await mkdir(OUT, { recursive: true });

console.log(`擷取來源：${ORIGIN}\n`);

// 1. 固定路徑
console.log('── 固定路徑 ──');
const FIXED = [
  '/', '/Home/Index', '/Home/About', '/Home/Team', '/Home/Gallery',
  '/Home/Project', '/Home/Services', '/Home/Service', '/Home/Contact',
];
for (const p of FIXED) await capture(p);

// 2. 文章列表逐頁 → 取得 legacy order
console.log('\n── 文章列表（同時取得顯示順序）──');
const articleOrder = await crawlArticleOrder();
console.log(`  → 共 ${articleOrder.length} 篇，順序已記錄`);

// 3. 分類：從首頁的 Service 連結取得
console.log('\n── 分類頁 ──');
const homeHtml = (await readFile(`${OUT}/root.html`)).toString('utf8');
const typeIds = [...new Set(
  [...homeHtml.matchAll(/Service\?ArticleTypeID=([0-9a-f-]{36})/gi)].map((m) => m[1].toLowerCase())
)];
for (const id of typeIds) {
  await capture(`/Home/Service?ArticleTypeID=${id}`);
  await capture(`/Home/Articles?ArticleTypeID=${id}`);
}

// 4. 每篇文章的詳細頁
console.log('\n── 文章詳細頁 ──');
for (const id of articleOrder) await capture(`/Home/ArticleDetail?ArticleID=${id}`);

// 5. 邊界情境 —— 這些是刻意探測舊站在異常輸入下的行為
console.log('\n── 邊界情境 ──');
const NONEXISTENT = '00000000-0000-0000-0000-000000000000';
await capture(`/Home/Articles?p=999`,                      { note: '超出範圍的頁碼' });
await capture(`/Home/Articles?p=0`,                        { note: '頁碼 0' });
await capture(`/Home/Articles?p=abc`,                      { note: '頁碼非數字' });
await capture(`/Home/Articles?ArticleTypeID=${NONEXISTENT}`, { note: '不存在的分類' });
await capture(`/Home/ArticleDetail?ArticleID=${NONEXISTENT}`, { note: '不存在的文章 —— 舊站預期 500' });
await capture(`/Home/Service?ArticleTypeID=${NONEXISTENT}`, { note: '不存在的分類' });
await capture(`/home/about`,                               { note: '小寫路徑 —— IIS 不敏感，Astro 需 middleware' });
await capture(`/Home/About/`,                              { note: '尾斜線' });
await capture(`/Error/Validation`,                         { note: '舊站未實作，預期 404' });

// ── 寫出 legacy order ────────────────────────────────────
const legacyOrder = Object.fromEntries(articleOrder.map((id, i) => [id, i + 1]));
await mkdir(EXPORT_DIR, { recursive: true });
await writeFile(`${EXPORT_DIR}/legacy-order.json`,
  JSON.stringify({
    capturedAt: new Date().toISOString(),
    origin: ORIGIN,
    note: '從正式站 /Home/Articles 的實際顯示順序取得。CreateDate 並列時的順序' +
          '無法從資料庫推導，見 docs/04-data-model.md §5',
    order: legacyOrder,
  }, null, 2) + '\n', 'utf8');

// ── manifest ─────────────────────────────────────────────
// dataDigest 把 golden 綁在特定的資料快照上。對不上就不該比對 —— 那些失敗
// 是內容漂移，不是回歸。見 docs/08-verification.md §2
let dataDigest = null;
try {
  dataDigest = JSON.parse(await readFile(`${EXPORT_DIR}/manifest.json`, 'utf8')).dataDigest;
} catch {
  console.warn('\n⚠️  找不到 data/export/manifest.json —— golden 將沒有資料快照綁定');
}

await writeFile(`${OUT}/manifest.json`, JSON.stringify({
  capturedAt: new Date().toISOString(),
  origin: ORIGIN,
  dataDigest,
  articleOrder,
  articleTypeIds: typeIds,
  pages: fetched,
}, null, 2) + '\n', 'utf8');

const byStatus = fetched.reduce((m, f) => (m[f.status] = (m[f.status] ?? 0) + 1, m), {});
console.log(`\n共 ${fetched.length} 頁，狀態碼分佈：${JSON.stringify(byStatus)}`);
console.log(`dataDigest  ${dataDigest ?? '(無)'}`);
