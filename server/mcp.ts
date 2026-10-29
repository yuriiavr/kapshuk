// Інструменти Капшука для Адольфа (інтеграція Model Context Protocol у HA). Суми тут — гривні, а не копійки:
// так їх називають уголос. Слухає лише 127.0.0.1 (див. main.ts).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as b from './budget.ts';
import { BUCKETS } from './db.ts';
import { addMonths, thisMonth } from './time.ts';
import { CURRENCY } from './monobank.ts';

const BUCKET_NAMES = { needs: 'базові потреби', wants: 'на себе', savings: 'заощадження' } as const;
const uah = (kop: number | null | undefined) => (kop == null ? null : Math.round(kop) / 100);
const kop = (hrn: number) => Math.round(hrn * 100);

const bucket = z.enum(['needs', 'wants', 'savings']).describe('needs — базові потреби, wants — на себе (покупки для сім\'ї, кафе, розваги), savings — заощадження');
const month = z.string().regex(/^\d{4}-\d{2}$/).optional().describe('Місяць РРРР-ММ; без нього — поточний');

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
  const free = { needs: s.buckets.needs.left - s.needs_plan.left, wants: s.buckets.wants.left - s.wants_plan.left, savings: s.buckets.savings.left };
  return {
    month: s.month,
    income_plan: uah(s.income),
    income_received: uah(s.income_actual),
    buckets: Object.fromEntries(BUCKETS.map((k) => [BUCKET_NAMES[k], {
      percent: s.buckets[k].pct, plan: uah(s.buckets[k].allocated), [k === 'savings' ? 'saved' : 'spent']: uah(s.buckets[k].spent),
      left: uah(s.buckets[k].left), [k === 'savings' ? 'to_save' : 'free_after_plan']: uah(free[k]),
    }])),
    needs_unpaid: s.needs.filter((n) => !n.paid).map((n) => ({ title: n.title, amount: uah(n.amount) })),
    needs_paid: s.needs.filter((n) => n.paid).map((n) => n.title),
    purchases_planned: s.wants.filter((w) => !w.bought).map((w) => ({ title: w.title, price: uah(w.amount) })),
    moves: s.moves.map((mv) => ({ from: BUCKET_NAMES[mv.from], to: BUCKET_NAMES[mv.to], amount: uah(mv.amount), note: mv.note })),
    jars: s.jars.map((j) => ({ title: j.title, balance: uah(j.balance), goal: uah(j.goal), currency: CURRENCY[j.currency] ?? j.currency, owner: j.member })),
    unchecked_transactions: s.unchecked,
  };
}

export function buildMcp() {
  const server = new McpServer({ name: 'kapshuk', version: '0.1.0' });
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
    'Сімейний бюджет «Капшук» за місяць: скільки заплановано, витрачено й лишилось у кожному кошику (базові потреби, на себе, заощадження), ' +
    'які обов\'язкові платежі ще не сплачені, заплановані покупки, перерозподіли й баланси банок Monobank. ' +
    'free_after_plan — скільки вільно після ще не сплачених потреб чи не куплених запланованих покупок.',
    { month }, true, ({ month: m }) => overview(b.checkMonth(m)));

  tool('kapshuk_mark_paid',
    'Позначити обов\'язковий платіж зі списку базових потреб (оренда, комуналка, інтернет…) сплаченим або несплаченим.',
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
    'Додати платіж до базових потреб: постійний (щомісяця) або разовий лише на один місяць.',
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
    'Запланувати покупку «на себе» для сім\'ї на цей чи наступний місяць або додати її у вішліст (бажане без дати).',
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

  tool('kapshuk_add_expense',
    'Записати витрату готівкою (або іншу, якої немає в Monobank), дохід чи відкладене на заощадження.',
    {
      amount: z.number().positive().describe('Сума, грн'), description: z.string(),
      bucket: z.enum(['needs', 'wants', 'savings', 'income']).describe('needs/wants/savings як у бюджеті, income — дохід'),
    }, false, ({ amount, description, bucket: bk }) => ({ id: b.addManualTx({ amount: kop(amount), description, bucket: bk }) }));

  tool('kapshuk_move_money',
    'Перерозподілити гроші між кошиками на місяць: напр., «наступного місяця 12 500 із заощаджень на погашення кредиту» — ' +
    'from savings, to needs, as_payment true (тоді в потребах того місяця з\'явиться разовий платіж). ' +
    'Чи вистачить грошей у кошику «from», перевір через kapshuk_overview і скажи людині.',
    {
      from: bucket, to: bucket, amount: z.number().positive().describe('Сума, грн'), month,
      note: z.string().optional().describe('На що: «погашення кредиту»'),
      as_payment: z.boolean().default(false).describe('Додати разовий платіж у базові потреби (лише коли to = needs)'),
    }, false, ({ from, to, amount, month: m, note, as_payment }) =>
      ({ id: b.addMove({ month: b.checkMonth(m), from, to, amount: kop(amount), note, as_need: as_payment }) }));

  tool('kapshuk_transactions',
    'Останні операції місяця з Monobank і вручну, з кошиком кожної. Витрати — мінус, надходження — плюс.',
    {
      bucket: z.enum(['needs', 'wants', 'savings', 'income', 'internal', 'ignore']).optional(),
      limit: z.number().int().min(1).max(50).default(10), month,
    }, true, ({ bucket: bk, limit, month: m }) =>
      b.transactions(b.checkMonth(m), bk, limit).map((t) => ({
        date: new Date(t.time * 1000).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
        amount: uah(t.amount), description: t.description, bucket: t.bucket, who: t.member,
      })));

  return server;
}
