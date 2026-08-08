/**
 * 後台實體頁面的共用載入邏輯 —— 守門、取定義、取資料。
 * 讓每個 route 檔維持在十幾行，不要把同一段複製六遍。
 */
import { env } from 'cloudflare:workers';
import type { AstroGlobal } from 'astro';
import { requirePermission, can, type AdminSession } from '../auth/session';
import { getArticleTypes } from '../../db/queries';
import { buildEntities, type EntityDef } from './entities';

export interface Loaded {
  def: EntityDef;
  session: AdminSession;
  may: { add: boolean; edit: boolean; delete: boolean };
}

export async function loadEntity(astro: AstroGlobal, key: string, verb: 'list' | 'add' | 'edit'):
  Promise<Loaded | { response: Response }> {
  const def = buildEntities(await getArticleTypes())[key];
  if (!def) return { response: new Response('未知的實體。', { status: 404 }) };

  const guard = await requirePermission(astro, def.routes[verb]);
  if ('response' in guard) return guard;

  const [add, edit, del] = await Promise.all([
    can(guard.session, def.routes.add),
    can(guard.session, def.routes.edit),
    can(guard.session, def.routes.delete),
  ]);
  return { def, session: guard.session, may: { add, edit, delete: del } };
}

/** 列表的主要欄位 —— 標題那一格印的東西，也拿來當頁面標題。 */
export function primaryColumn(def: EntityDef): string {
  return def.columns.find((c) => c.primary)?.column ?? def.columns[0]?.column ?? def.idColumn;
}

/**
 * 列表。可排序的依 Sort，否則依標題欄位 —— 跟公開站同一個順序。
 * `def.join` 是為了「分類」那一欄（舊後台的 Services 表格有這一欄），
 * 主表一律別名成 `e`。
 */
export async function listRows(def: EntityDef): Promise<Record<string, any>[]> {
  const order = def.sortable ? `e.Sort, e.${def.idColumn}` : `e.${primaryColumn(def)}`;
  const select = def.join ? `e.*, ${def.join.select}` : 'e.*';
  const { results } = await env.DB.prepare(
    `SELECT ${select} FROM ${def.table} e ${def.join?.sql ?? ''} ORDER BY ${order}`,
  ).all();
  return results as Record<string, any>[];
}

export async function getRow(def: EntityDef, id: string): Promise<Record<string, any> | null> {
  const row = await env.DB.prepare(`SELECT * FROM ${def.table} WHERE ${def.idColumn} = ?1`).bind(id).first();
  return (row as Record<string, any>) ?? null;
}
