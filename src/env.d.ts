/// <reference types="astro/client" />
import type { Flash } from './api/app';

declare global {
  namespace App {
    interface Locals {
      /** CSRF token，由 src/middleware.ts 在後台請求時發放 */
      csrf?: string;
      /** 上一個變更操作留下的訊息，由 middleware 讀取並清除 */
      flash?: Flash;
    }
  }
}
export {};
