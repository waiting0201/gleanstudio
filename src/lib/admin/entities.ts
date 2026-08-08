/**
 * 後台實體的宣告式定義。
 *
 * 舊系統把同一段 CRUD 在 WebMsController 裡寫了七遍（上傳那段也複製了七次）。
 * 這裡改成一份定義餵給共用的列表、表單與 API —— 要加一個實體是加一筆定義，
 * 不是再複製一遍。
 *
 * **文章不在這裡。** 它有富文本、兩個排序相容性欄位、還有日期，
 * 硬塞進來只會讓這層抽象變形。Projects（87 筆、四層分組）與 Admins（密碼與
 * 權限勾選）同理，各自有自己的頁面。
 *
 * ── 欄位與標籤一律照舊系統 ────────────────────────────────
 * `label`、`fields[].label`、`fields` 的順序、`columns` 的順序與表頭文字，
 * 全部逐字對照 reference/old 的 .cshtml，讓熟舊後台的人不用重新學：
 *   文章分類 Views/WebMs/EditArticleTypes.cshtml:55-106
 *   服務洽談 Views/WebMs/EditServices.cshtml:55-71
 *   人員     Views/WebMs/EditTeams.cshtml:55-98
 *   關於禾勤 Views/WebMs/Abouts.cshtml:55-69
 * 只有兩處刻意不照抄，理由寫在該處的註解。
 */
import type { RouteKey } from '../auth/permissions';
import type { MediaEntity } from '../media';

export type FieldKind = 'text' | 'textarea' | 'richtext' | 'select' | 'image' | 'url';

export interface FieldDef {
  /** 資料庫欄位名 —— 同時是表單的 name */
  column: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  hint?: string;
  /** kind === 'select' 時的選項來源 */
  options?: { value: string; label: string }[];
}

/** 列表的一欄。舊後台的表格長什麼樣，這裡就長什麼樣。 */
export interface ColumnDef {
  /** 表頭文字 —— 舊系統 <th> 的原文 */
  label: string;
  /** 要印的資料欄位 */
  column: string;
  /** photo = 縮圖、date = yyyy-MM-dd、text = 原樣 */
  kind?: 'text' | 'photo' | 'date';
  /** 這一欄是不是可以點進去編輯的主要欄位 */
  primary?: boolean;
  /** <th width> —— 舊系統標了寬度的就照抄 */
  width?: string;
  center?: boolean;
}

export interface EntityDef {
  key: string;
  table: string;
  idColumn: string;
  /** 人看的名稱，用在標題與訊息 —— 舊系統 <legend> / <h2> 的用字 */
  label: string;
  /** 左側選單上的名稱，也就是 Lims.Value */
  menuLabel: string;
  /** 列表的欄位。第一個 primary 的欄位當標題 */
  columns: ColumnDef[];
  fields: FieldDef[];
  routes: { list: RouteKey; add: RouteKey; edit: RouteKey; delete: RouteKey };
  /** 有圖片的實體。photoColumn 是存檔名的欄位 */
  media?: { entity: MediaEntity; photoColumn: string };
  /** 有 Sort 欄位就能上下移動 */
  sortable?: boolean;
  /** 列表要多帶的關聯欄位（目前只有「分類」）。key 是 SELECT 的別名 */
  join?: { sql: string; select: string };
  /** 只有一筆的實體（Abouts）—— 沒有列表，直接進表單 */
  singleton?: number;
  /** 這一筆在公開站上的網址。列表與表單都會印出來 */
  liveUrl: (row: Record<string, unknown>) => string;
  /** 這個實體出現在公開站的哪裡，一句話 */
  publicNote: string;
}

const BG_CLASSES = [
  { value: 'r-bg-primary', label: 'r-bg-primary（第一個分類的底色）' },
  { value: 'r-bg-secondary', label: 'r-bg-secondary（第二個）' },
  { value: 'r-bg-third', label: 'r-bg-third（第三個）' },
];

export function buildEntities(articleTypes: { articleTypeId: string; title: string }[]): Record<string, EntityDef> {
  const typeOptions = articleTypes.map((t) => ({ value: t.articleTypeId, label: t.title }));

  return {
    ArticleTypes: {
      key: 'ArticleTypes',
      table: 'ArticleTypes',
      idColumn: 'ArticleTypeID',
      label: '文章分類',
      menuLabel: '文章分類維護',
      publicNote: '首頁的三張卡片、選單的「專業服務項目」、以及 /Home/Service',
      routes: {
        list: 'WebMs/ArticleTypes', add: 'WebMs/AddArticleTypes',
        edit: 'WebMs/EditArticleTypes', delete: 'WebMs/DeleteArticleTypes',
      },
      media: { entity: 'ArticleTypes', photoColumn: 'Photo' },
      sortable: true,
      liveUrl: (r) => `/Home/Service?ArticleTypeID=${r.ArticleTypeID}`,
      // 舊系統：Views/WebMs/ArticleTypes.cshtml:43-46（排序 / 標題 / 編輯 / 刪除）
      columns: [
        { label: '標題', column: 'Title', primary: true },
      ],
      // 舊系統：Views/WebMs/EditArticleTypes.cshtml:55-106
      fields: [
        { column: 'Title', label: '標題', kind: 'text', required: true },
        {
          column: 'SubTitle', label: '子標題', kind: 'textarea',
          hint: '會原樣輸出成 HTML —— 首頁卡片就是靠這裡的 <br> 斷行的。',
        },
        { column: 'Summary', label: '簡介', kind: 'textarea', hint: '首頁三張卡片上的那段字。' },
        {
          column: 'BgClass', label: '背景Class', kind: 'select', options: BG_CLASSES,
          hint: '對應 style.css 裡的三個 class。改成沒有定義的值，卡片就會沒有底色。',
        },
        { column: 'Photo', label: '代表圖', kind: 'image' },
        { column: 'Description', label: '內文', kind: 'richtext' },
      ],
    },

    Services: {
      key: 'Services',
      table: 'Services',
      idColumn: 'ServiceID',
      label: '服務洽談',
      menuLabel: '服務洽談維護',
      publicNote: '/Home/Service 底下的圖片格 —— 每三個一列',
      routes: {
        list: 'WebMs/Services', add: 'WebMs/AddServices',
        edit: 'WebMs/EditServices', delete: 'WebMs/DeleteServices',
      },
      media: { entity: 'Services', photoColumn: 'Photo' },
      sortable: true,
      join: {
        select: 't.Title AS TypeTitle',
        sql: 'LEFT JOIN ArticleTypes t ON t.ArticleTypeID = e.ArticleTypeID',
      },
      liveUrl: (r) => `/Home/Service?ArticleTypeID=${r.ArticleTypeID}`,
      // 舊系統：Views/WebMs/Services.cshtml:55-60（排序 / 代表圖 / 分類 / 標題 / 編輯 / 刪除）
      columns: [
        { label: '代表圖', column: 'Photo', kind: 'photo', width: '10%', center: true },
        { label: '分類', column: 'TypeTitle', width: '20%' },
        { label: '標題', column: 'Title', primary: true },
      ],
      // 舊系統：Views/WebMs/EditServices.cshtml:55-71
      fields: [
        { column: 'ArticleTypeID', label: '文章分類', kind: 'select', required: true, options: typeOptions },
        { column: 'Title', label: '標題', kind: 'text', required: true },
        { column: 'Photo', label: '代表圖', kind: 'image' },
      ],
    },

    Teams: {
      key: 'Teams',
      table: 'Teams',
      idColumn: 'TeamID',
      label: '人員',
      menuLabel: '人員維護',
      publicNote: '/Home/Team —— 這一頁沒有任何導覽連結指過去（09-known-issues 1.6）',
      routes: {
        list: 'WebMs/Teams', add: 'WebMs/AddTeams',
        edit: 'WebMs/EditTeams', delete: 'WebMs/DeleteTeams',
      },
      media: { entity: 'Teams', photoColumn: 'Photo' },
      sortable: true,
      liveUrl: () => '/Home/Team',
      /*
       * 舊系統：Views/WebMs/Teams.cshtml:55-59（排序 / 代表圖 / 標題 / 編輯 / 刪除）。
       * ⚠️ 唯一不照抄的地方：舊表頭寫「標題」但那一格印的是 `entity.Name`
       * （Teams.cshtml:75），表頭跟內容對不上。這裡照抄它印的東西，
       * 把表頭正名為「姓名」，並多印一欄「標題」（＝職稱）—— 那才是它另一個欄位。
       */
      columns: [
        { label: '代表圖', column: 'Photo', kind: 'photo', width: '10%', center: true },
        { label: '姓名', column: 'Name', primary: true, width: '20%' },
        { label: '標題', column: 'Title' },
      ],
      // 舊系統：Views/WebMs/EditTeams.cshtml:55-98
      fields: [
        { column: 'Title', label: '標題', kind: 'text', required: true, hint: '公開頁上顯示在姓名底下的職稱。' },
        { column: 'Summary', label: '簡介', kind: 'textarea', required: true },
        { column: 'Photo', label: '代表圖', kind: 'image' },
        { column: 'Name', label: '姓名', kind: 'text', required: true },
        { column: 'EnName', label: '英文姓名', kind: 'text' },
      ],
    },

    Abouts: {
      key: 'Abouts',
      table: 'Abouts',
      idColumn: 'AboutID',
      label: '關於禾勤',
      menuLabel: '關於禾勤',
      publicNote: '/Home/About 與首頁的那段文字',
      routes: {
        list: 'WebMs/Abouts', add: 'WebMs/Abouts',
        edit: 'WebMs/EditAbouts', delete: 'WebMs/Abouts',
      },
      media: { entity: 'Abouts', photoColumn: 'Photo' },
      singleton: 1,
      liveUrl: () => '/Home/About',
      columns: [],
      // 舊系統：Views/WebMs/Abouts.cshtml:55-69（內文 / 代表圖）
      fields: [
        { column: 'Description', label: '內文', kind: 'richtext' },
        { column: 'Photo', label: '代表圖', kind: 'image' },
      ],
    },
  };
}
