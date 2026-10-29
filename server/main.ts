// Капшук — сімейний бюджет. Два HTTP-сервери:
// • HOST:PORT у локальній мережі — інтерфейс (dist/web), вхід і /api для нього;
// • 127.0.0.1:MCP_PORT — лише для HA на цьому ж ноутбуці: /mcp для Адольфа і /sensors для сенсорів HA.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { HA_ORIGINS, HOST, PORT, WEB_DIR } from './config.ts';
import * as auth from './auth.ts';
import { handleApi } from './api.ts';
import { buildMcp } from './mcp.ts';
import { startSync } from './monobank.ts';
import { monthSummary } from './budget.ts';
import { thisMonth } from './time.ts';

const MCP_HOST = '127.0.0.1';
const MCP_PORT = Number(process.env.MCP_PORT || 8793);
const HA_PORT = Number(process.env.HA_PORT || 8123);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
};

async function serveStatic(res: http.ServerResponse, pathname: string) {
  const rel = path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  let file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR)) return res.writeHead(400).end();
  try {
    if (!(await stat(file)).isFile()) throw new Error('dir');
  } catch {
    file = path.join(WEB_DIR, 'index.html'); // сторінки інтерфейсу — одна сторінка
  }
  try {
    const data = await readFile(file);
    const hashed = file.includes(`${path.sep}assets${path.sep}`);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    }).end(data);
  } catch {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Інтерфейс ще не зібрано (npm run build)');
  }
}

// Адреса, з якою відкрили Капшук (http://192.168.31.94:8792) — для входу через HA за тим самим іменем хоста
function origin(req: http.IncomingMessage) {
  const host = req.headers.host ?? '';
  return /^[\w.-]+(:\d+)?$/.test(host) ? `http://${host}` : null;
}

function cors(req: http.IncomingMessage, res: http.ServerResponse) {
  const o = req.headers.origin;
  if (o && HA_ORIGINS.includes(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
  }
}

const redirect = (res: http.ServerResponse, to: string, cookie?: string) =>
  res.writeHead(302, { Location: to, 'Cache-Control': 'no-store', ...(cookie ? { 'Set-Cookie': cookie } : {}) }).end();

let lastCode = 0;

http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  try {
    // Панель HA просить одноразове посилання входу за своїм токеном HA
    if (p === '/login/code') {
      cors(req, res);
      if (req.method === 'OPTIONS') {
        return res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Authorization', 'Access-Control-Max-Age': '600' }).end();
      }
      if (req.method !== 'POST') return res.writeHead(405, { Allow: 'POST' }).end();
      const o = origin(req);
      if (!o) return res.writeHead(400).end();
      if (Date.now() - lastCode < 1e3) return res.writeHead(429).end();
      lastCode = Date.now();
      if (!(await auth.haTokenValid(req.headers.authorization))) return res.writeHead(401).end();
      return res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(JSON.stringify({ url: `${o}/login?code=${auth.createCode()}` }));
    }
    if (p === '/login' && req.method === 'GET') {
      const o = origin(req);
      if (!o) return res.writeHead(400).end();
      if (url.searchParams.has('code')) {
        if (!auth.useCode(url.searchParams.get('code'))) return redirect(res, '/?login=expired');
        // Сесію даємо і кукою, і в адресі: сторінка всередині панелі HA на iPhone може не зберегти куку.
        // Панель просить вхід при кожному відкритті — чинну сесію не множимо
        const token = auth.sessionOf(req) ?? auth.createSession();
        return redirect(res, `/#s=${token}`, auth.sessionCookie(token));
      }
      const ha = new URL(o);
      ha.port = String(HA_PORT);
      return redirect(res, auth.haAuthorizeUrl(o, ha.origin));
    }
    if (p === '/login/ha' && req.method === 'GET') {
      const o = origin(req);
      if (!o || !(await auth.haExchange(o, url.searchParams.get('code'), url.searchParams.get('state')))) return redirect(res, '/?login=failed');
      return redirect(res, '/', auth.sessionCookie(auth.createSession()));
    }
    if (p === '/logout' && req.method === 'POST') {
      const s = auth.sessionOf(req);
      if (s) auth.endSession(s);
      return res.writeHead(204, { 'Set-Cookie': `${auth.COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` }).end();
    }
    if (p.startsWith('/api/')) {
      if (!auth.sessionOf(req)) {
        return res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'Потрібен вхід' }));
      }
      return await handleApi(req, res, url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end();
    return await serveStatic(res, p);
  } catch (err) {
    console.error(`${req.method} ${p}:`, err);
    if (!res.headersSent) res.writeHead(500).end();
  }
}).listen(PORT, HOST, () => console.log(`Капшук: http://${HOST}:${PORT}`));

// ── Лише для HA на цьому ж ноутбуці ──

function sensors() {
  const s = monthSummary(thisMonth());
  const uah = (k: number) => Math.round(k) / 100;
  return {
    month: s.month,
    income: uah(s.income),
    needs_left: uah(s.buckets.needs.left), wants_left: uah(s.buckets.wants.left), savings_left: uah(s.buckets.savings.left),
    needs_spent: uah(s.buckets.needs.spent), wants_spent: uah(s.buckets.wants.spent), savings_saved: uah(s.buckets.savings.spent),
    needs_unpaid: s.needs.filter((n) => !n.paid).length, needs_unpaid_sum: uah(s.needs_plan.left),
    needs_unpaid_titles: s.needs.filter((n) => !n.paid).map((n) => n.title).join(', '),
    wants_free: uah(s.buckets.wants.left - s.wants_plan.left),
    jars_total: uah(s.jars.filter((j) => j.currency === 980).reduce((sum, j) => sum + j.balance, 0)),
    unchecked: s.unchecked,
  };
}

http.createServer(async (req, res) => {
  const p = new URL(req.url ?? '/', 'http://x').pathname;
  if (p === '/sensors' && req.method === 'GET') {
    try {
      return res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(sensors()));
    } catch (err) {
      console.error('sensors:', err);
      return res.writeHead(500).end();
    }
  }
  if (p !== '/mcp') return res.writeHead(404).end();
  if (req.method !== 'POST') return res.writeHead(405, { Allow: 'POST' }).end();
  // Streamable HTTP без сесій — кожен запит із новим сервером і транспортом
  const server = buildMcp();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error('mcp:', err);
    if (!res.headersSent) res.writeHead(500).end();
  }
}).listen(MCP_PORT, MCP_HOST, () => console.log(`Капшук для HA: http://${MCP_HOST}:${MCP_PORT}/mcp, /sensors`));

startSync();
