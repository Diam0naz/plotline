// Plotline server: serves the app and the anchor ledger API from one process, with no dependencies.
//   node server/server.mjs            (PORT and DATA_DIR can be set in the environment)
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve, sep, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Ledger } from './ledger.mjs';
import { Registry } from './registry.mjs';
import { verifyEvents } from './chainlog.mjs';
import { fingerprint } from '../core.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};
// Only the app itself is public. Server code, data and tests never are.
const HIDDEN = new Set(['server', 'data', 'node_modules']);

const HEX64 = /^[0-9a-f]{64}$/;
const MAX_BODY = 2048;
const RATE = { windowMs: 60_000, max: 30 };
const SUBMIT_MAX_BODY = 65536; // three signed records and a farm boundary
const SUBMIT_RATE = { windowMs: 60_000, max: 10 };
const FP = /^[0-9a-f]{16}$/;

export function createApp({ dataDir = join(ROOT, 'data'), now = () => new Date(), adminToken = process.env.ADMIN_TOKEN || randomBytes(12).toString('hex') } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const ledger = new Ledger(join(dataDir, 'ledger.jsonl'));
  // Approved verifiers (id -> public key). Only an operator can add one.
  const verifiersFile = join(dataDir, 'verifiers.json');
  const verifiers = existsSync(verifiersFile) ? JSON.parse(readFileSync(verifiersFile, 'utf8')) : {};
  const registry = new Registry({ file: join(dataDir, 'registry.jsonl'), privateFile: join(dataDir, 'private.json'), verifiers, now });
  const hits = new Map(); // "bucket:ip" -> [timestamps] of recent writes

  const limited = (ip, bucket = 'anchor', rate = RATE) => {
    const t = Date.now();
    const k = bucket + ':' + ip;
    const recent = (hits.get(k) || []).filter((x) => t - x < rate.windowMs);
    recent.push(t);
    hits.set(k, recent);
    return recent.length > rate.max;
  };
  const isAdmin = (req) => {
    const h = String(req.headers.authorization || '');
    const given = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
    const want = Buffer.from(adminToken);
    return given.length === want.length && timingSafeEqual(given, want);
  };

  const send = (res, code, body, headers = {}) => {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    res.writeHead(code, {
      'content-type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      ...headers,
    });
    res.end(isJson ? JSON.stringify(body) : body);
  };

  const readBody = (req, max = MAX_BODY) =>
    new Promise((ok, fail) => {
      let size = 0;
      let failed = false;
      const chunks = [];
      req.on('data', (c) => {
        if (failed) return; // stop buffering; the reply below closes the connection
        size += c.length;
        if (size > max) { failed = true; fail(Object.assign(new Error('body too large'), { code: 413 })); return; }
        chunks.push(c);
      });
      req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
      req.on('error', fail);
    });

  async function api(req, res, path) {
    if (path === '/api/head' && req.method === 'GET') return send(res, 200, ledger.head());

    if (path === '/api/ledger' && req.method === 'GET') {
      const from = Math.max(1, parseInt(new URL(req.url, 'http://x').searchParams.get('from') || '1', 10) || 1);
      return send(res, 200, { head: ledger.head(), entries: ledger.list(from) });
    }

    const m = path.match(/^\/api\/anchor\/([^/]+)$/);
    if (m && req.method === 'GET') {
      if (!HEX64.test(m[1])) return send(res, 400, { error: 'root must be 64 lowercase hex characters' });
      const e = ledger.find(m[1]);
      return e ? send(res, 200, e) : send(res, 404, { error: 'not in ledger' });
    }

    if (path === '/api/anchor' && req.method === 'POST') {
      if (limited(req.socket.remoteAddress || 'unknown')) return send(res, 429, { error: 'too many requests, try again shortly' });
      let data;
      try { data = JSON.parse(await readBody(req)); }
      catch (err) {
        const big = err.code === 413;
        return send(res, big ? 413 : 400, { error: big ? 'body too large' : 'invalid JSON' }, big ? { connection: 'close' } : {});
      }
      if (!data || typeof data.root !== 'string' || !HEX64.test(data.root)) return send(res, 400, { error: 'root must be 64 lowercase hex characters' });
      if (!Number.isInteger(data.count) || data.count < 1 || data.count > 100000) return send(res, 400, { error: 'count must be an integer from 1 to 100000' });
      const { entry, created } = ledger.add(data.root, data.count, now());
      return send(res, created ? 201 : 200, entry);
    }

    if (path.startsWith('/api/registry/') || path === '/api/submit') return await registryApi(req, res, path);
    return send(res, 404, { error: 'unknown endpoint' });
  }

  const jsonBody = async (req, res, max) => {
    try { return JSON.parse(await readBody(req, max)); }
    catch (err) {
      const big = err.code === 413;
      send(res, big ? 413 : 400, { error: big ? 'body too large' : 'invalid JSON' }, big ? { connection: 'close' } : {});
      return undefined;
    }
  };
  const answer = (res, r, okCode = 200) => send(res, r.ok === false ? 400 : okCode, r);

  async function registryApi(req, res, path) {
    const ip = req.socket.remoteAddress || 'unknown';
    const get = req.method === 'GET';
    const post = req.method === 'POST';

    // ----- public: anyone can inspect the market, the totals and the log -----
    if (get && path === '/api/registry/market') return send(res, 200, registry.market());
    if (get && path === '/api/registry/reconcile') return send(res, 200, registry.reconcile());
    if (get && path === '/api/registry/log') {
      const from = Math.max(1, parseInt(new URL(req.url, 'http://x').searchParams.get('from') || '1', 10) || 1);
      return send(res, 200, { head: registry.log.head(), check: registry.verifyLog(), entries: registry.log.list(from, 500) });
    }
    let m = path.match(/^\/api\/registry\/certificate\/(ORD-\d{4,})$/);
    if (get && m) {
      const c = registry.certificate(m[1]);
      return c ? send(res, 200, c) : send(res, 404, { error: 'no retirement certificate for this order' });
    }
    m = path.match(/^\/api\/registry\/farmer\/([^/]+)$/);
    if (get && m) {
      if (!FP.test(m[1])) return send(res, 400, { error: 'farmer key must be 16 hex characters' });
      return send(res, 200, registry.farmerView(m[1]));
    }

    // ----- public writes that are protected by signatures and rate limits -----
    if (post && path === '/api/submit') {
      if (limited(ip, 'submit', SUBMIT_RATE)) return send(res, 429, { error: 'too many submissions, try again shortly' });
      const data = await jsonBody(req, res, SUBMIT_MAX_BODY);
      if (data === undefined) return;
      return answer(res, await registry.submit(data ?? {}), 201);
    }
    if (post && path === '/api/registry/decide') {
      if (limited(ip, 'decide', SUBMIT_RATE)) return send(res, 429, { error: 'too many requests, try again shortly' });
      const data = await jsonBody(req, res, 4096);
      if (data === undefined) return;
      return answer(res, await registry.decide(data ?? {}));
    }

    // ----- operator only -----
    if (!isAdmin(req)) return send(res, 401, { error: 'operator token required' });
    if (get && path === '/api/registry/submissions') {
      return send(res, 200, { submissions: [...registry.subs.values()].map((x) => registry.publicSub(x)).reverse() });
    }
    if (get && path === '/api/registry/verifiers') {
      const out = [];
      for (const [id, pub] of Object.entries(verifiers)) out.push({ id, key: await fingerprint(pub) });
      return send(res, 200, { verifiers: out });
    }
    if (post && path === '/api/registry/verifiers') {
      const data = await jsonBody(req, res, 2048);
      if (data === undefined) return;
      if (!/^[a-z0-9-]{2,32}$/.test(data?.id ?? '') || data.pub?.kty !== 'EC' || data.pub?.crv !== 'P-256' || !data.pub.x || !data.pub.y) {
        return send(res, 400, { error: 'send an id (a-z, 0-9, dash) and a P-256 public key' });
      }
      if (verifiers[data.id]) return send(res, 409, { error: 'verifier id already exists' });
      verifiers[data.id] = { kty: 'EC', crv: 'P-256', x: data.pub.x, y: data.pub.y };
      writeFileSync(verifiersFile, JSON.stringify(verifiers, null, 2));
      return send(res, 201, { id: data.id, key: await fingerprint(verifiers[data.id]) });
    }
    if (post && path === '/api/registry/order') {
      const data = await jsonBody(req, res, 2048);
      if (data === undefined) return;
      return answer(res, registry.placeOrder(data ?? {}), 201);
    }
    if (post && path === '/api/registry/retire') {
      const data = await jsonBody(req, res, 2048);
      if (data === undefined) return;
      return answer(res, registry.retire(data ?? {}), 201);
    }
    if (post && path === '/api/registry/release') {
      const data = await jsonBody(req, res, 1024);
      if (data === undefined) return;
      return answer(res, registry.releaseHeld(data?.fp));
    }
    return send(res, 404, { error: 'unknown endpoint' });
  }

  async function serveStatic(req, res, path) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    let rel;
    try { rel = decodeURIComponent(path); } catch { return send(res, 400, 'Bad request'); }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = resolve(ROOT, '.' + rel);
    const inside = file === ROOT || file.startsWith(ROOT + sep);
    const top = file.slice(ROOT.length + 1).split(sep)[0];
    if (!inside || HIDDEN.has(top) || /\.test\.mjs$/.test(file) || top.startsWith('.') || top === 'package.json') {
      return send(res, 404, 'Not found');
    }
    try {
      const s = await stat(file);
      if (!s.isFile()) return send(res, 404, 'Not found');
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] || 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        // The service worker and the shell must always be revalidated so updates reach farmers.
        'cache-control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      send(res, 404, 'Not found');
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://x').pathname;
      if (path.startsWith('/api/')) return await api(req, res, path);
      return await serveStatic(req, res, path);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: 'server error' });
    }
  });
  return { server, ledger, registry, adminToken };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 8123;
  const { server, ledger, adminToken } = createApp({ dataDir: process.env.DATA_DIR || join(ROOT, 'data') });
  server.listen(port, () => {
    const h = ledger.head();
    console.log(`Plotline on http://localhost:${port}  (ledger entries: ${h.seq}, head ${h.hash.slice(0, 12)}…)`);
    if (!process.env.ADMIN_TOKEN) console.log(`Operator token for this run (set ADMIN_TOKEN to keep one): ${adminToken}`);
  });
}
