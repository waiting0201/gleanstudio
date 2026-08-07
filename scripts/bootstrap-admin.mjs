#!/usr/bin/env node
/**
 * 建立或提升一個管理者帳號。取代舊系統寫死的 weypro 後門
 * （docs/06-admin-spec.md §4）。
 *
 *   node scripts/bootstrap-admin.mjs --username tim --name 提姆 --super
 *   ADMIN_PASSWORD=… node scripts/bootstrap-admin.mjs --username ci --name CI --super --no-force-change
 *
 * 密碼從 stdin 讀，或從 ADMIN_PASSWORD 環境變數讀（給 CI 用）。
 * **絕對不從命令列參數讀** —— 那會進 shell history 與行程列表。
 * 只寫入雜湊，明碼不落地。
 */
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (flag) => process.argv.includes(flag);

const REMOTE = has('--remote');
const username = arg('--username');
const name = arg('--name', username);
const email = arg('--email');
const isSuper = has('--super') ? 1 : 0;
/**
 * `--lims 3,4,5,6,8,9` 直接授予這些 Lims 的全部動作。
 * CI 用它重現正式資料的權限形狀 —— **刻意不給 7（Teams）**，
 * 因為 smoke:admin 會斷言那個區塊被擋（docs/09-known-issues.md 3.3）。
 */
const limIds = (arg('--lims') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
// CI 建的帳號要能直接登入跑測試，不要卡在強制換密碼
const mustChange = has('--no-force-change') ? 0 : 1;

if (!username) {
  console.error('用法：node scripts/bootstrap-admin.mjs --username <帳號> [--name <姓名>] [--super] [--remote]');
  process.exit(1);
}

/**
 * 密碼長度下限。**1 = 只擋空字串**（2026-08-07 拿掉原本的 12 字元下限）。
 *
 * ⚠️ 這是 `src/lib/auth/password.ts` 那個 `MIN_PASSWORD_LENGTH` 的副本 ——
 *    這支是純 node 腳本，import 不到 TS 模組。兩邊要一起改。
 */
const MIN_PASSWORD_LENGTH = 1;

let password = process.env.ADMIN_PASSWORD ?? '';
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const rule = MIN_PASSWORD_LENGTH > 1 ? `（至少 ${MIN_PASSWORD_LENGTH} 個字元）` : '';
  password = await rl.question(`「${username}」的密碼${rule}：`);
  rl.close();
}
if (password.length < MIN_PASSWORD_LENGTH) {
  console.error(MIN_PASSWORD_LENGTH > 1 ? `❌ 密碼至少要 ${MIN_PASSWORD_LENGTH} 個字元。` : '❌ 密碼不能是空的。');
  process.exit(1);
}

// ── PBKDF2，與 src/lib/auth/password.ts 同一組參數 ──
const ITERATIONS = 100_000;
const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, key, 256);
const b64 = (b) => Buffer.from(b).toString('base64');
const hash = `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(bits)}`;

const q = (v) => (v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const now = new Date().toISOString();

// 帳號已存在就更新（提升權限 / 重設密碼），不存在就新建
const sql = `
INSERT INTO Admins (Name, Username, PasswordHash, Email, IsSuperAdmin, MustChangePassword, CreatedAt)
VALUES (${q(name)}, ${q(username)}, ${q(hash)}, ${q(email)}, ${isSuper}, ${mustChange}, ${q(now)})
ON CONFLICT(Username) DO UPDATE SET
  Name = excluded.Name, PasswordHash = excluded.PasswordHash, Email = excluded.Email,
  IsSuperAdmin = excluded.IsSuperAdmin, MustChangePassword = excluded.MustChangePassword,
  UpdatedAt = ${q(now)};
`.trim();

const run = (statement) => execFileSync('npx', [
  'wrangler', 'd1', 'execute', 'gleanstudio', REMOTE ? '--remote' : '--local', '--command', statement,
], { stdio: ['ignore', 'ignore', 'inherit'] });

run(sql);

if (limIds.length) {
  const rows = limIds.map((id) =>
    `(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) ||`
    + ` '-a' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),`
    + ` (SELECT AdminID FROM Admins WHERE Username = ${q(username)}), ${Number(id)}, 1, 1, 1)`).join(',\n  ');
  run(`DELETE FROM AdminLims WHERE AdminID = (SELECT AdminID FROM Admins WHERE Username = ${q(username)});`);
  run(`INSERT INTO AdminLims (AdminLimID, AdminID, LimID, IsAdd, IsUpdate, IsDelete) VALUES\n  ${rows};`);
}

console.log(`✅ ${REMOTE ? '遠端' : '本機'}：${username}${isSuper ? '（超級使用者）' : ''}`);
console.log(`   MustChangePassword = ${mustChange}`);
if (limIds.length) console.log(`   權限：LimID ${limIds.join(', ')}（全部動作）`);
console.log('   密碼只以 PBKDF2 雜湊寫入，明碼沒有落地。');
