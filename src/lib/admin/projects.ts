/** 案例表單用的既有值 —— 依 LegacyOrder 的先後，跟公開頁的分組順序一致。 */
import { env } from 'cloudflare:workers';

export async function existingValues() {
  const pick = async (col: string) => {
    const { results } = await env.DB.prepare(
      `SELECT ${col} AS v, MIN(LegacyOrder) AS o FROM Projects
       WHERE ${col} IS NOT NULL AND ${col} <> '' GROUP BY ${col} ORDER BY o`,
    ).all<{ v: string }>();
    return results.map((r) => r.v);
  };
  const [types, places, titles] = await Promise.all([pick('Type'), pick('Place'), pick('Title')]);
  return { types, places, titles };
}
