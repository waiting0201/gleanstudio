#!/usr/bin/env node
/**
 * 從**已進版控的** tests/golden/ 重新推導顯示順序資料，不打正式站。
 *
 *   node scripts/derive-order.mjs
 *
 * capture-golden.mjs 也會產生同樣的兩個檔，但它需要正式站；重跑它等於重新
 * baseline。解析邏輯共用 scripts/lib/legacy-order.mjs，兩條路徑不會漂移。
 *
 * 產生：
 *   data/export/legacy-order.json    order（未篩選）+ typeOrder（依分類篩選）
 *   data/export/projects-order.json  Type|Place|Title|SubTitle → 排名
 *
 * ⚠️ golden 只涵蓋每個分類的第 1 頁，所以 typeOrder 裡超出第 1 頁的文章是
 *    **推斷**的（依未篩選順序往後續編），會列在 typeOrderInferred 讓人看得見。
 *    下一次 npm run golden 會逐頁爬，屆時就全部是觀察值。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArticleIds, parseProjectOrder } from './lib/legacy-order.mjs';

const GOLDEN = resolve('tests/golden');
const EXPORT_DIR = resolve('data/export');

const manifest = JSON.parse(await readFile(`${GOLDEN}/manifest.json`, 'utf8'));
const articles = JSON.parse(await readFile(`${EXPORT_DIR}/Articles.json`, 'utf8'));

const html = async (path) => {
  const page = manifest.pages.find((p) => p.path === path);
  return page ? readFile(`${GOLDEN}/${page.slug}`, 'utf8') : null;
};

/** 依序讀 ?p=1、?p=2… 的 fixture，串成一份順序。缺頁就停。 */
async function crawlFixtures(pathFor) {
  const ids = [];
  for (let p = 1; p <= 50; p++) {
    const body = await html(pathFor(p));
    if (body === null) break;
    const page = parseArticleIds(body);
    if (page.length === 0) break;
    ids.push(...page);
  }
  return ids;
}

// ── 未篩選的順序 ────────────────────────────────────────
const articleOrder = await crawlFixtures((p) => `/Home/Articles?p=${p}`);
const order = Object.fromEntries(articleOrder.map((id, i) => [id, i + 1]));

const allIds = articles.map((a) => a.ArticleID.toLowerCase());
const missing = allIds.filter((id) => !(id in order));
if (missing.length) {
  throw new Error(`這些文章不在 golden 的清單裡：${missing.join(', ')}\n` +
    'golden 可能過期了 —— 見 docs/08-verification.md');
}

// ── 依分類篩選後的順序 ──────────────────────────────────
// 同一組資料列在兩張清單上的先後不同，所以要各記一份。見 docs/04-data-model.md §5
const byType = new Map();
for (const a of articles) {
  const t = a.ArticleTypeID.toLowerCase();
  if (!byType.has(t)) byType.set(t, []);
  byType.get(t).push(a.ArticleID.toLowerCase());
}

const typeOrder = {};
const inferred = [];
for (const t of manifest.articleTypeIds) {
  // 第 1 頁的 fixture 不帶 p，之後才是 ?p=N&ArticleTypeID=…
  const seen = await crawlFixtures((p) =>
    p === 1 ? `/Home/Articles?ArticleTypeID=${t}` : `/Home/Articles?p=${p}&ArticleTypeID=${t}`);
  const rest = (byType.get(t) ?? [])
    .filter((id) => !seen.includes(id))
    .sort((a, b) => order[a] - order[b]);
  inferred.push(...rest);
  [...seen, ...rest].forEach((id, i) => { typeOrder[id] = i + 1; });
}

const noTypeOrder = allIds.filter((id) => !(id in typeOrder));
if (noTypeOrder.length) throw new Error(`這些文章沒有分類順序：${noTypeOrder.join(', ')}`);

await writeFile(`${EXPORT_DIR}/legacy-order.json`, JSON.stringify({
  capturedAt: manifest.capturedAt,
  origin: manifest.origin,
  derivedFrom: 'tests/golden (scripts/derive-order.mjs)',
  note: '從正式站 /Home/Articles 的實際顯示順序取得。CreateDate 並列時的順序' +
        '無法從資料庫推導，見 docs/04-data-model.md §5',
  typeOrderNote:
    '/Home/Articles?ArticleTypeID={guid} 的實際顯示順序（每個分類各自從 1 起算）。' +
    '舊站對 CreateDate 並列列的排序在「有無分類篩選」兩種查詢下不一致 —— ' +
    '同一組 2026-01-01 的資料列，未篩選是 4772b8a8→22acb62c，篩選後是 22acb62c→4772b8a8。' +
    '一個欄位表達不了兩種順序，所以有 LegacyOrder 與 LegacyTypeOrder 兩欄。',
  typeOrderInferred: inferred,
  order,
  typeOrder,
}, null, 2) + '\n', 'utf8');

// ── Project 的三層分組順序 ──────────────────────────────
const projectHtml = await html('/Home/Project');
const projectOrder = parseProjectOrder(projectHtml);

await writeFile(`${EXPORT_DIR}/projects-order.json`, JSON.stringify({
  capturedAt: manifest.capturedAt,
  derivedFrom: 'tests/golden (scripts/derive-order.mjs)',
  note: '/Home/Project 的分組順序，key 是 Type|Place|Title|SubTitle。舊站沒有 ORDER BY，' +
        '顯示順序無法從資料庫推導，見 docs/04-data-model.md §5',
  order: projectOrder,
}, null, 2) + '\n', 'utf8');

console.log(`文章順序      ${articleOrder.length} 篇`);
console.log(`分類內順序    ${Object.keys(typeOrder).length} 篇${inferred.length ? `（${inferred.length} 篇推斷：${inferred.map((i) => i.slice(0, 8)).join(', ')}）` : ''}`);
console.log(`Project 順序  ${Object.keys(projectOrder).length} 筆`);
