// Бюджет місяця: дохід ділимо на кошики (типово 50/30/20), перерозподіли додають чи забирають,
// а витрачене рахуємо з операцій. Спільне для інтерфейсу (api.ts) і Адольфа (mcp.ts).
import { randomUUID } from 'node:crypto';
import { all, BUCKETS, getDefaults, one, run, tx, TX_BUCKETS, type Bucket, type TxBucket } from './db.ts';
import { classify, loadContext, rulePattern } from './classify.ts';
import { addMonths, MONTH_RE, monthOf, monthRange, now, thisMonth } from './time.ts';

export class UserError extends Error {}

export const checkMonth = (month: string | undefined | null) => {
  const m = month || thisMonth();
  if (!MONTH_RE.test(m)) throw new UserError(`Місяць має бути у форматі РРРР-ММ, а не «${m}»`);
  return m;
};
const checkBucket = (b: string): Bucket => {
  if (!(BUCKETS as readonly string[]).includes(b)) throw new UserError(`Невідомий кошик «${b}»: needs, wants або savings`);
  return b as Bucket;
};
const checkAmount = (kop: number) => {
  if (!Number.isInteger(kop) || kop < 0) throw new UserError('Сума має бути додатною');
  return kop;
};

// ── Місяць ──

type MonthRow = { income: number | null; needs_pct: number | null; wants_pct: number | null; savings_pct: number | null };

export type Need = {
  id: number; title: string; amount: number; default_amount: number; match: string | null; once: boolean;
  paid: boolean; paid_at: number | null; paid_amount: number | null; tx_id: string | null;
};
export type Want = { id: number; title: string; amount: number | null; month: string | null; url: string | null; note: string | null; bought: boolean; bought_at: number | null };
export type Move = { id: number; month: string; from: Bucket; to: Bucket; amount: number; note: string | null; need_id: number | null };
export type Jar = { id: string; title: string; balance: number; goal: number | null; currency: number; member: string };

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

export function movesFor(month: string): Move[] {
  return all<{ id: number; month: string; from_bucket: Bucket; to_bucket: Bucket; amount: number; note: string | null; need_id: number | null }>(
    'SELECT * FROM moves WHERE month = :month ORDER BY id', { month },
  ).map((m) => ({ id: m.id, month: m.month, from: m.from_bucket, to: m.to_bucket, amount: m.amount, note: m.note, need_id: m.need_id }));
}

export function jars(): Jar[] {
  return all<Jar>(
    `SELECT a.id, a.title, a.balance, a.goal, a.currency, m.name AS member FROM accounts a JOIN members m ON m.id = a.member_id
      WHERE a.kind = 'jar' AND a.include = 1 ORDER BY a.balance DESC`);
}

export function monthSummary(month: string) {
  const d = getDefaults();
  const m = one<MonthRow>('SELECT income, needs_pct, wants_pct, savings_pct FROM months WHERE month = :month', { month });
  const income = m?.income ?? d.income;
  const pct = { needs: m?.needs_pct ?? d.needs_pct, wants: m?.wants_pct ?? d.wants_pct, savings: m?.savings_pct ?? d.savings_pct };
  const base = { needs: Math.round((income * pct.needs) / 100), wants: Math.round((income * pct.wants) / 100), savings: 0 };
  base.savings = Math.round((income * pct.savings) / 100);

  const moves = movesFor(month);
  const allocated = { ...base };
  for (const mv of moves) {
    allocated[mv.from] -= mv.amount;
    allocated[mv.to] += mv.amount;
  }

  const [start, end] = monthRange(month);
  const sums = all<{ bucket: TxBucket; total: number; n: number }>(
    'SELECT bucket, SUM(amount) AS total, COUNT(*) AS n FROM transactions WHERE time >= :start AND time < :end GROUP BY bucket', { start, end });
  const sum = (b: TxBucket) => sums.find((s) => s.bucket === b)?.total ?? 0;
  // Витрати й поповнення банок — мінус на картці, тож «витрачено» = −сума
  const spent = { needs: -sum('needs'), wants: -sum('wants'), savings: -sum('savings') };

  const needs = needsFor(month);
  const wants = wantsFor(month);
  const unchecked = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM transactions WHERE time >= :start AND time < :end AND bucket_source = 'auto' AND bucket IN ('needs', 'wants')", { start, end })!.n;

  const buckets = Object.fromEntries(BUCKETS.map((b) => [b, {
    pct: pct[b], base: base[b], allocated: allocated[b], spent: spent[b], left: allocated[b] - spent[b],
  }])) as Record<Bucket, { pct: number; base: number; allocated: number; spent: number; left: number }>;

  return {
    month, income, income_actual: sum('income'), custom: !!m, buckets, moves, needs, wants, unchecked,
    needs_plan: {
      total: needs.reduce((s, n) => s + n.amount, 0),
      paid: needs.filter((n) => n.paid).reduce((s, n) => s + (n.paid_amount ?? n.amount), 0),
      left: needs.filter((n) => !n.paid).reduce((s, n) => s + n.amount, 0),
      count: needs.length, paid_count: needs.filter((n) => n.paid).length,
    },
    wants_plan: {
      total: wants.reduce((s, w) => s + (w.amount ?? 0), 0),
      left: wants.filter((w) => !w.bought).reduce((s, w) => s + (w.amount ?? 0), 0),
      count: wants.length, bought_count: wants.filter((w) => w.bought).length,
    },
    jars: jars(),
  };
}

export function setMonth(month: string, p: { income?: number | null; needs_pct?: number | null; wants_pct?: number | null; savings_pct?: number | null; reset?: boolean }) {
  if (p.reset) return void run('DELETE FROM months WHERE month = :month', { month });
  const cur = one<MonthRow>('SELECT income, needs_pct, wants_pct, savings_pct FROM months WHERE month = :month', { month });
  const next = { income: cur?.income ?? null, needs_pct: cur?.needs_pct ?? null, wants_pct: cur?.wants_pct ?? null, savings_pct: cur?.savings_pct ?? null };
  if (p.income !== undefined) next.income = p.income == null ? null : checkAmount(p.income);
  if (p.needs_pct !== undefined || p.wants_pct !== undefined || p.savings_pct !== undefined) {
    const d = getDefaults();
    const n = p.needs_pct ?? next.needs_pct ?? d.needs_pct, w = p.wants_pct ?? next.wants_pct ?? d.wants_pct, s = p.savings_pct ?? next.savings_pct ?? d.savings_pct;
    if (n + w + s !== 100 || [n, w, s].some((x) => !Number.isInteger(x) || x < 0)) throw new UserError('Відсотки мають бути цілими й разом давати 100');
    Object.assign(next, { needs_pct: n, wants_pct: w, savings_pct: s });
  }
  run(`INSERT INTO months (month, income, needs_pct, wants_pct, savings_pct) VALUES (:month, :income, :needs_pct, :wants_pct, :savings_pct)
       ON CONFLICT (month) DO UPDATE SET income = excluded.income, needs_pct = excluded.needs_pct, wants_pct = excluded.wants_pct, savings_pct = excluded.savings_pct`,
  { month, ...next });
}

// ── Потреби ──

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
  if (!n) throw new UserError('Немає такої потреби');
  if (p.title !== undefined) {
    if (!p.title.trim()) throw new UserError('Порожня назва');
    run('UPDATE needs SET title = :t WHERE id = :id', { id, t: p.title.trim() });
  }
  if (p.match !== undefined) run('UPDATE needs SET match = :m WHERE id = :id', { id, m: p.match?.trim() || null });
}

/** Нова сума потреби: лише на цей місяць або з цього місяця й надалі (минулі не змінюються) */
export function setNeedAmount(id: number, month: string, amountIn: number, forward: boolean) {
  const amount = checkAmount(amountIn);
  tx(() => {
    const need = needsFor(month).find((n) => n.id === id);
    if (!need) throw new UserError('Цієї потреби немає в цьому місяці');
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
    if (!n) throw new UserError('Немає такої потреби');
    const history = one<{ n: number }>('SELECT COUNT(*) AS n FROM need_months WHERE need_id = :id AND paid_at IS NOT NULL AND month < :month', { id, month })!.n;
    if (n.once_month || !history || n.start_month >= month) {
      run('UPDATE moves SET need_id = NULL WHERE need_id = :id', { id });
      run('DELETE FROM needs WHERE id = :id', { id });
    } else run('UPDATE needs SET end_month = :month WHERE id = :id', { id, month });
  });
}

export function setNeedMonth(id: number, month: string, p: { amount?: number | null; paid?: boolean; paid_amount?: number | null; tx_id?: string | null; paid_at?: number }) {
  const need = needsFor(month).find((n) => n.id === id);
  if (!need) throw new UserError('Цієї потреби немає в цьому місяці');
  run('INSERT INTO need_months (need_id, month) VALUES (:id, :month) ON CONFLICT DO NOTHING', { id, month });
  if (p.amount !== undefined) run('UPDATE need_months SET amount = :a WHERE need_id = :id AND month = :month', { id, month, a: p.amount == null ? null : checkAmount(p.amount) });
  if (p.paid === true) {
    run(`UPDATE need_months SET paid_at = :at, paid_amount = :pa, tx_id = :tx WHERE need_id = :id AND month = :month`,
      { id, month, at: p.paid_at ?? now(), pa: p.paid_amount ?? (p.amount ?? need.amount), tx: p.tx_id ?? null });
  } else if (p.paid === false) {
    run('UPDATE need_months SET paid_at = NULL, paid_amount = NULL, tx_id = NULL WHERE need_id = :id AND month = :month', { id, month });
  }
}

// ── На себе: план місяця й вішліст ──

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

// ── Перерозподіл ──

export function addMove(p: { month: string; from: string; to: string; amount: number; note?: string | null; as_need?: boolean }) {
  const month = checkMonth(p.month), from = checkBucket(p.from), to = checkBucket(p.to);
  if (from === to) throw new UserError('Кошики мають бути різні');
  const amount = checkAmount(p.amount);
  if (!amount) throw new UserError('Сума має бути більшою за нуль');
  return tx(() => {
    // «12 500 із заощаджень на погашення кредиту» — ще й разовий пункт у потребах того місяця
    const needId = p.as_need && to === 'needs' ? addNeed({ title: p.note?.trim() || 'Разовий платіж', amount, once_month: month }) : null;
    const r = run(`INSERT INTO moves (month, from_bucket, to_bucket, amount, note, need_id, created_at)
                   VALUES (:month, :from, :to, :amount, :note, :need, :now)`, { month, from, to, amount, note: p.note?.trim() || null, need: needId, now: now() });
    return Number(r.lastInsertRowid);
  });
}

export function removeMove(id: number) {
  tx(() => {
    const m = one<{ need_id: number | null }>('SELECT need_id FROM moves WHERE id = :id', { id });
    if (!m) throw new UserError('Немає такого перерозподілу');
    run('DELETE FROM moves WHERE id = :id', { id });
    if (m.need_id) run('DELETE FROM needs WHERE id = :id AND once_month IS NOT NULL', { id: m.need_id });
  });
}

// ── Операції ──

export type Tx = {
  id: string; source: 'mono' | 'manual'; time: number; amount: number; description: string; mcc: number | null; comment: string | null;
  counter_name: string | null; hold: number; bucket: TxBucket; bucket_source: string; member: string | null; account: string | null;
};

export function transactions(month: string, bucket?: string, limit = 500): Tx[] {
  const [start, end] = monthRange(month);
  return all<Tx>(
    `SELECT t.id, t.source, t.time, t.amount, t.description, t.mcc, t.comment, t.counter_name, t.hold, t.bucket, t.bucket_source,
            m.name AS member, a.title AS account
       FROM transactions t LEFT JOIN members m ON m.id = t.member_id LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.time >= :start AND t.time < :end AND (:bucket IS NULL OR t.bucket = :bucket)
      ORDER BY t.time DESC LIMIT :limit`, { start, end, bucket: bucket ?? null, limit });
}

const checkTxBucket = (b: string): TxBucket => {
  if (!(TX_BUCKETS as readonly string[]).includes(b)) throw new UserError(`Невідомий кошик «${b}»`);
  return b as TxBucket;
};

export function addManualTx(p: { amount: number; description: string; bucket: string; time?: number; member_id?: number | null }) {
  const id = `man-${randomUUID()}`;
  const bucket = checkTxBucket(p.bucket);
  const kop = checkAmount(p.amount);
  if (!kop) throw new UserError('Сума має бути більшою за нуль');
  // Витрату й поповнення заощаджень пишемо мінусом, як у банку; дохід — плюсом
  const amount = bucket === 'income' ? kop : -kop;
  run(`INSERT INTO transactions (id, source, member_id, time, amount, description, bucket, bucket_source, created_at)
       VALUES (:id, 'manual', :member, :time, :amount, :desc, :bucket, 'user', :now)`,
  { id, member: p.member_id ?? null, time: p.time ?? now(), amount, desc: p.description.trim() || 'Готівка', bucket, now: now() });
  return id;
}

export function removeManualTx(id: string) {
  const t = one<{ source: string }>('SELECT source FROM transactions WHERE id = :id', { id });
  if (!t) throw new UserError('Немає такої операції');
  if (t.source !== 'manual') throw new UserError('Операції з банку не видаляються — познач «не рахувати»');
  run('DELETE FROM transactions WHERE id = :id', { id });
}

/** Змінити кошик операції; remember — запамʼятати для цього опису й перерахувати інші такі самі */
export function setTxBucket(id: string, bucketIn: string, remember = false) {
  const bucket = checkTxBucket(bucketIn);
  return tx(() => {
    const t = one<{ description: string }>('SELECT description FROM transactions WHERE id = :id', { id });
    if (!t) throw new UserError('Немає такої операції');
    run("UPDATE transactions SET bucket = :bucket, bucket_source = 'user' WHERE id = :id", { id, bucket });
    if (!remember) return 1;
    const pattern = rulePattern(t.description);
    run('INSERT INTO rules (pattern, bucket, created_at) VALUES (:pattern, :bucket, :now) ON CONFLICT (pattern) DO UPDATE SET bucket = excluded.bucket',
      { pattern, bucket, now: now() });
    const others = all<{ id: string; description: string }>("SELECT id, description FROM transactions WHERE bucket_source IN ('auto', 'rule') AND id <> :id", { id });
    let n = 1;
    for (const o of others) {
      if (rulePattern(o.description) !== pattern) continue;
      run("UPDATE transactions SET bucket = :bucket, bucket_source = 'rule' WHERE id = :id", { id: o.id, bucket });
      n++;
    }
    return n;
  });
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
      run(`INSERT INTO transactions (id, source, account_id, member_id, time, amount, description, mcc, comment, counter_name, counter_iban, hold, bucket, bucket_source, created_at)
           VALUES (:id, 'mono', :account, :member, :time, :amount, :description, :mcc, :comment, :counter_name, :counter_iban, :hold, :bucket, :source, :now)
           ON CONFLICT (id) DO UPDATE SET time = excluded.time, amount = excluded.amount, description = excluded.description, mcc = excluded.mcc,
             comment = excluded.comment, counter_name = excluded.counter_name, counter_iban = excluded.counter_iban, hold = excluded.hold,
             bucket = CASE WHEN transactions.bucket_source IN ('user', 'need') THEN transactions.bucket ELSE excluded.bucket END,
             bucket_source = CASE WHEN transactions.bucket_source IN ('user', 'need') THEN transactions.bucket_source ELSE excluded.bucket_source END`,
      {
        id: it.id, account: accountId, member: memberId, time: it.time, amount: it.amount, description: raw.description, mcc: raw.mcc,
        comment: it.comment ?? null, counter_name: raw.counter_name, counter_iban: raw.counter_iban, hold: it.hold ? 1 : 0,
        bucket: v.bucket, source: v.source, now: now(),
      });
      // Платіж зі списку потреб — ставимо галочку «сплачено»; ще одна частина того ж платежу з банку додається
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

/** Перед зміною типового плану: минулі місяці лишаються з тим, за яким жили (отримують свій запис) */
export function freezePast() {
  const d = getDefaults();
  const firstTx = one<{ t: number | null }>('SELECT MIN(time) AS t FROM transactions')!.t;
  const firstPlan = one<{ m: string | null }>(
    'SELECT MIN(m) AS m FROM (SELECT MIN(start_month) AS m FROM needs UNION ALL SELECT MIN(month) FROM moves UNION ALL SELECT MIN(month) FROM wants)')!.m;
  const start = [firstPlan, firstTx != null ? monthOf(firstTx) : null].filter((m): m is string => !!m).sort()[0];
  if (!start) return;
  const cur = thisMonth();
  tx(() => {
    run(`UPDATE months SET income = COALESCE(income, :income), needs_pct = COALESCE(needs_pct, :n), wants_pct = COALESCE(wants_pct, :w),
           savings_pct = COALESCE(savings_pct, :s) WHERE month < :cur`, { income: d.income, n: d.needs_pct, w: d.wants_pct, s: d.savings_pct, cur });
    for (let m = start; m < cur; m = addMonths(m, 1)) {
      run(`INSERT INTO months (month, income, needs_pct, wants_pct, savings_pct) VALUES (:m, :income, :n, :w, :s) ON CONFLICT (month) DO NOTHING`,
        { m, income: d.income, n: d.needs_pct, w: d.wants_pct, s: d.savings_pct });
    }
  });
}
