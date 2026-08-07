#!/usr/bin/env node
/**
 * 部署前的守門：檢查 `astro build` 產生的 Worker 設定綁到了正確的資源。
 *
 *   node scripts/check-deploy-config.mjs --expect production
 *
 * 這個專案**只有一個環境**（wrangler.jsonc 沒有 env 區塊），所以這支主要在擋
 * 兩件事：資源名稱被改錯，以及還沒填的 placeholder（KV 的 SESSION 沒填就部署，
 * 整個 /backend/* 都會 500）。
 *
 * ⚠️ 日後若要加 preview 環境，先讀 docs/07-deployment.md §2：
 * `@astrojs/cloudflare` 攤平設定時**不保留 env 區塊**，`wrangler deploy --env preview`
 * 不會報錯，只會安靜地綁上正式資源。環境要在 build 時用 CLOUDFLARE_ENV 決定。
 */
import { readFile } from 'node:fs/promises';

const i = process.argv.indexOf('--expect');
const expect = i !== -1 ? process.argv[i + 1] : null;
if (!['preview', 'production'].includes(expect)) {
  console.error('用法：node scripts/check-deploy-config.mjs --expect production');
  process.exit(1);
}

const CONFIG = 'dist/server/wrangler.json';
let cfg;
try {
  cfg = JSON.parse(await readFile(CONFIG, 'utf8'));
} catch {
  console.error(`❌ 找不到 ${CONFIG} —— 先跑 astro build。`);
  process.exit(1);
}

const EXPECTED = {
  preview: { name: 'gleanstudio-preview', d1: 'gleanstudio-preview', r2: 'gleanstudio-media-preview' },
  production: { name: 'gleanstudio', d1: 'gleanstudio', r2: 'gleanstudio-media' },
}[expect];

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '❌'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};

console.log(`目標環境：${expect}\n`);

const d1 = cfg.d1_databases?.[0];
const r2 = cfg.r2_buckets?.[0];
const kv = cfg.kv_namespaces?.[0];

check('Worker 名稱', cfg.name === EXPECTED.name, `${cfg.name}（期望 ${EXPECTED.name}）`);
check('D1', d1?.database_name === EXPECTED.d1, `${d1?.database_name}（期望 ${EXPECTED.d1}）`);
check('R2', r2?.bucket_name === EXPECTED.r2, `${r2?.bucket_name}（期望 ${EXPECTED.r2}）`);

// placeholder 還在就代表資源根本還沒建
const placeholders = JSON.stringify(cfg).match(/PLACEHOLDER[^"]*/g) ?? [];
check('沒有未填的 placeholder', placeholders.length === 0,
  placeholders.length ? placeholders.join('、') : '');

check('KV 有綁', !!kv?.id, kv?.id ? '' : 'SESSION 沒有 id —— 後台 session 會直接壞掉');
check('assets 有綁', !!cfg.assets?.directory);
check('main 有指定', !!cfg.main);

if (failed) {
  console.error(`\n❌ ${failed} 項不通過，不要部署。`);
  if (placeholders.length) {
    console.error('   還有 placeholder 沒填 —— 對應的 Cloudflare 資源還沒建。');
    console.error('   KV：wrangler kv namespace create SESSION，再把 id 填進 wrangler.jsonc');
  }
  console.error('   見 docs/07-deployment.md §2');
  process.exit(1);
}
console.log('\n✅ 綁定正確');
