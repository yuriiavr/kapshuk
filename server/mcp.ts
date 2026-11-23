// Інструменти Капшука для Адольфа (інтеграція Model Context Protocol у HA). Суми тут — гривні, а не копійки:
// так їх називають уголос. Слухає лише 127.0.0.1 (див. main.ts).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as b from './budget.ts';
import { monthItems, topMerchants } from './items.ts';
import { all } from './db.ts';
import { CATEGORIES, CATEGORY_KEYS, ITEM_GROUPS, isItemGroup } from './categories.ts';
import { addMonths, monthRange, thisMonth } from './time.ts';
import { CURRENCY } from './monobank.ts';

const uah = (kop: number | null | undefined) => (kop == null ? null : Math.round(kop) / 100);
const kop = (hrn: number) => Math.round(hrn * 100);
const cat = (c: string | null) => (c && c in CATEGORIES ? CATEGORIES[c as keyof typeof CATEGORIES].title : null);

const month = z.string().regex(/^\d{4}-\d{2}$/).optional().describe('Місяць РРРР-ММ; без нього — поточний');
const category = z.enum(CATEGORY_KEYS as [string, ...string[]])
  .describe(`Категорія витрат: ${CATEGORY_KEYS.map((k) => `${k} — ${CATEGORIES[k].title}`).join(', ')}`);

function pick<T extends { id: number; title: string }>(items: T[], query: string, what: string): T {
  const q = query.trim().toLowerCase();
  const exact = items.filter((i) => i.title.toLowerCase() === q);
  const found = exact.length ? exact : items.filter((i) => i.title.toLowerCase().includes(q) || q.includes(i.title.toLowerCase()));
  if (found.length === 1) return found[0];
  if (!found.length) throw new b.UserError(`Не знайшов ${what} «${query}». Є: ${items.map((i) => i.title).join(', ') || 'нічого'}`);
  throw new b.UserError(`Під «${query}» підходить кілька: ${found.map((i) => i.title).join(', ')} — уточни`);
}

function overview(m: string) {
  const s = b.monthSummary(m);
  const it = monthItems(m);
  return {
    month: s.month,
    spent: uah(s.spent),
    income_received: uah(s.income_actual),
    put_to_jars: uah(s.saved),
    by_category: s.categories.filter((c) => c.total > 0).map((c) => ({ category: CATEGORIES[c.category].title, spent: uah(c.total), payments: c.n })),
    top_places: topMerchants(m, 5).map((t) => ({ where: t.description, spent: uah(t.total), times: t.n })),
    receipts: { purchases_with_items: it.purchases, covered: uah(it.covered) },
    payments_unpaid: s.needs.filter((n) => !n.paid).map((n) => ({ title: n.title, amount: uah(n.amount) })),
    payments_paid: s.needs.filter((n) => n.paid).map((n) => n.title),
    purchases_planned: s.wants.filter((w) => !w.bought).map((w) => ({ title: w.title, price: uah(w.amount) })),
    jars: s.jars.map((j) => ({ title: j.title, balance: uah(j.balance), goal: uah(j.goal), currency: CURRENCY[j.currency] ?? j.currency, owner: j.member })),
  };
}

export function buildMcp() {
  const server = new McpServer({ name: 'kapshuk', version: '0.2.0' });
  const tool = (name: string, description: string, inputSchema: z.ZodRawShape, readOnly: boolean, run: (args: any) => unknown) =>
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: readOnly } }, async (args) => {
      try {
        return { content: [{ type: 'text', text: JSON.stringify((await run(args)) ?? { ok: true }) }] };
      } catch (err) {
        if (!(err instanceof b.UserError)) console.error(`${name}:`, err);
        return { content: [{ type: 'text', text: `Помилка: ${(err as Error).message}` }], isError: true };
      }
    });

  tool('kapshuk_overview',
    'Витрати сім\'ї в «Капшуку» за місяць: скільки витрачено й на що — по категоріях (продукти, кафе, таксі…) і де найбільше, ' +
    'скільки надійшло, які постійні платежі ще не сплачені, заплановані покупки й баланси банок Monobank. ' +
    'Перший вибір для «скільки витратили (на продукти, на кафе…)». Бюджет на кошики не ділимо.',
    { month }, true, ({ month: m }) => overview(b.checkMonth(m)));

  tool('kapshuk_purchases',
    'Що саме купували — товари з чеків і вписані до операцій. search («кава», «сир», «чипси») — скільки разів і на яку суму; ' +
    'без search — групи товарів і що купували найчастіше. Відомо лише для покупок, до яких додали чек чи товари.',
    { search: z.string().optional().describe('Назва товару чи її частина'), month }, true, ({ search, month: m }) => {
      const mm = b.checkMonth(m);
      const it = monthItems(mm);
      const base = { covered: `${uah(it.covered)} з ${uah(it.spent)} грн витрат розписано по товарах`, purchases_with_items: it.purchases };
      const q = search?.trim().toLowerCase();
      if (!q) {
        return {
          ...base,
          groups: it.groups.map((g) => ({ group: g.title, spent: uah(g.total), top: g.top.slice(0, 5).map((t) => ({ item: t.title, spent: uah(t.total) })) })),
          bought_often: it.frequent.map((t) => ({ item: t.title, times: t.n, spent: uah(t.total) })),
        };
      }
      const [start, end] = monthRange(mm);
      const rows = all<{ name: string; title: string | null; item_group: string | null; amount: number; time: number; description: string }>(
        `SELECT i.name, i.title, i.item_group, i.amount, t.time, t.description FROM items i JOIN transactions t ON t.id = i.tx_id
          WHERE t.bucket = 'spend' AND t.time >= :start AND t.time < :end ORDER BY t.time DESC`, { start, end })
        .filter((r) => r.name.toLowerCase().includes(q) || (r.title ?? '').toLowerCase().includes(q));
      return {
        ...base,
        found: rows.length,
        spent: uah(rows.reduce((s, r) => s + r.amount, 0)),
        latest: rows.slice(0, 10).map((r) => ({
          item: r.name, group: isItemGroup(r.item_group) ? ITEM_GROUPS[r.item_group] : null, spent: uah(r.amount), where: r.description,
          date: new Date(r.time * 1000).toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv', day: 'numeric', month: 'short' }),
        })),
      };
    });

  tool('kapshuk_mark_paid',
    'Позначити постійний платіж зі списку (оренда, комуналка, інтернет…) сплаченим або несплаченим.',
    {
      title: z.string().describe('Назва або її частина: «інтернет», «оренда»'),
      paid: z.boolean().default(true),
      amount: z.number().positive().optional().describe('Скільки фактично сплачено, грн (якщо не як заплановано)'),
      month,
    }, false, ({ title, paid, amount, month: m }) => {
      const mm = b.checkMonth(m);
      const need = pick(b.needsFor(mm), title, 'платежу');
      b.setNeedMonth(need.id, mm, { paid, paid_amount: amount != null ? kop(amount) : null });
      return { title: need.title, paid };
    });

  tool('kapshuk_add_need',
    'Додати постійний платіж (щомісяця) або разовий лише на один місяць — у список платежів з галочкою «сплачено».',
    {
      title: z.string(), amount: z.number().nonnegative().describe('Сума, грн'),
      once: z.boolean().default(false).describe('true — разово лише цього (або вказаного) місяця'),
      match: z.string().optional().describe('Слова через кому, за якими платіж упізнати у виписці банку'),
      month,
    }, false, ({ title, amount, once, match, month: m }) => {
      const mm = b.checkMonth(m);
      return { id: b.addNeed({ title, amount: kop(amount), match, month: mm, once_month: once ? mm : null }) };
    });

  tool('kapshuk_add_purchase',
    'Запланувати покупку на цей чи наступний місяць або додати її у вішліст (бажане без дати).',
    {
      title: z.string(), price: z.number().nonnegative().optional().describe('Орієнтовна ціна, грн'),
      when: z.enum(['this_month', 'next_month', 'wishlist']).default('this_month'),
      url: z.string().url().optional(), note: z.string().optional(),
    }, false, ({ title, price, when, url, note }) => {
      const m = when === 'wishlist' ? null : when === 'next_month' ? addMonths(thisMonth(), 1) : thisMonth();
      return { id: b.addWant({ title, amount: price != null ? kop(price) : null, month: m, url, note }), month: m ?? 'вішліст' };
    });

  tool('kapshuk_mark_bought',
    'Позначити заплановану покупку купленою (або повернути в план). Шукає в покупках поточного місяця.',
    { title: z.string(), bought: z.boolean().default(true), month }, false, ({ title, bought, month: m }) => {
      const w = pick(b.wantsFor(b.checkMonth(m)), title, 'покупки');
      b.updateWant(w.id, { bought });
      return { title: w.title, bought };
    });

  tool('kapshuk_wishlist',
    'Вішліст: бажані покупки без дати. Можна перенести одну з них у план місяця.',
    {
      plan_title: z.string().optional().describe('Перенести цю позицію вішліста в план місяця'),
      to_month: month,
    }, false, ({ plan_title, to_month }) => {
      if (plan_title) {
        const w = pick(b.wantsFor(null), plan_title, 'у вішлісті');
        b.updateWant(w.id, { month: b.checkMonth(to_month) });
      }
      return b.wantsFor(null).map((w) => ({ title: w.title, price: uah(w.amount), url: w.url, note: w.note }));
    });

  // Витрат голосом не записуємо: сім'я платить усе з Monobank, операції приходять звідти самі, а товари — з чеків
  tool('kapshuk_transactions',
    'Операції місяця з Monobank і вручну (усі витрати й надходження сім\'ї), з категорією кожної й товарами, якщо їх записали. ' +
    'Витрати — мінус, надходження — плюс. Операції категорії (продукти, кафе…) — через category, а не search. ' +
    'search — назва магазину чи товару («сільпо», «аптека», «кава»): знайти й порахувати, скільки на це пішло.',
    {
      kind: z.enum(['spend', 'income', 'savings', 'internal', 'ignore']).optional()
        .describe('spend — витрати, income — дохід, savings — у банки, internal — перекази між своїми, ignore — не рахуються'),
      category: category.optional(),
      search: z.string().optional().describe('Частина опису операції чи назви товару'),
      limit: z.number().int().min(1).max(100).default(15), month,
    }, true, ({ kind, category: c, search, limit, month: m }) => {
      const list = b.transactions(b.checkMonth(m), { bucket: kind, category: c, search }, 5000);
      return {
        count: list.length,
        // Як у підсумку місяця: повернення в магазин зменшують витрати
        spent: uah(-list.filter((t) => t.bucket === 'spend').reduce((s, t) => s + t.amount, 0)),
        received: uah(list.filter((t) => t.amount > 0 && t.bucket === 'income').reduce((s, t) => s + t.amount, 0)),
        latest: list.slice(0, limit).map((t) => ({
          date: new Date(t.time * 1000).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
          amount: uah(t.amount), description: t.description, kind: t.bucket, category: cat(t.category), who: t.member, items: t.items_text,
        })),
      };
    });

  return server;
}
