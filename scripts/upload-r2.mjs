#!/usr/bin/env node
/**
 * 把 Upload/ 底下的圖片放進 R2。
 *
 *   node scripts/upload-r2.mjs --local
 *   node scripts/upload-r2.mjs --remote
 *
 * R2 key 與舊系統的實體路徑逐字相同（Upload/{Entity}/{ID}/{Photo}），
 * 這樣遷移是純複製、「這張圖在不在」一行指令就能回答、回退也不用轉換 key。
 * 見 docs/10-decisions.md ADR-007
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, relative, join } from 'node:path';

const execFileAsync = promisify(execFile);

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (flag) => process.argv.includes(flag);

const DIR = resolve(arg('--dir', 'reference/old/Gleanstudio/Upload'));
const BUCKET = arg('--bucket', 'gleanstudio-media');
const REMOTE = has('--remote');
const IN = resolve('data/export');

const CONTENT_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp',
};

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(p));
    else if (entry.isFile() && !entry.name.startsWith('.')) out.push(p);
  }
  return out;
}

/** 資料庫實際引用到的 key —— 用來標記哪些是孤兒檔。 */
async function referencedKeys() {
  const read = async (n) => JSON.parse(await readFile(`${IN}/${n}.json`, 'utf8'));
  const keys = new Set();
  const add = (entity, id, photo) => photo && keys.add(`Upload/${entity}/${String(id).toLowerCase()}/${photo}`);

  for (const r of await read('Articles'))     add('Articles', r.ArticleID, r.Photo);
  for (const r of await read('ArticleTypes')) add('ArticleTypes', r.ArticleTypeID, r.Photo);
  for (const r of await read('Services'))     add('Services', r.ServiceID, r.Photo);
  for (const r of await read('Teams'))        add('Teams', r.TeamID, r.Photo);
  for (const r of await read('Abouts'))       add('Abouts', r.AboutID, r.Photo);
  return keys;
}

const files = (await walk(DIR)).sort();
const referenced = await referencedKeys();

console.log(`來源  ${DIR}`);
console.log(`目標  ${BUCKET}（${REMOTE ? 'remote' : 'local'}）`);
console.log(`檔案  ${files.length} 個\n`);

let uploaded = 0, orphans = 0, failed = 0;

for (const file of files) {
  // key 就是相對於 Upload 父目錄的路徑，大小寫比照舊系統的實體路徑，
  // 但 ID 段一律小寫（GUID 慣例，見 CLAUDE.md）
  const rel = relative(DIR, file);
  const [entity, id, photo] = rel.split('/');
  const key = `Upload/${entity}/${id.toLowerCase()}/${photo}`;

  const ext = photo.split('.').pop().toLowerCase();
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) {
    console.warn(`  ⚠️  略過（未知副檔名 .${ext}）  ${rel}`);
    continue;
  }

  const isOrphan = !referenced.has(key);
  const size = (await stat(file)).size;

  try {
    await execFileAsync('npx', [
      'wrangler', 'r2', 'object', 'put', `${BUCKET}/${key}`,
      '--file', file,
      '--content-type', contentType,
      '--cache-control', 'public, max-age=31536000, immutable',
      REMOTE ? '--remote' : '--local',
    ], { maxBuffer: 16 * 1024 * 1024 });
    uploaded++;
    if (isOrphan) orphans++;
    console.log(`  ✓ ${String((size / 1024).toFixed(0)).padStart(5)} KB  ${key}${isOrphan ? '   ← 孤兒檔' : ''}`);
  } catch (e) {
    failed++;
    console.error(`  ❌ ${key}\n     ${e.stderr?.toString().trim().split('\n').slice(-2).join(' ') ?? e.message}`);
  }
}

console.log(`\n上傳 ${uploaded} / ${files.length}，其中孤兒檔 ${orphans} 個（DB 沒有引用，仍一併保留）`);
if (failed) { console.error(`❌ ${failed} 個失敗`); process.exit(1); }
