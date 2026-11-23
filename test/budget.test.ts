// node --test test/ — витрати, платежі й чеки на тимчасовій базі, без Monobank і без ШІ
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'kapshuk-test-'));
process.env.KAPSHUK_NO_SYNC = '1';
process.env.GEMINI_URL = 'http://127.0.0.1:9'; // ШІ «недоступний»: товари вручну лишаються з назвою як є
const { run } = await import('../server/db.ts');
const b = await import('../server/budget.ts');
const items = await import('../server/items.ts');
const { normalizeReceipt } = await import('../server/ai.ts');
const { monthStart, addMonths, kyivUnix } = await import('../server/time.ts');

const M = '2026-11';
const at = (day: number) => monthStart(M) + (day - 1) * 86400 + 12 * 3600;
const item = (id: string, day: number, amount: number, description: string, mcc = 5411, extra = {}) =>
  ({ id, time: at(day), amount, description, mcc, hold: false, ...extra });
const tx = (id: string, month = M) => b.transactions(month).find((t) => t.id === id)!;

run("INSERT INTO members (id, name, mono_name, created_at) VALUES (1, 'Юра', 'Авраменко Юрій', 0), (2, 'Оля', 'Авраменко Ольга', 0)");
run("INSERT INTO accounts (id, member_id, kind, title, currency, balance, include) VALUES ('card1', 1, 'card', 'Чорна', 980, 0, 1), ('jar1', 1, 'jar', 'Відпустка', 980, 3000000, 1)");

test('постійні платежі: ціна з місяця й надалі не чіпає минулі', () => {
  const id = b.addNeed({ title: 'Інтернет', amount: 30000, match: 'тріолан, triolan', month: '2026-10' });
  b.setNeedAmount(id, M, 35000, true);
  assert.equal(b.needsFor('2026-10').find((n) => n.id === id)!.amount, 30000);
  assert.equal(b.needsFor(M).find((n) => n.id === id)!.amount, 35000);
  assert.equal(b.needsFor(addMonths(M, 3)).find((n) => n.id === id)!.amount, 35000);
  b.setNeedAmount(id, addMonths(M, 1), 40000, false); // лише грудень
  assert.equal(b.needsFor(addMonths(M, 1)).find((n) => n.id === id)!.amount, 40000);
  assert.equal(b.needsFor(addMonths(M, 2)).find((n) => n.id === id)!.amount, 35000);
});

test('операції з банку: категорії за магазином, банки, перекази своїм і галочка «сплачено»', () => {
  b.storeMonoItems(1, 'card1', [
    item('t1', 2, -120000, 'Сільпо'), // продукти
    item('t2', 3, -50000, 'Кінотеатр', 7832), // розваги
    item('t3', 4, -35000, 'Тріолан', 4814), // платіж зі списку → сплачено, категорія — зв'язок
    item('t4', 5, -1000000, 'На банку «Відпустка»', 4829), // у банку
    item('t5', 6, -200000, 'Ользі', 4829, { counterName: 'Ольга А.' }), // своїм — не витрата
    item('t6', 7, 6000000, 'Зарплата', 4829), // дохід
    item('t8', 8, 21000, 'Скасування. Сільпо', 5411), // повернення — мінус у продуктах
  ]);
  const s = b.monthSummary(M);
  assert.equal(s.spent, 120000 + 50000 + 35000 - 21000);
  assert.equal(s.saved, 1000000);
  assert.equal(s.income_actual, 6000000);
  assert.deepEqual(s.categories.map((c) => [c.category, c.total]), [['groceries', 99000], ['fun', 50000], ['utilities', 35000]]);
  assert.equal(tx('t5').bucket, 'internal');
  assert.equal(tx('t5').category, null);
  const internet = s.needs.find((n) => n.title === 'Інтернет')!;
  assert.equal(internet.paid, true);
  assert.equal(internet.tx_id, 't3');
});

test('оренда «зняттям готівки»: дрібне зняття не рахується, дві частини додаються', () => {
  const dec = addMonths(M, 1);
  const id = b.addNeed({ title: 'Оренда', amount: 2100000, match: 'Зняття готівки', month: dec });
  const d = (day: number) => monthStart(dec) + day * 86400;
  b.storeMonoItems(1, 'card1', [{ id: 'c1', time: d(1), amount: -50000, description: 'Зняття готівки: Банкомат', mcc: 6011, hold: false }]);
  assert.equal(b.needsFor(dec).find((n) => n.id === id)!.paid, false);
  assert.equal(tx('c1', dec).category, 'cash');
  b.storeMonoItems(1, 'card1', [
    { id: 'c2', time: d(2), amount: -1000000, description: 'Зняття готівки: Банкомат', mcc: 6011, hold: false },
    { id: 'c3', time: d(2) + 60, amount: -1100000, description: 'Зняття готівки: Банкомат', mcc: 6011, hold: false },
  ]);
  const rent = b.needsFor(dec).find((n) => n.id === id)!;
  assert.equal(rent.paid, true);
  assert.equal(rent.paid_amount, 2100000);
  b.removeNeed(id, dec);
});

test('нова категорія запам\'ятовується для такого самого магазину й не перетирається банком', () => {
  b.storeMonoItems(1, 'card1', [item('m1', 9, -18000, 'M312', 5814), item('m2', 10, -18000, 'M312', 5814)]);
  assert.equal(tx('m1').category, 'cafe');
  assert.equal(b.setTxKind('m1', { category: 'groceries' }, true), 2);
  assert.equal(tx('m2').category, 'groceries');
  assert.equal(tx('m2').bucket_source, 'rule');
  b.storeMonoItems(1, 'card1', [item('m3', 11, -18000, 'M312', 5814)]);
  assert.equal(tx('m3').category, 'groceries');
  // людина вирішила інакше для однієї — повторне завантаження з банку цього не змінює
  b.setTxKind('m3', { category: 'cafe' });
  b.storeMonoItems(1, 'card1', [item('m3', 11, -18000, 'M312', 5814)]);
  assert.equal(tx('m3').category, 'cafe');
  // «не рахувати» теж запам'ятовується
  b.setTxKind('m3', { bucket: 'ignore' });
  assert.equal(tx('m3').bucket, 'ignore');
  assert.equal(tx('m3').category, null);
});

test('перекази: від фірми — дохід, між нашими картками Monobank — ні витрата, ні дохід', () => {
  run("INSERT INTO accounts (id, member_id, kind, title, currency, balance, include) VALUES ('card2', 2, 'card', 'Біла', 980, 0, 1)");
  const before = b.monthSummary(M);
  b.storeMonoItems(1, 'card1', [
    item('p1', 12, 2900000, 'Від: Education', 6012, { counterName: 'Education' }), // зарплата, не «повернення»
    item('p2', 13, -2100000, 'Переказ на картку', 4829), // Юра → Олі
  ]);
  b.storeMonoItems(2, 'card2', [item('p3', 13, 2100000, 'З Чорної картки', 4829, { time: at(13) + 1 })]);
  const s = b.monthSummary(M);
  assert.equal(s.income_actual - before.income_actual, 2900000);
  assert.equal(s.spent, before.spent);
  assert.equal(tx('p2').bucket, 'internal');
  assert.equal(tx('p3').bucket, 'internal');
});

test('старим операціям без категорії вона з\'являється сама', () => {
  run(`INSERT INTO transactions (id, source, account_id, member_id, time, amount, description, mcc, bucket, bucket_source, created_at)
       VALUES ('old1', 'mono', 'card1', 1, :t, -9900, 'АТБ', 5411, 'spend', 'auto', 0), ('old2', 'mono', 'card1', 1, :t, -18000, 'M312', 5814, 'spend', 'rule', 0)`, { t: at(14) });
  assert.equal(b.backfillCategories(), 2);
  assert.equal(tx('old1').category, 'groceries');
  assert.equal(tx('old2').category, 'groceries'); // за правилом із попереднього тесту
});

test('ШІ про чек: знижки, сума, дата', () => {
  const now = kyivUnix('2026-11-20', '10:00')!;
  const r = normalizeReceipt({
    is_receipt: true, store: '  АТБ  ', date: '2026-11-18', time: '19:42', total: 312.4, category: 'groceries',
    items: [
      { name: 'Молоко 2.5% 900г', title: 'Молоко', group: 'dairy', qty: 2, amount: 84 },
      { name: 'Знижка', title: 'Знижка', group: 'other', amount: -10 },
      { name: 'Хліб', title: 'Хліб', group: 'bread', amount: '28,40' },
      { name: 'Пакет', title: 'Пакет', group: 'щось', amount: 2 },
      { name: '', amount: 5 },
    ],
  }, now);
  assert.equal(r.store, 'АТБ');
  assert.equal(r.total, 31240);
  assert.equal(r.time, kyivUnix('2026-11-18', '19:42'));
  assert.deepEqual(r.items.map((i) => [i.title, i.amount, i.group]), [['Молоко', 7400, 'dairy'], ['Хліб', 2840, 'bread'], ['Пакет', 200, 'other']]);
  assert.equal(normalizeReceipt({ total: 0, items: [{ name: 'Кава', amount: 55 }], date: '2031-01-01' }, now).total, 5500);
  assert.equal(normalizeReceipt({ total: 55, items: [], date: '2031-01-01' }, now).time, null);
  assert.throws(() => normalizeReceipt({ is_receipt: false, total: 0, items: [] }, now), b.UserError);
});

test('чек до операції з банку: та сама сума, товари й підсумок місяця', () => {
  b.storeMonoItems(1, 'card1', [
    item('r1', 15, -31240, 'АТБ', 5411),
    item('r2', 15, -31000, 'Велмарт', 5411), // схожа сума — у варіантах, але не обирається сама
    item('r3', 16, -45000, 'Епіцентр', 5999), // магазин банку невідомий («Інше»)
  ]);
  const when = at(15) - 600;
  const c = items.receiptCandidates(31240, when);
  assert.equal(c[0].id, 'r1');
  assert.ok(c[0].exact);
  assert.ok(c.some((x) => x.id === 'r2' && !x.exact));
  assert.equal(items.bestCandidate(c, when), 'r1');

  const goods = [
    { name: 'Молоко 2.5%', title: 'Молоко', group: 'dairy', amount: 7400 },
    { name: 'Хліб', title: 'Хліб', group: 'bread', amount: 2840 },
    { name: 'Кава мелена', title: 'Кава', group: 'coffee_tea', amount: 21000 },
  ];
  const saved = items.saveReceipt({ tx_id: 'r1', store: 'АТБ', time: when, total: 31240, category: 'groceries', items: goods });
  assert.equal(saved.tx_id, 'r1');
  assert.equal(items.itemsFor('r1').length, 3);
  assert.equal(tx('r1').items, 3);
  assert.equal(tx('r1').receipt_id, saved.receipt_id);
  // уже з товарами — далі не обирається сама
  assert.equal(items.bestCandidate(items.receiptCandidates(31240, when), when), null);

  // чек з «Інше» в банку — бере категорію з чека
  items.saveReceipt({ tx_id: 'r3', store: 'Епіцентр', total: 45000, category: 'home', items: [{ name: 'Лампочки', title: 'Лампочки', group: 'household', amount: 45000 }] });
  assert.equal(tx('r3').category, 'home');

  // чек без операції в банку (готівка) — окремий запис
  const cash = items.saveReceipt({ store: 'Ринок', time: at(17), total: 15000, category: 'groceries', items: [{ name: 'Кава', title: 'Кава', group: 'coffee_tea', amount: 15000 }] });
  const t = tx(cash.tx_id);
  assert.equal(t.source, 'manual');
  assert.equal(t.amount, -15000);
  assert.equal(t.description, 'Ринок');

  const sum = items.monthItems(M);
  assert.equal(sum.purchases, 3);
  assert.deepEqual(sum.groups.map((g) => [g.group, g.total]), [['household', 45000], ['coffee_tea', 36000], ['dairy', 7400], ['bread', 2840]]);
  assert.deepEqual(sum.frequent.map((f) => [f.title, f.n]), [['Кава', 2]]);
  assert.equal(b.transactions(M, { search: 'кава' }).length, 2);
});

test('товари вручну: без ШІ лишаються з назвою як є, список замінює попередній', async () => {
  const list = await items.setItems('r2', [{ name: 'Сир', amount: 20000 }, { name: 'Яблука', amount: 11000, qty: 1.2 }]);
  assert.deepEqual(list.map((i) => [i.name, i.title, i.group, i.amount]), [['Сир', 'Сир', 'other', 20000], ['Яблука', 'Яблука', 'other', 11000]]);
  const again = await items.setItems('r2', [{ id: list[1].id, name: 'Яблука', amount: 11000 }]);
  assert.equal(again.length, 1);
  await assert.rejects(items.setItems('r2', [{ name: 'Порожньо', amount: 0 }]), b.UserError);
});

test('план покупок і вішліст', () => {
  const wish = b.addWant({ title: 'Навушники', amount: 450000, url: 'https://rozetka.com.ua/x' });
  b.addWant({ title: 'Настолка', amount: 120000, month: M });
  assert.equal(b.wantsFor(null).length, 1);
  b.updateWant(wish, { month: M });
  const s = b.monthSummary(M);
  assert.equal(s.wants.length, 2);
  assert.equal(s.wants_plan.left, 570000);
  b.updateWant(wish, { bought: true });
  assert.equal(b.monthSummary(M).wants_plan.left, 120000);
});
