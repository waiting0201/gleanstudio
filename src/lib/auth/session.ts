/**
 * 後台的登入狀態與權限解析。
 *
 * ⚠️ **不要把權限矩陣快取進 session。** 舊系統把 Session["AdminLims"]（一個
 * EF 延遲載入集合）整包塞進去，結果是「改了權限要重新登入才生效」。
 * 這裡每個請求直接查 D1 —— 一次走 uq_lims_parent_key 與 uq_adminlims_admin_lim
 * 的查詢，同一個 isolate 內 memoize。見 docs/06-admin-spec.md §2
 */
import { env } from 'cloudflare:workers';
import type { AstroGlobal } from 'astro';
import { ROUTE_PERMISSIONS, VERB_COLUMN, type RouteKey } from './permissions';

export interface AdminSession {
  adminId: number;
  username: string;
  name: string;
  isSuper: boolean;
  mustChangePassword: boolean;
}

export const SESSION_KEY = 'admin';

/** Lims 的 (parent.Key, child.Key) → LimID。同一個 isolate 內只查一次。 */
const limIdCache = new Map<string, number | null>();

export async function resolveLimId(parent: string, child: string): Promise<number | null> {
  const cacheKey = `${parent}/${child}`;
  if (limIdCache.has(cacheKey)) return limIdCache.get(cacheKey)!;

  const rows = await env.DB.prepare(
    `SELECT c.LimID AS limId FROM Lims c
     JOIN Lims p ON p.LimID = c.ParentID
     WHERE p."Key" = ?1 AND c."Key" = ?2 AND p.ParentID IS NULL`,
  ).bind(parent, child).all<{ limId: number }>();

  // 恰好一筆才算解析成功。0 筆或多筆都是註冊表與資料對不上 ——
  // 舊系統會在這裡默默猜一個，我們寧可拒絕。
  const limId = rows.results.length === 1 ? rows.results[0].limId : null;
  limIdCache.set(cacheKey, limId);
  return limId;
}

export async function can(session: AdminSession | undefined, route: RouteKey): Promise<boolean> {
  if (!session) return false;
  // IsSuperAdmin 是一筆真實、可稽核、可撤銷的資料列 —— 不是寫死的 weypro 後門
  if (session.isSuper) return true;

  const perm = ROUTE_PERMISSIONS[route];
  const limId = await resolveLimId(perm.parent, perm.child);
  if (limId === null) return false;

  const row = await env.DB.prepare(
    `SELECT IsAdd, IsUpdate, IsDelete FROM AdminLims WHERE AdminID = ?1 AND LimID = ?2`,
  ).bind(session.adminId, limId).first<{ IsAdd: number; IsUpdate: number; IsDelete: number }>();

  if (!row) return false;
  if (perm.verb === 'view') return true;
  return row[VERB_COLUMN[perm.verb] as 'IsAdd' | 'IsUpdate' | 'IsDelete'] === 1;
}

export async function getSession(astro: AstroGlobal): Promise<AdminSession | undefined> {
  return astro.session?.get(SESSION_KEY);
}

/**
 * 後台頁面的守門。回傳 Response 就代表要中止渲染。
 *
 * 權限不足**原地渲染 403**，不轉址 —— 舊站轉到 /Error/Validation 而那個路由
 * 從未實作，結果「權限不足」與「網址打錯」在使用者眼中完全一樣。
 * 見 docs/06-admin-spec.md §7
 */
export async function requirePermission(
  astro: AstroGlobal,
  route: RouteKey,
): Promise<{ session: AdminSession } | { response: Response }> {
  const session = await getSession(astro);
  if (!session) {
    const next = encodeURIComponent(astro.url.pathname + astro.url.search);
    return { response: astro.redirect(`/backend/Main/Login?next=${next}`, 302) };
  }
  if (session.mustChangePassword) {
    return { response: astro.redirect('/backend/Main/ChangePassword', 302) };
  }
  if (!(await can(session, route))) {
    return { response: new Response(null, { status: 302, headers: { location: '/backend/Forbidden' } }) };
  }
  return { session };
}

/**
 * 側邊導覽。
 *
 * **名稱、分組與順序全部來自 Lims 表** —— 跟舊系統的
 * `Html.SiteMenuAsUnorderedList`（App_Helpers/HtmlHelperExtensions.cs:185）
 * 同一份資料、同一個 ORDER BY Sort。所以編輯者看到的是「網站管理 ▸ 文章維護」，
 * 不是我們自己另外取的短名。網址也照舊：`/backend/{父 Key}/{子 Key}`。
 *
 * 過濾條件仍然是這位編輯者**實際的**權限：進不去的區塊就不會出現，
 * 整個第一層都沒權限時連群組標題都不印。
 */
export interface NavItem {
  label: string;
  href: string;
  route: RouteKey;
}

export interface NavGroup {
  /** Lims 第一層的 Value —— 網站管理 / 系統管理 */
  label: string;
  key: string;
  items: NavItem[];
}

interface LimRow {
  parentKey: string; parentLabel: string;
  childKey: string; childLabel: string;
}

/** Lims 是設定資料，一個 isolate 內查一次就夠。 */
let limTree: LimRow[] | null = null;

async function loadLimTree(): Promise<LimRow[]> {
  if (limTree) return limTree;
  const { results } = await env.DB.prepare(
    `SELECT p."Key" AS parentKey, p.Value AS parentLabel,
            c."Key" AS childKey, c.Value AS childLabel
     FROM Lims c JOIN Lims p ON p.LimID = c.ParentID
     WHERE p.ParentID IS NULL
     ORDER BY p.Sort, p.LimID, c.Sort, c.LimID`,
  ).all<LimRow>();
  limTree = results;
  return results;
}

export async function visibleNav(session: AdminSession | undefined): Promise<NavGroup[]> {
  const rows = await loadLimTree();

  // Lims 的 (父 Key, 子 Key) 就是註冊表的 key。對不上的資料列直接跳過 ——
  // 那代表有人在資料庫加了選單卻沒有對應的路由，寧可不印也不要印出 404。
  const linked = rows
    .map((r) => ({ ...r, route: `${r.parentKey}/${r.childKey}` as RouteKey }))
    .filter((r) => r.route in ROUTE_PERMISSIONS);

  const allowed = await Promise.all(linked.map((r) => can(session, r.route)));

  const groups: NavGroup[] = [];
  linked.forEach((r, i) => {
    if (!allowed[i]) return;
    let g = groups.find((x) => x.key === r.parentKey);
    if (!g) groups.push((g = { label: r.parentLabel, key: r.parentKey, items: [] }));
    g.items.push({
      label: r.childLabel,
      href: `/backend/${r.parentKey}/${r.childKey}`,
      route: r.route,
    });
  });
  return groups;
}
