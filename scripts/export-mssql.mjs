#!/usr/bin/env node
/**
 * 從 SQL Server 匯出 9 張表，正規化後寫成 JSON。
 *
 * 開發期間來源是本機 Docker 容器；Phase 8 切換前改指向正式站的 Azure SQL，
 * 只換連線字串，其餘不動。見 docs/05-migration-runbook.md
 *
 *   MSSQL_URL='mssql://sa:PASSWORD@localhost:1433/gleanstudio?encrypt=false&trustServerCertificate=true' \
 *     node scripts/export-mssql.mjs --out data/export
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import sql from 'mssql';

// ── 表定義 ────────────────────────────────────────────────
// guid/date 欄位要正規化；orderBy 決定輸出的決定性順序。
// content: 是否影響前台渲染 —— 只有 content 表參與 dataDigest，見 §dataDigest
const TABLES = [
  { name: 'Lims',         orderBy: 'LimID',         guid: [],                            date: [], content: false },
  { name: 'Admins',       orderBy: 'AdminID',       guid: [],                            date: [], content: false },
  { name: 'AdminLims',    orderBy: 'AdminLimID',    guid: ['AdminLimID'],                date: [], content: false },
  { name: 'ArticleTypes', orderBy: 'ArticleTypeID', guid: ['ArticleTypeID'],             date: [], content: true  },
  // 注意：這裡「不」產生排序用的序號。CreateDate 並列時的顯示順序無法從資料庫
  // 推導（SQL Server 的掃描順序實測與正式站輸出不符），必須從正式站的實際輸出
  // 取得 —— 由 capture-golden.mjs 寫進 legacy-order.json。見 docs/04-data-model.md §5
  { name: 'Articles',     orderBy: 'ArticleID',     guid: ['ArticleID','ArticleTypeID'], date: ['CreateDate'], content: true },
  { name: 'Services',     orderBy: 'ServiceID',     guid: ['ServiceID','ArticleTypeID'], date: [], content: true  },
  { name: 'Teams',        orderBy: 'TeamID',        guid: ['TeamID'],                    date: [], content: true  },
  { name: 'Projects',     orderBy: 'ProjectID',     guid: ['ProjectID'],                 date: [], content: true  },
  { name: 'Abouts',       orderBy: 'AboutID',       guid: [],                            date: [], content: true  },
];

const PHOTO_RE = /^\d{14}\.[A-Za-z0-9]+$/;

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function normalise(rows, { guid, date }) {
  return rows.map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      if (v === null || v === undefined) { out[k] = null; continue; }
      if (guid.includes(k)) { out[k] = String(v).toLowerCase(); continue; }
      if (date.includes(k)) { out[k] = new Date(v).toISOString(); continue; }
      if (typeof v === 'boolean') { out[k] = v ? 1 : 0; continue; }
      if (v instanceof Date) { out[k] = v.toISOString(); continue; }
      out[k] = v;
    }
    return out;
  });
}

/** 找出會讓匯入失敗或讓 parity 變成運氣的資料狀況。每一條都是一個決定，不是警告。 */
function findAnomalies(data) {
  const a = [];
  const dup = (rows, keyFn, kind) => {
    const seen = new Map();
    for (const r of rows) {
      const k = keyFn(r);
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    for (const [k, n] of seen) if (n > 1) a.push({ kind, key: k, count: n });
  };

  // /Home/Articles 是 ORDER BY CreateDate DESC，跨分類。所以影響列表順序的是
  // CreateDate 單獨並列，與 ArticleTypeID 無關 —— 這兩個檢查不能合併。
  dup(data.Articles, (r) => r.CreateDate, 'articles-duplicate-createdate');
  // 首頁是「每分類最新一篇」，那裡才需要看 (ArticleTypeID, CreateDate)
  dup(data.Articles, (r) => `${r.ArticleTypeID}|${r.CreateDate}`, 'articles-duplicate-type-createdate');
  // 新 schema 有 uq_admins_username
  dup(data.Admins, (r) => r.Username, 'admins-duplicate-username');
  // 新 schema 有 uq_lims_parent_key
  dup(data.Lims, (r) => `${r.ParentID ?? 'null'}|${r.Key}`, 'lims-duplicate-parent-key');

  // 首頁取「每分類最新一篇」；若最大 CreateDate 本身有並列，首頁選誰是未定義的
  const byType = new Map();
  for (const r of data.Articles) {
    const cur = byType.get(r.ArticleTypeID);
    if (!cur || r.CreateDate > cur.max) byType.set(r.ArticleTypeID, { max: r.CreateDate, n: 1 });
    else if (r.CreateDate === cur.max) cur.n += 1;
  }
  for (const [type, { max, n }] of byType) {
    if (n > 1) a.push({ kind: 'homepage-latest-tie', articleTypeId: type, createDate: max, count: n });
  }

  // 孤兒外鍵
  const typeIds = new Set(data.ArticleTypes.map((r) => r.ArticleTypeID));
  for (const r of data.Articles) if (!typeIds.has(r.ArticleTypeID)) a.push({ kind: 'orphan-fk', table: 'Articles', id: r.ArticleID });
  for (const r of data.Services) if (!typeIds.has(r.ArticleTypeID)) a.push({ kind: 'orphan-fk', table: 'Services', id: r.ServiceID });
  const limIds = new Set(data.Lims.map((r) => r.LimID));
  for (const r of data.AdminLims) if (!limIds.has(r.LimID)) a.push({ kind: 'orphan-fk', table: 'AdminLims', id: r.AdminLimID });

  // Photo 檔名格式 —— R2 路由的 regex 會拒絕不符的
  for (const t of ['ArticleTypes', 'Articles', 'Services', 'Teams', 'Abouts']) {
    for (const r of data[t]) {
      if (r.Photo && !PHOTO_RE.test(r.Photo)) a.push({ kind: 'photo-format', table: t, photo: r.Photo });
    }
  }
  return a;
}

const rawUrl = process.env.MSSQL_URL;
if (!rawUrl) {
  console.error('缺少 MSSQL_URL。範例：');
  console.error("  MSSQL_URL='mssql://sa:PASSWORD@localhost:1433/gleanstudio?encrypt=false'");
  console.error('  （密碼中的特殊字元請用 percent-encoding，例如 @ → %40）');
  process.exit(1);
}

// 自己解析而不是交給 mssql 的連線字串解析器 —— 後者對密碼中 percent-encoded
// 的特殊字元處理不可靠，會丟出誤導性的 "config.server is required"。
const u = new URL(rawUrl);
const flag = (name, dflt) => {
  const v = u.searchParams.get(name);
  return v === null ? dflt : v !== 'false';
};
const config = {
  server: u.hostname,
  port: u.port ? Number(u.port) : 1433,
  user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password),
  database: decodeURIComponent(u.pathname.replace(/^\//, '')),
  options: {
    encrypt: flag('encrypt', true),
    trustServerCertificate: flag('trustServerCertificate', true),
  },
  requestTimeout: 60_000,
};

const outDir = resolve(arg('--out', 'data/export'));
await mkdir(outDir, { recursive: true });

const pool = await sql.connect(config);
const data = {};
const files = {};

for (const t of TABLES) {
  const query = t.select ?? `SELECT * FROM [${t.name}]`;
  const result = await pool.request().query(query);
  const rows = normalise(result.recordset, t)
    .sort((a, b) => (a[t.orderBy] > b[t.orderBy] ? 1 : a[t.orderBy] < b[t.orderBy] ? -1 : 0));

  data[t.name] = rows;
  const json = JSON.stringify(rows, null, 2) + '\n';
  await writeFile(`${outDir}/${t.name}.json`, json, 'utf8');
  files[t.name] = { rows: rows.length, sha256: sha256(json) };
  console.log(`  ${t.name.padEnd(13)} ${String(rows.length).padStart(4)} 列  ${files[t.name].sha256.slice(0, 12)}`);
}

await pool.close();

// ── dataDigest ────────────────────────────────────────────
// 只涵蓋「會影響前台渲染」的表。Admins / Lims / AdminLims 不影響前台輸出，
// 把它們算進來會讓「改個密碼」就使全部 golden 失效，那是假警報。
// docs/08-verification.md §2 的資料快照綁定用的就是這個值。
const dataDigest = sha256(
  TABLES.filter((t) => t.content).map((t) => `${t.name}:${files[t.name].sha256}`).join('\n')
);

const anomalies = findAnomalies(data);
await writeFile(`${outDir}/anomalies.json`, JSON.stringify(anomalies, null, 2) + '\n', 'utf8');

const manifest = {
  exportedAt: new Date().toISOString(),
  source: `${config.server}:${config.port}/${config.database}`,   // 不寫入帳密
  dataDigest,
  contentTables: TABLES.filter((t) => t.content).map((t) => t.name),
  files,
  anomalyCount: anomalies.length,
};
await writeFile(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log(`\ndataDigest  ${dataDigest}`);
console.log(`anomalies   ${anomalies.length} 筆 → ${outDir}/anomalies.json`);
if (anomalies.length) console.log('⚠️  逐條讀過再進行下一步 —— 每一條都是一個決定，不是警告');
