/**
 * 圖片上傳。舊系統把同一段邏輯在 WebMsController 裡複製了 **7 次**，
 * 這裡收斂成一個 helper。見 docs/06-admin-spec.md §8
 *
 * | 項目 | 舊 | 新 |
 * |---|---|---|
 * | 型別檢查 | **完全沒有** | **magic bytes**，不只看副檔名 |
 * | 大小上限 | 100 MB | 10 MB |
 * | 檔名 | yyyyMMddHHmmss.{ext} | **不變** —— 資料庫欄位格式因此不變，真要回退到舊系統路徑也還解析得到 |
 * | 舊檔 | 刪除 | 刪除 |
 */
import { env } from 'cloudflare:workers';

export const MEDIA_ENTITIES = ['Abouts', 'ArticleTypes', 'Articles', 'Services', 'Teams', 'Projects'] as const;
export type MediaEntity = (typeof MEDIA_ENTITIES)[number];

export const MAX_BYTES = 10 * 1024 * 1024;

/**
 * 只認這四種，而且是看**檔頭位元組**不是副檔名。
 * 副檔名是使用者說了算，magic bytes 不是。
 */
const SIGNATURES: { ext: string; type: string; test: (b: Uint8Array) => boolean }[] = [
  { ext: 'jpg', type: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', type: 'image/png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: 'gif', type: 'image/gif', test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  {
    ext: 'webp',
    type: 'image/webp',
    // RIFF....WEBP
    test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
];

export class MediaError extends Error {}

/** yyyyMMddHHmmss —— 逐字沿用舊站的檔名慣例，用 UTC（資料庫其他日期也是 UTC）。 */
function timestampName(ext: string, now: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`
    + `${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}.${ext}`;
}

export const mediaKey = (entity: MediaEntity, id: string, photo: string) =>
  `Upload/${entity}/${String(id).toLowerCase()}/${photo}`;

/**
 * 存一張圖，回傳新檔名供呼叫端寫進資料庫。
 * `previousPhoto` 有給就在寫入成功後刪掉舊檔。
 */
export async function putEntityPhoto(
  entity: MediaEntity,
  id: string,
  file: File,
  previousPhoto?: string | null,
  now: Date = new Date(),
): Promise<string> {
  if (file.size === 0) throw new MediaError('檔案是空的。');
  if (file.size > MAX_BYTES) {
    throw new MediaError(`圖片 ${(file.size / 1024 / 1024).toFixed(1)} MB，超過 10 MB 上限。請先壓縮。`);
  }

  const buf = new Uint8Array(await file.arrayBuffer());
  const sig = SIGNATURES.find((s) => s.test(buf));
  if (!sig) {
    throw new MediaError('這不是 JPEG / PNG / GIF / WebP。副檔名改掉沒有用 —— 這裡看的是檔案內容。');
  }

  const photo = timestampName(sig.ext, now);
  await env.MEDIA.put(mediaKey(entity, id, photo), buf, {
    httpMetadata: { contentType: sig.type },
  });

  // 先寫新的再刪舊的 —— 反過來的話寫入失敗就兩張都沒了
  if (previousPhoto && previousPhoto !== photo) {
    await env.MEDIA.delete(mediaKey(entity, id, previousPhoto)).catch(() => {});
  }
  return photo;
}

export async function deleteEntityPhoto(entity: MediaEntity, id: string, photo: string | null | undefined) {
  if (!photo) return;
  await env.MEDIA.delete(mediaKey(entity, id, photo)).catch(() => {});
}

/**
 * ⚠️ 富文本不准內嵌 base64 圖片。
 *
 * 舊後台的 Summernote 把貼上的圖片直接內嵌進 Articles.Description，
 * 現況最大一篇 **1.73 MB**，而 D1 的單列上限是 2 MB —— **只剩 13% 餘裕**。
 * 見 docs/06-admin-spec.md §8、docs/09-known-issues.md 1.13
 */
export const DESCRIPTION_LIMIT = 1.5 * 1024 * 1024;

export function checkDescription(html: string): string | null {
  if (/<img[^>]+src\s*=\s*["']?data:/i.test(html)) {
    return '內文裡有直接內嵌的圖片。請用編輯器的插入圖片功能 —— 內嵌的圖會把整篇撐爆資料庫的單列上限。';
  }
  if (html.length > DESCRIPTION_LIMIT) {
    return `內文 ${(html.length / 1024 / 1024).toFixed(2)} MB，超過 1.5 MB 上限。圖片請用插入功能，不要直接貼進來。`;
  }
  return null;
}
