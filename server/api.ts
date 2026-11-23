// REST для інтерфейсу: /api/... лише з сесією Капшука. Суми — цілі копійки.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { all, one, run, tx } from './db.ts';
import * as b from './budget.ts';
import * as items from './items.ts';
import { scanReceipt } from './ai.ts';
import { connect, syncSoon } from './monobank.ts';
import { now, thisMonth } from './time.ts';

type Body = Record<string, any>;
type Ctx = { body: Body; query: URLSearchParams; params: string[] };
/** maxBody — скільки байтів запиту приймаємо (типово 64 КБ; фото чека — більше) */
type Route = [method: string, path: RegExp, handler: (ctx: Ctx) => unknown, maxBody?: number];

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
    wishlist: b.wantsFor(null),
    members: members(),
  };
}

const MIME = /^image\/(jpeg|png|webp)$/;

const routes: Route[] = [
  ['GET', /^\/api\/state$/, ({ query }) => state(b.checkMonth(query.get('month')))],

  // Постійні платежі
  ['POST', /^\/api\/needs$/, ({ body }) => ({ id: b.addNeed(body as Parameters<typeof b.addNeed>[0]) })],
  ['PATCH', /^\/api\/needs\/(\d+)$/, ({ params, body }) => b.updateNeed(id(params[0]), body)],
  ['DELETE', /^\/api\/needs\/(\d+)$/, ({ params, query }) => b.removeNeed(id(params[0]), b.checkMonth(query.get('month')))],
  ['PUT', /^\/api\/needs\/(\d+)\/months\/([\d-]+)$/, ({ params, body }) => {
    const month = b.checkMonth(params[1]);
    if (body.amount != null) b.setNeedAmount(id(params[0]), month, body.amount, !!body.forward);
    if (body.paid !== undefined) b.setNeedMonth(id(params[0]), month, { paid: !!body.paid, paid_amount: body.paid_amount ?? null });
  }],

  // Хочу купити: план і вішліст
  ['POST', /^\/api\/wants$/, ({ body }) => ({ id: b.addWant(body as Parameters<typeof b.addWant>[0]) })],
  ['PATCH', /^\/api\/wants\/(\d+)$/, ({ params, body }) => b.updateWant(id(params[0]), body)],
  ['DELETE', /^\/api\/wants\/(\d+)$/, ({ params }) => b.removeWant(id(params[0]))],

  // Операції
  ['GET', /^\/api\/transactions$/, ({ query }) => b.transactions(b.checkMonth(query.get('month')), {
    bucket: query.get('bucket'), category: query.get('category'), search: query.get('search'),
  })],
  ['POST', /^\/api\/transactions$/, ({ body }) => ({ id: b.addManualTx(body as Parameters<typeof b.addManualTx>[0]) })],
  ['DELETE', /^\/api\/transactions\/([\w-]+)$/, ({ params }) => b.removeManualTx(params[0])],
  ['PUT', /^\/api\/transactions\/([\w-]+)\/kind$/, ({ params, body }) =>
    ({ changed: b.setTxKind(params[0], { bucket: body.bucket, category: body.category }, !!body.remember) })],
  ['GET', /^\/api\/transactions\/([\w-]+)\/items$/, ({ params }) => ({
    items: items.itemsFor(params[0]),
    receipt: one('SELECT id, store, time, total, image IS NOT NULL AS has_image FROM receipts WHERE tx_id = :id ORDER BY id DESC LIMIT 1', { id: params[0] }) ?? null,
  })],
  ['PUT', /^\/api\/transactions\/([\w-]+)\/items$/, async ({ params, body }) => ({ items: await items.setItems(params[0], body.items) }), 256e3],
  ['GET', /^\/api\/rules$/, () => all('SELECT pattern, bucket, category, created_at FROM rules ORDER BY created_at DESC')],
  ['DELETE', /^\/api\/rules$/, ({ query }) => void run('DELETE FROM rules WHERE pattern = :p', { p: query.get('pattern') ?? '' })],

  // Чеки: фото → ШІ читає → людина перевіряє й записує
  ['POST', /^\/api\/receipts\/scan$/, async ({ body }) => {
    const data = String(body.image ?? '').replace(/^data:[^,]*,/, '');
    const mime = MIME.test(body.mime) ? body.mime : 'image/jpeg';
    if (data.length < 2000) throw new b.UserError('Немає фото чека');
    const receipt = await scanReceipt(data, mime);
    const image = items.saveImage(Buffer.from(data, 'base64'));
    const candidates = items.receiptCandidates(receipt.total, receipt.time);
    // Чек фотографують з конкретної операції — вона перша й обрана, навіть якщо сума трохи інша
    const forTx = typeof body.tx_id === 'string' ? body.tx_id : null;
    if (forTx && !candidates.some((c) => c.id === forTx)) {
      const t = one<items.Candidate>(
        `SELECT t.id, t.time, t.amount, t.description, t.category, m.name AS member, a.title AS account,
                (SELECT COUNT(*) FROM items i WHERE i.tx_id = t.id) AS items
           FROM transactions t LEFT JOIN members m ON m.id = t.member_id LEFT JOIN accounts a ON a.id = t.account_id WHERE t.id = :id`, { id: forTx });
      if (t) candidates.unshift({ ...t, exact: -t.amount === receipt.total });
    }
    return { image, receipt, candidates, match: forTx ?? items.bestCandidate(candidates, receipt.time) };
  }, 14e6],
  ['POST', /^\/api\/receipts$/, ({ body }) => items.saveReceipt(body as Parameters<typeof items.saveReceipt>[0]), 256e3],
  ['GET', /^\/api\/receipts\/(\d+)\/image$/, ({ params }) => {
    const img = items.receiptImage(id(params[0]));
    if (!img) throw new b.UserError('Фото цього чека немає');
    return img;
  }],

  // Підсумок місяця: куди пішли гроші, що купували, порада ШІ
  ['GET', /^\/api\/summary$/, ({ query }) => {
    const month = b.checkMonth(query.get('month'));
    return { categories: b.categorySums(month), items: items.monthItems(month), merchants: items.topMerchants(month, 8), advice: items.savedAdvice(month) };
  }],
  ['POST', /^\/api\/advice$/, ({ query, body }) => items.adviceFor(b.checkMonth(query.get('month')), !!body.refresh)],

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
    if (body.include && a.kind === 'card' && a.currency !== 980) throw new b.UserError('Рахуються лише гривневі картки');
    run('UPDATE accounts SET include = :v WHERE id = :id', { id: params[0], v: body.include ? 1 : 0 });
  }],
  ['POST', /^\/api\/sync$/, () => syncSoon()],
];

async function readBody(req: IncomingMessage, max = 64e3): Promise<Body> {
  if (req.method === 'GET' || req.method === 'DELETE') return {};
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new b.UserError(max > 1e6 ? 'Завелике фото' : 'Завеликий запит');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {}
  throw new b.UserError('Очікую JSON');
}

const send = (res: ServerResponse, status: number, data: unknown) => {
  if (Buffer.isBuffer(data)) {
    return res.writeHead(status, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' }).end(data);
  }
  return res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(data ?? { ok: true }));
};

export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  // Змінювати — лише запитами з нашим заголовком: чужа сторінка не надішле його без дозволу CORS
  if (req.method !== 'GET' && req.headers['x-kapshuk'] !== '1') return send(res, 403, { error: 'Без заголовка X-Kapshuk' });
  for (const [method, path, handler, maxBody] of routes) {
    const m = url.pathname.match(path);
    if (!m || method !== req.method) continue;
    try {
      const body = await readBody(req, maxBody);
      return send(res, 200, await handler({ body, query: url.searchParams, params: m.slice(1) }));
    } catch (err) {
      if (err instanceof b.UserError) return send(res, 400, { error: err.message });
      console.error(`${req.method} ${url.pathname}:`, err);
      return send(res, 500, { error: 'Щось пішло не так на сервері' });
    }
  }
  send(res, 404, { error: 'Немає такого запиту' });
}
