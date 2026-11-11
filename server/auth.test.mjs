// Role-based access: sign in, sign out, path protection and password handling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './server.mjs';
import { hashPassword, verifyPassword } from './auth.mjs';

const NOW = () => new Date('2026-11-15T12:00:00.000Z');

test('passwords are hashed, never stored in the clear, and compared safely', () => {
  const h = hashPassword('correct horse battery staple');
  assert.match(h, /^scrypt\$16384\$8\$1\$/);
  assert.ok(!h.includes('correct horse'), 'the plaintext is not recoverable from the hash');
  assert.equal(verifyPassword('correct horse battery staple', h), true);
  assert.equal(verifyPassword('wrong password', h), false);
  assert.equal(verifyPassword('anything', 'not-a-real-hash'), false);
});

function boot(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'auth-'));
  const app = createApp({ dataDir: dir, adminToken: 'op', now: NOW, ...opts });
  return new Promise((resolve) => {
    app.server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${app.server.address().port}`;
      resolve({ app, base, dir });
    });
  });
}
const cleanup = async ({ app }) => { app.server.closeAllConnections?.(); await new Promise((r) => app.server.close(r)); };

// A tiny cookie jar: fetch() will not manage cookies itself.
function jar() {
  const bag = new Map();
  return {
    keep(res) {
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        bag.set(pair.slice(0, i).trim(), c);
      }
    },
    header() {
      const flat = [...bag.values()].filter((c) => !/Max-Age=0/.test(c)).map((c) => c.split(';')[0]);
      return flat.join('; ');
    },
    get(name) {
      const c = [...bag.values()].find((x) => x.startsWith(name + '='));
      return c || null;
    },
  };
}
const post = (base, path, body, { headers = {}, jar: j } = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(j ? { cookie: j.header() } : {}), ...(j ? { origin: base } : {}), ...headers },
    body: JSON.stringify(body),
  }).then((res) => { if (j && res.headers.getSetCookie?.().length) j.keep(res); return res; });
const status = async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) });

test('the console signs in as admin with a cookie session', async (t) => {
  const hadPassword = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  t.after(() => { if (hadPassword !== undefined) process.env.ADMIN_PASSWORD = hadPassword; });

  const b = await boot();
  const j = jar();
  try {
    // Wrong password: one generic failure for everything.
    const bad = await post(b.base, '/api/auth/login', { username: 'admin', password: 'nope' }, { jar: j });
    assert.equal(bad.status, 401);
    assert.equal((await status(bad)).json.error, 'invalid username or password');

    // The admin password was bootstrapped from the printed operator token.
    const ok = await post(b.base, '/api/auth/login', { username: 'admin', password: 'op' }, { jar: j });
    const out = await status(ok);
    assert.equal(ok.status, 200, JSON.stringify(out.json));
    assert.equal(out.json.session.role, 'admin');
    const cookie = j.get('plotline.session');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\//);
    assert.doesNotMatch(cookie, /Secure/, 'localhost is a safe context; Secure only matters over TLS');
    assert.equal(j.header().length > 40, true, 'the session token is long');

    // The cookie alone now opens operator routes; no Bearer token needed.
    const queue = await fetch(b.base + '/api/registry/submissions', { headers: { cookie: j.header(), origin: b.base } });
    assert.equal(queue.status, 200);

    // Who am I?
    const me = await fetch(b.base + '/api/auth/session', { headers: { cookie: j.header() } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).session.role, 'admin');
  } finally {
    await cleanup(b);
  }
});

test('signing out ends the session server-side', async (t) => {
  const hadPassword = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  t.after(() => { if (hadPassword !== undefined) process.env.ADMIN_PASSWORD = hadPassword; });

  const b = await boot();
  const j = jar();
  try {
    assert.equal((await post(b.base, '/api/auth/login', { username: 'admin', password: 'op' }, { jar: j })).status, 200);
    const out = await fetch(b.base + '/api/auth/logout', { method: 'POST', headers: { cookie: j.header() } });
    assert.equal(out.status, 200);
    const setCookie = (out.headers.getSetCookie?.() ?? []).join(' | ');
    assert.match(setCookie, /plotline.session=/);
    assert.match(setCookie, /Max-Age=0/, 'the cookie is cleared');
    const after = await fetch(b.base + '/api/registry/submissions', { headers: { cookie: j.header() } });
    assert.equal(after.status, 401, 'the session is dead on the server, not just in the browser');
  } finally {
    await cleanup(b);
  }
});

test('a verifier account can read the queue, but not run the registry', async (t) => {
  const hadPassword = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  t.after(() => { if (hadPassword !== undefined) process.env.ADMIN_PASSWORD = hadPassword; });

  const b = await boot();
  const j = jar();
  const op = { authorization: 'Bearer op' };
  try {
    // Admin must provision the key first, then the account.
    const keys = await import('./testkit.mjs');
    const verifier = await keys.makeFarmer();
    const noKey = await post(b.base, '/api/auth/verifiers', { username: 'ver-a', password: 'long-enough-1' }, { headers: op });
    assert.equal(noKey.status, 400, 'an account without an approved key is refused');
    const keyRes = await fetch(b.base + '/api/registry/verifiers', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...op },
      body: JSON.stringify({ id: 'ver-a', pub: verifier.pub }),
    });
    assert.equal(keyRes.status, 201);
    const made = await post(b.base, '/api/auth/verifiers', { username: 'ver-a', password: 'long-enough-1' }, { headers: op });
    assert.equal(made.status, 201, JSON.stringify((await status(made)).json));
    const short = await post(b.base, '/api/auth/verifiers', { username: 'ver-b', password: 'tiny' }, { headers: op });
    assert.equal(short.status, 400);

    // Verifier signs in.
    const login = await post(b.base, '/api/auth/login', { username: 'ver-a', password: 'long-enough-1' }, { jar: j });
    assert.equal(login.status, 200);
    assert.equal((await status(login)).json.session.role, 'verifier');

    // Reads the queue. Decisions continue to be authorised by the verifier's key signature.
    const queue = await fetch(b.base + '/api/registry/submissions', { headers: { cookie: j.header(), origin: b.base } });
    assert.equal(queue.status, 200);

    // Cannot touch operator-only paths.
    const accredit = await fetch(b.base + '/api/registry/verifiers/accredit', {
      method: 'POST',
      headers: { cookie: j.header(), 'content-type': 'application/json', origin: b.base },
      body: JSON.stringify({ id: 'ver-a', standard: 'X' }),
    });
    assert.equal(accredit.status, 401);

    // Anonymous users still cannot read the queue.
    const anon = await fetch(b.base + '/api/registry/submissions');
    assert.equal(anon.status, 401);
  } finally {
    await cleanup(b);
  }
});

test('a cookie session is refused cross-site and an expired session is dead', async (t) => {
  const hadPassword = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  t.after(() => { if (hadPassword !== undefined) process.env.ADMIN_PASSWORD = hadPassword; });

  // Expiry: a 50 ms session checked at a later clock time is over.
  let t0 = new Date('2026-11-15T12:00:00.000Z');
  const b = await boot({ sessionTtlMs: 50, now: () => new Date(t0) });
  const j = jar();
  try {
    assert.equal((await post(b.base, '/api/auth/login', { username: 'admin', password: 'op' }, { jar: j })).status, 200);
    t0 = new Date('2026-11-15T12:00:01.000Z'); // one second passes
    const after = await fetch(b.base + '/api/auth/session', { headers: { cookie: j.header() } });
    assert.equal(after.status, 404, 'sessions expire');

    // Cross-site replay of a live cookie: refused on a read, and on the write per origin.
    const b2 = await boot();
    const j2 = jar();
    assert.equal((await post(b2.base, '/api/auth/login', { username: 'admin', password: 'op' }, { jar: j2 })).status, 200);
    const evilRead = await fetch(b2.base + '/api/registry/submissions', {
      headers: { cookie: j2.header(), origin: 'https://evil.example' },
    });
    assert.equal(evilRead.status, 401, 'the session does not work from another host');
    const evilWrite = await post(b2.base, '/api/registry/projects', { name: 'steal' }, { headers: evilAuth(j2) });
    assert.equal(evilWrite.status, 401, 'nor on a write');
    await cleanup(b2);
  } finally {
    await cleanup(b);
  }
});

// A cross-site POST carrying the victim's cookie and no trusted token.
const evilAuth = (j) => ({ cookie: j.header(), 'content-type': 'application/json', origin: 'https://evil.example' });

test('sign-in attempts are rate-limited', async (t) => {
  const hadPassword = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  t.after(() => { if (hadPassword !== undefined) process.env.ADMIN_PASSWORD = hadPassword; });

  const b = await boot({ sessionTtlMs: 60000 });
  try {
    let last = null;
    for (let i = 0; i < 12; i++) last = await post(b.base, '/api/auth/login', { username: 'admin', password: 'nope-' + i });
    assert.equal(last.status, 429);
  } finally {
    await cleanup(b);
  }
});

test('unified auth flow: standard signup, unified login, verifier application and activation', async (t) => {
  const hadPassword = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  t.after(() => { if (hadPassword !== undefined) process.env.ADMIN_PASSWORD = hadPassword; });

  const b = await boot();
  const jUser = jar();
  const jAdmin = jar();
  const op = { authorization: 'Bearer op' };

  try {
    // 1. Admin signup is forbidden via public signup route
    const adminSignup = await post(b.base, '/api/auth/signup', {
      username: 'admin',
      password: 'password123',
      email: 'admin@example.com',
      name: 'Admin User',
    });
    assert.equal(adminSignup.status, 400);

    // 2. Standard user signs up via public signup route
    const userSignup = await post(b.base, '/api/auth/signup', {
      username: 'farmer-joe',
      password: 'mypassword123',
      email: 'joe@example.com',
      name: 'Joe Farmer',
    }, { jar: jUser });
    const userSignupData = await status(userSignup);
    assert.equal(userSignup.status, 201);
    assert.equal(userSignupData.json.session.role, 'user');
    assert.equal(userSignupData.json.session.username, 'farmer-joe');

    // 3. Standard user cannot read verifier submissions queue
    const queueBefore = await fetch(b.base + '/api/registry/submissions', {
      headers: { cookie: jUser.header(), origin: b.base },
    });
    assert.equal(queueBefore.status, 401);

    // 4. Admin signs in using standard unified login form
    const adminLogin = await post(b.base, '/api/auth/login', {
      username: 'admin',
      password: 'op',
    }, { jar: jAdmin });
    const adminLoginData = await status(adminLogin);
    assert.equal(adminLogin.status, 200);
    assert.equal(adminLoginData.json.session.role, 'admin');

    // 5. Standard user applies to be a verifier
    const applyRes = await post(b.base, '/api/auth/apply', {
      name: 'Joe Farmer',
      email: 'joe@example.com',
      org: 'Green Agro',
      reason: 'Experienced in surveying agroforestry plots across Kaduna.',
    }, { jar: jUser });
    const applyData = await status(applyRes);
    assert.equal(applyRes.status, 201);
    assert.ok(applyData.json.id);
    const appId = applyData.json.id;

    // 6. Admin lists applications and approves
    const appsListRes = await fetch(b.base + '/api/auth/apply', {
      headers: { cookie: jAdmin.header(), origin: b.base },
    });
    assert.equal(appsListRes.status, 200);
    const appsList = (await appsListRes.json()).applications;
    assert.ok(appsList.some((a) => a.id === appId));

    const approveRes = await post(b.base, `/api/auth/apply/${appId}/approve`, {}, {
      headers: { cookie: jAdmin.header(), origin: b.base },
    });
    const approveData = await status(approveRes);
    assert.equal(approveRes.status, 200);
    assert.ok(approveData.json.activationCode);
    const actCode = approveData.json.activationCode;

    // 7. Standard user activates verifier role with the off-band code
    const activateRes = await post(b.base, '/api/auth/activate', {
      code: actCode,
    }, { jar: jUser });
    const activateData = await status(activateRes);
    assert.equal(activateRes.status, 200);
    assert.equal(activateData.json.session.role, 'verifier');

    // 8. Now session is upgraded: verifier can access the submissions queue
    const queueAfter = await fetch(b.base + '/api/registry/submissions', {
      headers: { cookie: jUser.header(), origin: b.base },
    });
    assert.equal(queueAfter.status, 200);
  } finally {
    await cleanup(b);
  }
});

test('activation: only an approved, unused code upgrades the signed-in caller', async () => {
  const b = await boot();
  const jUser = jar();
  const jAdmin = jar();
  try {
    await post(b.base, '/api/auth/signup', { username: 'mallory', password: 'mypassword123', email: 'm@example.com', name: 'M' }, { jar: jUser });
    await post(b.base, '/api/auth/login', { username: 'admin', password: 'op' }, { jar: jAdmin });

    // A well-formed code nobody issued, or no session at all, gets nothing.
    assert.equal((await post(b.base, '/api/auth/activate', { code: 'VERIFY-AAAA' }, { jar: jUser })).status, 400);
    assert.equal((await post(b.base, '/api/auth/activate', { code: 'VACT-DEADBEEF', username: 'mallory' })).status, 401);

    // An application id is a public receipt, not a code.
    const { json: { id } } = await status(await post(b.base, '/api/auth/apply', { name: 'Mallory', email: 'm@example.com', reason: 'I would like to review agroforestry plots.' }, { jar: jUser }));
    assert.equal((await post(b.base, '/api/auth/activate', { code: id }, { jar: jUser })).status, 400);

    const { json: { activationCode } } = await status(await post(b.base, `/api/auth/apply/${id}/approve`, {}, { jar: jAdmin }));
    const ok = await post(b.base, '/api/auth/activate', { code: activationCode.toLowerCase() }, { jar: jUser });
    assert.equal(ok.status, 200);
    // The new role survives a restart because the rotated session was persisted.
    const again = createApp({ dataDir: b.dir, adminToken: 'op', now: NOW });
    const res = await new Promise((resolve) => again.server.listen(0, '127.0.0.1', () => resolve(again.server.address().port)))
      .then((port) => fetch(`http://127.0.0.1:${port}/api/auth/session`, { headers: { cookie: jUser.header() } }));
    assert.equal((await res.json()).session.role, 'verifier');
    again.server.closeAllConnections?.(); await new Promise((r) => again.server.close(r));

    // One use only.
    assert.equal((await post(b.base, '/api/auth/activate', { code: activationCode }, { jar: jUser })).status, 400);
    // A decided application cannot be approved again (that would mint a second account).
    assert.equal((await post(b.base, `/api/auth/apply/${id}/approve`, {}, { jar: jAdmin })).status, 409);
  } finally {
    await cleanup(b);
  }
});

test('approving an application never takes over an existing verifier id', async () => {
  const b = await boot();
  const jAdmin = jar();
  try {
    await post(b.base, '/api/auth/login', { username: 'admin', password: 'op' }, { jar: jAdmin });
    const ids = [];
    for (let i = 0; i < 2; i++) {
      const { json: { id } } = await status(await post(b.base, '/api/auth/apply', { name: 'Ada Obi', email: `a${i}@example.com`, reason: 'I would like to review agroforestry plots.' }));
      ids.push((await status(await post(b.base, `/api/auth/apply/${id}/approve`, {}, { jar: jAdmin }))).json);
    }
    assert.equal(ids[0].username, 'ada-obi');
    assert.equal(ids[1].username, 'ada-obi-2');
    // The first account still signs in with its own password.
    assert.equal((await post(b.base, '/api/auth/login', { username: 'ada-obi', password: ids[0].password })).status, 200);
  } finally {
    await cleanup(b);
  }
});
