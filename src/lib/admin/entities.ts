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

export interface EntityDef {
  key: string;
  table: string;
  idColumn: string;
  /** 人看的名稱，用在標題與訊息 */
  label: string;
  /** 列表頁一列要顯示什麼 —— 第一欄當標題 */
  listColumns: string[];
  fields: FieldDef[];
  routes: { list: RouteKey; add: RouteKey; edit: RouteKey; delete: RouteKey };
  /** 有圖片的實體。photoColumn 是存檔名的欄位 */
  media?: { entity: MediaEntity; photoColumn: string };
  /** 有 Sort 欄位就能上下移動 */
  sortable?: boolean;
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
      listColumns: ['Title', 'Summary'],
      publicNote: '首頁的三張卡片、選單的「專業服務項目」、以及 /Home/Service',
      routes: {
        list: 'WebMs/ArticleTypes', add: 'WebMs/AddArticleTypes',
        edit: 'WebMs/EditArticleTypes', delete: 'WebMs/DeleteArticleTypes',
      },
      media: { entity: 'ArticleTypes', photoColumn: 'Photo' },
      sortable: true,
      liveUrl: (r) => `/Home/Service?ArticleTypeID=${r.ArticleTypeID}`,
      fields: [
        { column: 'Title', label: '名稱', kind: 'text', required: true },
        {
          column: 'SubTitle', label: '英文副標', kind: 'textarea',
          hint: '會原樣輸出成 HTML —— 首頁卡片就是靠這裡的 <br> 斷行的。',
        },
        { column: 'Summary', label: '首頁卡片的簡述', kind: 'textarea' },
        { column: 'Description', label: '分類頁的說明', kind: 'richtext' },
        {
          column: 'BgClass', label: '底色 class', kind: 'select', options: BG_CLASSES,
          hint: '對應 style.css 裡的三個 class。改成沒有定義的值，卡片就會沒有底色。',
        },
      ],
    },

    Services: {
      key: 'Services',
      table: 'Services',
      idColumn: 'ServiceID',
      label: '服務項目',
      listColumns: ['Title'],
      publicNote: '/Home/Service 底下的圖片格 —— 每三個一列',
      routes: {
        list: 'WebMs/Services', add: 'WebMs/AddServices',
        edit: 'WebMs/EditServices', delete: 'WebMs/DeleteServices',
      },
      media: { entity: 'Services', photoColumn: 'Photo' },
      sortable: true,
      liveUrl: (r) => `/Home/Service?ArticleTypeID=${r.ArticleTypeID}`,
      fields: [
        { column: 'ArticleTypeID', label: '所屬分類', kind: 'select', required: true, options: typeOptions },
        { column: 'Title', label: '名稱', kind: 'text', required: true },
      ],
    },

    Teams: {
      key: 'Teams',
      table: 'Teams',
      idColumn: 'TeamID',
      label: '團隊成員',
      listColumns: ['Name', 'Title'],
      publicNote: '/Home/Team —— 這一頁沒有任何導覽連結指過去（09-known-issues 1.6）',
      routes: {
        list: 'WebMs/Teams', add: 'WebMs/AddTeams',
        edit: 'WebMs/EditTeams', delete: 'WebMs/DeleteTeams',
      },
      media: { entity: 'Teams', photoColumn: 'Photo' },
      sortable: true,
      liveUrl: () => '/Home/Team',
      fields: [
        { column: 'Name', label: '姓名', kind: 'text', required: true },
        { column: 'EnName', label: '英文名', kind: 'text' },
        { column: 'Title', label: '職稱', kind: 'text', required: true },
        { column: 'Summary', label: '簡介', kind: 'textarea', required: true },
      ],
    },

    Abouts: {
      key: 'Abouts',
      table: 'Abouts',
      idColumn: 'AboutID',
      label: '關於禾勤',
      listColumns: [],
      publicNote: '/Home/About 與首頁的那段文字',
      routes: {
        list: 'WebMs/Abouts', add: 'WebMs/Abouts',
        edit: 'WebMs/EditAbouts', delete: 'WebMs/Abouts',
      },
      media: { entity: 'Abouts', photoColumn: 'Photo' },
      singleton: 1,
      liveUrl: () => '/Home/About',
      fields: [
        { column: 'Description', label: '內容', kind: 'richtext' },
      ],
    },
  };
}
