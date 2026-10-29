// node --test test/ — бюджет на тимчасовій базі, без Monobank
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'kapshuk-test-'));
process.env.KAPSHUK_NO_SYNC = '1';
const { run, setDefault } = await import('../server/db.ts');
const b = await import('../server/budget.ts');
const { monthStart, addMonths } = await import('../server/time.ts');

const M = '2026-11';
const at = (day: number) => monthStart(M) + (day - 1) * 86400 + 12 * 3600;
const item = (id: string, day: number, amount: number, description: string, mcc = 5411, extra = {}) =>
  ({ id, time: at(day), amount, description, mcc, hold: false, ...extra });

run("INSERT INTO members (id, name, mono_name, created_at) VALUES (1, 'Юра', 'Авраменко Юрій', 0), (2, 'Оля', 'Авраменко Ольга', 0)");
run("INSERT INTO accounts (id, member_id, kind, title, currency, balance, include) VALUES ('card1', 1, 'card', 'Чорна', 980, 0, 1), ('jar1', 1, 'jar', 'Відпустка', 980, 3000000, 1)");
setDefault('income', 6000000); // 60 000 ₴

test('ділить дохід 50/30/20', () => {
  const s = b.monthSummary(M);
  assert.equal(s.buckets.needs.allocated, 3000000);
  assert.equal(s.buckets.wants.allocated, 1800000);
  assert.equal(s.buckets.savings.allocated, 1200000);
});

test('потреби: ціна з місяця й надалі не чіпає минулі', () => {
  const id = b.addNeed({ title: 'Інтернет', amount: 30000, match: 'тріолан, triolan', month: '2026-10' });
  b.setNeedAmount(id, M, 35000, true);
  assert.equal(b.needsFor('2026-10').find((n) => n.id === id)!.amount, 30000);
  assert.equal(b.needsFor(M).find((n) => n.id === id)!.amount, 35000);
  assert.equal(b.needsFor(addMonths(M, 3)).find((n) => n.id === id)!.amount, 35000);
  b.setNeedAmount(id, addMonths(M, 1), 40000, false); // лише грудень
  assert.equal(b.needsFor(addMonths(M, 1)).find((n) => n.id === id)!.amount, 40000);
  assert.equal(b.needsFor(addMonths(M, 2)).find((n) => n.id === id)!.amount, 35000);
});

test('операції з банку: кошики, банки, перекази своїм і галочка «сплачено»', () => {
  b.storeMonoItems(1, 'card1', [
    item('t1', 2, -120000, 'Сільпо'), // продукти → потреби
    item('t2', 3, -50000, 'Кінотеатр', 7832), // на себе
    item('t3', 4, -35000, 'Тріолан', 4814), // потреба зі списку → сплачено
    item('t4', 5, -1000000, 'На банку «Відпустка»', 4829), // заощадження
    item('t5', 6, -200000, 'Ользі', 4829, { counterName: 'Ольга А.' }), // своїм — не витрата
    item('t6', 7, 6000000, 'Зарплата', 4829), // дохід
  ]);
  const s = b.monthSummary(M);
  assert.equal(s.buckets.needs.spent, 155000);
  assert.equal(s.buckets.wants.spent, 50000);
  assert.equal(s.buckets.savings.spent, 1000000);
  assert.equal(s.income_actual, 6000000);
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
  assert.equal(b.transactions(dec).find((t) => t.id === 'c1')!.bucket, 'wants');
  b.storeMonoItems(1, 'card1', [
    { id: 'c2', time: d(2), amount: -1000000, description: 'Зняття готівки: Банкомат', mcc: 6011, hold: false },
    { id: 'c3', time: d(2) + 60, amount: -1100000, description: 'Зняття готівки: Банкомат', mcc: 6011, hold: false },
  ]);
  const rent = b.needsFor(dec).find((n) => n.id === id)!;
  assert.equal(rent.paid, true);
  assert.equal(rent.paid_amount, 2100000);
  b.removeNeed(id, dec);
});

test('виправлення запам\'ятовується для такого самого магазину', () => {
  b.setTxBucket('t2', 'needs', true);
  b.storeMonoItems(1, 'card1', [item('t7', 8, -40000, 'Кінотеатр', 7832)]);
  const tx = b.transactions(M).find((t) => t.id === 't7')!;
  assert.equal(tx.bucket, 'needs');
  assert.equal(tx.bucket_source, 'rule');
  // повторне завантаження з банку не перетирає вибір людини
  b.setTxBucket('t7', 'wants');
  b.storeMonoItems(1, 'card1', [item('t7', 8, -40000, 'Кінотеатр', 7832)]);
  assert.equal(b.transactions(M).find((t) => t.id === 't7')!.bucket, 'wants');
});

test('перерозподіл: 12 500 із заощаджень на кредит разовим платежем', () => {
  const dec = addMonths(M, 1);
  const before = b.monthSummary(dec);
  const moveId = b.addMove({ month: dec, from: 'savings', to: 'needs', amount: 1250000, note: 'Погашення кредиту', as_need: true });
  const s = b.monthSummary(dec);
  assert.equal(s.buckets.savings.allocated, before.buckets.savings.allocated - 1250000);
  assert.equal(s.buckets.needs.allocated, before.buckets.needs.allocated + 1250000);
  assert.ok(s.needs.some((n) => n.title === 'Погашення кредиту' && n.once && n.amount === 1250000));
  assert.ok(!b.monthSummary(addMonths(dec, 1)).needs.some((n) => n.title === 'Погашення кредиту'));
  b.removeMove(moveId);
  assert.ok(!b.monthSummary(dec).needs.some((n) => n.title === 'Погашення кредиту'));
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

test('відсотки місяця мають давати 100', () => {
  assert.throws(() => b.setMonth(M, { needs_pct: 60 }), b.UserError);
  b.setMonth(M, { needs_pct: 60, wants_pct: 20, income: 7000000 });
  const s = b.monthSummary(M);
  assert.equal(s.buckets.needs.allocated, 4200000);
  assert.equal(s.buckets.savings.allocated, 1400000);
  b.setMonth(M, { reset: true });
  assert.equal(b.monthSummary(M).buckets.needs.pct, 50);
});
