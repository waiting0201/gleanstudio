#!/usr/bin/env node
/**
 * 驗證 D1 的內容與 data/export 的匯出結果一致。
 *
 *   node scripts/verify-d1.mjs            # 本機
 *   node scripts/verify-d1.mjs --remote
 *
 * 本機直接讀 miniflare 的 sqlite 檔（快，且不受 wrangler 輸出格式變動影響）；
 * 遠端只能走 wrangler d1 execute --json。
 *
 * ⚠️ 不要用 SQLite 的 LENGTH() 跟 JS 的 .length 比長度來判斷內容是否完整。
 *    LENGTH() 數的是 code point，JS .length 數的是 UTF-16 單位 —— 內文裡只要
 *    有一個 BMP 外的字元（例如 🔗），兩者就會差 1，看起來像資料損壞其實不是。
 *    要比就比整個字串或它的雜湊。
 */
import { readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const REMOTE = process.argv.includes('--remote');
/**
 * `--no-accounts` 跳過 Admins / AdminLims 的列數對照。
 * CI 的資料庫是用 `build-seed-sql.mjs --no-accounts` 灌的 —— 帳號資料不進版控
 * （Admins.json 有舊系統的明碼密碼），帳號由 bootstrap-admin.mjs 現場建。
 * 見 docs/07-deployment.md §2
 */
const NO_ACCOUNTS = process.argv.includes('--no-accounts');
const ACCOUNT_TABLES = new Set(['Admins', 'AdminLims']);
const D1_DIR = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
const IN = resolve('data/export');

let query;
if (REMOTE) {
  query = (q) => {
    const out = execFileSync('npx',
      ['wrangler', 'd1', 'execute', 'gleanstudio', '--remote', '--json', '--command', q],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out)[0].results;
  };
} else {
  /**
   * ⚠️ 不要用「目錄裡第一個 .sqlite」。
   *
   * miniflare 的檔名是內部雜湊，而只要用 `CLOUDFLARE_ENV=preview` build 過一次，
   * 這個目錄就會多出第二個（空的）資料庫 —— 然後這支腳本會挑到它，
   * 報出「no such table: Lims」這種看起來像資料損壞、其實是挑錯檔的錯誤。
   *
   * 改成挑**真的有 schema 的那一個**，多於一個就報錯不猜。
   */
  const explicit = process.argv.indexOf('--db');
  const candidates = explicit !== -1
    ? [process.argv[explicit + 1]]
    : readdirSync(D1_DIR)
        .filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')
        .map((f) => `${D1_DIR}/${f}`);

  const hasSchema = (file) => {
    try {
      const o = execFileSync('sqlite3', ['-json', file,
        "SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='Lims'"],
        { encoding: 'utf8' }).trim();
      return o ? JSON.parse(o)[0].c === 1 : false;
    } catch { return false; }
  };

  const usable = candidates.filter(hasSchema);
  if (usable.length === 0) {
    console.error('找不到已套用 migration 的本機 D1。先跑 npm run db:migrate');
    if (candidates.length) console.error(`  （看到 ${candidates.length} 個 .sqlite，但都沒有 Lims 表）`);
    process.exit(1);
  }
  if (usable.length > 1) {
    console.error('本機有多個 D1 資料庫，不猜是哪一個：');
    for (const f of usable) console.error(`  ${f}`);
    console.error('用 --db <路徑> 指定，或刪掉不用的（通常是 CLOUDFLARE_ENV=preview build 留下的）。');
    process.exit(1);
  }

  const dbFile = usable[0];
  query = (q) => {
    const o = execFileSync('sqlite3', ['-json', dbFile, q],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim();
    return o ? JSON.parse(o) : [];
  };
}

console.log(`目標：${REMOTE ? 'remote D1' : 'local D1'}\n`);

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '❌'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

// ── 1. 列數 ───────────────────────────────────────────
console.log('列數對照 data/export/manifest.json');
const manifest = JSON.parse(await readFile(`${IN}/manifest.json`, 'utf8'));
for (const [table, meta] of Object.entries(manifest.files)) {
  if (NO_ACCOUNTS && ACCOUNT_TABLES.has(table)) {
    console.log(`  – ${table.padEnd(14)} 略過（--no-accounts）`);
    continue;
  }
  const n = query(`SELECT COUNT(*) c FROM ${table}`)[0].c;
  check(table.padEnd(14), n === meta.rows, `D1 ${String(n).padStart(3)} / 匯出 ${String(meta.rows).padStart(3)}`);
}

// ── 2. LegacyOrder 與正式站觀察到的顯示順序一致 ────────
console.log('\n文章排序（LegacyOrder）');
const legacyFile = JSON.parse(await readFile(`${IN}/legacy-order.json`, 'utf8'));
const legacy = legacyFile.order;
const ordered = query('SELECT ArticleID FROM Articles ORDER BY CreateDate DESC, LegacyOrder').map((r) => r.ArticleID);
const expected = Object.keys(legacy);
check('順序與正式站相同', JSON.stringify(ordered) === JSON.stringify(expected));
if (JSON.stringify(ordered) !== JSON.stringify(expected)) {
  expected.forEach((id, i) => {
    if (ordered[i] !== id) console.log(`      #${i + 1} 期望 ${id.slice(0, 8)} 實得 ${(ordered[i] ?? '—').slice(0, 8)}`);
  });
}

// 分類篩選後是另一套順序 —— 舊站兩種查詢對並列列的輸出不一致，
// 兩種順序都是凍結的契約。見 docs/04-data-model.md §5
console.log('\n文章排序（LegacyTypeOrder，依分類篩選）');
const typeOrder = legacyFile.typeOrder;
for (const typeId of [...new Set(query('SELECT DISTINCT ArticleTypeID t FROM Articles').map((r) => r.t))]) {
  const got = query(
    `SELECT ArticleID FROM Articles WHERE ArticleTypeID = '${typeId}' ORDER BY CreateDate DESC, LegacyTypeOrder`,
  ).map((r) => r.ArticleID);
  const want = Object.entries(typeOrder)
    .filter(([id]) => got.includes(id))
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => id);
  check(typeId.slice(0, 8), JSON.stringify(got) === JSON.stringify(want), `${got.length} 篇`);
}

/**
 * ⚠️ 只驗「排出來的順序對不對」是不夠的。
 *
 * 實測過一個真實情境：遠端資料庫套了 migration 但**沒有跑補值**，
 * LegacyTypeOrder 整欄都是 0，而 SQLite 對並列列的處理**碰巧**給出正確順序 ——
 * 上面那個檢查於是對一個半套的資料庫按了綠燈。
 *
 * 巧合不是保證，這正是 ADR-012 一開始就拒絕依賴的東西。
 * 所以這裡直接驗「值本身有沒有被填」：產生器給的就是 1..N，少一個都不行。
 */
console.log('\n順序欄位的值');
const ranks = (rows, col) => rows.map((r) => r[col]).sort((a, b) => a - b);
const isOneToN = (v) => v.every((n, i) => n === i + 1);

const artRanks = ranks(query('SELECT LegacyOrder FROM Articles'), 'LegacyOrder');
check('Articles.LegacyOrder 是 1..N', isOneToN(artRanks), `${artRanks.length} 筆`);

for (const typeId of [...new Set(query('SELECT DISTINCT ArticleTypeID t FROM Articles').map((r) => r.t))]) {
  const v = ranks(query(`SELECT LegacyTypeOrder FROM Articles WHERE ArticleTypeID = '${typeId}'`), 'LegacyTypeOrder');
  check(`${typeId.slice(0, 8)} 的 LegacyTypeOrder 是 1..N`, isOneToN(v), `${v.length} 篇`);
}

const projRanks = ranks(query('SELECT LegacyOrder FROM Projects'), 'LegacyOrder');
check('Projects.LegacyOrder 是 1..N', isOneToN(projRanks), `${projRanks.length} 筆`);

// ── 3. 富文本完整性（UTF-8 中文 + HTML 經 JSON 再經 SQL 字面值）──
// 逐字比對，不比長度 —— 理由見檔頭的 LENGTH() 警告
console.log('\n富文本完整性');
const srcArticles = JSON.parse(await readFile(`${IN}/Articles.json`, 'utf8'));
const remoteArticles = query('SELECT ArticleID, Description FROM Articles');
const mismatched = srcArticles.filter((src) => {
  const got = remoteArticles.find((r) => r.ArticleID === src.ArticleID);
  return !got || got.Description !== src.Description;
});
check(`${srcArticles.length} 篇 Description 逐字相符`, mismatched.length === 0);
for (const m of mismatched) {
  const got = remoteArticles.find((r) => r.ArticleID === m.ArticleID);
  console.log(`      ${m.ArticleID.slice(0, 8)}  來源 ${m.Description.length} 字元 / D1 ${got ? got.Description.length : '不存在'}`);
}

// 抽驗一筆一定含中文的欄位
const about = query('SELECT Description FROM Abouts WHERE AboutID = 1')[0];
const srcAbout = JSON.parse(await readFile(`${IN}/Abouts.json`, 'utf8'))[0];
check('Abouts.Description 逐字相符', about.Description === srcAbout.Description);
check('Abouts.Description 含中文', /[一-鿿]/.test(about.Description ?? ''));

const types = query('SELECT ArticleTypeID, Title, BgClass FROM ArticleTypes ORDER BY Sort');
check('ArticleTypes 標題為中文', types.every((t) => /[一-鿿]/.test(t.Title)),
  types.map((t) => t.Title).join('、'));
check('BgClass 值正確', types.every((t) => ['r-bg-primary', 'r-bg-secondary', 'r-bg-third'].includes(t.BgClass)));

// ── 4. 安全性 ─────────────────────────────────────────
console.log('\n安全性');
const cols = query("SELECT name FROM pragma_table_info('Admins')").map((r) => r.name);
check('Admins 沒有明碼 Password 欄位', !cols.includes('Password'));
const admins = query('SELECT AdminID, Username, PasswordHash, MustChangePassword, IsSuperAdmin FROM Admins');
check('PasswordHash 格式為 pbkdf2$100000$…', admins.every((a) => /^pbkdf2\$100000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(a.PasswordHash)));
check('全部 MustChangePassword = 1', admins.every((a) => a.MustChangePassword === 1));
check('沒有 AdminID 888 的後門帳號', !admins.some((a) => a.AdminID === 888));
check('沒有 weypro 帳號', !admins.some((a) => a.Username === 'weypro'));

// ── 5. GUID 正規化 ────────────────────────────────────
// 逐欄分開查 —— 遠端 D1 對 compound SELECT 的項數限制比本機 sqlite3 嚴，
// 六個 UNION ALL 會被拒（SQLITE_ERROR 7500 "too many terms in compound SELECT"）
console.log('\nGUID 正規化');
const GUID_COLS = [
  ['Articles', 'ArticleID'], ['Articles', 'ArticleTypeID'],
  ['ArticleTypes', 'ArticleTypeID'], ['Services', 'ServiceID'],
  ['Teams', 'TeamID'], ['Projects', 'ProjectID'], ['AdminLims', 'AdminLimID'],
];
let badGuid = 0;
for (const [t, c] of GUID_COLS) {
  badGuid += query(`SELECT COUNT(*) c FROM ${t} WHERE ${c} <> LOWER(${c})`)[0].c;
}
check('全部 GUID 為小寫', badGuid === 0, badGuid ? `${badGuid} 筆不合` : `檢查 ${GUID_COLS.length} 個欄位`);

// ── 6. schema 約束確實生效 ────────────────────────────
console.log('\nschema 約束');
const strict = query("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND sql LIKE '%STRICT%'")[0].c;
check('9 張表都是 STRICT', strict === 9, `${strict}/9`);
const idx = query("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' OR name LIKE 'uq_%'")[0].c;
check('自訂索引已建立', idx >= 11, `${idx} 個`);

console.log(failures === 0 ? '\n✅ 全部通過' : `\n❌ ${failures} 項未通過`);
process.exit(failures === 0 ? 0 : 1);
