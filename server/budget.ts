// Витрати сім'ї за місяць: що й куди (категорії за магазином), постійні платежі з галочкою «сплачено»,
// заплановані покупки й вішліст. Спільне для інтерфейсу (api.ts) і Адольфа (mcp.ts).
import { randomUUID } from 'node:crypto';
import { all, one, run, tx, TX_BUCKETS, type TxBucket } from './db.ts';
import { classify, loadContext, rulePattern, TRANSFER_MCC } from './classify.ts';
import { isCategory, mccCategory, type Category } from './categories.ts';
import { MONTH_RE, monthOf, monthRange, now, thisMonth } from './time.ts';

export class UserError extends Error {}

export const checkMonth = (month: string | undefined | null) => {
  const m = month || thisMonth();
  if (!MONTH_RE.test(m)) throw new UserError(`Місяць має бути у форматі РРРР-ММ, а не «${m}»`);
  return m;
};
export const checkAmount = (kop: number) => {
  if (!Number.isInteger(kop) || kop < 0) throw new UserError('Сума має бути додатною');
  return kop;
};
export const checkCategory = (c: unknown): Category => {
  if (!isCategory(c)) throw new UserError(`Невідома категорія «${c}»`);
  return c;
};

// ── Місяць ──

export type Need = {
  id: number; title: string; amount: number; default_amount: number; match: string | null; once: boolean;
  paid: boolean; paid_at: number | null; paid_amount: number | null; tx_id: string | null;
};
export type Want = { id: number; title: string; amount: number | null; month: string | null; url: string | null; note: string | null; bought: boolean; bought_at: number | null };
export type Jar = { id: string; title: string; balance: number; goal: number | null; currency: number; member: string };
export type CategorySum = { category: Category; total: number; n: number };

export function needsFor(month: string): Need[] {
  const rows = all<{
    id: number; title: string; amount: number; match: string | null; once_month: string | null;
    m_amount: number | null; paid_at: number | null; paid_amount: number | null; tx_id: string | null;
  }>(
    `SELECT n.id, n.title, n.match, n.once_month, nm.amount AS m_amount, nm.paid_at, nm.paid_amount, nm.tx_id,
            COALESCE((SELECT p.amount FROM need_prices p WHERE p.need_id = n.id AND p.from_month <= :month
                       ORDER BY p.from_month DESC LIMIT 1), n.amount) AS amount
       FROM needs n LEFT JOIN need_months nm ON nm.need_id = n.id AND nm.month = :month
      WHERE n.start_month <= :month AND (n.end_month IS NULL OR n.end_month > :month)
        AND (n.once_month IS NULL OR n.once_month = :month)
      ORDER BY n.once_month IS NOT NULL, n.sort, n.id`, { month });
  return rows.map((r) => ({
    id: r.id, title: r.title, amount: r.m_amount ?? r.amount, default_amount: r.amount, match: r.match, once: r.once_month != null,
    paid: r.paid_at != null, paid_at: r.paid_at, paid_amount: r.paid_amount, tx_id: r.tx_id,
  }));
}

const wantRow = (r: { id: number; title: string; amount: number | null; month: string | null; url: string | null; note: string | null; bought_at: number | null }): Want =>
  ({ ...r, bought: r.bought_at != null });

export function wantsFor(month: string | null): Want[] {
  const rows = month
    ? all<Parameters<typeof wantRow>[0]>('SELECT id, title, amount, month, url, note, bought_at FROM wants WHERE month = :month ORDER BY bought_at IS NOT NULL, sort, id', { month })
    : all<Parameters<typeof wantRow>[0]>('SELECT id, title, amount, month, url, note, bought_at FROM wants WHERE month IS NULL ORDER BY sort, id');
  return rows.map(wantRow);
}

export function jars(): Jar[] {
  return all<Jar>(
    `SELECT a.id, a.title, a.balance, a.goal, a.currency, m.name AS member FROM accounts a JOIN members m ON m.id = a.member_id
      WHERE a.kind = 'jar' AND a.include = 1 ORDER BY a.balance DESC`);
}

/** Куди пішли гроші: витрати за категоріями, найбільші спершу. Повернення в магазин зменшують свою категорію */
export function categorySums(month: string): CategorySum[] {
  const [start, end] = monthRange(month);
  return all<{ category: string | null; total: number; n: number }>(
    `SELECT category, -SUM(amount) AS total, COUNT(*) AS n FROM transactions
      WHERE bucket = 'spend' AND time >= :start AND time < :end GROUP BY category`, { start, end })
    .map((r) => ({ category: isCategory(r.category) ? r.category : 'other', total: r.total, n: r.n }))
    .reduce<CategorySum[]>((acc, r) => {
      const same = acc.find((a) => a.category === r.category);
      if (same) Object.assign(same, { total: same.total + r.total, n: same.n + r.n });
      else acc.push(r);
      return acc;
    }, [])
    .sort((a, b) => b.total - a.total);
}

export function monthSummary(month: string) {
  const [start, end] = monthRange(month);
  const sums = all<{ bucket: TxBucket; total: number }>(
    'SELECT bucket, SUM(amount) AS total FROM transactions WHERE time >= :start AND time < :end GROUP BY bucket', { start, end });
  const sum = (b: TxBucket) => sums.find((s) => s.bucket === b)?.total ?? 0;
  const needs = needsFor(month);
  const wants = wantsFor(month);
  return {
    month,
    // Витрати — мінус на картці, тож «витрачено» = −сума
    spent: -sum('spend'),
    income_actual: sum('income'),
    saved: -sum('savings'),
    categories: categorySums(month),
    needs,
    needs_plan: {
      total: needs.reduce((s, n) => s + n.amount, 0),
      paid: needs.filter((n) => n.paid).reduce((s, n) => s + (n.paid_amount ?? n.amount), 0),
      left: needs.filter((n) => !n.paid).reduce((s, n) => s + n.amount, 0),
      count: needs.length, paid_count: needs.filter((n) => n.paid).length,
    },
    wants,
    wants_plan: {
      total: wants.reduce((s, w) => s + (w.amount ?? 0), 0),
      left: wants.filter((w) => !w.bought).reduce((s, w) => s + (w.amount ?? 0), 0),
      count: wants.length, bought_count: wants.filter((w) => w.bought).length,
    },
    jars: jars(),
  };
}

// ── Постійні платежі ──

export function addNeed(p: { title: string; amount: number; match?: string | null; once_month?: string | null; month?: string }) {
  const title = p.title.trim();
  if (!title) throw new UserError('Порожня назва');
  const once = p.once_month ? checkMonth(p.once_month) : null;
  const start = once ?? checkMonth(p.month);
  const r = run(`INSERT INTO needs (title, amount, match, once_month, start_month, sort, created_at)
                 VALUES (:title, :amount, :match, :once, :start, (SELECT COALESCE(MAX(sort), 0) + 1 FROM needs), :now)`,
  { title, amount: checkAmount(p.amount), match: p.match?.trim() || null, once, start, now: now() });
  return Number(r.lastInsertRowid);
}

export function updateNeed(id: number, p: { title?: string; match?: string | null }) {
  const n = one<{ id: number }>('SELECT id FROM needs WHERE id = :id', { id });
  if (!n) throw new UserError('Немає такого платежу');
  if (p.title !== undefined) {
    if (!p.title.trim()) throw new UserError('Порожня назва');
    run('UPDATE needs SET title = :t WHERE id = :id', { id, t: p.title.trim() });
  }
  if (p.match !== undefined) run('UPDATE needs SET match = :m WHERE id = :id', { id, m: p.match?.trim() || null });
}

/** Нова сума платежу: лише на цей місяць або з цього місяця й надалі (минулі не змінюються) */
export function setNeedAmount(id: number, month: string, amountIn: number, forward: boolean) {
  const amount = checkAmount(amountIn);
  tx(() => {
    const need = needsFor(month).find((n) => n.id === id);
    if (!need) throw new UserError('Цього платежу немає в цьому місяці');
    if (!forward || need.once) return setNeedMonth(id, month, { amount });
    run(`INSERT INTO need_prices (need_id, from_month, amount) VALUES (:id, :month, :amount)
         ON CONFLICT (need_id, from_month) DO UPDATE SET amount = excluded.amount`, { id, month, amount });
    run('DELETE FROM need_prices WHERE need_id = :id AND from_month > :month', { id, month });
    run('UPDATE need_months SET amount = NULL WHERE need_id = :id AND month >= :month', { id, month });
  });
}

/** Прибрати з поточного й наступних місяців; історію сплат лишаємо */
export function removeNeed(id: number, month: string) {
  tx(() => {
    const n = one<{ start_month: string; once_month: string | null }>('SELECT start_month, once_month FROM needs WHERE id = :id', { id });
    if (!n) throw new UserError('Немає такого платежу');
    const history = one<{ n: number }>('SELECT COUNT(*) AS n FROM need_months WHERE need_id = :id AND paid_at IS NOT NULL AND month < :month', { id, month })!.n;
    if (n.once_month || !history || n.start_month >= month) {
      run('UPDATE moves SET need_id = NULL WHERE need_id = :id', { id }); // старі перерозподіли (до 2026-11-23)
      run('DELETE FROM needs WHERE id = :id', { id });
    } else run('UPDATE needs SET end_month = :month WHERE id = :id', { id, month });
  });
}

export function setNeedMonth(id: number, month: string, p: { amount?: number | null; paid?: boolean; paid_amount?: number | null; tx_id?: string | null; paid_at?: number }) {
  const need = needsFor(month).find((n) => n.id === id);
  if (!need) throw new UserError('Цього платежу немає в цьому місяці');
  run('INSERT INTO need_months (need_id, month) VALUES (:id, :month) ON CONFLICT DO NOTHING', { id, month });
  if (p.amount !== undefined) run('UPDATE need_months SET amount = :a WHERE need_id = :id AND month = :month', { id, month, a: p.amount == null ? null : checkAmount(p.amount) });
  if (p.paid === true) {
    run(`UPDATE need_months SET paid_at = :at, paid_amount = :pa, tx_id = :tx WHERE need_id = :id AND month = :month`,
      { id, month, at: p.paid_at ?? now(), pa: p.paid_amount ?? (p.amount ?? need.amount), tx: p.tx_id ?? null });
  } else if (p.paid === false) {
    run('UPDATE need_months SET paid_at = NULL, paid_amount = NULL, tx_id = NULL WHERE need_id = :id AND month = :month', { id, month });
  }
}

// ── Хочу купити: план місяця й вішліст ──

export function addWant(p: { title: string; amount?: number | null; month?: string | null; url?: string | null; note?: string | null }) {
  const title = p.title.trim();
  if (!title) throw new UserError('Порожня назва');
  const r = run(`INSERT INTO wants (title, amount, month, url, note, sort, created_at)
                 VALUES (:title, :amount, :month, :url, :note, (SELECT COALESCE(MAX(sort), 0) + 1 FROM wants), :now)`, {
    title, amount: p.amount == null ? null : checkAmount(p.amount), month: p.month ? checkMonth(p.month) : null,
    url: p.url?.trim() || null, note: p.note?.trim() || null, now: now(),
  });
  return Number(r.lastInsertRowid);
}

export function updateWant(id: number, p: { title?: string; amount?: number | null; month?: string | null; url?: string | null; note?: string | null; bought?: boolean }) {
  const w = one<{ id: number }>('SELECT id FROM wants WHERE id = :id', { id });
  if (!w) throw new UserError('Немає такої покупки');
  if (p.title !== undefined) run('UPDATE wants SET title = :v WHERE id = :id', { id, v: p.title.trim() });
  if (p.amount !== undefined) run('UPDATE wants SET amount = :v WHERE id = :id', { id, v: p.amount == null ? null : checkAmount(p.amount) });
  if (p.month !== undefined) run('UPDATE wants SET month = :v WHERE id = :id', { id, v: p.month ? checkMonth(p.month) : null });
  if (p.url !== undefined) run('UPDATE wants SET url = :v WHERE id = :id', { id, v: p.url?.trim() || null });
  if (p.note !== undefined) run('UPDATE wants SET note = :v WHERE id = :id', { id, v: p.note?.trim() || null });
  if (p.bought !== undefined) run('UPDATE wants SET bought_at = :v WHERE id = :id', { id, v: p.bought ? now() : null });
}

export const removeWant = (id: number) => void run('DELETE FROM wants WHERE id = :id', { id });

// ── Операції ──

export type Tx = {
  id: string; source: 'mono' | 'manual'; time: number; amount: number; description: string; mcc: number | null; comment: string | null;
  counter_name: string | null; hold: number; bucket: TxBucket; category: Category | null; bucket_source: string;
  member: string | null; account: string | null;
  /** Скільки товарів записано й перші з них — для рядка в списку */
  items: number; items_text: string | null; receipt_id: number | null;
};

export function transactions(month: string, filter: { bucket?: string | null; category?: string | null; search?: string | null } = {}, limit = 500): Tx[] {
  const [start, end] = monthRange(month);
  const rows = all<Omit<Tx, 'items' | 'items_text' | 'receipt_id'>>(
    `SELECT t.id, t.source, t.time, t.amount, t.description, t.mcc, t.comment, t.counter_name, t.hold, t.bucket, t.category, t.bucket_source,
            m.name AS member, a.title AS account
       FROM transactions t LEFT JOIN members m ON m.id = t.member_id LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.time >= :start AND t.time < :end AND (:bucket IS NULL OR t.bucket = :bucket)
        AND (:category IS NULL OR (t.bucket = 'spend' AND COALESCE(t.category, 'other') = :category))
      ORDER BY t.time DESC LIMIT :limit`, { start, end, bucket: filter.bucket || null, category: filter.category || null, limit });
  const items = all<{ tx_id: string; name: string }>(
    `SELECT i.tx_id, COALESCE(i.title, i.name) AS name FROM items i JOIN transactions t ON t.id = i.tx_id
      WHERE t.time >= :start AND t.time < :end ORDER BY i.tx_id, i.sort, i.id`, { start, end });
  const receipts = all<{ tx_id: string; id: number }>(
    `SELECT r.tx_id, MAX(r.id) AS id FROM receipts r JOIN transactions t ON t.id = r.tx_id
      WHERE t.time >= :start AND t.time < :end GROUP BY r.tx_id`, { start, end });
  const byTx = new Map<string, string[]>();
  for (const i of items) byTx.set(i.tx_id, [...(byTx.get(i.tx_id) ?? []), i.name]);
  const receiptOf = new Map(receipts.map((r) => [r.tx_id, r.id]));
  const q = filter.search?.trim().toLowerCase();
  return rows
    .map((t) => {
      const names = byTx.get(t.id) ?? [];
      const category = t.bucket === 'spend' ? (isCategory(t.category) ? t.category : 'other') : null;
      return { ...t, category, items: names.length, items_text: names.length ? [...new Set(names)].slice(0, 6).join(', ') : null, receipt_id: receiptOf.get(t.id) ?? null };
    })
    .filter((t) => !q || t.description.toLowerCase().includes(q) || (byTx.get(t.id) ?? []).some((n) => n.toLowerCase().includes(q)));
}

const checkTxBucket = (b: string): TxBucket => {
  if (!(TX_BUCKETS as readonly string[]).includes(b)) throw new UserError(`Невідомий тип операції «${b}»`);
  return b as TxBucket;
};

export function addManualTx(p: { amount: number; description: string; bucket?: string; category?: string | null; time?: number; member_id?: number | null }) {
  const id = `man-${randomUUID()}`;
  const bucket = checkTxBucket(p.bucket ?? 'spend');
  if (!['spend', 'income', 'savings'].includes(bucket)) throw new UserError('Вручну — лише витрата, дохід чи відкладене');
  const category = bucket === 'spend' ? (p.category ? checkCategory(p.category) : 'other') : null;
  const kop = checkAmount(p.amount);
  if (!kop) throw new UserError('Сума має бути більшою за нуль');
  // Витрату й відкладене пишемо мінусом, як у банку; дохід — плюсом
  const amount = bucket === 'income' ? kop : -kop;
  run(`INSERT INTO transactions (id, source, member_id, time, amount, description, bucket, category, bucket_source, created_at)
       VALUES (:id, 'manual', :member, :time, :amount, :desc, :bucket, :category, 'user', :now)`,
  { id, member: p.member_id ?? null, time: p.time ?? now(), amount, desc: p.description.trim() || 'Готівка', bucket, category, now: now() });
  return id;
}

export function removeManualTx(id: string) {
  const t = one<{ source: string }>('SELECT source FROM transactions WHERE id = :id', { id });
  if (!t) throw new UserError('Немає такої операції');
  if (t.source !== 'manual') throw new UserError('Операції з банку не видаляються — познач «не рахувати»');
  run('DELETE FROM transactions WHERE id = :id', { id });
}

/** Змінити тип і категорію операції; remember — запамʼятати для цього опису й перерахувати інші такі самі */
export function setTxKind(id: string, p: { bucket?: string; category?: string | null }, remember = false) {
  const bucket = checkTxBucket(p.bucket ?? 'spend');
  return tx(() => {
    const t = one<{ description: string; mcc: number | null }>('SELECT description, mcc FROM transactions WHERE id = :id', { id });
    if (!t) throw new UserError('Немає такої операції');
    const category = bucket === 'spend' ? (p.category ? checkCategory(p.category) : mccCategory(t.mcc)) : null;
    run("UPDATE transactions SET bucket = :bucket, category = :category, bucket_source = 'user' WHERE id = :id", { id, bucket, category });
    if (!remember) return 1;
    const pattern = rulePattern(t.description);
    run(`INSERT INTO rules (pattern, bucket, category, created_at) VALUES (:pattern, :bucket, :category, :now)
         ON CONFLICT (pattern) DO UPDATE SET bucket = excluded.bucket, category = excluded.category`, { pattern, bucket, category, now: now() });
    const others = all<{ id: string; description: string; amount: number }>(
      "SELECT id, description, amount FROM transactions WHERE bucket_source IN ('auto', 'rule') AND id <> :id", { id });
    let n = 1;
    for (const o of others) {
      if (rulePattern(o.description) !== pattern) continue;
      run("UPDATE transactions SET bucket = :bucket, category = :category, bucket_source = 'rule' WHERE id = :id", { id: o.id, bucket, category });
      n++;
    }
    return n;
  });
}

/** Старим операціям (до категорій) і тим, що прийшли без неї, — категорія за правилом чи типом магазину */
export function backfillCategories() {
  const rows = all<{ id: string; description: string; mcc: number | null }>(
    "SELECT id, description, mcc FROM transactions WHERE bucket = 'spend' AND category IS NULL");
  if (!rows.length) return 0;
  const rules = new Map(all<{ pattern: string; category: string }>("SELECT pattern, category FROM rules WHERE bucket = 'spend' AND category IS NOT NULL")
    .map((r) => [r.pattern, r.category]));
  tx(() => {
    for (const r of rows) {
      const ruled = rules.get(rulePattern(r.description));
      run('UPDATE transactions SET category = :c WHERE id = :id', { id: r.id, c: isCategory(ruled) ? ruled : mccCategory(r.mcc) });
    }
  });
  return rows.length;
}

// ── Запис операцій з Monobank ──

export type MonoItem = {
  id: string; time: number; description: string; mcc: number; originalMcc?: number; hold: boolean; amount: number;
  comment?: string; counterName?: string; counterIban?: string;
};

/** Додати чи оновити операції картки; вибір людини (user/need) не перетираємо */
export function storeMonoItems(memberId: number, accountId: string, items: MonoItem[]) {
  const contexts = new Map<string, ReturnType<typeof loadContext>>();
  let added = 0;
  tx(() => {
    for (const it of items) {
      const month = monthOf(it.time);
      if (!contexts.has(month)) contexts.set(month, loadContext(month));
      const raw = { amount: it.amount, description: it.description ?? '', mcc: it.mcc ?? null, counter_name: it.counterName ?? null, counter_iban: it.counterIban ?? null };
      const v = classify(raw, contexts.get(month)!);
      const existed = one<{ bucket_source: string }>('SELECT bucket_source FROM transactions WHERE id = :id', { id: it.id });
      if (!existed) added++;
      run(`INSERT INTO transactions (id, source, account_id, member_id, time, amount, description, mcc, comment, counter_name, counter_iban, hold, bucket, category, bucket_source, created_at)
           VALUES (:id, 'mono', :account, :member, :time, :amount, :description, :mcc, :comment, :counter_name, :counter_iban, :hold, :bucket, :category, :source, :now)
           ON CONFLICT (id) DO UPDATE SET time = excluded.time, amount = excluded.amount, description = excluded.description, mcc = excluded.mcc,
             comment = excluded.comment, counter_name = excluded.counter_name, counter_iban = excluded.counter_iban, hold = excluded.hold,
             bucket = CASE WHEN transactions.bucket_source IN ('user', 'need') THEN transactions.bucket ELSE excluded.bucket END,
             category = CASE WHEN transactions.bucket_source IN ('user', 'need') THEN transactions.category ELSE excluded.category END,
             bucket_source = CASE WHEN transactions.bucket_source IN ('user', 'need') THEN transactions.bucket_source ELSE excluded.bucket_source END`,
      {
        id: it.id, account: accountId, member: memberId, time: it.time, amount: it.amount, description: raw.description, mcc: raw.mcc,
        comment: it.comment ?? null, counter_name: raw.counter_name, counter_iban: raw.counter_iban, hold: it.hold ? 1 : 0,
        bucket: v.bucket, category: v.category, source: v.source, now: now(),
      });
      if (raw.mcc != null && TRANSFER_MCC.has(raw.mcc)) pairInternal(it.id);
      // Платіж зі списку — ставимо галочку «сплачено»; ще одна частина того ж платежу з банку додається
      if (v.needId && !existed) {
        const need = needsFor(month).find((n) => n.id === v.needId);
        if (need && !need.paid) setNeedMonth(need.id, month, { paid: true, paid_amount: -it.amount, tx_id: it.id, paid_at: it.time });
        else if (need?.tx_id) {
          run('UPDATE need_months SET paid_amount = COALESCE(paid_amount, 0) + :add WHERE need_id = :id AND month = :month', { id: need.id, month, add: -it.amount });
        }
      }
    }
  });
  return added;
}

// Переказ між нашими картками Monobank («Переказ на картку» в одного, «З Чорної картки» в іншого) приходить
// без імені й IBAN. Упізнаємо за парою: та сама сума з іншим знаком на іншій нашій картці в межах двох хвилин.
// Та сама умова — у міграції 2 (db.ts) для вже збережених операцій
const PAIR_SECONDS = 120;
const TRANSFER_MCC_SQL = [...TRANSFER_MCC].join(', ');
function pairInternal(id: string) {
  const t = one<{ account_id: string; time: number; amount: number }>(
    "SELECT account_id, time, amount FROM transactions WHERE id = :id AND bucket_source = 'auto' AND bucket IN ('income', 'spend', 'internal')", { id });
  if (!t || !t.amount) return;
  const twin = one<{ id: string }>(
    `SELECT id FROM transactions WHERE account_id <> :account AND amount = :amount AND ABS(time - :time) <= ${PAIR_SECONDS}
       AND bucket_source = 'auto' AND bucket IN ('income', 'spend', 'internal') AND mcc IN (${TRANSFER_MCC_SQL})
     ORDER BY ABS(time - :time) LIMIT 1`,
    { account: t.account_id, amount: -t.amount, time: t.time });
  if (twin) run("UPDATE transactions SET bucket = 'internal', category = NULL WHERE id IN (:a, :b)", { a: id, b: twin.id });
}
