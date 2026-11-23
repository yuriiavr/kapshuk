// Запити до сервера Капшука. Сесія — кука, а якщо сторінку відкрили з панелі HA, ще й токен з адреси (#s=…):
// у вбудованій сторінці WebKit може не зберегти куку.
import type { monthSummary, Tx, Need, Want, Jar, CategorySum } from '../../server/budget.ts';
import type { members } from '../../server/api.ts';
import type { TxBucket } from '../../server/db.ts';
import type { Candidate, Item, monthItems } from '../../server/items.ts';
import type { Receipt, ReceiptItem } from '../../server/ai.ts';
import type { Category, ItemGroup } from '../../server/categories.ts';

export type Summary = ReturnType<typeof monthSummary>;
export type Member = ReturnType<typeof members>[number];
export type MonthItems = ReturnType<typeof monthItems>;
export type { Tx, Need, Want, Jar, CategorySum, TxBucket, Candidate, Item, Receipt, ReceiptItem, Category, ItemGroup };
export type State = { today: string; summary: Summary; wishlist: Want[]; members: Member[] };
export type Advice = { text: string; created_at: number };
export type MonthReport = { categories: CategorySum[]; items: MonthItems; merchants: { description: string; total: number; n: number }[]; advice: Advice | null };
export type Scan = { image: string; receipt: Receipt; candidates: Candidate[]; match: string | null };
export type TxItems = { items: Item[]; receipt: { id: number; store: string | null; time: number | null; total: number | null; has_image: number } | null };

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
  /** Фото чека: <img> не надішле заголовок сесії, тож тягнемо самі й показуємо через blob: */
  async image(path: string) {
    const res = await fetch(path, { headers: session ? { 'X-Kapshuk-Session': session } : {}, credentials: 'same-origin' });
    if (!res.ok) throw new Error('Фото не відкрилось');
    return URL.createObjectURL(await res.blob());
  },
  async logout() {
    await fetch('/logout', { method: 'POST', headers: session ? { 'X-Kapshuk-Session': session } : {} }).catch(() => {});
    session = null;
    try {
      sessionStorage.removeItem(KEY);
    } catch {}
  },
};
