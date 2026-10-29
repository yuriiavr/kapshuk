// Monobank: особистий токен кожного члена сім'ї (api.monobank.ua). Банк дозволяє один запит на хвилину
// з одним токеном, тож для кожного токена своя черга: раз на 10 хв — рахунки й баланси банок,
// решту часу — виписки карток по черзі. Вебхук не використовуємо: Капшук не має адреси в інтернеті.
import { all, one, run, tx } from './db.ts';
import { storeMonoItems, UserError, type MonoItem } from './budget.ts';
import { addMonths, monthStart, now, thisMonth } from './time.ts';
import { NO_SYNC } from './config.ts';

const API = 'https://api.monobank.ua';
const GAP = 61; // секунд між запитами з одним токеном
const INFO_EVERY = 10 * 60; // як часто оновлювати баланси
const CARD_EVERY = 2 * 60; // одну картку — не частіше
const OVERLAP = 3 * 86400; // перечитуємо останні дні: утримання (hold) стають списаннями, з'являються запізнілі
const WINDOW = 31 * 86400; // банк віддає виписку щонайбільше за 31 добу
const PAGE = 500; // і щонайбільше 500 операцій за запит
export const CURRENCY: Record<number, string> = { 980: '₴', 840: '$', 978: '€', 985: 'zł', 826: '£' };
const CARD_TYPES: Record<string, string> = {
  black: 'Чорна', white: 'Біла', platinum: 'Platinum', iron: 'Iron', fop: 'ФОП', yellow: 'Дитяча', eAid: 'єПідтримка', madeInUkraine: 'Made in Ukraine',
};

type ClientInfo = {
  clientId: string; name: string;
  accounts: { id: string; balance: number; creditLimit: number; type: string; currencyCode: number; maskedPan: string[]; iban: string }[];
  jars?: { id: string; title: string; currencyCode: number; balance: number; goal?: number | null }[];
};

class MonoError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function mono<T>(token: string, path: string): Promise<T> {
  const res = await fetch(API + path, { headers: { 'X-Token': token }, signal: AbortSignal.timeout(30e3) });
  if (res.ok) return (await res.json()) as T;
  let detail = '';
  try {
    detail = ((await res.json()) as { errorDescription?: string }).errorDescription ?? '';
  } catch {}
  if (res.status === 401 || res.status === 403) throw new MonoError(res.status, 'Monobank не приймає токен — створи новий на api.monobank.ua');
  if (res.status === 429) throw new MonoError(429, 'Monobank просить не так часто');
  throw new MonoError(res.status, `Monobank відповів ${res.status}${detail ? `: ${detail}` : ''}`);
}

function cardTitle(a: ClientInfo['accounts'][number]) {
  const pan = a.maskedPan?.[0]?.slice(-4);
  return [CARD_TYPES[a.type] ?? a.type, CURRENCY[a.currencyCode] ?? a.currencyCode, pan && `••${pan}`].filter(Boolean).join(' ');
}

/** Оновити картки й банки людини з client-info. Нові гривневі картки й усі банки — одразу в бюджеті */
function applyInfo(memberId: number, info: ClientInfo) {
  tx(() => {
    run('UPDATE members SET client_id = :cid, mono_name = :name, info_at = :now, last_error = NULL WHERE id = :id',
      { id: memberId, cid: info.clientId, name: info.name, now: now() });
    const seen: string[] = [];
    const upsert = (p: { id: string; kind: 'card' | 'jar'; title: string; currency: number; balance: number; goal: number | null; iban: string | null; include: number }) => {
      seen.push(p.id);
      run(`INSERT INTO accounts (id, member_id, kind, title, currency, balance, goal, iban, include, updated_at)
           VALUES (:id, :member, :kind, :title, :currency, :balance, :goal, :iban, :include, :now)
           ON CONFLICT (id) DO UPDATE SET member_id = excluded.member_id, title = excluded.title, currency = excluded.currency,
             balance = excluded.balance, goal = excluded.goal, iban = excluded.iban, updated_at = excluded.updated_at`,
      { ...p, member: memberId, now: now() });
    };
    for (const a of info.accounts) {
      upsert({
        id: a.id, kind: 'card', title: cardTitle(a), currency: a.currencyCode, balance: a.balance - (a.creditLimit ?? 0), goal: null,
        iban: a.iban || null, include: a.currencyCode === 980 && a.type !== 'eAid' ? 1 : 0,
      });
    }
    for (const j of info.jars ?? []) {
      upsert({ id: j.id, kind: 'jar', title: j.title, currency: j.currencyCode, balance: j.balance, goal: j.goal || null, iban: null, include: 1 });
    }
    const old = all<{ id: string }>('SELECT id FROM accounts WHERE member_id = :id', { id: memberId }).filter((a) => !seen.includes(a.id));
    for (const a of old) run('DELETE FROM accounts WHERE id = :id', { id: a.id });
  });
}

/** Перевірити токен і одразу підтягнути рахунки (для нового члена сім'ї чи нового токена) */
export async function connect(memberId: number, token: string) {
  const t = token.trim();
  if (!/^[\w-]{20,100}$/.test(t)) throw new UserError('Це не схоже на токен Monobank');
  let info: ClientInfo;
  try {
    info = await mono<ClientInfo>(t, '/personal/client-info');
  } catch (err) {
    throw err instanceof MonoError ? new UserError(err.message) : err;
  }
  run('UPDATE members SET token = :t, last_request_at = :now WHERE id = :id', { id: memberId, t, now: now() });
  applyInfo(memberId, info);
}

// Сторінки виписки, що лишились: банк віддав рівно 500 — по решту йдемо ще раз до часу найстаршої
const pageTo = new Map<string, number>();
const busy = new Set<number>();

async function step(m: { id: number; token: string; info_at: number | null }) {
  if (!m.info_at || now() - m.info_at > INFO_EVERY) {
    applyInfo(m.id, await mono<ClientInfo>(m.token, '/personal/client-info'));
    return;
  }
  const card = one<{ id: string; synced_to: number | null; synced_at: number | null }>(
    `SELECT id, synced_to, synced_at FROM accounts WHERE member_id = :id AND kind = 'card' AND include = 1 AND currency = 980
      ORDER BY COALESCE(synced_at, 0) LIMIT 1`, { id: m.id });
  if (!card || (card.synced_at && now() - card.synced_at < CARD_EVERY)) return false;

  // Уперше беремо з початку минулого місяця, далі — від останнього разу з перекриттям
  const first = monthStart(addMonths(thisMonth(), -1));
  const from = card.synced_to ? Math.max(first, card.synced_to - OVERLAP) : first;
  const to = pageTo.get(card.id) ?? Math.min(from + WINDOW - 3600, now());
  const items = await mono<MonoItem[]>(m.token, `/personal/statement/${card.id}/${from}/${to}`);
  storeMonoItems(m.id, card.id, items);
  if (items.length >= PAGE) {
    pageTo.set(card.id, Math.min(...items.map((i) => i.time)));
    return;
  }
  pageTo.delete(card.id);
  const end = Math.min(from + WINDOW - 3600, now());
  // Ще наздоганяємо історію — картка лишається першою в черзі
  run('UPDATE accounts SET synced_to = :to, synced_at = :at WHERE id = :id', { id: card.id, to: end, at: end < now() - 60 ? 0 : now() });
}

async function tick() {
  const members = all<{ id: number; token: string; info_at: number | null; last_request_at: number | null }>(
    "SELECT id, token, info_at, last_request_at FROM members WHERE token IS NOT NULL AND token <> ''");
  for (const m of members) {
    if (busy.has(m.id) || (m.last_request_at && now() - m.last_request_at < GAP)) continue;
    busy.add(m.id);
    const at = now();
    step(m)
      .then((asked) => {
        if (asked !== false) run('UPDATE members SET last_request_at = :at, last_error = NULL WHERE id = :id', { id: m.id, at });
      })
      .catch((err) => {
        run('UPDATE members SET last_request_at = :at, last_error = :e WHERE id = :id', { id: m.id, at, e: String(err.message ?? err) });
        if (!(err instanceof MonoError && err.status === 429)) console.error(`monobank (member ${m.id}):`, err.message ?? err);
      })
      .finally(() => busy.delete(m.id));
  }
}

/** «Оновити зараз»: усі картки — на початок черги (банк однаково не частіше разу на хвилину) */
export function syncSoon() {
  run("UPDATE accounts SET synced_at = 0 WHERE kind = 'card'");
  run('UPDATE members SET info_at = 0');
}

export function startSync() {
  if (NO_SYNC) return console.log('Monobank: синхронізацію вимкнено (KAPSHUK_NO_SYNC=1)');
  setInterval(() => void tick(), 5e3).unref();
  void tick();
}
