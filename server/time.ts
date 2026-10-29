// Місяці бюджету — за київським часом: «2026-11» і межі місяця в unix-секундах
import { TZ } from './config.ts';

const parts = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function kyivParts(unixSec: number) {
  const p = Object.fromEntries(parts.formatToParts(new Date(unixSec * 1000)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), min: Number(p.minute), s: Number(p.second) };
}

export const now = () => Math.floor(Date.now() / 1000);

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function monthOf(unixSec: number): string {
  const { y, m } = kyivParts(unixSec);
  return `${y}-${String(m).padStart(2, '0')}`;
}

export const thisMonth = () => monthOf(now());

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}

/** Початок місяця (київська північ першого числа) в unix-секундах */
export function monthStart(month: string): number {
  const [y, m] = month.split('-').map(Number);
  let guess = Date.UTC(y, m - 1, 1) / 1000;
  // Зсув Києва +2 або +3 год: дві ітерації вистачає, щоб влучити в північ
  for (let i = 0; i < 2; i++) {
    const p = kyivParts(guess);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) / 1000;
    guess -= asUtc - Date.UTC(y, m - 1, 1) / 1000;
  }
  return guess;
}

export const monthRange = (month: string): [number, number] => [monthStart(month), monthStart(addMonths(month, 1))];
