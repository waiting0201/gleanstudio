/**
 * Hono 的掛載點。所有 /api/** 都進同一個 app —— middleware 鏈在那裡定義一次。
 * 見 src/api/app.ts、docs/10-decisions.md ADR-003
 */
import type { APIRoute } from 'astro';
import app from '../../api/app';

export const prerender = false;

// Astro 的 context 整包傳進去，Hono 那邊才拿得到 session
export const ALL: APIRoute = (ctx) => app.fetch(ctx.request, { astro: ctx });
