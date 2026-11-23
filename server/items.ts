// Що саме купили: товари з чеків (фото → ШІ) і вписані вручну до операції.
// Чек прив'язуємо до операції з банку за сумою й часом; немає такої (готівка, інша картка) — окрема операція.
// Наприкінці місяця — підсумок по товарах і порада ШІ, від чого можна відмовитись.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.ts';
import { all, one, run, tx } from './db.ts';
import { addManualTx, categorySums, checkAmount, checkCategory, UserError } from './budget.ts';
import { CATEGORIES, isItemGroup, ITEM_GROUPS, type Category, type ItemGroup } from './categories.ts';
import { adviseMonth, tagItems } from './ai.ts';
import { monthRange, now } from './time.ts';

const DIR = path.join(DATA_DIR, 'receipts');
mkdirSync(DIR, { recursive: true, mode: 0o700 });
const IMAGE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MONTHS_OF = ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень', 'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'];

export type Item = { id: number; name: string; title: string | null; group: ItemGroup | null; qty: number | null; amount: number; receipt_id: number | null };
export type ItemInput = { id?: number | null; name: string; title?: string | null; group?: string | null; qty?: number | null; amount: number };

export function itemsFor(txId: string): Item[] {
  return all<Omit<Item, 'group'> & { item_group: string | null }>(
    'SELECT id, name, title, item_group, qty, amount, receipt_id FROM items WHERE tx_id = :id ORDER BY sort, id', { id: txId })
    .map(({ item_group, ...i }) => ({ ...i, group: isItemGroup(item_group) ? item_group : null }));
}

function cleanItems(list: unknown): ItemInput[] {
  if (!Array.isArray(list)) throw new UserError('Очікую список товарів');
  if (list.length > 200) throw new UserError('Забагато товарів в одному чеку');
  return list.map((i: any) => {
    const name = String(i?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!name) throw new UserError('У товару порожня назва');
    const amount = checkAmount(Number(i?.amount));
    if (!amount) throw new UserError(`Вкажи ціну для «${name}»`);
    const qty = Number(i?.qty);
    return {
      id: Number.isInteger(i?.id) ? i.id : null, name, amount,
      title: typeof i?.title === 'string' && i.title.trim() ? i.title.trim().slice(0, 60) : null,
      group: isItemGroup(i?.group) ? i.group : null,
      qty: Number.isFinite(qty) && qty > 0 ? qty : null,
    };
  });
}

function insertItems(txId: string, items: ItemInput[], receiptId: number | null) {
  items.forEach((i, sort) => run(
    `INSERT INTO items (tx_id, receipt_id, name, title, item_group, qty, amount, sort, created_at)
     VALUES (:tx, :receipt, :name, :title, :grp, :qty, :amount, :sort, :now)`,
    { tx: txId, receipt: receiptId, name: i.name, title: i.title ?? i.name, grp: i.group ?? 'other', qty: i.qty ?? null, amount: i.amount, sort, now: now() }));
}

/**
 * Товари операції, вписані вручну: список замінює попередній. Нові й перейменовані товари ШІ підписує
 * загальною назвою й групою (для підсумку місяця); у вже відомих лишаємо як були
 */
export async function setItems(txId: string, list: unknown) {
  const t = one<{ description: string }>('SELECT description FROM transactions WHERE id = :id', { id: txId });
  if (!t) throw new UserError('Немає такої операції');
  const items = cleanItems(list);
  const old = new Map(itemsFor(txId).map((i) => [i.id, i]));
  const keep = items.map((i) => {
    const o = i.id != null ? old.get(i.id) : undefined;
    return o && o.name === i.name ? { ...i, title: i.title ?? o.title, group: i.group ?? o.group, receipt: o.receipt_id } : { ...i, receipt: null };
  });
  const untagged = keep.filter((i) => !i.title || !i.group);
  const tags = await tagItems(untagged.map((i) => i.name), t.description);
  untagged.forEach((i, n) => Object.assign(i, { title: i.title ?? tags[n].title, group: i.group ?? tags[n].group }));
  tx(() => {
    run('DELETE FROM items WHERE tx_id = :id', { id: txId });
    keep.forEach((i, sort) => run(
      `INSERT INTO items (tx_id, receipt_id, name, title, item_group, qty, amount, sort, created_at)
       VALUES (:tx, :receipt, :name, :title, :grp, :qty, :amount, :sort, :now)`,
      { tx: txId, receipt: i.receipt ?? null, name: i.name, title: i.title ?? i.name, grp: i.group ?? 'other', qty: i.qty ?? null, amount: i.amount, sort, now: now() }));
  });
  return itemsFor(txId);
}

// ── Чеки ──

/** Фото чека — у DATA_DIR/receipts; повертаємо назву, яку потім передають у saveReceipt */
export function saveImage(data: Buffer) {
  const id = randomUUID();
  writeFileSync(path.join(DIR, `${id}.jpg`), data, { mode: 0o600 });
  return id;
}

export function receiptImage(receiptId: number): Buffer | null {
  const r = one<{ image: string | null }>('SELECT image FROM receipts WHERE id = :id', { id: receiptId });
  if (!r?.image || !IMAGE_RE.test(r.image)) return null;
  try {
    return readFileSync(path.join(DIR, `${r.image}.jpg`));
  } catch {
    return null;
  }
}

/** Фото, які так і не записали (передумали) або чиї операції видалили, — геть за два дні */
export function cleanupImages(maxAge = 2 * 86400) {
  const used = new Set(all<{ image: string }>('SELECT image FROM receipts WHERE image IS NOT NULL').map((r) => r.image));
  for (const f of readdirSync(DIR)) {
    const id = f.replace(/\.jpg$/, '');
    if (!IMAGE_RE.test(id) || used.has(id)) continue;
    const file = path.join(DIR, f);
    if (Date.now() / 1000 - statSync(file).mtimeMs / 1000 > maxAge) unlinkSync(file);
  }
}

export type Candidate = {
  id: string; time: number; amount: number; description: string; category: Category | null;
  member: string | null; account: string | null; items: number; exact: boolean;
};

/**
 * Операції, до яких підходить чек: витрата на ту саму суму (або майже — у межах 3%, щонайменше 1 ₴)
 * від доби до чека до 4 діб після (утримання й списання бувають пізніше). Спершу точна сума, далі найближчі за часом
 */
export function receiptCandidates(total: number, time: number | null, at = now()): Candidate[] {
  const ref = time ?? at;
  const rows = all<Omit<Candidate, 'exact'>>(
    `SELECT t.id, t.time, t.amount, t.description, t.category, m.name AS member, a.title AS account,
            (SELECT COUNT(*) FROM items i WHERE i.tx_id = t.id) AS items
       FROM transactions t LEFT JOIN members m ON m.id = t.member_id LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.bucket = 'spend' AND t.amount < 0 AND t.time BETWEEN :from AND :to AND ABS(-t.amount - :total) <= MAX(100, :total * 3 / 100)`,
    { from: ref - (time ? 86400 : 10 * 86400), to: ref + 4 * 86400, total });
  return rows
    .map((r) => ({ ...r, exact: -r.amount === total }))
    .sort((a, b) => Number(b.exact) - Number(a.exact) || Number(a.items > 0) - Number(b.items > 0) || Math.abs(a.time - ref) - Math.abs(b.time - ref))
    .slice(0, 6);
}

/** Який варіант обрати самим: точна сума без товарів; коли час чека відомий — не далі двох діб */
export function bestCandidate(c: Candidate[], time: number | null) {
  return c.find((x) => x.exact && !x.items && (time == null || Math.abs(x.time - time) <= 2 * 86400))?.id ?? null;
}

/**
 * Записати чек: до операції tx_id або, якщо її немає, окремою операцією (магазин, сума, час із чека).
 * Чек до операції один — новий замінює попередній разом із товарами
 */
export function saveReceipt(p: { tx_id?: string | null; store?: string | null; time?: number | null; total: number; category?: string | null; items: unknown; image?: string | null }) {
  const items = cleanItems(p.items);
  const total = checkAmount(Number(p.total));
  if (!total) throw new UserError('Сума чека має бути більшою за нуль');
  const store = typeof p.store === 'string' ? p.store.trim().slice(0, 60) || null : null;
  const category = p.category ? checkCategory(p.category) : null;
  const time = Number.isInteger(p.time) ? p.time! : null;
  const image = typeof p.image === 'string' && IMAGE_RE.test(p.image) ? p.image : null;
  return tx(() => {
    let txId = p.tx_id || null;
    if (txId) {
      const t = one<{ bucket_source: string; category: string | null }>('SELECT bucket_source, category FROM transactions WHERE id = :id', { id: txId });
      if (!t) throw new UserError('Немає такої операції');
      // Банк не знав, що це за магазин («Інше»), — беремо категорію з чека
      if (category && t.bucket_source === 'auto' && (t.category ?? 'other') === 'other') {
        run("UPDATE transactions SET category = :c WHERE id = :id AND bucket = 'spend'", { id: txId, c: category });
      }
    } else {
      txId = addManualTx({ amount: total, description: store || 'Покупка за чеком', bucket: 'spend', category: category ?? 'other', time: time ?? now() });
    }
    run('DELETE FROM items WHERE tx_id = :id', { id: txId });
    run('DELETE FROM receipts WHERE tx_id = :id', { id: txId });
    const r = run('INSERT INTO receipts (tx_id, store, time, total, image, created_at) VALUES (:tx, :store, :time, :total, :image, :now)',
      { tx: txId, store, time, total, image, now: now() });
    insertItems(txId, items, Number(r.lastInsertRowid));
    return { tx_id: txId, receipt_id: Number(r.lastInsertRowid) };
  });
}

// ── Підсумок місяця ──

type TitleSum = { title: string; total: number; n: number };

export function monthItems(month: string) {
  const [start, end] = monthRange(month);
  const rows = all<{ title: string; grp: string | null; amount: number; tx_id: string }>(
    `SELECT COALESCE(i.title, i.name) AS title, i.item_group AS grp, i.amount, i.tx_id
       FROM items i JOIN transactions t ON t.id = i.tx_id
      WHERE t.bucket = 'spend' AND t.time >= :start AND t.time < :end`, { start, end });
  const spent = one<{ s: number | null }>(
    "SELECT -SUM(amount) AS s FROM transactions WHERE bucket = 'spend' AND time >= :start AND time < :end", { start, end })!.s ?? 0;
  const covered = one<{ s: number | null; n: number }>(
    `SELECT -SUM(t.amount) AS s, COUNT(*) AS n FROM transactions t
      WHERE t.bucket = 'spend' AND t.time >= :start AND t.time < :end AND EXISTS (SELECT 1 FROM items i WHERE i.tx_id = t.id)`, { start, end })!;

  const groups = new Map<ItemGroup, { total: number; n: number; titles: Map<string, TitleSum> }>();
  const titles = new Map<string, TitleSum & { tx: Set<string> }>();
  for (const r of rows) {
    const g = isItemGroup(r.grp) ? r.grp : 'other';
    const gs = groups.get(g) ?? { total: 0, n: 0, titles: new Map() };
    gs.total += r.amount;
    gs.n++;
    const key = r.title.toLowerCase();
    const ts = gs.titles.get(key) ?? { title: r.title, total: 0, n: 0 };
    ts.total += r.amount;
    ts.n++;
    gs.titles.set(key, ts);
    groups.set(g, gs);
    const ti = titles.get(key) ?? { title: r.title, total: 0, n: 0, tx: new Set<string>() };
    ti.total += r.amount;
    ti.tx.add(r.tx_id);
    ti.n = ti.tx.size;
    titles.set(key, ti);
  }
  const strip = ({ title, total, n }: TitleSum) => ({ title, total, n });
  return {
    spent,
    /** Скільки витрат розписано по товарах і в скількох покупках */
    covered: covered.s ?? 0, purchases: covered.n,
    total: rows.reduce((s, r) => s + r.amount, 0),
    groups: [...groups.entries()]
      .map(([group, g]) => ({ group, title: ITEM_GROUPS[group], total: g.total, n: g.n, top: [...g.titles.values()].sort((a, b) => b.total - a.total).slice(0, 8) }))
      .sort((a, b) => b.total - a.total),
    /** Що купували найчастіше (скільки разів — у скількох покупках) */
    frequent: [...titles.values()].filter((t) => t.n >= 2).sort((a, b) => b.n - a.n || b.total - a.total).slice(0, 10).map(strip),
    biggest: [...titles.values()].sort((a, b) => b.total - a.total).slice(0, 10).map(strip),
  };
}

export function topMerchants(month: string, limit = 12) {
  const [start, end] = monthRange(month);
  return all<{ description: string; total: number; n: number }>(
    `SELECT MIN(description) AS description, -SUM(amount) AS total, COUNT(*) AS n FROM transactions
      WHERE bucket = 'spend' AND time >= :start AND time < :end GROUP BY LOWER(description) ORDER BY total DESC LIMIT :limit`, { start, end, limit });
}

export function savedAdvice(month: string) {
  return one<{ text: string; created_at: number }>('SELECT text, created_at FROM advice WHERE month = :month', { month }) ?? null;
}

/** Порада ШІ на місяць: що скоротити. Зберігаємо — щоб не питати щоразу; refresh — спитати знову */
export async function adviceFor(month: string, refresh = false) {
  const saved = savedAdvice(month);
  if (saved && !refresh) return saved;
  const items = monthItems(month);
  if (!items.spent) throw new UserError('За цей місяць ще немає витрат');
  const uah = (k: number) => Math.round(k / 100);
  const data = {
    spent_total: uah(items.spent),
    by_category: categorySums(month).filter((c) => c.total > 0).map((c) => ({ category: CATEGORIES[c.category].title, uah: uah(c.total), payments: c.n })),
    top_merchants: topMerchants(month).map((m) => ({ where: m.description, uah: uah(m.total), times: m.n })),
    receipts_cover: `${uah(items.covered)} з ${uah(items.spent)} грн витрат розписано по товарах`,
    item_groups: items.groups.map((g) => ({ group: g.title, uah: uah(g.total), top: g.top.slice(0, 5).map((t) => `${t.title} ${uah(t.total)}`) })),
    bought_often: items.frequent.map((t) => ({ item: t.title, times: t.n, uah: uah(t.total) })),
  };
  const [, m] = month.split('-').map(Number);
  const text = await adviseMonth(MONTHS_OF[m - 1], data);
  run(`INSERT INTO advice (month, text, created_at) VALUES (:month, :text, :now)
       ON CONFLICT (month) DO UPDATE SET text = excluded.text, created_at = excluded.created_at`, { month, text, now: now() });
  return savedAdvice(month)!;
}
