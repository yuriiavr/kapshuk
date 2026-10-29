// Гроші в копійках → «12 500 ₴»; місяці «2026-11» → «Листопад 2026»
import type { TxBucket } from './api.ts';

const whole = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 });
const exact = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const SYMBOLS: Record<number, string> = { 980: '₴', 840: '$', 978: '€', 985: 'zł', 826: '£' };

export function money(kop: number | null | undefined, opts: { exact?: boolean; sign?: boolean; currency?: number } = {}) {
  if (kop == null) return '—';
  const n = Math.abs(kop) / 100;
  const text = (opts.exact && kop % 100 ? exact : whole).format(opts.exact ? n : Math.round(n));
  const sign = kop < 0 ? '−' : opts.sign && kop > 0 ? '+' : '';
  return `${sign}${text} ${SYMBOLS[opts.currency ?? 980] ?? ''}`.trim();
}

/** «12 500», «12500,50», «12.5к» → копійки; не число — null */
export function parseMoney(text: string): number | null {
  let s = text.replace(/[\s ₴]/g, '').replace(',', '.').toLowerCase();
  let mult = 1;
  if (/[кk]$/.test(s)) {
    mult = 1000;
    s = s.slice(0, -1);
  }
  if (!/^\d+(\.\d{0,2})?$/.test(s) && !(mult > 1 && /^\d+(\.\d+)?$/.test(s))) return null;
  return Math.round(Number(s) * mult * 100);
}

/** Копійки → текст для поля вводу */
export const moneyInput = (kop: number | null | undefined) => (kop == null ? '' : String(kop % 100 ? (kop / 100).toFixed(2) : kop / 100));

export const MONTHS = ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень', 'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'];
const MONTHS_IN = ['січні', 'лютому', 'березні', 'квітні', 'травні', 'червні', 'липні', 'серпні', 'вересні', 'жовтні', 'листопаді', 'грудні'];

export function monthLabel(month: string, withYear = true) {
  const [y, m] = month.split('-').map(Number);
  return withYear ? `${MONTHS[m - 1]} ${y}` : MONTHS[m - 1];
}
export const monthIn = (month: string) => MONTHS_IN[Number(month.split('-')[1]) - 1];

export function addMonths(month: string, n: number) {
  const [y, m] = month.split('-').map(Number);
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}

const dayFmt = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: 'numeric', month: 'long' });
const weekdayFmt = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', weekday: 'long' });
const timeFmt = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' });
const keyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' });

export const dayKey = (unix: number) => keyFmt.format(unix * 1000);
export const time = (unix: number) => timeFmt.format(unix * 1000);
export const dayShort = (unix: number) => dayFmt.format(unix * 1000);

export function dayTitle(unix: number) {
  const key = dayKey(unix);
  const now = Date.now() / 1000;
  if (key === dayKey(now)) return 'Сьогодні';
  if (key === dayKey(now - 86400)) return 'Учора';
  return `${dayFmt.format(unix * 1000)}, ${weekdayFmt.format(unix * 1000)}`;
}

export function ago(unix: number | null) {
  if (!unix) return 'ще ні';
  const min = Math.round((Date.now() / 1000 - unix) / 60);
  if (min < 1) return 'щойно';
  if (min < 60) return `${min} хв тому`;
  if (min < 24 * 60) return `${Math.round(min / 60)} год тому`;
  return dayShort(unix);
}

export const BUCKETS = {
  needs: { title: 'Базові потреби', short: 'Потреби' },
  wants: { title: 'На себе', short: 'На себе' },
  savings: { title: 'Заощадження', short: 'Заощадження' },
} as const;

export const TX_BUCKETS: Record<TxBucket, { title: string; hint: string }> = {
  needs: { title: 'Потреби', hint: 'продукти, комуналка, транспорт, ліки' },
  wants: { title: 'На себе', hint: 'покупки для сім\'ї, кафе, розваги' },
  savings: { title: 'Заощадження', hint: 'банки й відкладене' },
  income: { title: 'Дохід', hint: 'зарплата, надходження' },
  internal: { title: 'Свої перекази', hint: 'між своїми картками й сім\'єю' },
  ignore: { title: 'Не рахувати', hint: 'не враховувати ніде' },
};
