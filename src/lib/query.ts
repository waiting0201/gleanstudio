/**
 * ASP.NET 的 model binding 對查詢參數名稱不分大小寫（`?articleid=` 也吃），
 * URLSearchParams 分。要與舊站行為一致就得自己掃。
 * 見 docs/03-url-contract.md §3.3
 */
export function getParam(url: URL, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [k, v] of url.searchParams) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

/**
 * 舊站的 `int p = 1` model binding：解析不出整數就回退成預設值。
 * 實測 `?p=abc` 的輸出與 `?p=1` byte 相同。
 *
 * `?p=0` 舊站會 500（ToPagedList(0, …) 丟例外）。我們刻意不重現當機，
 * 一律視為第 1 頁 —— 記在 docs/09-known-issues.md 4.1c。
 */
export function getPage(url: URL): number {
  const raw = getParam(url, 'p');
  if (raw === null) return 1;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GUID 一律正規化成小寫；格式不對回 null。 */
export function getGuid(url: URL, name: string): string | null {
  const raw = getParam(url, name);
  if (raw === null || !GUID_RE.test(raw)) return null;
  return raw.toLowerCase();
}
