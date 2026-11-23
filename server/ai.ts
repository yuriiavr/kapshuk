// ШІ Капшука — Gemini через проксі на цьому ж ноутбуці (~/gemini_proxy: спершу безкоштовні моделі, потім платний
// ключ). Ключа Капшук не має й не потребує: проксі підставляє свій. Модель — gemini-3.1-flash-lite, як в Адольфа.
// Що вміє: прочитати фото чека, розкласти товари по групах, порадити наприкінці місяця, від чого відмовитись.
import { CATEGORIES, CATEGORY_KEYS, isCategory, isItemGroup, ITEM_GROUP_KEYS, ITEM_GROUPS, type Category, type ItemGroup } from './categories.ts';
import { kyivUnix, now } from './time.ts';
import { UserError } from './budget.ts';

const BASE = (process.env.GEMINI_URL || 'http://127.0.0.1:8797').replace(/\/$/, '');
const MODEL = process.env.KAPSHUK_AI_MODEL || 'gemini-3.1-flash-lite';
const KEY = process.env.GEMINI_API_KEY?.trim(); // лише якщо ходити напряму в Google, без проксі

type Part = { text: string } | { inline_data: { mime_type: string; data: string } };

async function gemini(parts: Part[], opts: { schema?: object; system?: string; timeoutMs?: number; thinking?: 'minimal' | 'low' } = {}): Promise<string> {
  const body = {
    ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.1,
      thinkingConfig: { thinkingLevel: opts.thinking ?? 'low' },
      ...(opts.schema ? { responseMimeType: 'application/json', responseSchema: opts.schema } : {}),
    },
  };
  let res: Response;
  try {
    res = await fetch(`${BASE}/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(KEY ? { 'x-goog-api-key': KEY } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60e3),
    });
  } catch (err) {
    console.error('gemini:', (err as Error).message);
    throw new UserError((err as Error).name === 'TimeoutError' ? 'ШІ думає задовго — спробуй ще раз' : 'ШІ зараз недоступний (проксі Gemini на ноутбуці не відповідає)');
  }
  const data = await res.json().catch(() => null) as any;
  if (!res.ok) {
    console.error(`gemini ${res.status}:`, JSON.stringify(data)?.slice(0, 300));
    throw new UserError(res.status === 429 ? 'Ліміт ШІ на сьогодні вичерпано — спробуй пізніше' : `ШІ не відповів (${res.status})`);
  }
  const text = (data?.candidates?.[0]?.content?.parts ?? []).filter((p: any) => !p.thought && p.text).map((p: any) => p.text).join('');
  if (!text) throw new UserError('ШІ нічого не відповів — спробуй ще раз');
  return text;
}

async function geminiJson<T>(parts: Part[], schema: object, opts: { system?: string; timeoutMs?: number } = {}): Promise<T> {
  const text = await gemini(parts, { ...opts, schema });
  try {
    return JSON.parse(text) as T;
  } catch {
    console.error('gemini: не JSON:', text.slice(0, 300));
    throw new UserError('ШІ відповів незрозуміло — спробуй ще раз');
  }
}

const list = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k} — ${v}`).join('; ');
const CATEGORY_LIST = list(Object.fromEntries(CATEGORY_KEYS.map((k) => [k, CATEGORIES[k].title])));
const GROUP_LIST = list(ITEM_GROUPS);

const ITEM_SCHEMA = {
  type: 'OBJECT',
  properties: {
    name: { type: 'STRING', description: 'Назва товару як у чеку, але розбірливо: без кодів і артикулів, скорочення розгорнуто, якщо очевидно' },
    title: { type: 'STRING', description: 'Коротка загальна назва українською, однакова для того самого товару в різних магазинах: «Молоко», «Хліб», «Банани», «Кава в зернах», «Пакет»' },
    group: { type: 'STRING', enum: ITEM_GROUP_KEYS },
    qty: { type: 'NUMBER', nullable: true, description: 'Кількість: штуки або кілограми' },
    amount: { type: 'NUMBER', description: 'Сума рядка в гривнях після знижки на цей товар' },
  },
  required: ['name', 'title', 'group', 'amount'],
  propertyOrdering: ['name', 'title', 'group', 'qty', 'amount'],
};

const RECEIPT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    is_receipt: { type: 'BOOLEAN', description: 'false, якщо на фото не чек або його не прочитати' },
    store: { type: 'STRING', nullable: true, description: 'Магазин чи заклад (назва мережі): «АТБ», «Сільпо», «McDonald\'s»' },
    date: { type: 'STRING', nullable: true, description: 'Дата чека РРРР-ММ-ДД' },
    time: { type: 'STRING', nullable: true, description: 'Час чека ГГ:ХХ' },
    total: { type: 'NUMBER', description: 'Сума до сплати за чеком, грн' },
    category: { type: 'STRING', enum: CATEGORY_KEYS, description: 'Категорія всієї покупки' },
    items: { type: 'ARRAY', items: ITEM_SCHEMA },
  },
  required: ['is_receipt', 'total', 'category', 'items'],
  propertyOrdering: ['is_receipt', 'store', 'date', 'time', 'total', 'category', 'items'],
};

const RECEIPT_PROMPT = `Це фото касового чека з України. Перепиши з нього покупки.
- items — кожен товар окремим рядком. Знижку, що стоїть окремим рядком під товаром, відніми від суми цього товару. Пакет теж товар.
- amount — сума рядка (ціна × кількість) у гривнях; не плутай із ціною за кілограм.
- group — одна з груп: ${GROUP_LIST}.
- category — категорія всієї покупки: ${CATEGORY_LIST}.
- total — підсумок «До сплати» / «Сума», не решта й не готівка, яку дали.
- Не вигадуй: чого не видно — пропусти, дату чи час не видно — null.`;

export type ReceiptItem = { name: string; title: string; group: ItemGroup; qty: number | null; amount: number };
export type Receipt = { store: string | null; time: number | null; total: number; category: Category; items: ReceiptItem[] };

type RawItem = { name?: unknown; title?: unknown; group?: unknown; qty?: unknown; amount?: unknown };
type RawReceipt = { is_receipt?: unknown; store?: unknown; date?: unknown; time?: unknown; total?: unknown; category?: unknown; items?: unknown };

const str = (v: unknown, max = 120) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v.replace(',', '.'))) ? Number(v.replace(',', '.')) : null);
const kop = (hrn: number) => Math.round(hrn * 100);

export function normalizeItems(raw: unknown): ReceiptItem[] {
  const out: ReceiptItem[] = [];
  for (const r of Array.isArray(raw) ? (raw as RawItem[]) : []) {
    const amount = num(r?.amount);
    const name = str(r?.name) || str(r?.title);
    if (amount == null || !name) continue;
    // Знижка окремим рядком (мінус) — з попереднього товару
    if (amount < 0) {
      if (out.length) out[out.length - 1].amount = Math.max(0, out[out.length - 1].amount + kop(amount));
      continue;
    }
    const qty = num(r?.qty);
    out.push({ name, title: str(r?.title, 60) || name, group: isItemGroup(r?.group) ? r.group : 'other', qty: qty && qty > 0 ? qty : null, amount: kop(amount) });
  }
  return out.filter((i) => i.amount > 0);
}

/** Відповідь ШІ про чек → наші одиниці (копійки, unix-час). Окремо від запиту, щоб перевіряти тестами */
export function normalizeReceipt(raw: RawReceipt, at = now()): Receipt {
  if (raw?.is_receipt === false) throw new UserError('На фото не видно чека — сфотографуй його ближче й рівніше');
  const items = normalizeItems(raw?.items);
  const total = num(raw?.total);
  const itemsSum = items.reduce((s, i) => s + i.amount, 0);
  const totalKop = total != null && total > 0 ? kop(total) : itemsSum;
  if (!totalKop) throw new UserError('Не вдалося прочитати суму чека — спробуй ще раз');
  let time = typeof raw?.date === 'string' ? kyivUnix(raw.date, typeof raw.time === 'string' ? raw.time : null) : null;
  // Дата з майбутнього чи старша за рік — ШІ схибив, краще без неї
  if (time != null && (time > at + 86400 || time < at - 366 * 86400)) time = null;
  return {
    store: str(raw?.store, 60) || null,
    time,
    total: totalKop,
    category: isCategory(raw?.category) ? raw.category : 'other',
    items,
  };
}

export async function scanReceipt(imageBase64: string, mime: string): Promise<Receipt> {
  const raw = await geminiJson<RawReceipt>(
    [{ inline_data: { mime_type: mime, data: imageBase64 } }, { text: RECEIPT_PROMPT }], RECEIPT_SCHEMA, { timeoutMs: 90e3 });
  return normalizeReceipt(raw);
}

/** Товари, записані вручну: загальна назва й група для підсумку місяця. ШІ недоступний — назва як є, група «Інше» */
export async function tagItems(names: string[], context?: string): Promise<{ title: string; group: ItemGroup }[]> {
  if (!names.length) return [];
  const fallback = names.map((n) => ({ title: n, group: 'other' as ItemGroup }));
  try {
    const raw = await geminiJson<{ items?: { title?: unknown; group?: unknown }[] }>([{ text:
      `Покупки сім'ї${context ? ` (${context})` : ''}. Для кожної назви дай коротку загальну назву українською (title) і групу (group: ${GROUP_LIST}). ` +
      `Порядок такий самий, як у списку.\n${names.map((n, i) => `${i + 1}. ${n}`).join('\n')}` }],
    {
      type: 'OBJECT',
      properties: { items: { type: 'ARRAY', items: { type: 'OBJECT', properties: { title: { type: 'STRING' }, group: { type: 'STRING', enum: ITEM_GROUP_KEYS } }, required: ['title', 'group'] } } },
      required: ['items'],
    }, { timeoutMs: 15e3 });
    return names.map((n, i) => {
      const r = raw.items?.[i];
      return { title: str(r?.title, 60) || n, group: isItemGroup(r?.group) ? r.group : 'other' };
    });
  } catch (err) {
    console.error('tagItems:', (err as Error).message);
    return fallback;
  }
}

/** Порада наприкінці місяця: від чого можна відмовитись і скільки це заощадить. data — уже пораховані суми */
export async function adviseMonth(monthTitle: string, data: object): Promise<string> {
  const text = await gemini([{ text:
    `Ось витрати сім'ї за ${monthTitle} (гривні): категорії, групи товарів і що купували найчастіше.\n` +
    `${JSON.stringify(data)}\n\n` +
    'Порадь коротко, від чого можна відмовитись або на чому заощадити: 3–6 пунктів, у кожному — конкретна річ із цих даних ' +
    'і скільки приблизно вийде заощадити за місяць. Спершу найбільша економія. Обов\'язкові платежі, ліки й дитяче не чіпай. ' +
    'Без моралізаторства й загальних порад, без вступу й висновку. Кожен пункт — 1–2 речення, починай з «• ». ' +
    'Звичайний текст без markdown: жодних зірочок, решіток чи списків з «-».' }],
  { system: 'Ти — уважний сімейний фінансовий помічник. Відповідаєш українською, просто й по ділу.', timeoutMs: 45e3 });
  return text.trim();
}
