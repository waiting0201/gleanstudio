/**
 * 後台的變更操作。Astro 頁面負責渲染，Hono 負責變更（ADR-003）。
 *
 * 每一條路由都要走同一條鏈：**session → 權限 → CSRF**。
 * 在十幾個 Astro endpoint 各寫一次這條鏈，遲早會有一個漏掉；
 * 在這裡它是 middleware，漏不掉。
 *
 * 表單 POST 進來，完成後回 **303** 導回列表 —— POST/Redirect/GET，
 * 重新整理不會重送。
 */
import { Hono } from 'hono';
import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import { can, getSession, type AdminSession } from '../lib/auth/session';
import { verifyCsrf, CSRF_FIELD } from '../lib/auth/csrf';
import type { RouteKey } from '../lib/auth/permissions';
import { putEntityPhoto, deleteEntityPhoto, checkDescription, MediaError } from '../lib/media';

type Env = { Bindings: { astro: APIContext }; Variables: { admin: AdminSession; form: FormData } };

const app = new Hono<Env>().basePath('/api/admin');

/** 訊息帶回渲染頁 —— 存在 session，讀完就清。 */
export const FLASH_KEY = 'flash';
export interface Flash { tone: 'done' | 'stop'; text: string }

const astro = (c: { env: { astro: APIContext } }) => c.env.astro;

async function setFlash(c: { env: { astro: APIContext } }, flash: Flash) {
  astro(c).session?.set(FLASH_KEY, flash);
}

/** 303 —— POST/Redirect/GET，重新整理不會重送表單。 */
const back = (to: string) => new Response(null, { status: 303, headers: { location: to } });

// ── 鏈的第一節：一定要登入 ────────────────────────────
app.use('*', async (c, next) => {
  const session = await getSession(astro(c) as never);
  if (!session) return new Response('請先登入', { status: 401 });
  c.set('admin', session);
  await next();
});

// ── 第二節：讀表單並驗 CSRF ───────────────────────────
// 舊系統任何地方都沒有 anti-forgery token，而且刪除是 GET（docs/06 §9）
app.use('*', async (c, next) => {
  if (c.req.method !== 'POST') return c.text('只收 POST', 405);
  const form = await c.req.raw.formData();
  if (!(await verifyCsrf(astro(c).session as never, form.get(CSRF_FIELD)))) {
    return c.text('表單驗證碼不對。請重新整理頁面再試一次。', 403);
  }
  c.set('form', form);
  await next();
});

/** 第三節：逐路由的權限。403 不轉址 —— 見 docs/06 §7 */
const requires = (route: RouteKey) => async (c: any, next: any) => {
  if (!(await can(c.get('admin'), route))) {
    return c.text('這個動作你沒有權限。', 403);
  }
  await next();
};

// ── 登出 ──────────────────────────────────────────────
// POST，不是 GET —— GET 登出可被 CSRF（docs/09-known-issues.md 4.3）
app.post('/logout', async (c) => {
  await astro(c).session?.destroy();
  return back('/backend/Main/Login');
});

// ── 文章 ──────────────────────────────────────────────
const ARTICLES = '/backend/WebMs/Articles';

app.post('/articles/save', async (c) => {
  const form = c.get('form');
  const id = String(form.get('ArticleID') ?? '').toLowerCase();
  const isNew = id === '';

  // 新增與修改是不同的權限，不能共用一個檢查
  if (!(await can(c.get('admin'), isNew ? 'WebMs/AddArticles' : 'WebMs/EditArticles'))) {
    return c.text('這個動作你沒有權限。', 403);
  }

  const title = String(form.get('Title') ?? '').trim();
  const articleTypeId = String(form.get('ArticleTypeID') ?? '').toLowerCase();
  const createDate = String(form.get('CreateDate') ?? '').trim();
  const description = String(form.get('Description') ?? '');
  const photo = form.get('Photo');

  const problem =
    !title ? '請填標題。'
    : !articleTypeId ? '請選分類。'
    : !/^\d{4}-\d{2}-\d{2}$/.test(createDate) ? '日期格式要是 YYYY-MM-DD。'
    : checkDescription(description);

  if (problem) {
    await setFlash(c, { tone: 'stop', text: problem });
    return back(isNew ? '/backend/WebMs/AddArticles' : `/backend/WebMs/EditArticles?ArticleID=${id}`);
  }

  const iso = `${createDate}T00:00:00.000Z`;

  try {
    if (isNew) {
      const newId = crypto.randomUUID();  // GUID 一律小寫 —— randomUUID 本來就是
      // 新文章排在最後。兩個順序欄位都要給，見 docs/04-data-model.md §5
      const tail = await env.DB.prepare(
        `SELECT COALESCE(MAX(LegacyOrder), 0) + 1 AS o,
                (SELECT COALESCE(MAX(LegacyTypeOrder), 0) + 1 FROM Articles WHERE ArticleTypeID = ?1) AS t
         FROM Articles`,
      ).bind(articleTypeId).first<{ o: number; t: number }>();

      let photoName = '';
      if (photo instanceof File && photo.size > 0) {
        photoName = await putEntityPhoto('Articles', newId, photo);
      }

      await env.DB.prepare(
        `INSERT INTO Articles (ArticleID, ArticleTypeID, Title, Photo, Description, CreateDate, LegacyOrder, LegacyTypeOrder)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      ).bind(newId, articleTypeId, title, photoName, description, iso, tail?.o ?? 1, tail?.t ?? 1).run();

      await setFlash(c, { tone: 'done', text: `已新增「${title}」。` });
    } else {
      const existing = await env.DB.prepare('SELECT Photo FROM Articles WHERE ArticleID = ?1')
        .bind(id).first<{ Photo: string }>();
      if (!existing) return c.text('找不到這篇文章。', 404);

      let photoName = existing.Photo;
      if (photo instanceof File && photo.size > 0) {
        photoName = await putEntityPhoto('Articles', id, photo, existing.Photo);
      }

      await env.DB.prepare(
        `UPDATE Articles SET ArticleTypeID = ?1, Title = ?2, Photo = ?3, Description = ?4, CreateDate = ?5
         WHERE ArticleID = ?6`,
      ).bind(articleTypeId, title, photoName, description, iso, id).run();

      await setFlash(c, { tone: 'done', text: `已更新「${title}」。` });
    }
  } catch (e) {
    if (e instanceof MediaError) {
      await setFlash(c, { tone: 'stop', text: e.message });
      return back(isNew ? '/backend/WebMs/AddArticles' : `/backend/WebMs/EditArticles?ArticleID=${id}`);
    }
    throw e;
  }

  return back(ARTICLES);
});

// 刪除是 POST —— 舊站是 [HttpGet]（docs/09-known-issues.md 4.4）
app.post('/articles/delete', requires('WebMs/DeleteArticles'), async (c) => {
  const id = String(c.get('form').get('ArticleID') ?? '').toLowerCase();
  const row = await env.DB.prepare('SELECT Title, Photo FROM Articles WHERE ArticleID = ?1')
    .bind(id).first<{ Title: string; Photo: string }>();
  if (!row) return c.text('找不到這篇文章。', 404);

  await env.DB.prepare('DELETE FROM Articles WHERE ArticleID = ?1').bind(id).run();
  await deleteEntityPhoto('Articles', id, row.Photo);

  await setFlash(c, { tone: 'done', text: `已刪除「${row.Title}」。` });
  return back(ARTICLES);
});

// ── 富文本裡的圖片 ────────────────────────────────────
// 編輯器把貼上/拖入的圖片送到這裡換成一個 /Upload/… 網址，
// **不准內嵌 base64**（docs/06-admin-spec.md §8）
app.post('/articles/photo', requires('WebMs/EditArticles'), async (c) => {
  const form = c.get('form');
  const id = String(form.get('ArticleID') ?? '').toLowerCase();
  const file = form.get('file');
  if (!(file instanceof File)) return c.json({ error: '沒有收到檔案。' }, 400);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    return c.json({ error: '要先儲存一次才能插入圖片。' }, 400);
  }
  try {
    const photo = await putEntityPhoto('Articles', id, file);
    return c.json({ url: `/Upload/Articles/${id}/${photo}` });
  } catch (e) {
    return c.json({ error: e instanceof MediaError ? e.message : '上傳失敗。' }, 400);
  }
});

export default app;
