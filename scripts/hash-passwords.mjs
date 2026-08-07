#!/usr/bin/env node
/**
 * 把匯出資料裡的明碼 Admins.Password 轉成 PBKDF2 雜湊。
 *
 * 演算法與參數受 Workers 免費方案限制 —— 見 docs/06-admin-spec.md §3。
 * 這裡用 node:crypto 的 pbkdf2，與 Workers 上的 Web Crypto PBKDF2 產出相同結果
 * （同樣是 PBKDF2-HMAC-SHA256），所以驗證端可以直接用 Web Crypto 比對。
 *
 *   node scripts/hash-passwords.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';
import { pbkdf2, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const pbkdf2Async = promisify(pbkdf2);

// Workers 對 PBKDF2 迭代數的硬上限就是 100,000（workerd#1346）。
// 低於 OWASP 建議的 600,000，原因與升級路徑見 docs/09-known-issues.md 3.4
export const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

export async function hashPassword(plain, salt = randomBytes(SALT_BYTES)) {
  const derived = await pbkdf2Async(plain, salt, ITERATIONS, KEY_BYTES, 'sha256');
  return `pbkdf2$${ITERATIONS}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dir = resolve(arg('--dir', 'data/export'));
const admins = JSON.parse(await readFile(`${dir}/Admins.json`, 'utf8'));

const out = {};
for (const a of admins) {
  if (!a.Password) {
    console.error(`❌ AdminID ${a.AdminID} (${a.Username}) 沒有密碼，無法雜湊`);
    process.exit(1);
  }
  out[a.AdminID] = {
    username: a.Username,
    passwordHash: await hashPassword(a.Password),
    // 舊密碼是 nvarchar(20) 明碼，存在一個帳密曾經進過版控的資料庫裡 ——
    // 必須視為已洩漏。強制首次登入改密碼，見 docs/05-migration-runbook.md §4
    mustChangePassword: 1,
  };
  console.log(`  AdminID ${String(a.AdminID).padStart(3)}  ${a.Username.padEnd(16)} → pbkdf2$${ITERATIONS}$…`);
}

await writeFile(`${dir}/admin-hashes.json`, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`\n${Object.keys(out).length} 筆 → ${dir}/admin-hashes.json（gitignored）`);
console.log('全部設 MustChangePassword = 1');
