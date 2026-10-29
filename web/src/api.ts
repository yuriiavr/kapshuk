// Запити до сервера Капшука. Сесія — кука, а якщо сторінку відкрили з панелі HA, ще й токен з адреси (#s=…):
// у вбудованій сторінці WebKit може не зберегти куку.
import type { monthSummary, Tx, Need, Want, Move, Jar } from '../../server/budget.ts';
import type { members } from '../../server/api.ts';
import type { Defaults, TxBucket } from '../../server/db.ts';

export type Summary = ReturnType<typeof monthSummary>;
export type Member = ReturnType<typeof members>[number];
export type { Tx, Need, Want, Move, Jar, Defaults, TxBucket };
export type State = { today: string; summary: Summary; defaults: Defaults; wishlist: Want[]; members: Member[] };

const KEY = 'kapshuk:session';
let session: string | null = null;

{
  const m = location.hash.match(/^#s=([\w-]+)$/);
  if (m) {
    session = m[1];
    history.replaceState(null, '', location.pathname + location.search);
    try {
      sessionStorage.setItem(KEY, session);
    } catch {}
  } else {
    try {
      session = sessionStorage.getItem(KEY);
    } catch {}
  }
}

export class AuthError extends Error {}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'X-Kapshuk': '1' };
  if (session) headers['X-Kapshuk-Session'] = session;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  } catch {
    throw new Error("Немає зв'язку з Капшуком на ноутбуці");
  }
  if (res.status === 401) throw new AuthError('Потрібен вхід');
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `Сервер відповів ${res.status}`);
  return data as T;
}

export const api = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T = unknown>(path: string, body: unknown = {}) => call<T>('POST', path, body),
  put: <T = unknown>(path: string, body: unknown) => call<T>('PUT', path, body),
  patch: <T = unknown>(path: string, body: unknown) => call<T>('PATCH', path, body),
  del: <T = unknown>(path: string) => call<T>('DELETE', path),
  state: (month: string | null) => call<State>('GET', `/api/state${month ? `?month=${month}` : ''}`),
  async logout() {
    await fetch('/logout', { method: 'POST', headers: session ? { 'X-Kapshuk-Session': session } : {} }).catch(() => {});
    session = null;
    try {
      sessionStorage.removeItem(KEY);
    } catch {}
  },
};
