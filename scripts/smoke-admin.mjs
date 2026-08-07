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

const d1 = (sql, json = false) => {
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

const admin = JSON.parse(await readFile('data/export/Admins.json', 'utf8'))[0];
d1('UPDATE Admins SET MustChangePassword = 0 WHERE AdminID = 1');

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
  check('未登入的變更被擋', r.status === 401);
  cookie = noCookie;

  r = await post('/api/admin/articles/delete', new URLSearchParams({ ArticleID: 'x' }));
  check('沒有 CSRF token 被擋', r.status === 403);

  // 真的撤掉一個權限來測那條鏈，測完還原。
  // （唯一天生沒權限的 Teams 頁面還沒建，拿它測會變成在測 404）
  d1('UPDATE AdminLims SET IsDelete = 0 WHERE AdminID = 1 AND LimID = 4');
  r = await post('/api/admin/articles/delete',
    new URLSearchParams({ __csrf: csrfOf(await get('/backend/WebMs/Articles')), ArticleID: '00000000-0000-0000-0000-000000000000' }));
  check('權限被撤掉就 403', r.status === 403, '（不用重新登入就生效）');
  d1('UPDATE AdminLims SET IsDelete = 1 WHERE AdminID = 1 AND LimID = 4');

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
} finally {
  console.log('\n清理');
  if (createdId) {
    const html = await get('/backend/WebMs/Articles');
    await post('/api/admin/articles/delete', new URLSearchParams({ __csrf: csrfOf(html), ArticleID: createdId }));
    check('刪除', rowsTitled(await get('/backend/WebMs/Articles'), TEST_TITLE) === 0);
  }
  d1('UPDATE Admins SET MustChangePassword = 1 WHERE AdminID = 1');
  check('MustChangePassword 已還原',
    d1('SELECT MustChangePassword m FROM Admins WHERE AdminID = 1', true)[0].m === 1);
}

console.log(fail ? `\n❌ ${fail} 項未通過（${pass} 項通過）` : `\n✅ ${pass} 項全部通過`);
console.log('   資料已回到原狀 —— 接著跑 npm run parity 應該仍然全綠。');
process.exit(fail ? 1 : 0);
