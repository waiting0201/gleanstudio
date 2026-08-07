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
import { buildEntities, type EntityDef } from '../lib/admin/entities';
import { getArticleTypes } from '../db/queries';

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

// ── 其餘實體：一份定義餵給同一組 handler ─────────────
// 舊系統把這段 CRUD 寫了七遍，上傳那段也複製了七次。
// 文章 / Projects / Admins 不走這裡 —— 它們各有各的形狀，見 src/lib/admin/entities.ts

async function entityDef(name: string): Promise<EntityDef | null> {
  const defs = buildEntities(await getArticleTypes());
  return defs[name] ?? null;
}

const listUrl = (def: EntityDef) => `/backend/WebMs/${def.key}`;
const formUrl = (def: EntityDef, id?: string) =>
  def.singleton !== undefined || !id
    ? (def.singleton !== undefined ? `/backend/WebMs/${def.key}` : `/backend/WebMs/Add${def.key}`)
    : `/backend/WebMs/Edit${def.key}?id=${id}`;

/** 富文本裡的圖片。編輯器把貼上/拖入的圖片送到這裡換成一個 /Upload/… 網址。 */
app.post('/:entity/photo', async (c) => {
  const def = await entityDef(c.req.param('entity'));
  const isArticles = c.req.param('entity') === 'Articles';
  if (!def && !isArticles) return c.json({ error: '未知的實體。' }, 404);

  const route = isArticles ? 'WebMs/EditArticles' : def!.routes.edit;
  if (!(await can(c.get('admin'), route))) return c.json({ error: '沒有權限。' }, 403);

  const form = c.get('form');
  const id = String(form.get('id') ?? '').toLowerCase();
  const file = form.get('file');
  const mediaEntity = isArticles ? 'Articles' : def!.media?.entity;
  if (!mediaEntity) return c.json({ error: '這個實體沒有圖片。' }, 400);
  if (!(file instanceof File)) return c.json({ error: '沒有收到檔案。' }, 400);
  if (!/^[0-9a-f-]{1,36}$/.test(id) || id === '') return c.json({ error: '要先儲存一次才能插入圖片。' }, 400);

  try {
    const photo = await putEntityPhoto(mediaEntity, id, file);
    return c.json({ url: `/Upload/${mediaEntity}/${id}/${photo}` });
  } catch (e) {
    return c.json({ error: e instanceof MediaError ? e.message : '上傳失敗。' }, 400);
  }
});

app.post('/:entity/save', async (c) => {
  const def = await entityDef(c.req.param('entity'));
  if (!def) return c.text('未知的實體。', 404);

  const form = c.get('form');
  const rawId = String(form.get('id') ?? '').trim();
  const id = def.singleton !== undefined ? String(def.singleton) : rawId.toLowerCase();
  const isNew = def.singleton === undefined && id === '';

  if (!(await can(c.get('admin'), isNew ? def.routes.add : def.routes.edit))) {
    return c.text('這個動作你沒有權限。', 403);
  }

  const values: Record<string, string> = {};
  for (const f of def.fields) {
    const v = String(form.get(f.column) ?? '').trim();
    if (f.required && v === '') {
      await setFlash(c, { tone: 'stop', text: `請填「${f.label}」。` });
      return back(formUrl(def, id));
    }
    if (f.kind === 'richtext') {
      const problem = checkDescription(v);
      if (problem) {
        await setFlash(c, { tone: 'stop', text: problem });
        return back(formUrl(def, id));
      }
    }
    values[f.column] = v;
  }

  const photo = form.get(def.media?.photoColumn ?? '__none');
  const recordId = isNew ? crypto.randomUUID() : id;

  try {
    if (def.media && photo instanceof File && photo.size > 0) {
      const prev = isNew ? null : (await env.DB.prepare(
        `SELECT ${def.media.photoColumn} AS p FROM ${def.table} WHERE ${def.idColumn} = ?1`,
      ).bind(recordId).first<{ p: string }>())?.p ?? null;
      values[def.media.photoColumn] = await putEntityPhoto(def.media.entity, recordId, photo, prev);
    }

    if (isNew) {
      // 新的排在最後 —— 公開站依 Sort 排序
      if (def.sortable) {
        const tail = await env.DB.prepare(`SELECT COALESCE(MAX(Sort), 0) + 5 AS s FROM ${def.table}`)
          .first<{ s: number }>();
        values.Sort = String(tail?.s ?? 0);
      }
      if (def.media && !values[def.media.photoColumn]) values[def.media.photoColumn] = '';
      const cols = [def.idColumn, ...Object.keys(values)];
      await env.DB.prepare(
        `INSERT INTO ${def.table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(', ')})`,
      ).bind(recordId, ...Object.values(values)).run();
      await setFlash(c, { tone: 'done', text: `已新增一筆${def.label}。` });
    } else {
      const cols = Object.keys(values);
      if (cols.length === 0) return back(listUrl(def));
      await env.DB.prepare(
        `UPDATE ${def.table} SET ${cols.map((col, i) => `${col} = ?${i + 1}`).join(', ')}
         WHERE ${def.idColumn} = ?${cols.length + 1}`,
      ).bind(...Object.values(values), recordId).run();
      await setFlash(c, { tone: 'done', text: `已更新${def.label}。` });
    }
  } catch (e) {
    if (e instanceof MediaError) {
      await setFlash(c, { tone: 'stop', text: e.message });
      return back(formUrl(def, id));
    }
    throw e;
  }

  return back(def.singleton !== undefined ? formUrl(def) : listUrl(def));
});

app.post('/:entity/delete', async (c) => {
  const def = await entityDef(c.req.param('entity'));
  if (!def || def.singleton !== undefined) return c.text('這個實體不能刪除。', 404);
  if (!(await can(c.get('admin'), def.routes.delete))) return c.text('這個動作你沒有權限。', 403);

  const id = String(c.get('form').get('id') ?? '').toLowerCase();
  const row = await env.DB.prepare(`SELECT * FROM ${def.table} WHERE ${def.idColumn} = ?1`)
    .bind(id).first<Record<string, string>>();
  if (!row) return c.text('找不到這筆資料。', 404);

  await env.DB.prepare(`DELETE FROM ${def.table} WHERE ${def.idColumn} = ?1`).bind(id).run();
  if (def.media) await deleteEntityPhoto(def.media.entity, id, row[def.media.photoColumn]);

  await setFlash(c, { tone: 'done', text: `已刪除一筆${def.label}。` });
  return back(listUrl(def));
});

/**
 * 上下移動。舊系統的 Add/Edit/Delete 對應表**根本沒有涵蓋 Sort\***，
 * 等於排序只要有檢視權限就能做。這裡對應到 update（docs/06-admin-spec.md §5）。
 */
app.post('/:entity/sort', async (c) => {
  const def = await entityDef(c.req.param('entity'));
  if (!def?.sortable) return c.text('這個實體不能排序。', 404);
  if (!(await can(c.get('admin'), def.routes.edit))) return c.text('這個動作你沒有權限。', 403);

  const form = c.get('form');
  const id = String(form.get('id') ?? '').toLowerCase();
  const dir = String(form.get('dir') ?? '');
  if (dir !== 'up' && dir !== 'down') return c.text('方向只能是 up 或 down。', 400);

  const me = await env.DB.prepare(`SELECT Sort FROM ${def.table} WHERE ${def.idColumn} = ?1`)
    .bind(id).first<{ Sort: number }>();
  if (!me) return c.text('找不到這筆資料。', 404);

  // 相鄰的那一筆。Sort 並列時用 id 當第二排序，才不會兩筆互相跳
  const neighbour = await env.DB.prepare(
    dir === 'up'
      ? `SELECT ${def.idColumn} AS id, Sort FROM ${def.table}
         WHERE Sort < ?1 OR (Sort = ?1 AND ${def.idColumn} < ?2)
         ORDER BY Sort DESC, ${def.idColumn} DESC LIMIT 1`
      : `SELECT ${def.idColumn} AS id, Sort FROM ${def.table}
         WHERE Sort > ?1 OR (Sort = ?1 AND ${def.idColumn} > ?2)
         ORDER BY Sort, ${def.idColumn} LIMIT 1`,
  ).bind(me.Sort, id).first<{ id: string; Sort: number }>();

  if (!neighbour) {
    await setFlash(c, { tone: 'stop', text: dir === 'up' ? '已經是第一筆了。' : '已經是最後一筆了。' });
    return back(listUrl(def));
  }

  // Sort 相同時交換值沒有作用，補一格差距
  const [a, b] = me.Sort === neighbour.Sort
    ? (dir === 'up' ? [neighbour.Sort - 1, neighbour.Sort] : [neighbour.Sort + 1, neighbour.Sort])
    : [neighbour.Sort, me.Sort];

  await env.DB.batch([
    env.DB.prepare(`UPDATE ${def.table} SET Sort = ?1 WHERE ${def.idColumn} = ?2`).bind(a, id),
    env.DB.prepare(`UPDATE ${def.table} SET Sort = ?1 WHERE ${def.idColumn} = ?2`).bind(b, neighbour.id),
  ]);

  return back(listUrl(def));
});

export default app;
