/** 管理者頁面共用：Lims 樹與某位管理者已被授予的權限。 */
import { env } from 'cloudflare:workers';

export interface LimNode { LimID: number; Key: string; Value: string; ParentValue: string }
export type Grant = { view: boolean; add: boolean; update: boolean; delete: boolean };

export async function limTree(): Promise<LimNode[]> {
  const { results } = await env.DB.prepare(
    `SELECT c.LimID, c."Key", c.Value, p.Value AS ParentValue
     FROM Lims c JOIN Lims p ON p.LimID = c.ParentID
     WHERE p.ParentID IS NULL
     ORDER BY p.Sort, c.Sort`,
  ).all<LimNode>();
  return results;
}

export async function grantsFor(adminId: number): Promise<Record<number, Grant>> {
  const { results } = await env.DB.prepare(
    'SELECT LimID, IsAdd, IsUpdate, IsDelete FROM AdminLims WHERE AdminID = ?1',
  ).bind(adminId).all<{ LimID: number; IsAdd: number; IsUpdate: number; IsDelete: number }>();

  // 檢視 = 資料列存在。這是舊系統的語意，照抄。
  return Object.fromEntries(results.map((r) => [
    r.LimID,
    { view: true, add: r.IsAdd === 1, update: r.IsUpdate === 1, delete: r.IsDelete === 1 },
  ]));
}
