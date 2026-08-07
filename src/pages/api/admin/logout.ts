/**
 * 登出。**POST，不是 GET** —— 舊站的 GET 登出可以被 CSRF
 * （docs/06-admin-spec.md §1、docs/09-known-issues.md 4.3）。
 *
 * 舊站的 Logout 只設 IsLogin = false 並移除 Username，把 AdminID 與 AdminLims
 * 留在 session 裡。這裡直接 destroy。
 */
import type { APIRoute } from 'astro';

export const prerender = false;

export const POST: APIRoute = async ({ session, redirect }) => {
  await session?.destroy();
  return redirect('/backend/Main/Login', 303);
};
