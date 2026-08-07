/**
 * 權限註冊表 —— 把舊系統默默容忍的歧義變成大聲、可修的錯誤。
 *
 * 舊做法（Filters/CheckSessionAttribute.cs:51-58）有兩個問題：
 *   ac.Replace("Add","")…  會移除 action 名稱**任何位置**的 Add/Edit/Delete
 *                          （一個叫 AddressEdit 的 action 會被切成 ress）
 *   Key.Contains(controller)  是子字串比對 —— 任何 Key 是另一個 Key 的子字串
 *                             就會靜默授予錯誤的權限
 * 以目前 9 筆 Lims 而言碰巧安全，但那是運氣。
 *
 * 這裡改成明確的表 + 精確比對。每一項都必須恰好解析到一個 LimID，
 * 解析到 0 個或多個就讓 CI 失敗（scripts/verify-permissions.mjs）。
 *
 * 見 docs/06-admin-spec.md §5
 */
export type Verb = 'view' | 'add' | 'update' | 'delete';

export interface Permission {
  parent: string;
  child: string;
  verb: Verb;
}

/**
 * ⚠️ `Sort*` 對應到 `update` —— **舊系統的對應表根本沒有涵蓋 Sort\***，
 * 等於排序操作只要有檢視權限就能做。這裡補上。
 */
export const ROUTE_PERMISSIONS = {
  'WebMs/ArticleTypes':       { parent: 'WebMs', child: 'ArticleTypes', verb: 'view' },
  'WebMs/AddArticleTypes':    { parent: 'WebMs', child: 'ArticleTypes', verb: 'add' },
  'WebMs/EditArticleTypes':   { parent: 'WebMs', child: 'ArticleTypes', verb: 'update' },
  'WebMs/DeleteArticleTypes': { parent: 'WebMs', child: 'ArticleTypes', verb: 'delete' },
  'WebMs/SortArticleTypes':   { parent: 'WebMs', child: 'ArticleTypes', verb: 'update' },

  'WebMs/Articles':           { parent: 'WebMs', child: 'Articles', verb: 'view' },
  'WebMs/AddArticles':        { parent: 'WebMs', child: 'Articles', verb: 'add' },
  'WebMs/EditArticles':       { parent: 'WebMs', child: 'Articles', verb: 'update' },
  'WebMs/DeleteArticles':     { parent: 'WebMs', child: 'Articles', verb: 'delete' },

  'WebMs/Services':           { parent: 'WebMs', child: 'Services', verb: 'view' },
  'WebMs/AddServices':        { parent: 'WebMs', child: 'Services', verb: 'add' },
  'WebMs/EditServices':       { parent: 'WebMs', child: 'Services', verb: 'update' },
  'WebMs/DeleteServices':     { parent: 'WebMs', child: 'Services', verb: 'delete' },
  'WebMs/SortServices':       { parent: 'WebMs', child: 'Services', verb: 'update' },

  'WebMs/Teams':              { parent: 'WebMs', child: 'Teams', verb: 'view' },
  'WebMs/AddTeams':           { parent: 'WebMs', child: 'Teams', verb: 'add' },
  'WebMs/EditTeams':          { parent: 'WebMs', child: 'Teams', verb: 'update' },
  'WebMs/DeleteTeams':        { parent: 'WebMs', child: 'Teams', verb: 'delete' },
  'WebMs/SortTeams':          { parent: 'WebMs', child: 'Teams', verb: 'update' },

  'WebMs/Projects':           { parent: 'WebMs', child: 'Projects', verb: 'view' },
  'WebMs/AddProjects':        { parent: 'WebMs', child: 'Projects', verb: 'add' },
  'WebMs/EditProjects':       { parent: 'WebMs', child: 'Projects', verb: 'update' },
  'WebMs/DeleteProjects':     { parent: 'WebMs', child: 'Projects', verb: 'delete' },
  'WebMs/SortProjects':       { parent: 'WebMs', child: 'Projects', verb: 'update' },

  'WebMs/Abouts':             { parent: 'WebMs', child: 'Abouts', verb: 'view' },
  'WebMs/EditAbouts':         { parent: 'WebMs', child: 'Abouts', verb: 'update' },

  'SettingMs/Admins':         { parent: 'SettingMs', child: 'Admins', verb: 'view' },
  'SettingMs/AddAdmins':      { parent: 'SettingMs', child: 'Admins', verb: 'add' },
  'SettingMs/EditAdmins':     { parent: 'SettingMs', child: 'Admins', verb: 'update' },
  'SettingMs/DeleteAdmins':   { parent: 'SettingMs', child: 'Admins', verb: 'delete' },
} as const satisfies Record<string, Permission>;

export type RouteKey = keyof typeof ROUTE_PERMISSIONS;

/** 動詞對應 AdminLims 的欄位。view 只要求資料列存在。 */
export const VERB_COLUMN: Record<Exclude<Verb, 'view'>, string> = {
  add: 'IsAdd',
  update: 'IsUpdate',
  delete: 'IsDelete',
};
