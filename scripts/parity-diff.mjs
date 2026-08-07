#!/usr/bin/env node
/**
 * 把本機輸出與 tests/golden/ 的正式站基準比對。
 *
 *   npm run parity                    # 全部 fixture
 *   npm run parity -- /Home/About     # 單一路徑
 *   npm run parity -- --level a       # 只看 byte diff 細節
 *
 * Level A（byte，CRLF 正規化後）非 gating —— 一個多餘的換行不該擋住合併。
 * Level B（DOM 正規化）是 gating 層 —— 掉一個 class 會擋。
 * 見 docs/08-verification.md §3
 */
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'parse5';

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BASE = arg('--base', 'http://localhost:8787');
const GOLDEN = resolve('tests/golden');
const ONLY = process.argv.slice(2).filter((a) => a.startsWith('/'));
const SHOW_A = arg('--level', '') === 'a';

const manifest = JSON.parse(await readFile(`${GOLDEN}/manifest.json`, 'utf8'));

// ── 資料快照綁定 ──────────────────────────────────────
// golden 是快照。編輯者一發佈新內容，Level A 就會在每一頁失敗 —— 而且是
// 合理的失敗。對不上就拒絕比對，不要吐一堆假警報。見 docs/08-verification.md §2
try {
  const exp = JSON.parse(await readFile('data/export/manifest.json', 'utf8'));
  if (manifest.dataDigest && exp.dataDigest !== manifest.dataDigest) {
    console.error('❌ 資料快照與 golden 不符，拒絕比對。');
    console.error(`   golden  ${manifest.dataDigest}`);
    console.error(`   本機    ${exp.dataDigest}`);
    console.error('   → 重新匯出資料，或重新擷取 golden（npm run golden）。');
    process.exit(2);
  }
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
  console.warn('⚠️  找不到 data/export/manifest.json，跳過資料快照綁定檢查\n');
}

const norm = (s) => s.replace(/\r\n/g, '\n');

// ── Level B：DOM 正規化 ───────────────────────────────
// 排序屬性、收斂無意義空白，比對樹狀結構。
const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
// 這些元素裡的空白有意義，不收斂
const PRE = new Set(['pre', 'textarea', 'script', 'style']);

function serialize(node, inPre = false) {
  if (node.nodeName === '#text') {
    const t = inPre ? node.value : node.value.replace(/\s+/g, ' ');
    return t.trim() === '' ? '' : t;
  }
  if (node.nodeName === '#comment') return `<!--${node.data.trim()}-->`;
  if (node.nodeName === '#documentType') return '<!doctype>';
  if (!node.tagName) return (node.childNodes ?? []).map((c) => serialize(c, inPre)).join('');

  const attrs = (node.attrs ?? [])
    .map((a) => [a.name, a.name === 'class' ? a.value.trim().split(/\s+/).sort().join(' ') : a.value.trim()])
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    .map(([n, v]) => `${n}="${v}"`)
    .join(' ');

  const open = `<${node.tagName}${attrs ? ' ' + attrs : ''}>`;
  if (VOID.has(node.tagName)) return open;
  const nextPre = inPre || PRE.has(node.tagName);
  const inner = (node.childNodes ?? []).map((c) => serialize(c, nextPre)).join('');
  return `${open}${inner}</${node.tagName}>`;
}

/**
 * 明列的 markup 豁免。**只放真的無法達成、且經過審閱的**，不要當成垃圾桶。
 * 每一條都要在 docs/08-verification.md §7 有對應紀錄。
 */
const EXEMPTIONS = [
  {
    // Astro 的編譯器會丟掉版型層的 HTML 註解（四種寫法都試過）。
    // 零渲染影響，見 src/layouts/Site.astro 的說明。
    // 連同它後面那個換行一起拿掉 —— 註解在 Razor 裡自成一行，只刪註解會留下
    // 一個本機不可能產生的空行，讓 Level A 的 byte 比對每一頁都失敗。
    id: 'astro-strips-main-comment',
    apply: (html) => html.replace('<!--main-->\n', ''),
  },
];

const applyExemptions = (html) => EXEMPTIONS.reduce((h, e) => e.apply(h), html);
const domSig = (html) => serialize(parse(html));

/**
 * 刻意分歧：舊站的行為不值得重現，而且**永遠**不會與 golden 相符。
 * 跟 EXEMPTIONS 不同 —— 那是「輸出幾乎一樣、差在無渲染影響的細節」，
 * 這裡是「我們決定不做那件事」。每一條都要在 docs/09-known-issues.md §4 有紀錄。
 */
const DIVERGENCES = new Map([
  ['/Error/Validation', '舊站從未實作（404 黃頁）。新站回 403 原地渲染，見 docs/06-admin-spec.md §7'],
]);

/** 找出兩個字串第一個不同的位置，並附上上下文。 */
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  const from = Math.max(0, i - 70);
  return {
    index: i,
    golden: JSON.stringify(a.slice(from, i + 70)),
    local: JSON.stringify(b.slice(from, i + 70)),
  };
}

// ── 執行 ──────────────────────────────────────────────
const pages = ONLY.length
  ? manifest.pages.filter((p) => ONLY.includes(p.path.split('?')[0]) || ONLY.includes(p.path))
  : manifest.pages;

if (!pages.length) {
  console.error(`找不到符合的 fixture：${ONLY.join(' ')}`);
  process.exit(1);
}

let passA = 0, passB = 0, failB = 0, skipped = 0;
const failures = [];
const diverged = [];

for (const p of pages) {
  // 舊站當機的頁面刻意不重現，見 docs/09-known-issues.md §4
  if (p.status >= 500) { skipped++; continue; }
  if (DIVERGENCES.has(p.path)) {
    diverged.push(p.path);
    console.log(`≠  ${p.path}\n   刻意分歧：${DIVERGENCES.get(p.path)}`);
    continue;
  }

  let res, body;
  try {
    res = await fetch(BASE + p.path, { redirect: 'manual' });
    body = await res.text();
  } catch (e) {
    console.log(`❌ ${p.path}\n   取不到本機回應：${e.message}`);
    failB++; failures.push(p.path);
    continue;
  }

  // golden 套用豁免後再比 —— 本機不套，這樣「本機多了什麼」仍然會被抓到
  const golden = applyExemptions(norm(await readFile(`${GOLDEN}/${p.slug}`, 'utf8')));
  const local = norm(body);

  const statusOk = res.status === p.status;
  const a = golden === local;
  const gSig = domSig(golden), lSig = domSig(local);
  const b = gSig === lSig;

  if (a) passA++;
  if (b && statusOk) {
    passB++;
    console.log(`${a ? 'AB' : 'B '} ✓ ${p.path}`);
  } else {
    failB++; failures.push(p.path);
    console.log(`   ❌ ${p.path}`);
    if (!statusOk) console.log(`      狀態碼 golden ${p.status} / 本機 ${res.status}`);
    if (!b) {
      const d = firstDiff(gSig, lSig);
      console.log(`      DOM 第一處差異 @${d.index}`);
      console.log(`      golden ${d.golden}`);
      console.log(`      本機   ${d.local}`);
    }
  }

  if (SHOW_A && b && !a) {
    const d = firstDiff(golden, local);
    console.log(`      [A] 第一處 byte 差異 @${d.index}`);
    console.log(`      golden ${d.golden}`);
    console.log(`      本機   ${d.local}`);
  }
}

const total = pages.length - skipped - diverged.length;
console.log(`\nLevel A（byte）  ${passA}/${total}`);
console.log(`Level B（DOM）   ${passB}/${total}   ← gating`);
if (skipped) console.log(`略過 ${skipped} 頁（舊站 5xx，刻意不重現）`);
if (diverged.length) console.log(`刻意分歧 ${diverged.length} 頁：${diverged.join(', ')}`);
if (failures.length) {
  console.log(`\n❌ Level B 未通過：\n${failures.map((f) => '   ' + f).join('\n')}`);
  process.exit(1);
}
console.log('\n✅ Level B 全部通過');
if (EXEMPTIONS.length) {
  console.log(`（已套用 ${EXEMPTIONS.length} 條明列豁免：${EXEMPTIONS.map((e) => e.id).join(', ')}）`);
}
