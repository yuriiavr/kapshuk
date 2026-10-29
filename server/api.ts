// REST для інтерфейсу: /api/... лише з сесією Капшука. Суми — цілі копійки.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { all, getDefaults, one, run, setDefault, tx } from './db.ts';
import * as b from './budget.ts';
import { connect, syncSoon } from './monobank.ts';
import { now, thisMonth } from './time.ts';

type Body = Record<string, any>;
type Ctx = { body: Body; query: URLSearchParams; params: string[] };
type Route = [method: string, path: RegExp, handler: (ctx: Ctx) => unknown];

const id = (s: string) => Number(s);

export function members() {
  return all<{ id: number; name: string; mono_name: string | null; connected: number; info_at: number | null; last_error: string | null }>(
    "SELECT id, name, mono_name, token IS NOT NULL AND token <> '' AS connected, info_at, last_error FROM members ORDER BY id",
  ).map((m) => ({
    ...m,
    connected: !!m.connected,
    accounts: all<{ id: string; kind: string; title: string; currency: number; balance: number | null; goal: number | null; include: number; synced_at: number | null }>(
      'SELECT id, kind, title, currency, balance, goal, include, synced_at FROM accounts WHERE member_id = :id ORDER BY kind, title', { id: m.id },
    ).map((a) => ({ ...a, include: !!a.include })),
  }));
}

function state(month: string) {
  return {
    today: thisMonth(),
    summary: b.monthSummary(month),
    defaults: getDefaults(),
    wishlist: b.wantsFor(null),
    members: members(),
  };
}

const routes: Route[] = [
  ['GET', /^\/api\/state$/, ({ query }) => state(b.checkMonth(query.get('month')))],

  // Місяць і типові відсотки
  ['PUT', /^\/api\/months\/([\d-]+)$/, ({ params, body }) => b.setMonth(b.checkMonth(params[0]), body)],
  ['PUT', /^\/api\/defaults$/, ({ body }) => {
    const keys = ['income', 'needs_pct', 'wants_pct', 'savings_pct'] as const;
    const d = { ...getDefaults(), ...body };
    if (keys.some((key) => !Number.isInteger(d[key]) || d[key] < 0)) throw new b.UserError('Значення мають бути додатними цілими');
    if (d.needs_pct + d.wants_pct + d.savings_pct !== 100) throw new b.UserError('Відсотки мають разом давати 100');
    tx(() => {
      b.freezePast();
      for (const key of keys) setDefault(key, d[key]);
    });
  }],

  // Базові потреби
  ['POST', /^\/api\/needs$/, ({ body }) => ({ id: b.addNeed(body as Parameters<typeof b.addNeed>[0]) })],
  ['PATCH', /^\/api\/needs\/(\d+)$/, ({ params, body }) => b.updateNeed(id(params[0]), body)],
  ['DELETE', /^\/api\/needs\/(\d+)$/, ({ params, query }) => b.removeNeed(id(params[0]), b.checkMonth(query.get('month')))],
  ['PUT', /^\/api\/needs\/(\d+)\/months\/([\d-]+)$/, ({ params, body }) => {
    const month = b.checkMonth(params[1]);
    if (body.amount != null) b.setNeedAmount(id(params[0]), month, body.amount, !!body.forward);
    if (body.paid !== undefined) b.setNeedMonth(id(params[0]), month, { paid: !!body.paid, paid_amount: body.paid_amount ?? null });
  }],

  // На себе: план і вішліст
  ['POST', /^\/api\/wants$/, ({ body }) => ({ id: b.addWant(body as Parameters<typeof b.addWant>[0]) })],
  ['PATCH', /^\/api\/wants\/(\d+)$/, ({ params, body }) => b.updateWant(id(params[0]), body)],
  ['DELETE', /^\/api\/wants\/(\d+)$/, ({ params }) => b.removeWant(id(params[0]))],

  // Перерозподіл
  ['POST', /^\/api\/moves$/, ({ body }) => ({ id: b.addMove(body as Parameters<typeof b.addMove>[0]) })],
  ['DELETE', /^\/api\/moves\/(\d+)$/, ({ params }) => b.removeMove(id(params[0]))],

  // Операції
  ['GET', /^\/api\/transactions$/, ({ query }) => b.transactions(b.checkMonth(query.get('month')), query.get('bucket') || undefined)],
  ['POST', /^\/api\/transactions$/, ({ body }) => ({ id: b.addManualTx(body as Parameters<typeof b.addManualTx>[0]) })],
  ['DELETE', /^\/api\/transactions\/([\w-]+)$/, ({ params }) => b.removeManualTx(params[0])],
  ['PUT', /^\/api\/transactions\/([\w-]+)\/bucket$/, ({ params, body }) => ({ changed: b.setTxBucket(params[0], body.bucket, !!body.remember) })],
  ['GET', /^\/api\/rules$/, () => all('SELECT pattern, bucket, created_at FROM rules ORDER BY created_at DESC')],
  ['DELETE', /^\/api\/rules$/, ({ query }) => void run('DELETE FROM rules WHERE pattern = :p', { p: query.get('pattern') ?? '' })],

  // Сім'я й Monobank. Токен лише приймаємо — назад не віддаємо ніколи
  ['POST', /^\/api\/members$/, async ({ body }) => {
    const name = String(body.name ?? '').trim();
    if (!name) throw new b.UserError("Вкажи ім'я");
    const r = run('INSERT INTO members (name, mono_name, created_at) VALUES (:name, :mono, :now)', { name, mono: body.mono_name?.trim() || null, now: now() });
    const mid = Number(r.lastInsertRowid);
    if (body.token) {
      try {
        await connect(mid, body.token);
      } catch (err) {
        run('DELETE FROM members WHERE id = :id', { id: mid });
        throw err;
      }
    }
    return { id: mid };
  }],
  ['PATCH', /^\/api\/members\/(\d+)$/, async ({ params, body }) => {
    const mid = id(params[0]);
    if (!one('SELECT id FROM members WHERE id = :id', { id: mid })) throw new b.UserError('Немає такої людини');
    if (body.name !== undefined) {
      if (!String(body.name).trim()) throw new b.UserError("Вкажи ім'я");
      run('UPDATE members SET name = :n WHERE id = :id', { id: mid, n: String(body.name).trim() });
    }
    if (body.token) await connect(mid, body.token);
    if (body.disconnect) {
      tx(() => {
        run('UPDATE members SET token = NULL, client_id = NULL, info_at = NULL, last_error = NULL WHERE id = :id', { id: mid });
        run('DELETE FROM accounts WHERE member_id = :id', { id: mid });
      });
    }
  }],
  ['DELETE', /^\/api\/members\/(\d+)$/, ({ params }) => void run('DELETE FROM members WHERE id = :id', { id: id(params[0]) })],
  ['PATCH', /^\/api\/accounts\/([\w-]+)$/, ({ params, body }) => {
    const a = one<{ currency: number; kind: string }>('SELECT currency, kind FROM accounts WHERE id = :id', { id: params[0] });
    if (!a) throw new b.UserError('Немає такого рахунку');
    if (body.include && a.kind === 'card' && a.currency !== 980) throw new b.UserError('У бюджеті лише гривневі картки');
    run('UPDATE accounts SET include = :v WHERE id = :id', { id: params[0], v: body.include ? 1 : 0 });
  }],
  ['POST', /^\/api\/sync$/, () => syncSoon()],
];

async function readBody(req: IncomingMessage): Promise<Body> {
  if (req.method === 'GET' || req.method === 'DELETE') return {};
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64e3) throw new b.UserError('Завеликий запит');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {}
  throw new b.UserError('Очікую JSON');
}

const send = (res: ServerResponse, status: number, data: unknown) =>
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(data ?? { ok: true }));

export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  // Змінювати — лише запитами з нашим заголовком: чужа сторінка не надішле його без дозволу CORS
  if (req.method !== 'GET' && req.headers['x-kapshuk'] !== '1') return send(res, 403, { error: 'Без заголовка X-Kapshuk' });
  for (const [method, path, handler] of routes) {
    const m = url.pathname.match(path);
    if (!m || method !== req.method) continue;
    try {
      const body = await readBody(req);
      return send(res, 200, await handler({ body, query: url.searchParams, params: m.slice(1) }));
    } catch (err) {
      if (err instanceof b.UserError) return send(res, 400, { error: err.message });
      console.error(`${req.method} ${url.pathname}:`, err);
      return send(res, 500, { error: 'Щось пішло не так на сервері' });
    }
  }
  send(res, 404, { error: 'Немає такого запиту' });
}
