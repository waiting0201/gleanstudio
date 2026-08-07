/**
 * PBKDF2-SHA256 @ 100,000 迭代。格式 `pbkdf2$100000$<saltB64>$<hashB64>`。
 *
 * 100,000 低於 OWASP 對 PBKDF2-SHA256 建議的 600,000，**而且 Workers 不允許再高**
 * —— Web Crypto 的 PBKDF2 在 workerd 硬性上限就是 100,000（cloudflare/workerd#1346）。
 * scrypt 要 50–100 ms CPU，免費方案的 10 ms 上限跑不完。
 *
 * 即便如此仍遠優於現況（nvarchar(20) 明碼 + 字串相等比對）。
 * 雜湊字串帶演算法前綴，所以改用 Workers Paid 之後可以在登入成功時漸進式重算成
 * scrypt。見 docs/06-admin-spec.md §3、docs/09-known-issues.md 3.4
 */
const ALGO = 'pbkdf2';
const ITERATIONS = 100_000;
const KEY_BITS = 256;
const SALT_BYTES = 16;

const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, KEY_BITS);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const bits = await derive(password, salt, ITERATIONS);
  return `${ALGO}$${ITERATIONS}$${b64(salt.buffer as ArrayBuffer)}$${b64(bits)}`;
}

/** 長度不同就直接不同，長度相同時逐位元 XOR —— 不要短路。 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== ALGO) return false;

  const iterations = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations < 1 || iterations > ITERATIONS) return false;

  try {
    const bits = await derive(password, unb64(parts[2]), iterations);
    return timingSafeEqual(new Uint8Array(bits), unb64(parts[3]));
  } catch {
    return false;
  }
}
