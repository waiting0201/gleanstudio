/// <reference types="astro/client" />
import type { Flash } from './api/app';

declare global {
  /**
   * Worker secrets。
   *
   * `wrangler types` 只從 wrangler.jsonc 產生 Env，而 secret **不在那裡**
   * （也不該在），所以型別上看不到它們 —— astro check 會說 Property 不存在。
   * 在這裡補宣告，順便讓「這個專案需要哪些 secret」有一個唯一的、看得到的地方。
   *
   * ⚠️ 一定要放在 `declare global` 裡面。這個檔有 `export {}`，是個 module，
   *    module 裡的 `declare namespace` 不會併進全域。
   *
   * 兩個都是 optional：沒設的時候程式要安全降級，不是崩潰。
   *   RECAPTCHA_SECRET  沒設 → 所有送出都判定驗證碼錯誤（fail closed）
   *   SENDGRID_API_KEY  沒設 → 不寄信（docs/09-known-issues.md 4.13）
   *   CONTACT_TO        沒設 → 不寄信。聯絡表單的收件人（可逗號分隔多個）。
   *                     **測試期間是開發者的信箱，Phase 8 換正式網域時要改成
   *                     禾勤的信箱** —— 見 docs/11-roadmap.md Phase 8
   *
   * 設定：wrangler secret put <NAME>
   */
  namespace Cloudflare {
    interface Env {
      RECAPTCHA_SECRET?: string;
      SENDGRID_API_KEY?: string;
      CONTACT_TO?: string;
    }
  }

  namespace App {
    interface Locals {
      /** CSRF token，由 src/middleware.ts 在後台請求時發放 */
      csrf?: string;
      /** 上一個變更操作留下的訊息，由 middleware 讀取並清除 */
      flash?: Flash;
    }
  }
}
/**
 * Worker secrets。
 *
 * `wrangler types` 只從 wrangler.jsonc 產生 Env，而 secret **不在那裡**
 * （也不該在），所以型別上看不到它們 —— astro check 會說 Property 不存在。
 * 在這裡補宣告，順便讓「這個專案需要哪些 secret」有一個唯一的、看得到的地方。
 *
 * 兩個都是 optional：沒設的時候程式要能安全降級，不是崩潰。
 *   RECAPTCHA_SECRET  沒設 → 所有聯絡表單送出都判定驗證碼錯誤（fail closed）
 *   SENDGRID_API_KEY  沒設 → 不寄信（docs/09-known-issues.md 4.13）
 *
 * 設定：wrangler secret put <NAME>
 */
export {};
