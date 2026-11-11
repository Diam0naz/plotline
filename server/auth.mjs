// auth.mjs — roles, passwords and sessions for the registry console.
//
// Three roles, in order of what they may touch:
//   admin    the operator. Everything an operator token can do, plus account management.
//   verifier an accredited reviewer. Can read the submissions queue and sign decisions
//            with their approved key (the signature stays the authoriser).
//   user     a farmer. There are deliberately no farmer server accounts: the phone
//            holds an ECDSA key and offline-first access requires no login. Their
//            "sign in" is the device-local PIN lock in the app.
//
// Data handling rules followed here:
//   • passwords are hashed with scrypt (N=16384, r=8, p=1) and a 16-byte salt, compared
//     in constant time; the plaintext never reaches disk or a log;
//   • sessions are random 256-bit tokens; only their SHA-256 is stored server-side, so
//     a copy of the data directory cannot be replayed as a session;
//   • session files are written with mode 0600 and expired entries are purged on load;
//   • the cookie is HttpOnly and SameSite=Lax (the app cannot read it, other sites
//     cannot send it cross-site); it is only ever Secure on non-localhost origins;
//   • login is rate-limited per IP; failures give one generic message;
//   • cookie-authenticated state changes are refused unless the Origin/Referer host
//     matches the Host header (defence in depth beyond SameSite).

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1 });
const SESSION_COOKIE = 'plotline.session';

export const ROLES = Object.freeze(['admin', 'verifier', 'user']);

// ---------- password hashing ----------

export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(String(password), salt, 64, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltHex, keyHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const want = Buffer.from(keyHex, 'hex');
    const got = scryptSync(String(password), salt, want.length, { N: +N, r: +r, p: +p });
    return got.length === want.length && timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

// ---------- accounts (data/accounts.json, mode 0600) ----------

export class Accounts {
  constructor(dir, store = null) {
    this.file = join(dir, 'accounts.json');
    this.store = store ?? null;
    mkdirSync(dir, { recursive: true });
    this.data = existsSync(this.file) ? (() => {
      try { return JSON.parse(readFileSync(this.file, 'utf8')); }
      catch { return { admins: {}, verifiers: {} }; }
    })() : { admins: {}, verifiers: {} };
    for (const k of ['admins', 'verifiers']) {
      if (!this.data[k] || typeof this.data[k] !== 'object') this.data[k] = {};
    }
  }

  // Neon Postgres wiring: attach a PgStore pushed live at boot, when DATABASE_URL exists.
  attachStore(store) {
    this.store = store;
  }

  /** Merge the database's view: DB wins per record, local-only records are pushed up. */
  async hydrate() {
    if (!this.store) return false;
    const data = await this.store.loadAccounts();
    const admins = data.admins ?? {};
    const verifiers = data.verifiers ?? {};
    const localOnly = [];
    for (const r of ['admins', 'verifiers']) {
      const from = r === 'admins' ? admins : verifiers;
      for (const [username, rec] of Object.entries(this.data[r])) {
        if (!(r === 'admins' ? admins : verifiers)[username]) localOnly.push([r, username, rec]);
      }
      this.data[r] = { ...this.data[r], ...from };
    }
    // Provisions done before the store attached (e.g. ensureAdmin at boot) survive.
    for (const [r, username, rec] of localOnly) this.data[r][username] = rec;
    this.#flush();
    return true;
  }

  #flush() {
    writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    // Write-through to Neon Postgres runs behind the request; a missed save surfaces
    // on the next hydrate, so it must never block or fail the operator's action.
    if (this.store) this.store.saveAccounts(this.data).catch((e) => console.error(`account sync to Neon Postgres failed: ${e.message}`));
  }

  // The operator's password comes from ADMIN_PASSWORD, or reuses the printed operator
  // token so the console boots with no extra configuration.
  ensureAdmin(password) {
    const a = this.data.admins;
    if (a.admin?.hash) return 'kept';
    a.admin = { hash: hashPassword(password), createdAt: new Date().toISOString(), lastChanged: null };
    this.#flush();
    return 'created';
  }

  find(role, username) {
    if (role !== 'admin' && role !== 'verifier') return null;
    const store = role === 'admin' ? this.data.admins : this.data.verifiers;
    const rec = store[username];
    return rec && rec.hash ? { ...rec, role, username } : null;
  }

  // Only an admin can create/remove verifier accounts. Usernames reuse the verifier
  // id used for decisions, so an account maps one-to-one onto an approved key.
  setVerifier(username, password) {
    if (!/^[a-z0-9-]{2,32}$/.test(username)) return false;
    this.data.verifiers[username] = { hash: hashPassword(password), createdAt: new Date().toISOString(), disabled: null };
    this.#flush();
    return true;
  }

  removeVerifier(username) {
    if (!this.data.verifiers[username]) return false;
    delete this.data.verifiers[username];
    this.#flush();
    return true;
  }

  listVerifiers() {
    return Object.entries(this.data.verifiers).map(([username, v]) => ({
      username, createdAt: v.createdAt, disabledAt: v.disabled ?? null,
    }));
  }

  changePassword(role, username, password) {
    const store = role === 'admin' ? this.data.admins : this.data.verifiers;
    if (!store[username]) return false;
    store[username].hash = hashPassword(password);
    store[username].lastChanged = new Date().toISOString();
    this.#flush();
    return true;
  }
}

// ---------- sessions (data/sessions.json, mode 0600) ----------

// Only sha256(token) is ever stored; the raw token exists only in the user's cookie.
// Map files are written as [[key, value], ...]; older files may be a plain object.
export const entryMap = (j) => new Map(Array.isArray(j) ? j : Object.entries(j ?? {}));

export class Sessions {
  constructor(dir, { ttlMs = 12 * 3600_000, now = () => new Date(), max = 200, store = null } = {}) {
    this.file = join(dir, 'sessions.json');
    this.store = store;
    mkdirSync(dir, { recursive: true });
    this.ttlMs = ttlMs;
    this.now = now;
    this.max = max;
    this.sbyHash = existsSync(this.file) ? (() => {
      try { return entryMap(JSON.parse(readFileSync(this.file, 'utf8'))); }
      catch { return new Map(); }
    })() : new Map();
    this.purge();
  }

  attachStore(store) {
    this.store = store;
  }

  async hydrate() {
    if (!this.store) return false;
    const rows = await this.store.loadSessions();
    // Postgres wins per live session; sessions minted before the store attached
    // (the boot race) survive, and everything is synced back in one write.
    const live = new Map(rows);
    for (const [h, s] of this.sbyHash) if (!live.has(h)) live.set(h, s);
    this.sbyHash = new Map([...live].filter(([, s]) => Date.parse(s.expiresAt) > Date.parse(this.now())));
    this.#flush();
    return true;
  }

  #flush() {
    writeFileSync(this.file, JSON.stringify([...this.sbyHash]), { mode: 0o600 });
    if (this.store) this.store.saveSessions([...this.sbyHash]).catch((e) => console.error(`session sync to Neon Postgres failed: ${e.message}`));
  }

  purge() {
    const t = this.now().getTime();
    let changed = false;
    for (const [h, s] of this.sbyHash) {
      if (t >= Date.parse(s.expiresAt)) { this.sbyHash.delete(h); changed = true; }
    }
    if (changed) this.#flush();
  }

  create(role, username) {
    if (this.sbyHash.size >= this.max) this.purge();
    const token = randomBytes(32).toString('base64url');
    const s = {
      role,
      username,
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(Date.parse(this.now()) + this.ttlMs).toISOString(),
    };
    this.sbyHash.set(createHash('sha256').update(token).digest('hex'), s);
    this.#flush();
    return { token, session: s };
  }

  get(token) {
    if (!token) return null;
    this.purge();
    const s = this.sbyHash.get(createHash('sha256').update(String(token)).digest('hex'));
    if (!s || ROLES.includes(s.role) === false) return null;
    return s;
  }

  end(token) {
    if (!token) return false;
    const h = createHash('sha256').update(String(token)).digest('hex');
    if (!this.sbyHash.has(h)) return false;
    this.sbyHash.delete(h);
    this.#flush();
    return true;
  }
}

// ---------- cookies ----------

export function sessionCookie(token, { secure, maxAgeSeconds }) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionToken(req) {
  // Cookie first (browser flow); `Bearer <session>` is accepted for tooling. A value
  // that is not a valid session simply does not resolve in Sessions.get(), and the
  // admin Bearer token keeps working through the separate isAdmin() path.
  const c = parseCookies(req);
  if (c[SESSION_COOKIE]) return c[SESSION_COOKIE];
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// Cookie sessions must never be replayed from another site: state-changing requests that
// authenticate by cookie (not by token header) must carry a matching Origin or Referer.
export function sameOrigin(req) {
  const o = firstHeader(req, 'origin') || firstHeader(req, 'referer');
  if (!o) return true; // non-browser clients (tests, curl) have no Origin; token paths verify themselves
  try {
    return new URL(o).host === String(req.headers.host || '');
  } catch {
    return false;
  }
}

// For requests that authenticate by cookie, the Origin is checked when the client
// supplies one (browsers do, on any fetch), and a missing Origin is only tolerated
// for reads (tests and curl). A cookie-authenticated write with no Origin at all
// is refused.
export function cookieOriginOk(req) {
  const c = parseCookies(req);
  if (!c[SESSION_COOKIE]) return true; // token/Bearer flows are checked below the API layer
  const hasOrigin = Boolean(firstHeader(req, 'origin') || firstHeader(req, 'referer'));
  if (!hasOrigin) return req.method === 'GET' || req.method === 'HEAD';
  return sameOrigin(req);
}

function firstHeader(req, name) {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** One generic failure: never say whether the username or the password was wrong. */
export const LOGIN_FAILED = { error: 'invalid username or password' };
