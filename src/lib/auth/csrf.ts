/**
 * Double-submit token，綁在 session 上。
 *
 * 舊系統**任何地方都沒有** anti-forgery token，而且刪除是 GET
 * （docs/06-admin-spec.md §9）。
 *
 * Astro 預設的 `security.checkOrigin` 已經擋掉大部分跨站 POST，但那依賴
 * 瀏覽器一定送 `Origin`。token 是第二道，兩道都要。
 */
const TOKEN_KEY = 'csrf';
export const CSRF_FIELD = '__csrf';

type SessionLike = {
  get(key: string): Promise<string | undefined> | string | undefined;
  set(key: string, value: string): void;
};

/**
 * 讀或發一個 token。
 *
 * ⚠️ **只能在 middleware 裡呼叫。** session.set() 一旦在元件渲染期間執行，
 * 回應的 header 已經送出去了，Astro 會丟一個 warning 然後把寫入丟掉 ——
 * token 渲染得出來，但 session 裡沒有，於是每一次 POST 都 403。
 * 這個 bug 不會讓頁面壞掉，只會讓所有變更操作靜默失敗。
 */
export async function ensureCsrfToken(session: SessionLike | undefined): Promise<string> {
  if (!session) return '';
  const existing = await session.get(TOKEN_KEY);
  if (typeof existing === 'string' && existing.length === 43) return existing;

  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  session.set(TOKEN_KEY, token);
  return token;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyCsrf(session: SessionLike | undefined, submitted: unknown): Promise<boolean> {
  if (!session || typeof submitted !== 'string' || submitted.length === 0) return false;
  const expected = await session.get(TOKEN_KEY);
  if (typeof expected !== 'string') return false;
  return timingSafeEqual(expected, submitted);
}
