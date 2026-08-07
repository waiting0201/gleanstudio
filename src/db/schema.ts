import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

// 單一真相來源。改這裡就要一併產生 migration —— 見 docs/04-data-model.md §6
// 欄位定義取自本機 gleanstudio 的 INFORMATION_SCHEMA，不是從 .edmx 推測。

export const lims = sqliteTable('Lims', {
  limId: integer('LimID').primaryKey({ autoIncrement: true }),
  key: text('Key'),
  value: text('Value'),
  icon: text('Icon'),
  sort: integer('Sort').notNull().default(0),
  parentId: integer('ParentID'),
}, (t) => [
  index('idx_lims_parent_sort').on(t.parentId, t.sort),
  uniqueIndex('uq_lims_parent_key').on(t.parentId, t.key),
]);

export const admins = sqliteTable('Admins', {
  adminId: integer('AdminID').primaryKey({ autoIncrement: true }),
  name: text('Name'),
  username: text('Username').notNull(),
  passwordHash: text('PasswordHash').notNull(),
  email: text('Email'),
  isSuperAdmin: integer('IsSuperAdmin').notNull().default(0),
  mustChangePassword: integer('MustChangePassword').notNull().default(0),
  createdAt: text('CreatedAt').notNull(),
  updatedAt: text('UpdatedAt'),
}, (t) => [uniqueIndex('uq_admins_username').on(t.username)]);

export const adminLims = sqliteTable('AdminLims', {
  adminLimId: text('AdminLimID').primaryKey(),
  adminId: integer('AdminID').notNull().references(() => admins.adminId, { onDelete: 'cascade' }),
  limId: integer('LimID').notNull().references(() => lims.limId),
  isAdd: integer('IsAdd').notNull().default(0),
  isUpdate: integer('IsUpdate').notNull().default(0),
  isDelete: integer('IsDelete').notNull().default(0),
}, (t) => [
  uniqueIndex('uq_adminlims_admin_lim').on(t.adminId, t.limId),
  index('idx_adminlims_admin').on(t.adminId),
]);

export const articleTypes = sqliteTable('ArticleTypes', {
  articleTypeId: text('ArticleTypeID').primaryKey(),
  title: text('Title').notNull(),
  subTitle: text('SubTitle'),
  summary: text('Summary'),
  description: text('Description'),
  // CSS class 名稱存在資料庫裡：r-bg-primary / r-bg-secondary / r-bg-third
  bgClass: text('BgClass'),
  photo: text('Photo'),
  sort: integer('Sort').notNull().default(0),
}, (t) => [index('idx_articletypes_sort').on(t.sort)]);

export const articles = sqliteTable('Articles', {
  articleId: text('ArticleID').primaryKey(),
  articleTypeId: text('ArticleTypeID').notNull().references(() => articleTypes.articleTypeId),
  title: text('Title').notNull(),
  photo: text('Photo').notNull(),
  description: text('Description').notNull(),
  createDate: text('CreateDate').notNull(),
  // 相容性欄位：釘住 CreateDate 並列時的顯示順序，值來自正式站觀察。
  // 見 docs/04-data-model.md §5、docs/10-decisions.md ADR-012
  legacyOrder: integer('LegacyOrder').notNull().default(0),
});

export const services = sqliteTable('Services', {
  serviceId: text('ServiceID').primaryKey(),
  articleTypeId: text('ArticleTypeID').notNull()
    .references(() => articleTypes.articleTypeId, { onDelete: 'cascade' }),
  title: text('Title').notNull(),
  photo: text('Photo').notNull(),
  sort: integer('Sort').notNull().default(0),
}, (t) => [index('idx_services_type_sort').on(t.articleTypeId, t.sort)]);

export const teams = sqliteTable('Teams', {
  teamId: text('TeamID').primaryKey(),
  title: text('Title').notNull(),
  summary: text('Summary').notNull(),
  name: text('Name').notNull(),
  enName: text('EnName'),
  photo: text('Photo').notNull(),
  sort: integer('Sort').notNull().default(0),
}, (t) => [index('idx_teams_sort').on(t.sort)]);

export const projects = sqliteTable('Projects', {
  projectId: text('ProjectID').primaryKey(),
  type: text('Type').notNull(),
  place: text('Place').notNull(),
  title: text('Title').notNull(),
  subTitle: text('SubTitle'),
  sort: integer('Sort').notNull().default(0),
}, (t) => [index('idx_projects_group').on(t.type, t.place, t.title, t.sort)]);

export const abouts = sqliteTable('Abouts', {
  aboutId: integer('AboutID').primaryKey(),   // 非 autoincrement，程式一律用 1
  description: text('Description'),
  photo: text('Photo'),
});
