#!/usr/bin/env node
/**
 * 驗證 D1 的 Photo 欄位與 R2 的物件互相對得上。
 *
 *   node scripts/verify-media.mjs            # 本機
 *   node scripts/verify-media.mjs --remote
 */
import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const has = (flag) => process.argv.includes(flag);
function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BUCKET = arg('--bucket', 'gleanstudio-media');
const SRC_DIR = resolve(arg('--dir', 'reference/old/Gleanstudio/Upload'));
const REMOTE = has('--remote');
const IN = resolve('data/export');

const PHOTO_RE = /^\d{14}\.[A-Za-z0-9]+$/;

const read = async (n) => JSON.parse(await readFile(`${IN}/${n}.json`, 'utf8'));

// ── 從匯出資料建立「應該存在」的 key 清單 ──────────────
const expected = [];
const push = (entity, id, photo) => {
  if (photo) expected.push({ entity, id: String(id).toLowerCase(), photo, key: `Upload/${entity}/${String(id).toLowerCase()}/${photo}` });
};
for (const r of await read('Articles'))     push('Articles', r.ArticleID, r.Photo);
for (const r of await read('ArticleTypes')) push('ArticleTypes', r.ArticleTypeID, r.Photo);
for (const r of await read('Services'))     push('Services', r.ServiceID, r.Photo);
for (const r of await read('Teams'))        push('Teams', r.TeamID, r.Photo);
for (const r of await read('Abouts'))       push('Abouts', r.AboutID, r.Photo);

console.log(`資料庫引用 ${expected.length} 個檔案\n`);

let failures = 0;
const fail = (msg) => { console.log(`  ❌ ${msg}`); failures++; };

// ── 1. 檔名格式 ───────────────────────────────────────
console.log('檔名格式（R2 路由的 regex 會拒絕不合的）');
const badFormat = expected.filter((e) => !PHOTO_RE.test(e.photo));
badFormat.length ? badFormat.forEach((e) => fail(`${e.key} 不符 yyyyMMddHHmmss.ext`))
                 : console.log('  ✓ 全部符合 yyyyMMddHHmmss.ext');

// ── 2. 每個 D1 引用都在 R2 找得到，且位元組數相符 ──────
// wrangler 沒有 object list / head，只能整個抓下來比對。遠端等於要下載 40 MB，
// 而每次呼叫都要付一次 npx + node 的啟動成本 —— 所以併發跑，並即時輸出進度。
console.log(`\nD1 → R2（${REMOTE ? 'remote，需下載約 40 MB' : 'local'}）`);

const CONCURRENCY = REMOTE ? 4 : 8;
let done = 0;

async function checkOne(e) {
  const srcSize = (await stat(`${SRC_DIR}/${e.entity}/${e.id}/${e.photo}`)).size;
  try {
    const { stdout } = await execFileAsync('npx', [
      'wrangler', 'r2', 'object', 'get', `${BUCKET}/${e.key}`,
      '--pipe', REMOTE ? '--remote' : '--local',
    ], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    if (stdout.length !== srcSize) {
      return `${e.key} 位元組數不符（R2 ${stdout.length} / 來源 ${srcSize}）`;
    }
  } catch (err) {
    return `${e.key} 在 R2 取不到 — ${err.stderr?.toString().trim().split('\n').pop() ?? err.message}`;
  } finally {
    done++;
    process.stdout.write(`\r  ${done}/${expected.length} …`);
  }
  return null;
}

const queue = [...expected];
const errors = [];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) {
    const err = await checkOne(queue.shift());
    if (err) errors.push(err);
  }
}));
process.stdout.write('\r');
errors.forEach(fail);
if (!errors.length) console.log(`  ✓ ${expected.length} 個全部存在且位元組數相符`);

// ── 3. 大圖警告 ───────────────────────────────────────
// 不是失敗 —— 前台的 markup 已凍結，改不了。但值得知道。
console.log('\n檔案大小');
const sizes = [];
for (const e of expected) {
  try { sizes.push({ key: e.key, size: (await stat(`${SRC_DIR}/${e.entity}/${e.id}/${e.photo}`)).size }); } catch {}
}
const huge = sizes.filter((s) => s.size > 2 * 1024 * 1024).sort((a, b) => b.size - a.size);
console.log(`  總計 ${(sizes.reduce((s, x) => s + x.size, 0) / 1024 / 1024).toFixed(1)} MB`);
if (huge.length) {
  console.log(`  ⚠️  ${huge.length} 個超過 2 MB（前台會直接送出原圖，markup 已凍結無法改）：`);
  for (const h of huge) console.log(`       ${(h.size / 1024 / 1024).toFixed(1)} MB  ${h.key}`);
}

console.log(failures === 0 ? '\n✅ 全部通過' : `\n❌ ${failures} 項未通過`);
process.exit(failures === 0 ? 0 : 1);
