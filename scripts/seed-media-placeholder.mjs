#!/usr/bin/env node
/**
 * 在**本機** R2 放佔位圖 —— 只給 CI 用。
 *
 *   node scripts/seed-media-placeholder.mjs
 *
 * 為什麼要有這支：真正的圖片在 reference/old/Gleanstudio/Upload（gitignored），
 * CI 上根本沒有，所以 `npm run media:upload` 在 CI 跑不了，R2 是空的。
 * 於是 `npm run verify:url-case` 的「上傳的圖片」那一組**連正規大小寫都 404**，
 * 三項全紅 —— 紅的不是大小寫處理，是根本沒有那個物件。
 *
 * 大小寫這件事只有在 Linux 上驗才算數（見 CLAUDE.md），所以正確的修法是讓 CI
 * 真的有物件可以打，而不是讓檢查跳過。key 從版控裡的 data/export/*.json 推導，
 * 與 upload-r2.mjs / verify-media.mjs 用的是同一組規則。
 *
 * ⚠️ 這裡放的是 1×1 的佔位圖，**不是**真的內容 —— 位元組數與畫面都不對。
 *    所以 CI 不跑 verify:media（它比位元組數，本來就需要來源檔）。
 *    永遠不要對遠端用這支；`--remote` 直接拒絕。
 */
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const execFileAsync = promisify(execFile);

if (process.argv.includes('--remote')) {
  console.error('❌ 這支只寫本機 R2 —— 佔位圖絕不能蓋掉正式站的圖片');
  process.exit(1);
}

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BUCKET = arg('--bucket', 'gleanstudio-media');
const IN = resolve('data/export');

// 1×1 的最小合法檔案。副檔名對不上的就跳過並出聲 —— 現有資料全是 .jpg。
const PLACEHOLDER = {
  jpg:  ['image/jpeg', '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='],
  png:  ['image/png',  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='],
};
PLACEHOLDER.jpeg = PLACEHOLDER.jpg;

const read = async (n) => JSON.parse(await readFile(`${IN}/${n}.json`, 'utf8'));

const keys = new Set();
const add = (entity, id, photo) => photo && keys.add(`Upload/${entity}/${String(id).toLowerCase()}/${photo}`);
for (const r of await read('Articles'))     add('Articles', r.ArticleID, r.Photo);
for (const r of await read('ArticleTypes')) add('ArticleTypes', r.ArticleTypeID, r.Photo);
for (const r of await read('Services'))     add('Services', r.ServiceID, r.Photo);
for (const r of await read('Teams'))        add('Teams', r.TeamID, r.Photo);
for (const r of await read('Abouts'))       add('Abouts', r.AboutID, r.Photo);

if (!keys.size) {
  console.error('❌ data/export/*.json 裡一個 Photo 都沒有 —— 匯出資料是不是沒進版控？');
  process.exit(1);
}

const dir = await mkdtemp(join(tmpdir(), 'gs-placeholder-'));
const filePath = {};
for (const [ext, [, b64]] of Object.entries(PLACEHOLDER)) {
  filePath[ext] = join(dir, `placeholder.${ext}`);
  await writeFile(filePath[ext], Buffer.from(b64, 'base64'));
}

console.log(`佔位圖 → ${BUCKET}（local），共 ${keys.size} 個 key\n`);

let ok = 0, failed = 0;
for (const key of [...keys].sort()) {
  const ext = key.split('.').pop().toLowerCase();
  if (!PLACEHOLDER[ext]) { console.warn(`  ⚠️  略過（沒有 .${ext} 的佔位圖）  ${key}`); continue; }

  try {
    await execFileAsync('npx', [
      'wrangler', 'r2', 'object', 'put', `${BUCKET}/${key}`,
      '--file', filePath[ext],
      '--content-type', PLACEHOLDER[ext][0],
      '--cache-control', 'public, max-age=31536000, immutable',
      '--local',
    ]);
    ok++;
    console.log(`  ✓ ${key}`);
  } catch (e) {
    failed++;
    console.error(`  ❌ ${key}\n     ${e.stderr?.toString().trim().split('\n').slice(-2).join(' ') ?? e.message}`);
  }
}

console.log(`\n${failed ? `❌ ${failed} 個失敗（成功 ${ok}）` : `✅ ${ok} 個 key 都放好了`}`);
process.exit(failed ? 1 : 0);
