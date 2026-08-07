import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import * as s from './schema';

export const db = () => drizzle(env.DB, { schema: s });

export type ArticleType = typeof s.articleTypes.$inferSelect;
export type Article = typeof s.articles.$inferSelect;
export type Service = typeof s.services.$inferSelect;
export type Team = typeof s.teams.$inferSelect;
export type Project = typeof s.projects.$inferSelect;
export type About = typeof s.abouts.$inferSelect;

/**
 * 舊站的 BaseController.OnActionExecuting 對每個前台請求都注入這個，
 * 用來畫 header 的「專業服務項目」下拉選單。
 * 新站沒有等價的全域 filter —— 每頁明確呼叫。
 */
export const getArticleTypes = () =>
  db().select().from(s.articleTypes).orderBy(asc(s.articleTypes.sort));

export const getArticleType = (id: string) =>
  db().select().from(s.articleTypes).where(eq(s.articleTypes.articleTypeId, id)).get();

export const getAbout = () =>
  db().select().from(s.abouts).where(eq(s.abouts.aboutId, 1)).get();

/**
 * 這三個查詢用 D1 原生 API 而不是 Drizzle 的 sql`` + .all()。
 * 理由：Drizzle 的 .all() 對 D1 回傳的是欄位值陣列而不是具名物件，
 * 別名再怎麼寫都拿不到 row.articleId。原生 API 的形狀是明確的
 * （{ results: [...] } 具名物件），這裡需要的是可預測，不是抽象。
 */
const ARTICLE_COLS = `
    a.ArticleID     AS articleId,
    a.ArticleTypeID AS articleTypeId,
    a.Title         AS title,
    a.Photo         AS photo,
    a.Description   AS description,
    a.CreateDate    AS createDate,
    a.LegacyOrder   AS legacyOrder,
    t.Title         AS typeTitle
`;

async function queryArticles(where: string, binds: unknown[] = []): Promise<ArticleWithType[]> {
  const stmt = env.DB.prepare(`
    SELECT ${ARTICLE_COLS}
    FROM Articles a
    JOIN ArticleTypes t ON t.ArticleTypeID = a.ArticleTypeID
    ${where}
  `);
  const { results } = await (binds.length ? stmt.bind(...binds) : stmt).all<ArticleWithType>();
  return results;
}

export type ArticleWithType = Article & { typeTitle: string };

/**
 * 首頁：每個分類最新的一篇，再依分類的 Sort 排序。
 * 舊站是 EF 的 GroupBy → OrderByDescending → FirstOrDefault
 * （HomeController.cs:47-51），在 SQLite 用相關子查詢表達。
 *
 * LegacyOrder 是必要的次要排序 —— CreateDate 會並列，見 docs/04-data-model.md §5
 */
export const getLatestArticlePerType = () => queryArticles(`
  WHERE a.ArticleID = (
    SELECT a2.ArticleID FROM Articles a2
    WHERE a2.ArticleTypeID = a.ArticleTypeID
    ORDER BY a2.CreateDate DESC, a2.LegacyOrder LIMIT 1)
  ORDER BY t.Sort`);

export const PAGE_SIZE = 6;

export interface PagedArticles {
  items: ArticleWithType[];
  pageNumber: number;
  pageCount: number;
  totalItemCount: number;
}

/**
 * /Home/Articles —— 依 CreateDate DESC 排序，可選分類篩選，每頁 6 筆。
 *
 * ⚠️ 次要排序欄位隨有無篩選而換：舊站兩種查詢對 CreateDate 並列列的輸出順序
 * 本來就不一致（SQL Server 的計畫差異），而兩種順序都是凍結的契約。
 * 見 docs/04-data-model.md §5
 */
export async function getArticlesPage(page: number, articleTypeId?: string | null): Promise<PagedArticles> {
  const filter = articleTypeId ? 'WHERE a.ArticleTypeID = ?' : '';
  const binds = articleTypeId ? [articleTypeId] : [];
  const tieBreaker = articleTypeId ? 'a.LegacyTypeOrder' : 'a.LegacyOrder';

  const countStmt = env.DB.prepare(`SELECT COUNT(*) AS n FROM Articles a ${filter}`);
  const row = await (binds.length ? countStmt.bind(...binds) : countStmt).first<{ n: number }>();
  const total = row?.n ?? 0;

  const items = await queryArticles(
    `${filter} ORDER BY a.CreateDate DESC, ${tieBreaker} LIMIT ? OFFSET ?`,
    [...binds, PAGE_SIZE, (page - 1) * PAGE_SIZE],
  );

  return { items, pageNumber: page, pageCount: Math.ceil(total / PAGE_SIZE), totalItemCount: total };
}

export async function getArticle(id: string): Promise<ArticleWithType | null> {
  const rows = await queryArticles('WHERE a.ArticleID = ?', [id]);
  return rows[0] ?? null;
}

export const getTeams = () =>
  db().select().from(s.teams).orderBy(asc(s.teams.sort));

export const getServicesByType = (articleTypeId: string) =>
  db().select().from(s.services)
    .where(eq(s.services.articleTypeId, articleTypeId))
    .orderBy(asc(s.services.sort));

/**
 * /Home/Project —— 三層分組 Type → Place → Title。
 * 舊站在 controller 建巢狀匿名型別，view 用反射讀（因為匿名型別是 internal）。
 * 這裡直接建一般的巢狀結構，輸出的 HTML 必須相同。
 */
export interface ProjectGroup {
  type: string;
  places: { place: string; titles: { title: string; projects: Project[] }[] }[];
}

export async function getProjectGroups(): Promise<ProjectGroup[]> {
  const rows = await db().select().from(s.projects).orderBy(asc(s.projects.legacyOrder));

  // 分組順序必須跟著 EF 的 GroupBy 走 —— 也就是資料列本身的出現順序，
  // 不是字典序。所以用 Map 保留插入順序，不要排序。
  const byType = new Map<string, Map<string, Map<string, Project[]>>>();
  for (const p of rows) {
    if (!byType.has(p.type)) byType.set(p.type, new Map());
    const places = byType.get(p.type)!;
    if (!places.has(p.place)) places.set(p.place, new Map());
    const titles = places.get(p.place)!;
    if (!titles.has(p.title)) titles.set(p.title, []);
    titles.get(p.title)!.push(p);
  }

  return [...byType].map(([type, places]) => ({
    type,
    places: [...places].map(([place, titles]) => ({
      place,
      titles: [...titles].map(([title, projects]) => ({
        title,
        // LegacyOrder 已編碼正式站的實際 <li> 順序，見 docs/04-data-model.md §5
        projects: projects.sort((a, b) => a.legacyOrder - b.legacyOrder),
      })),
    })),
  }));
}
