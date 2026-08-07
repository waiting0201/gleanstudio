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

/** 側邊導覽只列出這位編輯者真的能進的區塊 —— 導覽列本身就是權限模型。 */
export interface NavItem {
  label: string;
  href: string;
  route: RouteKey;
}

export const NAV: NavItem[] = [
  { label: '文章', href: '/backend/WebMs/Articles', route: 'WebMs/Articles' },
  { label: '文章分類', href: '/backend/WebMs/ArticleTypes', route: 'WebMs/ArticleTypes' },
  { label: '案例', href: '/backend/WebMs/Projects', route: 'WebMs/Projects' },
  { label: '服務項目', href: '/backend/WebMs/Services', route: 'WebMs/Services' },
  { label: '團隊成員', href: '/backend/WebMs/Teams', route: 'WebMs/Teams' },
  { label: '關於禾勤', href: '/backend/WebMs/Abouts', route: 'WebMs/Abouts' },
  { label: '管理者', href: '/backend/SettingMs/Admins', route: 'SettingMs/Admins' },
];

export async function visibleNav(session: AdminSession | undefined): Promise<NavItem[]> {
  const allowed = await Promise.all(NAV.map((n) => can(session, n.route)));
  return NAV.filter((_, i) => allowed[i]);
}
