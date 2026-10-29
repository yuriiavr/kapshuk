// SQLite Капшука: один файл у DATA_DIR. Суми — цілі копійки, час — unix-секунди, місяць — 'YYYY-MM' за Києвом.
// Кошики бюджету: needs — базові потреби (50%), wants — на себе (30%), savings — заощадження (20%).
// Операції ще бувають income (дохід), internal (переказ між своїми картками) і ignore (не рахувати).
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.ts';

export const BUCKETS = ['needs', 'wants', 'savings'] as const;
export type Bucket = (typeof BUCKETS)[number];
export const TX_BUCKETS = [...BUCKETS, 'income', 'internal', 'ignore'] as const;
export type TxBucket = (typeof TX_BUCKETS)[number];

mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
export const db = new DatabaseSync(path.join(DATA_DIR, 'kapshuk.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');

const MIGRATIONS = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  -- Члени сім'ї; token — особистий токен Monobank (лише на ноутбуці, назовні не віддаємо)
  CREATE TABLE members (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, token TEXT, client_id TEXT, mono_name TEXT,
    info_at INTEGER, last_request_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL);

  -- Картки й банки Monobank. Виписку тягнемо лише з карток: поповнення банки видно на картці
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('card', 'jar')), title TEXT NOT NULL, currency INTEGER NOT NULL,
    balance INTEGER, goal INTEGER, iban TEXT, include INTEGER NOT NULL DEFAULT 1,
    synced_to INTEGER, synced_at INTEGER, updated_at INTEGER);

  -- Зміни доходу й відсотків на конкретний місяць (інакше — типові з settings)
  CREATE TABLE months (month TEXT PRIMARY KEY, income INTEGER, needs_pct INTEGER, wants_pct INTEGER, savings_pct INTEGER);

  -- Базові потреби: постійний список (once_month — разовий платіж лише того місяця).
  -- match — слова, за якими платіж упізнається у виписці («київстар, kyivstar»)
  CREATE TABLE needs (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, amount INTEGER NOT NULL DEFAULT 0, match TEXT,
    once_month TEXT, start_month TEXT NOT NULL, end_month TEXT, sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
  -- Нова ціна діє з from_month і далі; минулі місяці лишаються зі старою
  CREATE TABLE need_prices (
    need_id INTEGER NOT NULL REFERENCES needs(id) ON DELETE CASCADE, from_month TEXT NOT NULL, amount INTEGER NOT NULL,
    PRIMARY KEY (need_id, from_month));
  -- Місяць окремо: своя сума лише на цей місяць і позначка «сплачено»
  CREATE TABLE need_months (
    need_id INTEGER NOT NULL REFERENCES needs(id) ON DELETE CASCADE, month TEXT NOT NULL,
    amount INTEGER, paid_at INTEGER, paid_amount INTEGER, tx_id TEXT, PRIMARY KEY (need_id, month));

  -- «На себе»: заплановані покупки місяця (month) і вішліст (month IS NULL)
  CREATE TABLE wants (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, amount INTEGER, month TEXT, url TEXT, note TEXT,
    bought_at INTEGER, sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);

  -- Перерозподіл між кошиками на місяць («12 500 із заощаджень на кредит»)
  CREATE TABLE moves (
    id INTEGER PRIMARY KEY, month TEXT NOT NULL, from_bucket TEXT NOT NULL, to_bucket TEXT NOT NULL,
    amount INTEGER NOT NULL, note TEXT, need_id INTEGER REFERENCES needs(id) ON DELETE SET NULL, created_at INTEGER NOT NULL,
    CHECK (from_bucket IN ('needs', 'wants', 'savings') AND to_bucket IN ('needs', 'wants', 'savings') AND from_bucket <> to_bucket));

  -- Операції з Monobank і вручну. bucket_source: auto (за MCC), rule (запамʼятоване), need (платіж зі списку), user (вибрано руками)
  CREATE TABLE transactions (
    id TEXT PRIMARY KEY, source TEXT NOT NULL CHECK (source IN ('mono', 'manual')),
    account_id TEXT, member_id INTEGER, time INTEGER NOT NULL, amount INTEGER NOT NULL,
    description TEXT NOT NULL DEFAULT '', mcc INTEGER, comment TEXT, counter_name TEXT, counter_iban TEXT,
    hold INTEGER NOT NULL DEFAULT 0, bucket TEXT NOT NULL, bucket_source TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE INDEX transactions_time ON transactions (time);

  -- Запамʼятовані категорії магазинів: опис операції (малими літерами) → кошик
  CREATE TABLE rules (pattern TEXT PRIMARY KEY, bucket TEXT NOT NULL, created_at INTEGER NOT NULL);

  CREATE TABLE sessions (token TEXT PRIMARY KEY, created_at INTEGER NOT NULL, seen_at INTEGER NOT NULL);
  `,
];

const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
for (let v = version; v < MIGRATIONS.length; v++) {
  tx(() => {
    db.exec(MIGRATIONS[v]);
    db.exec(`PRAGMA user_version = ${v + 1}`);
  });
}

type Params = Record<string, SQLInputValue>;

export const one = <T>(sql: string, params: Params = {}) => db.prepare(sql).get(params) as T | undefined;
export const all = <T>(sql: string, params: Params = {}) => db.prepare(sql).all(params) as T[];
export const run = (sql: string, params: Params = {}) => db.prepare(sql).run(params);

export function tx<T>(fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ── Типові налаштування ──
const DEFAULTS = { income: '0', needs_pct: '50', wants_pct: '30', savings_pct: '20' };
export type Defaults = { income: number; needs_pct: number; wants_pct: number; savings_pct: number };

export function getDefaults(): Defaults {
  const rows = all<{ key: string; value: string }>('SELECT key, value FROM settings');
  const s: Record<string, string> = { ...DEFAULTS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  return { income: Number(s.income), needs_pct: Number(s.needs_pct), wants_pct: Number(s.wants_pct), savings_pct: Number(s.savings_pct) };
}

export function setDefault(key: keyof Defaults, value: number) {
  run('INSERT INTO settings (key, value) VALUES (:key, :value) ON CONFLICT (key) DO UPDATE SET value = excluded.value', { key, value: String(value) });
}
