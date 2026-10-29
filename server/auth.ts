// Хто може відкрити Капшук — той, хто має доступ до Home Assistant:
// • з панелі HA: картка показує чинний токен HA й отримує одноразове посилання входу (як у «Ням»);
// • напряму в браузері: вхід через сторінку входу HA (OAuth самого HA), після нього токени HA одразу відкликаємо.
// Далі — власна сесія Капшука: кука, а для сторінки всередині чужої (WebKit може не зберегти куку) ще й заголовок.
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { HA_URL } from './config.ts';
import { one, run } from './db.ts';
import { now } from './time.ts';

export const COOKIE = 'kapshuk_session';
export const SESSION_HEADER = 'x-kapshuk-session';
const SESSION_DAYS = 180;
const CODE_TTL = 60e3;

const hash = (token: string) => createHash('sha256').update(token).digest('base64url');
const random = () => randomBytes(32).toString('base64url');

export async function haTokenValid(header: string | undefined) {
  if (!/^Bearer [\w.-]+$/.test(header ?? '')) return false;
  const res = await fetch(`${HA_URL}/api/`, { headers: { Authorization: header! }, signal: AbortSignal.timeout(5e3) });
  return res.ok;
}

// ── Сесії ──

export function createSession() {
  const token = random();
  run('INSERT INTO sessions (token, created_at, seen_at) VALUES (:t, :now, :now)', { t: hash(token), now: now() });
  run('DELETE FROM sessions WHERE seen_at < :old', { old: now() - SESSION_DAYS * 86400 });
  return token;
}

export const sessionCookie = (token: string) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;

function readCookie(req: IncomingMessage) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === COOKIE && v) return v;
  }
}

export function sessionOf(req: IncomingMessage) {
  const header = req.headers[SESSION_HEADER];
  const token = (typeof header === 'string' && header) || readCookie(req);
  if (!token || !/^[\w-]{40,50}$/.test(token)) return null;
  const s = one<{ seen_at: number }>('SELECT seen_at FROM sessions WHERE token = :t', { t: hash(token) });
  if (!s || s.seen_at < now() - SESSION_DAYS * 86400) return null;
  if (now() - s.seen_at > 3600) run('UPDATE sessions SET seen_at = :now WHERE token = :t', { t: hash(token), now: now() });
  return token;
}

export const endSession = (token: string) => run('DELETE FROM sessions WHERE token = :t', { t: hash(token) });

// ── Одноразові коди для панелі HA ──

const codes = new Map<string, number>();

export function createCode() {
  const code = random();
  codes.set(code, Date.now() + CODE_TTL);
  for (const [c, until] of codes) if (until < Date.now()) codes.delete(c);
  return code;
}

export function useCode(code: string | null) {
  const until = code ? codes.get(code) : undefined;
  if (!code || !until) return false;
  codes.delete(code);
  return until > Date.now();
}

// ── Вхід через HA напряму ──
// client_id — адреса самого Капшука; HA пускає redirect_uri з того ж хоста без додаткових налаштувань.

const states = new Map<string, number>();

export function haAuthorizeUrl(origin: string, haOrigin: string) {
  const state = random();
  states.set(state, Date.now() + 10 * 60e3);
  const url = new URL('/auth/authorize', haOrigin);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', `${origin}/`);
  url.searchParams.set('redirect_uri', `${origin}/login/ha`);
  url.searchParams.set('state', state);
  return url.href;
}

export async function haExchange(origin: string, code: string | null, state: string | null) {
  const until = state ? states.get(state) : undefined;
  if (state) states.delete(state);
  if (!code || !until || until < Date.now()) return false;
  const res = await fetch(`${HA_URL}/auth/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: `${origin}/` }),
    signal: AbortSignal.timeout(10e3),
  });
  if (!res.ok) return false;
  const t = (await res.json()) as { access_token?: string; refresh_token?: string };
  const ok = !!t.access_token && (await haTokenValid(`Bearer ${t.access_token}`));
  // Токени HA Капшуку більше не потрібні
  if (t.refresh_token) {
    await fetch(`${HA_URL}/auth/token`, { method: 'POST', body: new URLSearchParams({ action: 'revoke', token: t.refresh_token }) }).catch(() => {});
  }
  return ok;
}
