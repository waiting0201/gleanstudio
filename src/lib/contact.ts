/**
 * 聯絡表單的伺服器端邏輯 —— 對應 HomeController.Contact [HttpPost] 與
 * Models/Partial/Contact.cs 的 DataAnnotations。
 *
 * 這是全站唯一沒有 oracle 的地方：不能對正式站發 POST（會寄真信、燒 reCAPTCHA
 * 配額），期望輸出只能從原始碼推導。見 docs/03-url-contract.md §7.1
 */

export const FIELDS = ['Name', 'Email', 'Title', 'Phone', 'Message'] as const;
export type Field = (typeof FIELDS)[number];
export type Values = Record<Field, string>;
export type Errors = Partial<Record<Field, string>>;

/** ErrorMessage 逐字取自 Models/Partial/Contact.cs */
const REQUIRED: Record<Field, string> = {
  Name: '請輸入姓名',
  Email: '請輸入Email',
  Title: '請輸入主旨',
  Phone: '請輸入電話',
  Message: '請輸入訊息',
};
const EMAIL_FORMAT = 'Email格式錯誤';

/**
 * .NET Framework 4.5+ 的 EmailAddressAttribute **不是**用正規表示式，
 * 而是這三個條件：只有一個 `@`、不在開頭、不在結尾。
 *
 * 所以 `a@b` 在伺服器端是合法的。頁面上的 `data-val-email` 屬性帶的是那條
 * 嚴格很多的 client-side 正規表示式，但 _Scripts.cshtml **沒有載入**
 * jquery.validate.unobtrusive —— 所有 data-val-* 屬性從來沒有生效過，
 * 驗證百分之百在伺服器端。照抄寬鬆的那條。
 */
function isValidEmail(s: string): boolean {
  const i = s.indexOf('@');
  return i > 0 && i !== s.length - 1 && i === s.lastIndexOf('@');
}

/**
 * RequiredAttribute 對字串是 `value.Trim().Length != 0`，而 ASP.NET 的
 * DefaultModelBinder 預設把空字串轉成 null —— 兩條規則疊起來就是「全空白也算沒填」。
 *
 * 每個欄位只會有一個訊息：ValidationMessageFor 只渲染第一筆錯誤。
 * Email 為空時 EmailAddressAttribute 對 null 回傳 true，所以拿到的是 Required 的訊息。
 */
export function validate(values: Values): Errors {
  const errors: Errors = {};
  for (const f of FIELDS) {
    if (values[f].trim().length === 0) {
      errors[f] = REQUIRED[f];
    } else if (f === 'Email' && !isValidEmail(values[f])) {
      errors[f] = EMAIL_FORMAT;
    }
  }
  return errors;
}

export function readForm(form: FormData): Values {
  return Object.fromEntries(FIELDS.map((f) => [f, String(form.get(f) ?? '')])) as Values;
}

/**
 * 判定條件與舊站逐字相同：`Success && Action === 'login' && Score > 0.5`。
 * 舊站把例外吞掉回 false，這裡也是 —— fail closed。
 *
 * secret 只能來自 `wrangler secret`。舊碼裡那組已外洩，見 docs/09-known-issues.md §2.3。
 */
export async function verifyCaptcha(token: string, remoteIp: string | null, secret: string | undefined): Promise<boolean> {
  if (!secret) {
    console.error('RECAPTCHA_SECRET 未設定 —— 所有聯絡表單送出都會被判定為驗證碼錯誤');
    return false;
  }
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.set('remoteip', remoteIp);

    const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const r = (await res.json()) as { success?: boolean; action?: string; score?: number };
    return r.success === true && r.action === 'login' && (r.score ?? 0) > 0.5;
  } catch (e) {
    console.error('reCAPTCHA 驗證失敗', e);
    return false;
  }
}

/** 信件內容逐字對應 HomeController.cs:205-209 的 StringBuilder。 */
export function mailBody(values: Values): string {
  return [
    `姓名：${values.Name}`,
    `Email：${values.Email}`,
    `主旨：${values.Title}`,
    `聯絡電話：${values.Phone}`,
    `訊息：${values.Message}`,
  ].join('\n') + '\n';
}

/**
 * ⚠️ **這裡刻意不重現舊站的行為。**
 *
 * 舊站把信寄給 `entity.Email` —— **訪客自己填的信箱**，禾勤根本不在收件人裡
 * （HomeController.cs:212）。加上呼叫端沒有 await、寄件網域是代理商的，
 * 合理推斷這張表單從未把任何一筆詢問送到禾勤手上。見 docs/09-known-issues.md §3.1
 *
 * 照抄它只會讓事情更糟：新站有 await，所以訪客會**真的**收到一封他們從來
 * 沒收過、內容是自己剛填的表單、寄件人是陌生網域的信，而禾勤還是收不到。
 * 那是新增的困惑，不是修復。
 *
 * 所以收件人改由 `CONTACT_TO` 決定，並把訪客的信箱放進 `reply_to` ——
 * 禾勤按「回覆」就直接回到客戶。
 *
 * **兩個閘門，任一個沒設就不寄**（fail-safe，不是預設寄給誰）：
 *   SENDGRID_API_KEY  沒設 → 不寄
 *   CONTACT_TO        沒設 → 不寄
 *
 * 表單的可見行為（成功 302 / 失敗 200 重新渲染）與有沒有寄信完全無關，
 * 所以 markup 契約不受影響。
 */
export async function sendContactMail(
  values: Values,
  apiKey: string | undefined,
  to: string | undefined,
): Promise<void> {
  if (!apiKey || !to) {
    console.warn(`略過寄信 —— ${!apiKey ? 'SENDGRID_API_KEY' : 'CONTACT_TO'} 未設定`);
    return;
  }
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: to.split(',').map((e) => ({ email: e.trim() })) }],
      from: { email: 'notification@weypro.com', name: '禾勤藝術' },
      // 禾勤按「回覆」直接回到客戶，不用手動複製信箱
      reply_to: { email: values.Email, name: values.Name },
      subject: '禾勤藝術聯絡我們',
      content: [{ type: 'text/html', value: mailBody(values) }],
    }),
  });
  if (!res.ok) console.error(`SendGrid ${res.status}: ${await res.text()}`);
}
