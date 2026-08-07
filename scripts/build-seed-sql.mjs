#!/usr/bin/env node
/**
 * 把 data/export/*.json 轉成 D1 可以吃的 seed SQL。
 *
 *   node scripts/build-seed-sql.mjs
 *
 * 三個 D1 特有的限制決定了這支腳本的形狀（docs/04-data-model.md §5a）：
 *   1. 單一 SQL 敘述上限 100 KB —— 7 篇文章的 Description 超過，必須分段
 *   2. 單列上限 2 MB —— 目前最大 1.73 MB，會檢查並警告
 *   3. 不接受 BEGIN TRANSACTION / COMMIT
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const IN = resolve(arg('--in', 'data/export'));
const OUT = resolve(arg('--out', 'db/seed/0001-data.sql'));

const CHUNK_BYTES = 80_000;      // 留 20 KB 給敘述本身，D1 上限 100 KB
const D1_ROW_LIMIT = 2_000_000;
const BATCH_ROWS = 200;

const q = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};

const read = async (name) => JSON.parse(await readFile(`${IN}/${name}.json`, 'utf8'));

/** 一般表：multi-VALUES 分批。 */
function insertRows(table, cols, rows) {
  const out = [];
  for (let i = 0; i < rows.length; i += BATCH_ROWS) {
    const batch = rows.slice(i, i + BATCH_ROWS);
    const values = batch.map((r) => `  (${cols.map((c) => q(r[c])).join(', ')})`).join(',\n');
    out.push(`INSERT INTO ${table} (${cols.join(', ')}) VALUES\n${values};`);
  }
  return out;
}

/**
 * Articles：Description 可能遠超過 100 KB 的敘述上限。
 * 先插入空字串，再一段一段 append 補完。
 *
 * 分段是在**跳脫後的字串**上切，這樣每段的實際 SQL 長度才可控；
 * 而且切點永遠落在完整的跳脫序列之間（'' 不會被切開），因為我們是先
 * 跳脫整串再依長度切，跳脫後的 '' 是兩個字元，切點若落在中間會壞掉 ——
 * 所以額外檢查切點，遇到落在 '' 中間就往前退一格。
 */
function insertArticles(rows, legacyOrder) {
  const cols = ['ArticleID', 'ArticleTypeID', 'Title', 'Photo', 'CreateDate', 'LegacyOrder'];
  const out = [];
  const warnings = [];

  for (const r of rows) {
    const order = legacyOrder[r.ArticleID];
    if (order === undefined) {
      throw new Error(
        `Articles ${r.ArticleID} 不在 legacy-order.json 裡。\n` +
        '排序資料來自 Phase 1 的 capture-golden.mjs —— 請先跑 npm run golden。\n' +
        '見 docs/04-data-model.md §5'
      );
    }
    if (r.Description.length > D1_ROW_LIMIT * 0.9) {
      warnings.push(`${r.ArticleID} 的 Description ${(r.Description.length / 1024 / 1024).toFixed(2)} MB，逼近 D1 的 2 MB 單列上限`);
    }

    const vals = cols.map((c) => (c === 'LegacyOrder' ? order : q(r[c])));
    out.push(`INSERT INTO Articles (${cols.join(', ')}, Description) VALUES\n  (${vals.join(', ')}, '');`);

    const escaped = String(r.Description).replace(/'/g, "''");
    let pos = 0;
    while (pos < escaped.length) {
      let end = Math.min(pos + CHUNK_BYTES, escaped.length);
      // 切點不可落在跳脫後的 '' 中間
      if (end < escaped.length) {
        let quotes = 0;
        for (let i = end - 1; i >= pos && escaped[i] === "'"; i--) quotes++;
        if (quotes % 2 === 1) end -= 1;
      }
      out.push(
        `UPDATE Articles SET Description = Description || '${escaped.slice(pos, end)}' ` +
        `WHERE ArticleID = ${q(r.ArticleID)};`
      );
      pos = end;
    }
  }
  return { statements: out, warnings };
}

// ── 組裝 ──────────────────────────────────────────────
const [lims, admins, adminLims, articleTypes, articles, services, teams, projects, abouts] =
  await Promise.all(['Lims', 'Admins', 'AdminLims', 'ArticleTypes', 'Articles', 'Services', 'Teams', 'Projects', 'Abouts'].map(read));

const hashes = JSON.parse(await readFile(`${IN}/admin-hashes.json`, 'utf8'));
const legacyOrder = JSON.parse(await readFile(`${IN}/legacy-order.json`, 'utf8')).order;

const adminRows = admins.map((a) => {
  const h = hashes[a.AdminID];
  if (!h) throw new Error(`AdminID ${a.AdminID} 沒有雜湊 —— 請先跑 scripts/hash-passwords.mjs`);
  return { ...a, PasswordHash: h.passwordHash, MustChangePassword: h.mustChangePassword, IsSuperAdmin: 0 };
});

const parts = [
  '-- 由 scripts/build-seed-sql.mjs 產生，不要手改。',
  '-- 插入順序依外鍵相依，見 docs/05-migration-runbook.md §3',
  '-- D1 會自己包交易，所以這裡不寫交易控制敘述。',
  '-- （連註解都不要提那兩個關鍵字 —— wrangler 的偵測器不理會註解，會誤判成',
  '--   「檔案含有多個交易」而整份拒絕。）',
  '',
];

const add = (title, stmts) => { parts.push(`-- ── ${title} ──`, ...stmts, ''); };

add('Lims', insertRows('Lims', ['LimID', '"Key"', 'Value', 'Icon', 'Sort', 'ParentID'],
  lims.map((r) => ({ ...r, '"Key"': r.Key }))));
add('Admins', insertRows('Admins', ['AdminID', 'Name', 'Username', 'PasswordHash', 'Email', 'IsSuperAdmin', 'MustChangePassword'], adminRows));
add('AdminLims', insertRows('AdminLims', ['AdminLimID', 'AdminID', 'LimID', 'IsAdd', 'IsUpdate', 'IsDelete'], adminLims));
add('ArticleTypes', insertRows('ArticleTypes', ['ArticleTypeID', 'Title', 'SubTitle', 'Summary', 'Description', 'BgClass', 'Photo', 'Sort'], articleTypes));

const art = insertArticles(articles, legacyOrder);
add(`Articles（${articles.length} 列，Description 分段 append）`, art.statements);

add('Services', insertRows('Services', ['ServiceID', 'ArticleTypeID', 'Title', 'Photo', 'Sort'], services));
add('Teams', insertRows('Teams', ['TeamID', 'Title', 'Summary', 'Name', 'EnName', 'Photo', 'Sort'], teams));
add('Projects', insertRows('Projects', ['ProjectID', 'Type', 'Place', 'Title', 'SubTitle', 'Sort'], projects));
add('Abouts', insertRows('Abouts', ['AboutID', 'Description', 'Photo'], abouts));

const sql = parts.join('\n');
await mkdir(resolve(OUT, '..'), { recursive: true });
await writeFile(OUT, sql, 'utf8');

// ── 自我檢查：沒有敘述超過 D1 上限 ────────────────────
const statements = sql.split(/;\s*$/m).filter((s) => s.trim() && !s.trim().startsWith('--'));
const tooLong = statements.filter((s) => Buffer.byteLength(s, 'utf8') > 100_000);

console.log(`${OUT}`);
console.log(`  敘述數      ${statements.length}`);
console.log(`  檔案大小    ${(Buffer.byteLength(sql, 'utf8') / 1024 / 1024).toFixed(2)} MB`);
console.log(`  最長敘述    ${(Math.max(...statements.map((s) => Buffer.byteLength(s, 'utf8'))) / 1024).toFixed(1)} KB（上限 100 KB）`);
if (tooLong.length) {
  console.error(`\n❌ 有 ${tooLong.length} 個敘述超過 D1 的 100 KB 上限`);
  process.exit(1);
}
console.log('  ✅ 全部敘述都在 D1 限制內');
for (const w of art.warnings) console.warn(`  ⚠️  ${w}`);
