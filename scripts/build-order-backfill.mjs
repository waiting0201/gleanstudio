#!/usr/bin/env node
/**
 * 產生「只有 UPDATE」的順序補值檔 → db/seed/0002-order-backfill.sql
 *
 *   npm run seed:order
 *
 * 用在**資料已經灌好、後來才加順序欄位**的資料庫上。`db:seed` 是純 INSERT，
 * 對已有資料的庫會直接撞主鍵；這一份只有 UPDATE，冪等，可以重複跑。
 *
 * 前提：db/migrations/0001 與 0002 已套用。
 * 值的來源見 docs/04-data-model.md §5 —— 兩份順序都只能從 oracle 取。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const IN = 'data/export';
const OUT = 'db/seed/0002-order-backfill.sql';

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

const legacy = JSON.parse(await readFile(`${IN}/legacy-order.json`, 'utf8'));
const projOrder = JSON.parse(await readFile(`${IN}/projects-order.json`, 'utf8')).order;
const projects = JSON.parse(await readFile(`${IN}/Projects.json`, 'utf8'));

const out = [
  '-- 由 scripts/build-order-backfill.mjs 產生，不要手改。',
  '-- 只有 UPDATE，冪等，可重複跑。前提：0001 與 0002 已套用。',
  '',
  '-- Articles.LegacyTypeOrder —— 依分類篩選後的顯示順序（每類各自 1..N）',
];

for (const [id, n] of Object.entries(legacy.typeOrder)) {
  out.push(`UPDATE Articles SET LegacyTypeOrder = ${n} WHERE ArticleID = ${q(id)};`);
}

out.push('', '-- Projects.LegacyOrder —— /Home/Project 的 <li> 顯示順序');
const missing = [];
for (const p of projects) {
  const key = `${p.Type}|${p.Place}|${p.Title}|${p.SubTitle ?? ''}`;
  const n = projOrder[key];
  if (n === undefined) { missing.push(key); continue; }
  out.push(`UPDATE Projects SET LegacyOrder = ${n} WHERE ProjectID = ${q(p.ProjectID)};`);
}
if (missing.length) {
  throw new Error(`${missing.length} 筆 Projects 沒有順序 —— 先跑 npm run order:derive\n  ${missing[0]}`);
}

await mkdir('db/seed', { recursive: true });
await writeFile(OUT, out.join('\n') + '\n', 'utf8');

console.log(`→ ${OUT}`);
console.log(`   Articles ${Object.keys(legacy.typeOrder).length} 筆、Projects ${projects.length} 筆`);
console.log('\n套用：');
console.log(`   npx wrangler d1 execute gleanstudio --remote --file=${OUT}`);
