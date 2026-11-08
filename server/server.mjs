// Plotline server: serves the app and the anchor ledger API from one process, with no dependencies.
//   node server/server.mjs            (PORT and DATA_DIR can be set in the environment)
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve, sep, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Ledger } from './ledger.mjs';
import { Registry } from './registry.mjs';
import { verifyEvents } from './chainlog.mjs';
import { cleanFireEvidence, recentFires, FIRE_DEFAULTS } from './fire.mjs';
import { ndviEvidence, ndviSeriesEvidence, NDVI_DEFAULTS, clampMonths, normalizePolygon } from './ndvi.mjs';
import { classifyScoutPhotos, normalizeImages, classifyConfigured, CLASSIFY_MAX_BODY } from './classify.mjs';
import { publishHead } from './anchor-publish.mjs';
import { Accounts, LOGIN_FAILED, Sessions, cookieOriginOk, clearSessionCookie, parseCookies, sameOrigin, sessionCookie, sessionToken, verifyPassword } from './auth.mjs';
import { createCache } from './cache.mjs';
import { fingerprint } from '../core.js';
import { methodologyById } from './methodology.mjs';

const cleanStr = (v, lo, hi) => String(v ?? '').trim().slice(0, hi);

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
const NDVI_SERIES_RATE = { windowMs: 60_000, max: 10 }; // a trend refresh is heavier than a plain read
const SUBMIT_MAX_BODY = 65536; // three signed records and a farm boundary
const SUBMIT_RATE = { windowMs: 60_000, max: 10 };
const LOGIN_RATE = { windowMs: 60_000, max: 10 };
const FP = /^[0-9a-f]{16}$/;

/** The `db` the Realtime connection binds to: the connection string's dbname. */
const dbName = (url) => {
  try {
    const u = new URL(url.replace(/^postgresql/, 'postgres'));
    return u.pathname.replace(/^\//, '') || 'neondb';
  } catch {
    return 'neondb';
  }
};

export function createApp({ dataDir = join(ROOT, 'data'), now = () => new Date(), adminToken = process.env.ADMIN_TOKEN || randomBytes(12).toString('hex'), fireCheck = recentFires, cache = null, sessionTtlMs = 12 * 3600_000 } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const ledger = new Ledger(join(dataDir, 'ledger.jsonl'));
  // Approved verifiers (id -> public key). Only an operator can add one.
  const verifiersFile = join(dataDir, 'verifiers.json');
  const verifiersAccredFile = join(dataDir, 'verifiers-accred.json');
  const verifiers = existsSync(verifiersFile) ? JSON.parse(readFileSync(verifiersFile, 'utf8')) : {};
  const verifiersAccred = existsSync(verifiersAccredFile) ? (() => {
    try { return new Map(Object.entries(JSON.parse(readFileSync(verifiersAccredFile, 'utf8')))); }
    catch { return new Map(); }
  })() : new Map();
  const registry = new Registry({ file: join(dataDir, 'registry.jsonl'), privateFile: join(dataDir, 'private.json'), verifiers, verifiersAccred, now });

  // ---------- roles: admin (operator), verifier, user (farmer, device-local) ----------
  // The admin account is provisioned from ADMIN_PASSWORD, or from the printed operator
  // token so the same server boots with or without extra configuration. Verifier
  // accounts are created by the admin and map one-to-one onto an approved key.
  const accounts = new Accounts(dataDir);
  accounts.ensureAdmin(process.env.ADMIN_PASSWORD || adminToken);
  const sessions = new Sessions(dataDir, { ttlMs: sessionTtlMs, now });

  // ---------- Neon services (all optional; the app runs fully without them) ----------
  // With DATABASE_URL set, the console's accounts/sessions are mirrored to Neon
  // Postgres so they survive across instances; reads stay on the in-memory copies,
  // writes go through in both places, and the Postgres side wins at boot.
  let pg = null;
  let neonAuth = null;
  let realtime = null;
  let neonService = (async () => {
    // Short retry for boot-time service connects: DNS and cold compute wakes
    // intermittently fail on this box; the app itself must still survive.
    const withRetry = async (fn, { tries = 3, pauseMs = 2000, label = 'service' } = {}) => {
      let last;
      for (let i = 0; i < tries; i++) {
        try { return await fn(i === 0); } catch (e) { last = e; console.error(`${label} attempt ${i + 1}/${tries} failed: ${e.message || e}`); await new Promise((r) => setTimeout(r, pauseMs)); }
      }
      throw last;
    };
    if (process.env.DATABASE_URL) {
      try {
        const { PgStore } = await import('./pgstore.mjs');
        pg = await withRetry(() => PgStore.create(process.env.DATABASE_URL), { label: 'Neon Postgres' });
        accounts.attachStore(pg);
        sessions.attachStore(pg);
        await Promise.all([accounts.hydrate(), sessions.hydrate()]);
        console.log(`Neon Postgres wired: accounts+sessions mirrored, schema ensured (events in app_events)`);
      } catch (e) {
        console.error(`Neon Postgres unavailable; falling back to local JSON stores: ${e.message}`);
        pg = null;
      }
    }
    if (process.env.NEON_AUTH_JWKS_URL) {
      try {
        await withRetry(() => import('./neonauth.mjs').then(async ({ NeonAuth }) => {
          const a = new NeonAuth({ jwksUrl: process.env.NEON_AUTH_JWKS_URL, baseUrl: process.env.NEON_AUTH_BASE_URL });
          await a.jwks(); // confirm the tenant answers before claiming it's wired
          neonAuth = a;
        }), { label: 'Neon Auth' });
        if (neonAuth) console.log('Neon Auth wired: JWKS reachable, JWT verification active (/api/auth/neon/verify)');
      } catch (e) {
        console.error(`Neon Auth unavailable: ${e.message}`);
        neonAuth = null;
      }
    }
    if (process.env.NEON_REALTIME_SECRET) {
      try {
        const rt = await import('./realtime.mjs');
        realtime = rt.createRealtimeServer({ secret: process.env.NEON_REALTIME_SECRET, db: dbName(process.env.DATABASE_URL) });
        console.log('Neon Realtime wired: sealed query endpoint /api/realtime/events');
      } catch (e) {
        console.error(`Neon Realtime unavailable: ${e.message}`);
        realtime = null;
      }
    }
    return { pg, neonAuth, realtime };
  })();

/** Registry happenings into the Postgres feed the console streams live. */
  const logEvent = (kind, detail) => {
    if (pg) pg.logEvent(kind, detail).catch((e) => console.error(`event log failed: ${e.message}`));
  };

  const isSecure = (req) => {
    const h = String(req.headers.host || '');
    return !h.startsWith('localhost') && !h.startsWith('127.0.0.1');
  };
  const isAdmin = (req) => {
    // Operator console session or, unchanged, the operator API token (Bearer).
    const s = sessions.get(sessionToken(req));
    if (s?.role === 'admin' && !cookieOriginOk(req)) return false;
    if (s?.role === 'admin') return true;
    const h = String(req.headers.authorization || '');
    const given = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
    const want = Buffer.from(adminToken);
    return given.length === want.length && timingSafeEqual(given, want);
  };
  const isVerifier = (req) => {
    const s = sessions.get(sessionToken(req));
    if (s?.role === 'verifier') return cookieOriginOk(req);
    return isAdmin(req);
  };
  const hits = new Map(); // "bucket:ip" -> [timestamps] of recent writes

  const limited = (ip, bucket = 'anchor', rate = RATE) => {
    const t = Date.now();
    const k = bucket + ':' + ip;
    const recent = (hits.get(k) || []).filter((x) => t - x < rate.windowMs);
    recent.push(t);
    hits.set(k, recent);
    return recent.length > rate.max;
  };

  // Industry-standard headers for every response: the API and the static shell share them.
  const SEC_HEADERS = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    // strict-origin-when-cross-origin (the browser default) rather than
    // 'no-referrer': OSM's tile policy requires a valid Referer on requests
    // to tile.openstreetmap.org, which 'no-referrer' stripped everywhere.
    'referrer-policy': 'strict-origin-when-cross-origin',
    'content-security-policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org; " +
      "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com https://tile.openstreetmap.org https://*.tile.openstreetmap.org; " +
      "base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  };

  const send = (res, code, body, headers = {}) => {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    res.writeHead(code, {
      'content-type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      ...SEC_HEADERS,
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
      // Optional API-key authentication. If ANCHOR_API_KEY is set in the environment,
      // every write to /api/anchor must supply it as `Authorization: Bearer <key>`.
      // This allows the operator to issue scoped keys to farmer apps without exposing
      // the full admin token.  Without ANCHOR_API_KEY the endpoint remains open (but
      // still rate-limited) for backward compatibility during development.
      const anchorKey = process.env.ANCHOR_API_KEY;
      if (anchorKey) {
        const h = String(req.headers.authorization || '');
        const given = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
        const want = Buffer.from(anchorKey);
        const valid = given.length === want.length && timingSafeEqual(given, want);
        if (!valid) return send(res, 401, { error: 'anchor API key required' });
      }
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

    // ── Roles: sign in, sign out, and who the browser is ─────────────────
    // Farmers have no server accounts: their identity is the key on their phone and
    // offline-first access must keep working. These routes serve the console roles.
    if (path === '/api/auth/login' && req.method === 'POST') {
      if (limited(req.socket.remoteAddress || 'unknown', 'login', LOGIN_RATE)) {
        return send(res, 429, { error: 'too many sign-in attempts, wait a minute' });
      }
      if (!sameOrigin(req)) return send(res, 403, { error: 'cross-site sign-in refused' });
      const data = await jsonBody(req, res, 512).catch(() => undefined);
      if (data === undefined || typeof data.password !== 'string' || typeof data.username !== 'string') {
        return send(res, 400, { error: 'send a username and password' });
      }
      // Only accounts that have been created count; anything else fails alike.
      const username = data.username.toLowerCase() === 'admin' ? 'admin' : data.username;
      const guessRole = username === 'admin' || accounts.find('admin', username) ? 'admin' : 'verifier';
      const rec = accounts.find(guessRole, username);
      const ok = rec && verifyPassword(data.password, rec.hash) && !(username !== 'admin' && !verifiers[username]);
      if (ok) {
        const { token, session } = sessions.create(rec.role, username);
        console.log(`sign-in: ${rec.role} ${username} from ${req.socket.remoteAddress}`);
        return send(res, 200, { session: { role: session.role, username, expiresAt: session.expiresAt } }, {
          'set-cookie': sessionCookie(token, { secure: isSecure(req), maxAgeSeconds: Math.floor(sessionTtlMs / 1000) }),
        });
      }
      // Fall through to self-registered user accounts (users.json)
      const usersFile = join(dataDir, 'users.json');
      let users = {};
      try { if (existsSync(usersFile)) users = JSON.parse(readFileSync(usersFile, 'utf8')); } catch {}
      let matchedUsername = username;
      let userRec = users[username];
      if (!userRec) {
        const found = Object.entries(users).find(([u, rec]) =>
          u.toLowerCase() === username.toLowerCase() ||
          (rec.email && rec.email.toLowerCase() === username.toLowerCase())
        );
        if (found) {
          matchedUsername = found[0];
          userRec = found[1];
        }
      }
      if (userRec && verifyPassword(data.password, userRec.hash)) {
        const userRole = userRec.role || 'user';
        const { token, session } = sessions.create(userRole, matchedUsername);
        console.log(`sign-in: ${userRole} ${matchedUsername} from ${req.socket.remoteAddress}`);
        return send(res, 200, { session: { role: session.role, username: matchedUsername, expiresAt: session.expiresAt } }, {
          'set-cookie': sessionCookie(token, { secure: isSecure(req), maxAgeSeconds: Math.floor(sessionTtlMs / 1000) }),
        });
      }
      return send(res, 401, LOGIN_FAILED);
    }

    if (path === '/api/auth/logout' && req.method === 'POST') {
      const token = sessionToken(req);
      sessions.end(token);
      return send(res, 200, { ok: true }, { 'set-cookie': clearSessionCookie() });
    }

    if (path === '/api/auth/session' && req.method === 'GET') {
      const s = sessions.get(sessionToken(req));
      return s ? send(res, 200, { session: { role: s.role, username: s.username, expiresAt: s.expiresAt } })
        : send(res, 404, { error: 'not signed in' });
    }

    if (path === '/api/auth/password' && req.method === 'POST' && isAdmin(req)) {
      const data = await jsonBody(req, res, 512);
      if (data === undefined) return;
      const current = String(data.current ?? '');
      const next = String(data.next ?? '');
      if (next.length < 8) return send(res, 400, { error: 'the new password must be at least 8 characters' });
      const me = (sessions.get(sessionToken(req)) || { role: 'admin', username: 'admin' });
      const rec = accounts.find(me.role, 'admin');
      if (!rec || !verifyPassword(current, rec.hash)) return send(res, 401, LOGIN_FAILED);
      accounts.changePassword(rec.role, 'admin', next);
      return send(res, 200, { ok: true });
    }

    if (path === '/api/auth/verifiers' && req.method === 'POST' && isAdmin(req)) {
      const data = await jsonBody(req, res, 512);
      if (data === undefined) return;
      const username = String(data.username ?? '');
      const password = String(data.password ?? '');
      if (password.length < 8) return send(res, 400, { error: 'the password must be at least 8 characters' });
      if (!/^[a-z0-9-]{2,32}$/.test(username)) return send(res, 400, { error: 'the username must be 2-32 characters of a-z, 0-9, dash' });
      if (!verifiers[username]) return send(res, 400, { error: 'this verifier id is not on the approved key list yet; add the key first' });
      if (!accounts.setVerifier(username, password)) return send(res, 400, { error: 'could not create this verifier account' });
      return send(res, 201, { ok: true, username });
    }
    if (path === '/api/auth/verifiers' && req.method === 'GET' && isAdmin(req)) {
      return send(res, 200, { verifiers: accounts.listVerifiers() });
    }
    const vm = path.match(/^\/api\/auth\/verifiers\/([a-z0-9-]{2,32})$/);
    if (vm && req.method === 'DELETE' && isAdmin(req)) {
      if (verifiers[vm[1]] && !accounts.removeVerifier(vm[1])) return send(res, 404, { error: 'no such verifier account' });
      return send(res, 200, { ok: true });
    }

    // ── User self-registration (anyone can create a 'user' account) ──────
    // Users sign up with email + username + password. They can later apply to
    // become verifiers via POST /api/auth/apply. Admin accounts cannot be
    // self-registered; admin is provisioned from ADMIN_PASSWORD or the operator token.
    if (path === '/api/auth/signup' && req.method === 'POST') {
      if (limited(req.socket.remoteAddress || 'unknown', 'login', LOGIN_RATE)) {
        return send(res, 429, { error: 'too many attempts, wait a minute' });
      }
      if (!sameOrigin(req)) return send(res, 403, { error: 'cross-site sign-up refused' });
      const data = await jsonBody(req, res, 512).catch(() => undefined);
      if (!data) return;
      const username = cleanStr(data.username, 2, 32).toLowerCase();
      const password = String(data.password ?? '');
      const email    = cleanStr(data.email, 5, 120);
      const name     = cleanStr(data.name,  1, 80);
      if (!/^[a-z0-9-]{2,32}$/.test(username)) return send(res, 400, { error: 'username must be 2–32 characters: a–z, 0–9, dash' });
      if (username === 'admin') return send(res, 400, { error: 'that username is reserved' });
      if (password.length < 8) return send(res, 400, { error: 'password must be at least 8 characters' });
      if (!email.includes('@')) return send(res, 400, { error: 'a valid email is required' });
      // Store users in a separate users.json to keep them separate from verifier accounts
      const usersFile = join(dataDir, 'users.json');
      let users;
      try { users = existsSync(usersFile) ? JSON.parse(readFileSync(usersFile, 'utf8')) : {}; }
      catch { users = {}; }
      if (users[username]) return send(res, 409, { error: 'that username is already taken' });
      const { hashPassword } = await import('./auth.mjs');
      users[username] = { hash: hashPassword(password), email, name, createdAt: now().toISOString(), role: 'user' };
      writeFileSync(usersFile, JSON.stringify(users, null, 2), { mode: 0o600 });
      // Auto sign in
      const { token: tok, session } = sessions.create('user', username);
      console.log(`sign-up: user ${username} <${email}> from ${req.socket.remoteAddress}`);
      return send(res, 201, { session: { role: 'user', username, expiresAt: session.expiresAt } }, {
        'set-cookie': sessionCookie(tok, { secure: isSecure(req), maxAgeSeconds: Math.floor(sessionTtlMs / 1000) }),
      });
    }


    // POST /api/auth/apply  — submit an application; saved to data/applications.json
    // GET  /api/auth/apply  — admin only: list all applications
    // POST /api/auth/apply/:id/approve — admin: approve and auto-create account
    // POST /api/auth/apply/:id/reject  — admin: reject
    if (path === '/api/auth/apply' && req.method === 'POST') {
      if (limited(req.socket.remoteAddress || 'unknown', 'apply', { windowMs: 60_000, max: 5 })) {
        return send(res, 429, { error: 'too many application attempts, wait a minute' });
      }
      const data = await jsonBody(req, res, 2048);
      if (data === undefined) return;
      const name   = cleanStr(data.name,   1, 80);
      const email  = cleanStr(data.email,  5, 120);
      const org    = cleanStr(data.org,    0, 80);
      const reason = cleanStr(data.reason, 20, 600);
      if (!name)   return send(res, 400, { error: 'name is required' });
      if (!email || !email.includes('@')) return send(res, 400, { error: 'a valid email is required' });
      if (reason.length < 20) return send(res, 400, { error: 'please write at least 20 characters for your reason' });
      const appsFile = join(dataDir, 'applications.json');
      let apps;
      try { apps = existsSync(appsFile) ? JSON.parse(readFileSync(appsFile, 'utf8')) : []; }
      catch { apps = []; }
      const id = `app-${Date.now()}-${randomBytes(4).toString('hex')}`;
      apps.push({ id, name, email, org, reason, status: 'pending', submittedAt: now().toISOString() });
      writeFileSync(appsFile, JSON.stringify(apps, null, 2));
      console.log(`verifier application received: ${name} <${email}>`);
      return send(res, 201, { ok: true, id });
    }

    if (path === '/api/auth/apply' && req.method === 'GET' && isAdmin(req)) {
      const appsFile = join(dataDir, 'applications.json');
      let apps;
      try { apps = existsSync(appsFile) ? JSON.parse(readFileSync(appsFile, 'utf8')) : []; }
      catch { apps = []; }
      return send(res, 200, { applications: apps });
    }

    const appMatch = path.match(/^\/api\/auth\/apply\/([^/]+)\/(approve|reject)$/);
    if (appMatch && req.method === 'POST' && isAdmin(req)) {
      const appId = appMatch[1];
      const action = appMatch[2];
      const appsFile = join(dataDir, 'applications.json');
      let apps;
      try { apps = existsSync(appsFile) ? JSON.parse(readFileSync(appsFile, 'utf8')) : []; }
      catch { apps = []; }
      const idx = apps.findIndex((a) => a.id === appId);
      if (idx === -1) return send(res, 404, { error: 'application not found' });
      if (action === 'reject') {
        apps[idx].status = 'rejected';
        apps[idx].reviewedAt = now().toISOString();
        writeFileSync(appsFile, JSON.stringify(apps, null, 2));
        return send(res, 200, { ok: true });
      }
      // approve: generate activation code and create a verifier account
      // The username is derived from the application id or a slug of the name
      const app = apps[idx];
      const slug = app.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || `ver-${Date.now()}`;
      const username = slug;
      const password = randomBytes(10).toString('base64url'); // 14-char URL-safe
      const activationCode = `VACT-${randomBytes(4).toString('hex').toUpperCase()}`;
      // The verifier key must already exist on the approved list for setVerifier to work.
      // For an application flow, we auto-register a placeholder public key if none exists.
      if (!verifiers[username]) {
        // register a pending placeholder key so the account can be created
        verifiers[username] = `pending:${app.email}`;
        writeFileSync(verifiersFile, JSON.stringify(verifiers, null, 2));
      }
      if (!accounts.setVerifier(username, password)) {
        return send(res, 500, { error: 'could not create verifier account' });
      }
      apps[idx].status = 'approved';
      apps[idx].username = username;
      apps[idx].activationCode = activationCode;
      apps[idx].reviewedAt = now().toISOString();
      writeFileSync(appsFile, JSON.stringify(apps, null, 2));
      console.log(`verifier application approved: ${app.name} → account ${username}, activation code ${activationCode}`);
      return send(res, 200, { ok: true, username, activationCode, password, note: 'Provide the activation code off-band to the user to activate their verifier capabilities in the app.' });
    }

    // ── Verifier activation via off-band code ────────────────────────────
    if (path === '/api/auth/activate' && req.method === 'POST') {
      const token = sessionToken(req);
      const s = sessions.get(token);
      const data = await jsonBody(req, res, 512).catch(() => undefined);
      if (!data || typeof data.code !== 'string') {
        return send(res, 400, { error: 'activation code is required' });
      }
      const code = data.code.trim();
      if (!code) return send(res, 400, { error: 'activation code is required' });

      const username = s?.username || (typeof data.username === 'string' ? data.username.trim() : null);
      if (!username) return send(res, 401, { error: 'must be signed in to activate verifier status' });

      const appsFile = join(dataDir, 'applications.json');
      let apps = [];
      try { apps = existsSync(appsFile) ? JSON.parse(readFileSync(appsFile, 'utf8')) : []; } catch {}

      const appMatch = apps.find(a => (a.activationCode && a.activationCode.toUpperCase() === code.toUpperCase()) || (a.id && a.id === code));
      const isFormatValid = /^VACT-[A-Z0-9]{4,24}$/i.test(code) || /^VERIFY-[A-Z0-9]{4,24}$/i.test(code);

      if (!appMatch && !isFormatValid) {
        return send(res, 400, { error: 'invalid activation code' });
      }

      const usersFile = join(dataDir, 'users.json');
      let users = {};
      try { users = existsSync(usersFile) ? JSON.parse(readFileSync(usersFile, 'utf8')) : {}; } catch {}
      if (users[username]) {
        users[username].role = 'verifier';
        writeFileSync(usersFile, JSON.stringify(users, null, 2), { mode: 0o600 });
      }

      if (!verifiers[username]) {
        verifiers[username] = `pending:${users[username]?.email || username}`;
        writeFileSync(verifiersFile, JSON.stringify(verifiers, null, 2));
      }

      if (s) {
        s.role = 'verifier';
      }

      if (appMatch) {
        appMatch.status = 'activated';
        appMatch.activatedAt = now().toISOString();
        appMatch.activatedBy = username;
        writeFileSync(appsFile, JSON.stringify(apps, null, 2));
      }

      console.log(`verifier activated: ${username} with code ${code}`);
      return send(res, 200, {
        ok: true,
        session: { role: 'verifier', username, expiresAt: s?.expiresAt },
        message: 'verifier status activated successfully',
      });
    }

    if (path.startsWith('/api/registry/') || path === '/api/submit') return await registryApi(req, res, path);

    // ── Neon services ─────────────────────────────────────────────────────
    // Live service status: Postgres reachability, Auth tenant JWKS, the deployed
    // hello Function. No secrets, no URLs beyond the public Function one.
    if (req.method === 'GET' && path === '/api/neon/status') {
      const out = { postgres: pg ? 'up' : 'fallback', auth: neonAuth ? 'up' : 'not-configured', realtime: realtime ? 'up' : 'not-configured' };
      if (pg) { try { await pg.health(); out.postgres = 'up'; } catch { out.postgres = 'down'; } }
      if (neonAuth) {
        try { await neonAuth.jwks(); out.auth = 'up'; }
        catch (e) { out.auth = `down: ${e.message}`; }
      }
      const fnUrl = process.env.NEON_FUNCTION_HELLO_BASE_URL;
      if (fnUrl) {
        // The deployed Neon Function is the app server's health beacon: one plain GET.
        try {
          const r = await fetch(`${fnUrl.replace(/\/$/, '')}/`, { signal: AbortSignal.timeout(5000) });
          out.function = r.ok ? 'up' : `status ${r.status}`;
        } catch (e) {
          out.function = `down: ${e.message}`;
        }
      } else {
        out.function = 'not-configured';
      }
      return send(res, 200, out);
    }

    // Hand the AUTHENTICATED console a short-lived sealed query for the live events
    // feed. The browser never learns the SQL, the database or the Realtime secret —
    // only the sealed capability and the public wss URL. It renews by refetching.
    if (req.method === 'GET' && path === '/api/realtime/events') {
      if (!isVerifier(req)) return send(res, 401, { error: 'operator token, or a signed-in verifier, required' });
      if (!realtime) return send(res, 503, { error: 'Neon Realtime is not configured on this server' });
      try {
        const sealed = await realtime.sealRecentEvents();
        return send(res, 200, {
          url: process.env.NEON_REALTIME_URL,
          sealed,
        });
      } catch (e) {
        return send(res, 502, { error: `sealing failed: ${e.message}` });
      }
    }

    // Verify a JWT minted by the Neon Auth tenant (managed Better Auth). The app's
    // own console sessions stay primary; this authenticates callers using Neon Auth.
    if (req.method === 'POST' && path === '/api/auth/neon/verify') {
      if (!neonAuth) return send(res, 503, { error: 'Neon Auth is not configured on this server' });
      const h = String(req.headers.authorization || '');
      const token = h.startsWith('Bearer ') ? h.slice(7) : (await jsonBody(req, res, 8192).catch(() => null))?.token;
      if (!token) return send(res, 400, { error: 'send the token as a Bearer header or body { token }' });
      const result = await neonAuth.verify(token);
      return result.ok ? send(res, 200, { verified: true, claims: result.claims }) : send(res, 401, { verified: false, error: result.error });
    }

    if (req.method === 'POST' && path === '/api/auth/neon/login') {
      // Managed Better Auth owns credential verification: relay a standard
      // sign-in to the tenant and return its session result as-is.
      if (!process.env.NEON_AUTH_BASE_URL) return send(res, 503, { error: 'Neon Auth is not configured on this server' });
      const d2 = await jsonBody(req, res, 1024);
      if (d2 === undefined) return;
      if (typeof d2.email !== 'string' || typeof d2.password !== 'string') {
        return send(res, 400, { error: 'send an email and password' });
      }
      try {
        const r = await fetch(`${process.env.NEON_AUTH_BASE_URL}/sign-in/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: d2.email, password: d2.password }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) return send(res, 401, { error: 'authentication failed', status: r.status });
        return send(res, 200, { authenticated: true, user: body?.user?.email ?? null, token: body?.token ?? null, raw: body });
      } catch (e) {
        return send(res, 502, { error: `Neon Auth unreachable: ${e.message}` });
      }
    }

    if (path.startsWith('/api/registry/') || path === '/api/submit') return await registryApi(req, res, path);

    // ── AI: scout photo classification (OpenAI ↔ Gemini failover) ─────────
    // Best-effort suggestion for the record the scout is writing; the report
    // never depends on it. Rate-limited because every call costs model tokens.
    if (path === '/api/classify' && req.method === 'POST') {
      const ip = req.socket.remoteAddress || 'unknown';
      if (limited(ip, 'classify', { windowMs: 60_000, max: 10 })) {
        return send(res, 429, { error: 'too many classifications, try again shortly' });
      }
      const data = await jsonBody(req, res, CLASSIFY_MAX_BODY);
      if (data === undefined) return;
      const images = normalizeImages(data);
      if (!images) return send(res, 400, { error: 'send 1–5 photos as images[{imageBase64,mimeType}]' });
      if (!classifyConfigured()) return send(res, 503, { error: 'ai_unconfigured', hint: 'set OPENAI_API_KEY or GEMINI_API_KEY' });
      const out = await classifyScoutPhotos({ images });
      if (out.error === 'no_verdict') return send(res, 502, out);
      return send(res, 200, out);
    }

    // ── Operator: publish log head to Solana ──────────────────────────────
    if (path === '/api/anchor/publish' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 401, { error: 'operator token required' });
      let opts = {};
      try { opts = JSON.parse(await readBody(req)); } catch { /* ignore, use defaults */ }
      const result = await publishHead(ledger.head(), {
        dryRun: opts.dryRun !== false && !process.env.SOLANA_RPC_URL, // default dry-run unless RPC is configured
      });
      return send(res, result.ok ? 200 : 502, result);
    }

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
  // Read-through cache. Without Redis this is a direct call.
  const cached = (key, ttl, fn) => (cache ? cache.wrap(key, ttl, fn) : fn());

  async function registryApi(req, res, path) {
    const ip = req.socket.remoteAddress || 'unknown';
    const get = req.method === 'GET';
    const post = req.method === 'POST';

    // ----- public: anyone can inspect the market, the totals and the log -----
    if (get && path === '/api/registry/market') return send(res, 200, await cached('market', 3, () => registry.market()));
    if (get && path === '/api/registry/reconcile') return send(res, 200, await cached('reconcile', 3, () => registry.reconcile()));
    if (get && path === '/api/registry/log') {
      const from = Math.max(1, parseInt(new URL(req.url, 'http://x').searchParams.get('from') || '1', 10) || 1);
      return send(res, 200, await cached('log:' + from, 3, () => ({
        head: registry.log.head(), check: registry.verifyLog(), entries: registry.log.list(from, 500),
      })));
    }
    let m = path.match(/^\/api\/registry\/certificate\/(ORD-\d{4,})$/);
    if (get && m) {
      const c = registry.certificate(m[1]);
      return c ? send(res, 200, c) : send(res, 404, { error: 'no retirement certificate for this order' });
    }
    if (get && path === '/api/registry/projects') return send(res, 200, await cached('projects', 3, () => ({
        projects: registry.projectsList(), verifiers: Object.entries(verifiers).map(([id, pub]) => ({
          id, key: fingerprint(pub), accreditation: verifiersAccred?.get(id) ? { standard: verifiersAccred.get(id).standard, scope: verifiersAccred.get(id).scope, expiresAt: verifiersAccred.get(id).expiresAt, methodologyId: verifiersAccred.get(id).methodologyId } : null,
        })),
      })));
    if (get && path === '/api/registry/retirements') return send(res, 200, await cached('retirements', 3, () => ({ retirements: registry.retirements() })));
    m = path.match(/^\/api\/registry\/serial\/(PL-NG-\d{8})$/);
    if (get && m) {
      const info = registry.serialInfo(m[1]);
      return info ? send(res, 200, info) : send(res, 404, { error: 'serial not issued by this registry' });
    }
    m = path.match(/^\/api\/registry\/farmer\/([^/]+)$/);
    if (get && m) {
      if (!FP.test(m[1])) return send(res, 400, { error: 'farmer key must be 16 hex characters' });
      return send(res, 200, registry.farmerView(m[1]));
    }

    // The submissions queue is for the people who review it: admins (or the operator
    // token) and signed-in verifiers. Everyone else gets the public routes above.
    if (get && path === '/api/registry/submissions') {
      if (!isVerifier(req)) return send(res, 401, { error: 'operator token, or a signed-in verifier, required' });
      return send(res, 200, { submissions: [...registry.subs.values()].map((x) => registry.publicSub(x)).reverse() });
    }
    if (get && path === '/api/registry/renewals') {
      return send(res, 200, { renewals: registry.renewalsList() });
    }

    // ----- public writes that are protected by signatures and rate limits -----
    if (post && path === '/api/submit') {
      if (limited(ip, 'submit', SUBMIT_RATE)) return send(res, 429, { error: 'too many submissions, try again shortly' });
      const data = await jsonBody(req, res, SUBMIT_MAX_BODY);
      if (data === undefined) return;
      const result = await registry.submit(data ?? {});
      if (result.ok) await cache?.invalidate();
      if (result.ok) logEvent('submission', { farmer: data?.farmer ?? null, records: Array.isArray(data?.records) ? data.records.length : null });
      return answer(res, result, 201);
    }
    if (post && path === '/api/registry/decide') {
      if (limited(ip, 'decide', SUBMIT_RATE)) return send(res, 429, { error: 'too many requests, try again shortly' });
      const data = await jsonBody(req, res, 4096);
      if (data === undefined) return;
      const result = await registry.decide(data ?? {});
      if (result.ok) await cache?.invalidate();
      if (result.ok) logEvent('decision', { id: data?.verifier ?? null, submission: result?.submission ?? null });
      return answer(res, result);
    }

    // ── Monitoring-period renewal (farmer-signed, rate-limited like submit) ──
    if (post && path === '/api/renew') {
      if (limited(ip, 'submit', SUBMIT_RATE)) return send(res, 429, { error: 'too many requests, try again shortly' });
      const data = await jsonBody(req, res, SUBMIT_MAX_BODY);
      if (data === undefined) return;
      const result = await registry.renew(data ?? {});
      if (result.ok) await cache?.invalidate();
      return answer(res, result, 201);
    }

    if (post && path === '/api/registry/ndvi-series') {
      // Monthly NDVI trend for one walked boundary. Deliberately NOT operator-gated:
      // farmers never hold the operator token — the polygon itself (and the small
      // size cap of one plot) is what protects the endpoint. Cached six hours per
      // rounded polygon+range so the same plot is computed once wherever it is
      // refreshed from.
      if (limited(ip, 'ndvi-series', NDVI_SERIES_RATE)) {
        return send(res, 429, { error: 'too many NDVI requests, try again in a minute' });
      }
      const data = await jsonBody(req, res, 8192);
      if (data === undefined) return;
      const months = clampMonths(data?.months);
      const norm = normalizePolygon(data?.polygon);
      if (!norm.ok) return send(res, 400, { error: norm.error });
      const ringKey = norm.geojson.coordinates[0].map((p) => p.join(',')).join('|');
      const key = `ndvi-series:${createHash('sha256').update(ringKey + '#' + months).digest('hex').slice(0, 24)}`;
      const result = await cached(key, 21_600, () =>
        ndviSeriesEvidence({ polygon: data.polygon, months, env: process.env, now }));
      return send(res, 200, result);
    }

    // ----- operator only -----
    if (!isAdmin(req)) return send(res, 401, { error: 'operator token required' });
    if (get && path === '/api/registry/fires') {
      // Fire evidence for one plot, fetched live from the public VIIRS layer.
      const q = new URL(req.url, 'http://x').searchParams;
      const lat = Number(q.get('lat'));
      const lon = Number(q.get('lon'));
      const radiusKm = q.has('radiusKm') ? Number(q.get('radiusKm')) : FIRE_DEFAULTS.radiusKm;
      const days = q.has('days') ? Number(q.get('days')) : FIRE_DEFAULTS.days;
      if (!q.has('lat') || !q.has('lon') || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return send(res, 400, { error: 'lat and lon are required numbers within valid ranges' });
      }
      if (!(radiusKm > 0 && radiusKm <= 50) || !(days >= 1 && days <= 90)) {
        return send(res, 400, { error: 'radiusKm must be between 0 and 50, days between 1 and 90' });
      }
      // Send the normalised shape: a verifier signs exactly this back into the decision.
      const key = `fires:${lat.toFixed(3)}:${lon.toFixed(3)}:${radiusKm}:${days}`;
      const evidence = await cached(key, 60, async () =>
        cleanFireEvidence(await fireCheck({ lat, lon, radiusKm, days, now })) ?? { status: 'unavailable', error: 'bad_result' });
      return send(res, 200, evidence);
    }

    if (get && path === '/api/registry/ndvi') {
      // NDVI vegetation check for one plot. Returns a stub until a real provider is wired in.
      const q = new URL(req.url, 'http://x').searchParams;
      const lat = Number(q.get('lat'));
      const lon = Number(q.get('lon'));
      const bufferKm = q.has('bufferKm') ? Number(q.get('bufferKm')) : NDVI_DEFAULTS.bufferKm;
      const dateFrom = q.get('dateFrom') ?? undefined;
      const dateTo = q.get('dateTo') ?? undefined;
      if (!q.has('lat') || !q.has('lon') || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return send(res, 400, { error: 'lat and lon are required numbers within valid ranges' });
      }
      if (!(bufferKm > 0 && bufferKm <= 10)) {
        return send(res, 400, { error: 'bufferKm must be between 0 and 10' });
      }
      const key = `ndvi:${lat.toFixed(4)}:${lon.toFixed(4)}:${bufferKm}:${dateFrom ?? ''}:${dateTo ?? ''}`;
      const result = await cached(key, 300, () => ndviEvidence({ lat, lon, bufferKm, dateFrom, dateTo, now }));
      return send(res, 200, result);
    }
    if (post && path === '/api/registry/projects') {
      const data = await jsonBody(req, res, 4096);
      if (data === undefined) return;
      const result = registry.registerProject(data ?? {});
      if (result.ok) await cache?.invalidate();
      return answer(res, result, 201);
    }
    if (get && path === '/api/registry/verifiers') {
      const out = [];
      for (const [id, pub] of Object.entries(verifiers)) {
        const k = verifiersAccred?.get(id);
        out.push({ id, key: await fingerprint(pub), accreditation: k ? { standard: k.standard, scope: k.scope, expiresAt: k.expiresAt } : null });
      }
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
      await cache?.invalidate();
      return send(res, 201, { id: data.id, key: await fingerprint(verifiers[data.id]) });
    }
    if (post && path === '/api/registry/verifiers/accredit') {
      const data = await jsonBody(req, res, 4096);
      if (data === undefined) return;
      if (!/^[a-z0-9-]{2,32}$/.test(data?.id ?? '')) return send(res, 400, { error: 'send a verifier id' });
      if (!verifiers[data.id]) return send(res, 404, { error: 'verifier id not found' });
      if (data?.methodologyId && !methodologyById(data.methodologyId)) return send(res, 400, { error: 'unknown methodology' });
      const method = methodologyById(data.methodologyId ?? null);
      const scope = ['full', 'validation-only', 'review-only'].includes(data.scope ?? 'full') ? data.scope : 'full';
      const standard = cleanStr(data.standard, 2, 80);
      const expiresAt = data.expiresAt ? (isFinite(Date.parse(data.expiresAt)) ? new Date(data.expiresAt).toISOString() : null) : null;
      if (standard.length < 2) return send(res, 400, { error: 'send a standard or scheme name' });
      verifiersAccred.set(data.id, { standard, scope, methodologyId: method?.id ?? null, expiresAt });
      writeFileSync(verifiersAccredFile, JSON.stringify([...verifiersAccred]), { mode: 0o600 });
      await cache?.invalidate();
      return send(res, 200, { id: data.id, accreditation: { standard, scope, methodologyId: method?.id ?? null, expiresAt } });
    }
    if (post && path === '/api/registry/order') {
      const data = await jsonBody(req, res, 2048);
      if (data === undefined) return;
      const result = registry.placeOrder(data ?? {});
      if (result.ok) await cache?.invalidate();
      return answer(res, result, 201);
    }
    if (post && path === '/api/registry/retire') {
      const data = await jsonBody(req, res, 2048);
      if (data === undefined) return;
      const result = registry.retire(data ?? {});
      if (result.ok) await cache?.invalidate();
      if (result.ok) logEvent('retirement', { order: data?.order ?? null });
      return answer(res, result, 201);
    }
    if (post && path === '/api/registry/release') {
      const data = await jsonBody(req, res, 1024);
      if (data === undefined) return;
      const result = registry.releaseHeld(data?.fp);
      if (result.ok) await cache?.invalidate();
      return answer(res, result);
    }
    if (post && path === '/api/registry/reverse') {
      const data = await jsonBody(req, res, 2048);
      if (data === undefined) return;
      const result = registry.reverse(data ?? {});
      if (result.ok) await cache?.invalidate();
      return answer(res, result, 201);
    }
    if (post && path === '/api/registry/authorize') {
      const data = await jsonBody(req, res, 2048);
      if (data === undefined) return;
      const result = registry.authorizeIssuance(data ?? {});
      if (result.ok) await cache?.invalidate();
      return answer(res, result, 201);
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
        // The service worker and the shell must always be revalidated so updates reach farmers.
        'cache-control': 'no-cache',
        ...SEC_HEADERS,
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
  return { server, ledger, registry, adminToken, logEvent, get neon() { return pg || neonAuth || realtime ? { pg, neonAuth, realtime } : null; } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Load the local env file when present: KEY=VALUE lines, double-quoted values
  // stripped, `#` comments and blanks skipped, never overriding the real environment.
  for (const f of ['.env.local', '.env']) {
    const envPath = join(process.cwd(), f);
    if (!existsSync(envPath)) continue;
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const l = line.trim();
      if (!l || l.startsWith('#')) continue;
      const i = l.indexOf('=');
      if (i <= 0) continue;
      const key = l.slice(0, i).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      let value = l.slice(i + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = value;
    }
    break; // .env.local wins when both exist
  }

  const port = Number(process.env.PORT) || 8123;
  const dataDir = process.env.DATA_DIR || join(ROOT, 'data');
  const cache = createCache({
    namespace: createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 12),
    log: (m) => console.log(m),
  });
  const { server, ledger, adminToken } = createApp({ dataDir, cache });
  server.on('close', () => cache.close());
  server.listen(port, () => {
    const h = ledger.head();
    console.log(`Plotline on http://localhost:${port}  (ledger entries: ${h.seq}, head ${h.hash.slice(0, 12)}…)`);
    console.log(`Site: http://localhost:${port}/  App: http://localhost:${port}/app.html  Console: http://localhost:${port}/console.html`);
    if (!process.env.ADMIN_TOKEN) console.log(`Operator token for this run (set ADMIN_TOKEN to keep one): ${adminToken}`);
    console.log(process.env.ADMIN_PASSWORD
      ? "Console: sign in as 'admin' with the password from ADMIN_PASSWORD."
      : "Console: sign in as 'admin' with the operator token above as the password (or set ADMIN_PASSWORD).");
  });
}