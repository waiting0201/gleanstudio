// 舊網址 /Upload/{Entity}/{ID}/{Photo} 完全不變 —— R2 的 key 就是這個路徑本身，
// 所以「這張圖在不在」永遠可以用一行 wrangler r2 object get 回答。
// 見 docs/02-architecture.md §5
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

// 路徑片段用大小寫不敏感比對（IIS 不敏感），但查 R2 之前正規化回正式大小寫 ——
// R2 的 key 本身是大小寫敏感的。
const ENTITIES = new Map(
  ['Abouts', 'ArticleTypes', 'Articles', 'Services', 'Teams', 'Projects'].map((e) => [e.toLowerCase(), e]),
);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^\d+$/i;
const PHOTO = /^\d{14}\.(jpe?g|png|gif|webp)$/i;

export const GET: APIRoute = async ({ params, request }) => {
  const entity = ENTITIES.get(String(params.entity).toLowerCase());
  if (!entity || !ID.test(params.id ?? '') || !PHOTO.test(params.photo ?? '')) {
    return new Response(null, { status: 404 });
  }

  const key = `Upload/${entity}/${params.id!.toLowerCase()}/${params.photo}`;
  const wantsRange = request.headers.has('range');
  const obj = await env.MEDIA.get(key, {
    onlyIf: request.headers,   // If-None-Match / If-Modified-Since
    range: request.headers,    // Range
  });
  if (!obj) return new Response(null, { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  // immutable 是安全的：後台換圖時寫的是**新的**時間戳檔名並更新資料庫欄位，
  // 同一個網址永遠不會對應到不同的 bytes。
  headers.set('cache-control', 'public, max-age=31536000, immutable');

  if (!('body' in obj)) return new Response(null, { status: 304, headers });

  // ⚠️ 只看 obj.range 不夠 —— 沒帶 Range 的請求在 workerd 裡 obj.range 一樣有值，
  //    照抄會讓每一張圖都回 206。以「請求有沒有 Range 標頭」為準。
  if (wantsRange && obj.range) {
    // R2Range 有三種形狀：{offset,length} / {offset} / {suffix}。三種都要算得出 content-range。
    const r = obj.range as { offset?: number; length?: number; suffix?: number };
    const offset = r.suffix !== undefined ? obj.size - r.suffix : r.offset ?? 0;
    const length = r.suffix ?? r.length ?? obj.size - offset;
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    return new Response(obj.body, { status: 206, headers });
  }
  return new Response(obj.body, { status: 200, headers });
};
