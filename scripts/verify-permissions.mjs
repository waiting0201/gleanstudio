#!/usr/bin/env node
/**
 * 權限註冊表的斷言 —— 每一個 ROUTE_PERMISSIONS 項目都必須**恰好**解析到一個 LimID。
 *
 *   node scripts/verify-permissions.mjs [--remote]
 *
 * 這把舊系統默默容忍的歧義變成一個大聲、可修的錯誤。
 * 舊做法用 `Key.Contains(...)` 子字串比對 —— 任何 Key 是另一個 Key 的子字串就會
 * 靜默授予錯誤權限。以目前 9 筆 Lims 而言碰巧安全，但那是運氣，不是設計。
 *
 * 見 docs/06-admin-spec.md §5
 */
import { execFileSync } from 'node:child_process';
import { ROUTE_PERMISSIONS } from '../src/lib/auth/permissions.ts';

const REMOTE = process.argv.includes('--remote');

function query(sql) {
  const out = execFileSync('npx', [
    'wrangler', 'd1', 'execute', 'gleanstudio', REMOTE ? '--remote' : '--local',
    '--json', '--command', sql,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out)[0].results;
}

console.log(`目標：${REMOTE ? 'remote D1' : 'local D1'}\n`);

const lims = query('SELECT LimID, "Key", ParentID FROM Lims');
const roots = new Map(lims.filter((l) => l.ParentID === null).map((l) => [l.Key, l.LimID]));

let failed = 0;
const seen = new Map();

for (const [route, perm] of Object.entries(ROUTE_PERMISSIONS)) {
  const rootId = roots.get(perm.parent);
  const matches = rootId === undefined
    ? []
    : lims.filter((l) => l.ParentID === rootId && l.Key === perm.child);

  if (matches.length !== 1) {
    failed++;
    console.log(`  ✗ ${route.padEnd(28)} ${perm.parent}/${perm.child} 解析到 ${matches.length} 筆（必須恰好 1 筆）`);
    continue;
  }
  seen.set(`${perm.parent}/${perm.child}`, matches[0].LimID);
}

// 反向：有 Lims 節點但註冊表完全沒提到 —— 代表有一塊後台沒被權限保護
const childKeys = lims.filter((l) => l.ParentID !== null);
for (const l of childKeys) {
  const parent = lims.find((p) => p.LimID === l.ParentID);
  const key = `${parent?.Key}/${l.Key}`;
  if (!seen.has(key)) {
    failed++;
    console.log(`  ✗ Lims ${key}（LimID ${l.LimID}）在 ROUTE_PERMISSIONS 裡沒有任何對應項目`);
  }
}

const routes = Object.keys(ROUTE_PERMISSIONS).length;
if (failed) {
  console.log(`\n❌ ${failed} 項不通過（共 ${routes} 個路由 / ${childKeys.length} 個 Lims 節點）`);
  process.exit(1);
}
console.log(`  ✓ ${routes} 個路由全部解析到唯一的 LimID`);
console.log(`  ✓ ${childKeys.length} 個 Lims 節點全部有對應的路由`);
console.log('\n✅ 權限註冊表與資料一致');
