#!/usr/bin/env node
/**
 * 部署前的守門：檢查 `astro build` 產生的 Worker 設定綁到了正確的資源。
 *
 *   node scripts/check-deploy-config.mjs --expect preview
 *   node scripts/check-deploy-config.mjs --expect production
 *
 * ⚠️ 這支存在的理由是一個**靜默**的失敗模式：
 *
 * `@astrojs/cloudflare` 會把 wrangler.jsonc 攤平成 dist/server/wrangler.json，
 * 而且**不保留 `env` 區塊**。所以 `wrangler deploy --env preview` 不會報錯 ——
 * 它找不到那個環境，就直接退回頂層綁定，於是 PR 的 preview 部署會寫進
 * **正式的** D1 與 R2。
 *
 * 正確做法是 build 時給 `CLOUDFLARE_ENV=preview`，adapter 會解析出對應環境
 * （連 worker 名稱都會變成 gleanstudio-preview），部署時**不要**再加 --env。
 * 這支腳本就是確認那件事真的發生了。
 */
import { readFile } from 'node:fs/promises';

const i = process.argv.indexOf('--expect');
const expect = i !== -1 ? process.argv[i + 1] : null;
if (!['preview', 'production'].includes(expect)) {
  console.error('用法：node scripts/check-deploy-config.mjs --expect preview|production');
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
  console.error('   build 時要給 CLOUDFLARE_ENV=' + expect + '，而且部署指令**不要**加 --env。');
  console.error('   見 docs/07-deployment.md §2');
  process.exit(1);
}
console.log('\n✅ 綁定正確');
