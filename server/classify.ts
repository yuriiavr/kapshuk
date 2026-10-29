// Куди віднести операцію: потреби, на себе, заощадження, дохід чи переказ між своїми.
// Порядок: свої перекази й банки → запамʼятовані правила → платежі зі списку потреб → тип магазину (MCC).
import { all, type TxBucket } from './db.ts';

export type RawTx = { amount: number; description: string; mcc: number | null; counter_name: string | null; counter_iban: string | null };
export type Verdict = { bucket: TxBucket; source: 'auto' | 'rule' | 'need'; needId?: number };

// Базові потреби за типом магазину (MCC). Решта витрат за замовчуванням — «на себе»
const NEEDS_MCC = new Set([
  // продукти, аптеки, медицина
  5297, 5300, 5331, 5411, 5422, 5451, 5462, 5499, 5122, 5912, 5975, 5976, 4119,
  8011, 8021, 8031, 8041, 8042, 8043, 8049, 8050, 8062, 8071, 8099,
  // комуналка, звʼязок, інтернет
  4900, 4814, 4816, 4899,
  // транспорт і авто
  4111, 4112, 4131, 4784, 4789, 5541, 5542, 5533, 7523, 7531, 7534, 7535, 7538, 7549,
  // освіта й діти
  8211, 8220, 8241, 8244, 8249, 8299, 8351, 5641,
  // страхування, держава, фінансові платежі, оренда
  6300, 5960, 9211, 9222, 9223, 9311, 9399, 6012, 6513,
  // дім і ремонт, побутові послуги
  1520, 1711, 1731, 1740, 1750, 1761, 1771, 5039, 5200, 5211, 5231, 5251, 7210, 7211, 7216, 7217, 7342, 7349,
  // тварини, пошта й доставка
  5995, 742, 9402, 4214, 4215,
]);
// Перекази людям, готівка, поповнення — тип магазину нічого не каже
const TRANSFER_MCC = new Set([4829, 6010, 6011, 6051, 6538, 6540]);

// Банки Monobank на картці: «На банку …», «З банки …», «Поповнення банки …»
const JAR_RE = /(^|\s)(на|з|із|до)\s+банк[уиі]\b|поповнення банки|зняття з банки/i;

export type Context = {
  jarTitles: string[];
  ownIbans: Set<string>;
  familyNames: string[][];
  rules: Map<string, TxBucket>;
  needs: { id: number; match: string[] }[];
};

const norm = (s: string) => s.toLowerCase().replace(/[ʼ'’`]/g, "'").replace(/\s+/g, ' ').trim();
const words = (s: string) => norm(s).split(/[\s.,]+/).filter(Boolean);
export const rulePattern = (description: string) => norm(description);

// Отримувач — хтось із сім'ї: кожне слово його імені («Юрій А.», «Юрій Авраменко») є початком слова
// в імені члена сім'ї («Авраменко Юрій»). Одного слова замало — «Юрій» буває й чужий.
function isFamily(counterName: string, family: string[][]) {
  const counter = words(counterName);
  if (counter.length < 2) return false;
  return family.some((name) => counter.every((w) => name.some((n) => n.startsWith(w))));
}

export function loadContext(month: string): Context {
  const jars = all<{ title: string }>("SELECT title FROM accounts WHERE kind = 'jar'");
  const ibans = all<{ iban: string }>("SELECT iban FROM accounts WHERE iban IS NOT NULL AND iban <> ''");
  const members = all<{ name: string; mono_name: string | null }>('SELECT name, mono_name FROM members');
  const rules = all<{ pattern: string; bucket: TxBucket }>('SELECT pattern, bucket FROM rules');
  const needs = all<{ id: number; match: string | null }>(
    `SELECT id, match FROM needs WHERE match IS NOT NULL AND match <> '' AND start_month <= :month
       AND (end_month IS NULL OR end_month > :month) AND (once_month IS NULL OR once_month = :month)`, { month });
  return {
    jarTitles: jars.map((j) => norm(j.title)).filter((t) => t.length >= 3),
    ownIbans: new Set(ibans.map((a) => a.iban)),
    familyNames: members.flatMap((m) => [m.mono_name, m.name]).filter((n): n is string => !!n).map(words).filter((w) => w.length >= 2),
    rules: new Map(rules.map((r) => [r.pattern, r.bucket])),
    needs: needs.map((n) => ({ id: n.id, match: n.match!.split(',').map(norm).filter(Boolean) })),
  };
}

export function classify(t: RawTx, ctx: Context): Verdict {
  const desc = norm(t.description);
  const counter = norm(t.counter_name ?? '');

  // Банки Monobank — це заощадження: поповнення з картки «-», зняття на картку «+»
  if (JAR_RE.test(desc) || ctx.jarTitles.some((title) => desc.includes(title))) return { bucket: 'savings', source: 'auto' };
  // Переказ на свою картку чи комусь із сім'ї — не витрата й не дохід
  if (t.counter_iban && ctx.ownIbans.has(t.counter_iban)) return { bucket: 'internal', source: 'auto' };
  if (counter && isFamily(counter, ctx.familyNames)) return { bucket: 'internal', source: 'auto' };

  const rule = ctx.rules.get(desc);
  if (rule) return { bucket: rule, source: 'rule' };

  if (t.amount < 0) {
    const need = ctx.needs.find((n) => n.match.some((word) => desc.includes(word) || counter.includes(word)));
    if (need) return { bucket: 'needs', source: 'need', needId: need.id };
  }

  const merchant = t.mcc != null && !TRANSFER_MCC.has(t.mcc);
  if (t.amount > 0) {
    // Повернення в магазин зменшує витрати того ж кошика, решта надходжень — дохід
    if (merchant) return { bucket: NEEDS_MCC.has(t.mcc!) ? 'needs' : 'wants', source: 'auto' };
    return { bucket: 'income', source: 'auto' };
  }
  if (merchant && NEEDS_MCC.has(t.mcc!)) return { bucket: 'needs', source: 'auto' };
  return { bucket: 'wants', source: 'auto' };
}
