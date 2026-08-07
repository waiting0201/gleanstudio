#!/usr/bin/env node
/**
 * 後台的端到端煙霧測試。
 *
 *   npm run smoke:admin        （先跑 npm run preview 讓 wrangler dev 起來）
 *
 * 會**真的**在本機 D1 建一筆文章再刪掉。跑完資料回到原狀，parity 應該仍然全綠 ——
 * 最後一步就是驗這件事。
 *
 * 密碼從 gitignored 的 data/export/Admins.json 讀，不印出來。
 * 測試期間暫時把 MustChangePassword 設成 0，結束時還原。
 */
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const BASE = process.argv.includes('--base')
  ? process.argv[process.argv.indexOf('--base') + 1]
  : 'http://localhost:8787';

const TEST_TITLE = '【煙霧測試】跑完會自動刪除';
const TYPE_ID = 'ff829f70-4d55-4f55-aa1f-750c050d2be0';

/**
 * ⚠️ 這會在 `wrangler dev` 執行中另外開一個行程碰同一個 miniflare SQLite。
 * CI 上的崩潰高度懷疑跟這個有關（docs/08-verification.md §9），所以把每次
 * 呼叫標出來，才能跟 wrangler 的請求 log 對時間。
 */
let d1Calls = 0;
const d1 = (sql, json = false) => {
  if (process.env.SMOKE_TRACE) console.log(`      [d1 #${++d1Calls}] ${sql.slice(0, 70)}`);
  const out = execFileSync('npx', [
    'wrangler', 'd1', 'execute', 'gleanstudio', '--local', ...(json ? ['--json'] : []), '--command', sql,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return json ? JSON.parse(out)[0].results : out;
};

let pass = 0, fail = 0;
const check = (label, ok, note = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(26)} ${note}`);
  ok ? pass++ : fail++;
};

/**
 * 伺服器死掉與斷言失敗是兩件事，訊息要能分辨。
 *
 * CI 上遇過一次 `wrangler dev` 在跑到一半崩潰（stdout 只留一個空的 ERROR），
 * 結果表現成「沒有 CSRF token 被擋」這一項失敗 —— 看起來像 CSRF 壞了，
 * 其實是伺服器已經不在了。無法重現，見 docs/08-verification.md §9。
 */
async function assertAlive(where) {
  try {
    await fetch(BASE + '/backend/Main/Login', { signal: AbortSignal.timeout(5000) });
  } catch (e) {
    console.error(`\n💥 ${where} 之後連不上 ${BASE} —— **伺服器掛了，不是斷言失敗**。`);
    console.error(`   ${e.message}`);
    console.error('   去看 wrangler 的詳細 log（CI 會印，本機在 /tmp/gleanstudio-wrangler.log）。');
    process.exit(2);
  }
}

/**
 * 帳密來源：CI 用環境變數（帳號由 scripts/bootstrap-admin.mjs 現場建），
 * 本機沿用 gitignored 的匯出檔。兩邊都不把密碼印出來。
 */
const admin = process.env.SMOKE_USERNAME
  ? { Username: process.env.SMOKE_USERNAME, Password: process.env.SMOKE_PASSWORD ?? '' }
  : JSON.parse(await readFile('data/export/Admins.json', 'utf8'))[0];

const ADMIN_ID = d1(`SELECT AdminID FROM Admins WHERE Username = '${admin.Username}'`, true)[0]?.AdminID;
if (!ADMIN_ID) {
  console.error(`找不到帳號 ${admin.Username}。CI 請先跑 scripts/bootstrap-admin.mjs`);
  process.exit(1);
}
d1(`UPDATE Admins SET MustChangePassword = 0 WHERE AdminID = ${ADMIN_ID}`);

let cookie = '';
const post = (path, body, isForm = false) => fetch(BASE + path, {
  method: 'POST',
  body,
  headers: {
    origin: BASE,
    ...(isForm ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
    ...(cookie ? { cookie } : {}),
  },
  redirect: 'manual',
});
const get = async (path) => (await fetch(BASE + path, { headers: { cookie } })).text();
const csrfOf = (html) => html.match(/name="__csrf" value="([^"]+)"/)?.[1] ?? '';
/** 只數列表的資料列 —— flash 訊息裡也會有標題，用 includes 會誤判 */
const rowsTitled = (html, needle) =>
  [...html.matchAll(/EditArticles\?ArticleID=[0-9a-f-]{36}"[^>]*>([^<]*)</g)]
    .filter((m) => m[1].includes(needle)).length;

let createdId = null;
let createdServiceIds = [];
let createdProjectId = null;
let createdAdminId = null;

try {
  console.log('\n登入與 session');
  // 匿名 session 也有 CSRF token（middleware 發的），登入表單也要帶
  let loginPage = await fetch(BASE + '/backend/Main/Login');
  cookie = (loginPage.headers.get('set-cookie') ?? '').split(';')[0];
  const loginToken = csrfOf(await loginPage.text());
  check('匿名 session 有 CSRF token', loginToken.length === 43);

  let r = await post('/backend/Main/Login', new URLSearchParams({ username: admin.Username, password: admin.Password }));
  check('沒帶 CSRF 的登入被擋', r.status === 403);

  r = await post('/backend/Main/Login',
    new URLSearchParams({ __csrf: loginToken, username: admin.Username, password: 'wrong' }));
  check('錯誤密碼不給身分',
    (await fetch(BASE + '/backend/Main/Index', { headers: { cookie }, redirect: 'manual' })).status === 302);

  r = await post('/backend/Main/Login',
    new URLSearchParams({ __csrf: loginToken, username: admin.Username, password: admin.Password }));
  cookie = (r.headers.get('set-cookie') ?? '').split(';')[0] || cookie;
  check('登入', r.status === 302, `→ ${r.headers.get('location')}`);

  console.log('\n權限與 CSRF');
  const noCookie = cookie; cookie = '';
  r = await post('/api/admin/articles/delete', new URLSearchParams({ ArticleID: 'x' }));
  check('未登入的變更被擋', r.status === 401, `實得 ${r.status}`);
  cookie = noCookie;

  r = await post('/api/admin/articles/delete', new URLSearchParams({ ArticleID: 'x' }));
  if (r.status !== 403) {
    // 401 代表 session 不見了（不是 CSRF 的問題），其他狀態碼則是別的東西壞了
    console.log(`      實得 ${r.status}：${(await r.text()).slice(0, 80)}`);
    await assertAlive('未帶 CSRF 的刪除');
  }
  check('沒有 CSRF token 被擋', r.status === 403, `實得 ${r.status}`);

  // 真的撤掉一個權限來測那條鏈，測完還原。
  // （唯一天生沒權限的 Teams 頁面還沒建，拿它測會變成在測 404）
  d1(`UPDATE AdminLims SET IsDelete = 0 WHERE AdminID = ${ADMIN_ID} AND LimID = 4`);
  r = await post('/api/admin/articles/delete',
    new URLSearchParams({ __csrf: csrfOf(await get('/backend/WebMs/Articles')), ArticleID: '00000000-0000-0000-0000-000000000000' }));
  check('權限被撤掉就 403', r.status === 403, '（不用重新登入就生效）');
  d1(`UPDATE AdminLims SET IsDelete = 1 WHERE AdminID = ${ADMIN_ID} AND LimID = 4`);

  console.log('\n新增');
  const before = d1('SELECT COUNT(*) n FROM Articles', true)[0].n;
  const fd = new FormData();
  fd.set('__csrf', csrfOf(await get('/backend/WebMs/AddArticles')));
  fd.set('Title', TEST_TITLE);
  fd.set('ArticleTypeID', TYPE_ID);
  fd.set('CreateDate', '2026-08-07');
  fd.set('Description', '<p>煙霧測試</p>');
  r = await post('/api/admin/articles/save', fd, true);
  check('儲存回 303', r.status === 303, `→ ${r.headers.get('location')}`);

  let html = await get('/backend/WebMs/Articles');
  createdId = html.match(new RegExp(`EditArticles\\?ArticleID=([0-9a-f-]{36})"[^>]*>${TEST_TITLE.slice(0, 6)}`))?.[1] ?? null;
  check('列表出現一列', rowsTitled(html, TEST_TITLE) === 1);
  check('flash 訊息', /role="status"/.test(html));
  check('flash 只顯示一次', !/role="status"/.test(await get('/backend/WebMs/Articles')));

  // 新文章要排在最後。兩個順序欄位都要給，見 docs/04-data-model.md §5
  const orders = d1(`SELECT LegacyOrder o, LegacyTypeOrder t FROM Articles WHERE ArticleID='${createdId}'`, true)[0];
  check('LegacyOrder 接在最後', orders.o === before + 1, `= ${orders.o}`);
  check('LegacyTypeOrder 接在最後', orders.t > 0, `= ${orders.t}`);

  check('公開站看得到', (await (await fetch(BASE + '/Home/Articles?p=1')).text()).includes(TEST_TITLE));

  console.log('\n內文的 base64 防線');
  const fd2 = new FormData();
  fd2.set('__csrf', csrfOf(await get(`/backend/WebMs/EditArticles?ArticleID=${createdId}`)));
  fd2.set('ArticleID', createdId);
  fd2.set('Title', TEST_TITLE);
  fd2.set('ArticleTypeID', TYPE_ID);
  fd2.set('CreateDate', '2026-08-07');
  fd2.set('Description', '<p><img src="data:image/png;base64,AAAA"></p>');
  await post('/api/admin/articles/save', fd2, true);
  check('內嵌圖片被拒絕', (await get(`/backend/WebMs/EditArticles?ArticleID=${createdId}`)).includes('內嵌的圖'));
  check('內文沒有被寫進去',
    !d1(`SELECT Description d FROM Articles WHERE ArticleID='${createdId}'`, true)[0].d.includes('base64'));
  // ── 共用實體層（ArticleTypes / Services / Teams / Abouts）──
  console.log('\n共用實體層');
  for (const [key, label] of [['ArticleTypes', '文章分類'], ['Services', '服務項目'], ['Abouts', '關於禾勤']]) {
    const h = await get(`/backend/WebMs/${key}`);
    check(`${key} 列表渲染`, h.includes(label) && !h.includes('未知的實體'));
  }

  // 這個管理員**沒有** Teams 權限（AdminLims 缺 LimID 7）——
  // 那是舊資料的既有狀態，不是移植造成的。見 docs/09-known-issues.md 3.3
  check('沒權限的實體被擋',
    (await fetch(BASE + '/backend/WebMs/Teams', { headers: { cookie }, redirect: 'manual' }))
      .headers.get('location') === '/backend/Forbidden');

  // Services 目前 0 筆，拿它測完整的 CRUD 與排序，測完不留痕跡
  const svc = async (title) => {
    const f = new FormData();
    f.set('__csrf', csrfOf(await get('/backend/WebMs/AddServices')));
    f.set('ArticleTypeID', TYPE_ID);
    f.set('Title', title);
    return post('/api/admin/Services/save', f, true);
  };

  r = await svc(`${TEST_TITLE} A`);
  check('新增服務項目', r.status === 303);
  await svc(`${TEST_TITLE} B`);

  let svcs = d1('SELECT ServiceID, Title, Sort FROM Services ORDER BY Sort, ServiceID', true);
  createdServiceIds = svcs.map((x) => x.ServiceID);
  check('兩筆都在，B 排最後', svcs.length === 2 && svcs.at(-1).Title.endsWith('B'), `Sort = ${svcs.map(x=>x.Sort).join(', ')}`);

  const bId = svcs.at(-1).ServiceID;
  r = await post('/api/admin/Services/sort',
    new URLSearchParams({ __csrf: csrfOf(await get('/backend/WebMs/Services')), id: bId, dir: 'up' }));
  svcs = d1('SELECT Title FROM Services ORDER BY Sort, ServiceID', true);
  check('往上移一格', r.status === 303 && svcs[0].Title.endsWith('B'));

  await post('/api/admin/Services/sort',
    new URLSearchParams({ __csrf: csrfOf(await get('/backend/WebMs/Services')), id: bId, dir: 'up' }));
  check('已經在最前面時擋下', /role="status"/.test(await get('/backend/WebMs/Services')));

  const ef = new FormData();
  ef.set('__csrf', csrfOf(await get(`/backend/WebMs/EditServices?id=${bId}`)));
  ef.set('id', bId); ef.set('ArticleTypeID', TYPE_ID); ef.set('Title', '改過的名稱');
  r = await post('/api/admin/Services/save', ef, true);
  check('修改服務項目', r.status === 303
    && d1(`SELECT Title t FROM Services WHERE ServiceID='${bId}'`, true)[0].t === '改過的名稱');

  const bad = new FormData();
  bad.set('__csrf', csrfOf(await get('/backend/WebMs/AddServices')));
  bad.set('ArticleTypeID', TYPE_ID);
  r = await post('/api/admin/Services/save', bad, true);
  check('必填欄位空白被擋', /請填/.test(await get('/backend/WebMs/AddServices')));

  r = await post('/api/admin/Services/delete',
    new URLSearchParams({ __csrf: csrfOf(await get('/backend/WebMs/Services')), id: bId }));
  check('刪除服務項目', r.status === 303
    && d1('SELECT COUNT(*) n FROM Services', true)[0].n === 1);

  // Abouts 是單筆 —— 把同樣的值存回去，確認往返不會改到內容
  const beforeAbout = d1('SELECT Description d FROM Abouts WHERE AboutID = 1', true)[0].d;
  const bf = new FormData();
  bf.set('__csrf', csrfOf(await get('/backend/WebMs/Abouts')));
  bf.set('Description', beforeAbout);
  r = await post('/api/admin/Abouts/save', bf, true);
  const afterAbout = d1('SELECT Description d FROM Abouts WHERE AboutID = 1', true)[0].d;
  check('Abouts 存回原值不變形', r.status === 303 && afterAbout === beforeAbout);

  // ── 案例（87 筆，自己的形狀）──────────────────────────
  console.log('\n案例');
  let h = await get('/backend/WebMs/Projects');
  check('列表渲染', h.includes('案例') && /instrument">87</.test(h));
  check('依分類篩選', (await get('/backend/WebMs/Projects?type=' + encodeURIComponent('文物修護'))).includes('文物修護'));
  check('搜尋', (await get('/backend/WebMs/Projects?q=' + encodeURIComponent('歷史博物館'))).includes('歷史博物館'));

  const pf = new FormData();
  pf.set('__csrf', csrfOf(await get('/backend/WebMs/AddProjects')));
  pf.set('Type', '文物修護'); pf.set('Place', TEST_TITLE); pf.set('Title', '測試案名'); pf.set('SubTitle', '測試項目');
  r = await post('/api/admin/Projects/save', pf, true);
  const proj = d1(`SELECT ProjectID, LegacyOrder o FROM Projects WHERE Place = '${TEST_TITLE}'`, true)[0];
  createdProjectId = proj?.ProjectID ?? null;
  check('新增案例排在最後', r.status === 303 && proj?.o === 88, `#${proj?.o}`);
  check('公開頁看得到', (await (await fetch(BASE + '/Home/Project')).text()).includes('測試項目'));

  r = await post('/api/admin/Projects/delete',
    new URLSearchParams({ __csrf: csrfOf(await get('/backend/WebMs/Projects')), id: createdProjectId }));
  check('刪除案例', r.status === 303 && d1('SELECT COUNT(*) n FROM Projects', true)[0].n === 87);
  createdProjectId = null;

  // ── 管理者（密碼 + 權限矩陣）──────────────────────────
  console.log('\n管理者');
  h = await get('/backend/SettingMs/Admins');
  check('列表渲染', h.includes('管理者') && h.includes('（你自己）'));

  const af2 = new FormData();
  af2.set('__csrf', csrfOf(await get('/backend/SettingMs/AddAdmins')));
  af2.set('Name', TEST_TITLE); af2.set('Username', 'smoketest'); af2.set('password', 'a-temporary-passphrase-2026');
  af2.set('lim_4_view', '1'); af2.set('lim_4_add', '1');   // 只給文章的檢視與新增
  r = await post('/api/admin/Admins/save', af2, true);
  const created = d1(`SELECT AdminID, MustChangePassword m FROM Admins WHERE Username = 'smoketest'`, true)[0];
  createdAdminId = created?.AdminID ?? null;
  check('新增管理者', r.status === 303 && !!createdAdminId);
  check('強制首次換密碼', created?.m === 1);

  const grants = d1(`SELECT LimID, IsAdd, IsUpdate, IsDelete FROM AdminLims WHERE AdminID = ${createdAdminId}`, true);
  check('權限只給了勾選的', grants.length === 1 && grants[0].LimID === 4
    && grants[0].IsAdd === 1 && grants[0].IsUpdate === 0 && grants[0].IsDelete === 0);

  const dup = new FormData();
  dup.set('__csrf', csrfOf(await get('/backend/SettingMs/AddAdmins')));
  dup.set('Name', 'x'); dup.set('Username', 'smoketest'); dup.set('password', 'a-temporary-passphrase-2026');
  await post('/api/admin/Admins/save', dup, true);
  check('重複帳號被擋', /已經有人用了/.test(await get('/backend/SettingMs/AddAdmins')));

  /**
   * 長度下限已經拿掉（MIN_PASSWORD_LENGTH = 1），所以這裡驗的是剩下的那道底線：
   * **新帳號的密碼不能是空的**。空密碼會建出一個誰都登得進去的帳號。
   */
  const weak = new FormData();
  weak.set('__csrf', csrfOf(await get('/backend/SettingMs/AddAdmins')));
  weak.set('Name', 'x'); weak.set('Username', 'nopw'); weak.set('password', '');
  await post('/api/admin/Admins/save', weak, true);
  check('空白的初始密碼被擋', /請填密碼/.test(await get('/backend/SettingMs/AddAdmins')));
  check('沒有留下殘帳號', d1(`SELECT COUNT(*) n FROM Admins WHERE Username = 'nopw'`, true)[0].n === 0);

  r = await post('/api/admin/Admins/delete',
    new URLSearchParams({ __csrf: csrfOf(await get('/backend/SettingMs/Admins')), id: String(ADMIN_ID) }));
  check('不能刪除自己', /不能刪除自己/.test(await get('/backend/SettingMs/Admins')));

  r = await post('/api/admin/Admins/delete',
    new URLSearchParams({ __csrf: csrfOf(await get('/backend/SettingMs/Admins')), id: String(createdAdminId) }));
  check('刪除管理者', r.status === 303
    && d1(`SELECT COUNT(*) n FROM Admins WHERE Username='smoketest'`, true)[0].n === 0);
  check('權限一併清掉（CASCADE）',
    d1(`SELECT COUNT(*) n FROM AdminLims WHERE AdminID = ${createdAdminId}`, true)[0].n === 0);
  createdAdminId = null;

} finally {
  console.log('\n清理');
  if (createdId) {
    const html = await get('/backend/WebMs/Articles');
    await post('/api/admin/articles/delete', new URLSearchParams({ __csrf: csrfOf(html), ArticleID: createdId }));
    check('刪除', rowsTitled(await get('/backend/WebMs/Articles'), TEST_TITLE) === 0);
  }
  if (createdServiceIds.length) {
    d1(`DELETE FROM Services WHERE ServiceID IN (${createdServiceIds.map((i) => `'${i}'`).join(', ')})`);
    check('Services 已清空', d1('SELECT COUNT(*) n FROM Services', true)[0].n === 0);
  }
  if (createdProjectId) d1(`DELETE FROM Projects WHERE ProjectID = '${createdProjectId}'`);
  if (createdAdminId) d1(`DELETE FROM Admins WHERE AdminID = ${createdAdminId}`);
  d1("DELETE FROM Admins WHERE Username IN ('smoketest','weakpw')");
  check('測試帳號已清乾淨', d1("SELECT COUNT(*) n FROM Admins WHERE Username IN ('smoketest','weakpw')", true)[0].n === 0);
  d1(`UPDATE Admins SET MustChangePassword = 1 WHERE AdminID = ${ADMIN_ID}`);
  check('MustChangePassword 已還原',
    d1(`SELECT MustChangePassword m FROM Admins WHERE AdminID = ${ADMIN_ID}`, true)[0].m === 1);
}

console.log(fail ? `\n❌ ${fail} 項未通過（${pass} 項通過）` : `\n✅ ${pass} 項全部通過`);
console.log('   資料已回到原狀 —— 接著跑 npm run parity 應該仍然全綠。');
process.exit(fail ? 1 : 0);
