import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCache } from './cache.mjs';
import { createApp } from './server.mjs';
import { makeFarmer } from './testkit.mjs';

// A tiny in-memory stand-in for a Redis client.
function memoryClient() {
  const store = new Map();
  return {
    store, isReady: true,
    on() {},
    async connect() {},
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v, opts = {}) {
      if (opts.NX && store.has(k)) return null;
      store.set(k, v);
      return 'OK';
    },
    async incr(k) { const n = Number(store.get(k) || 0) + 1; store.set(k, String(n)); return n; },
    async quit() {}, async destroy() {},
  };
}

test('cache: wraps a read, serves the second call, and invalidates by version', async () => {
  const client = memoryClient();
  const cache = createCache({ clientFactory: () => client, namespace: 't1' });
  let calls = 0;
  const fn = async () => { calls += 1; return { value: calls }; };

  assert.deepEqual(await cache.wrap('market', 5, fn), { value: 1 });
  assert.deepEqual(await cache.wrap('market', 5, fn), { value: 1 }, 'second call comes from Redis');
  assert.equal(calls, 1);

  await cache.invalidate();
  assert.deepEqual(await cache.wrap('market', 5, fn), { value: 2 }, 'invalidation forces a refresh');
  assert.equal(calls, 2);

  const stored = [...client.store.entries()].filter(([k]) => k.endsWith(':market')).map(([, v]) => JSON.parse(v).value);
  assert.ok(stored.includes(2), 'the refreshed entry is stored under the new version key');
});

test('cache: namespaces do not collide, and TTL is applied', async () => {
  const client = memoryClient();
  const a = createCache({ clientFactory: () => client, namespace: 'a' });
  const b = createCache({ clientFactory: () => client, namespace: 'b' });
  await a.set('k', 'A', 30);
  await b.set('k', 'B', 30);
  assert.equal(await a.get('k'), 'A');
  assert.equal(await b.get('k'), 'B');
  assert.ok([...client.store.keys()].some((k) => k.includes('plotline:cache:a:')));
});

test('cache: a dead Redis never breaks the request path', async () => {
  const down = createCache({
    clientFactory: () => { throw new Error('ECONNREFUSED'); },
    namespace: 'down',
    log: () => {},
  });
  let called = 0;
  const value = await down.wrap('market', 5, async () => { called += 1; return { ok: true }; });
  assert.deepEqual(value, { ok: true });
  assert.equal(called, 1);
  assert.equal(await down.get('market'), null);
  assert.equal(await down.set('market', { ok: true }), false);
  assert.equal(await down.invalidate(), false);
  assert.equal(down.enabled, false);
  await down.close();
});

test('cache: command failures fall through instead of throwing', async () => {
  const broken = {
    isReady: true, on() {}, async connect() {},
    async get() { throw new Error('socket closed'); },
    async set() { throw new Error('socket closed'); },
    async incr() { throw new Error('socket closed'); },
    async quit() {},
  };
  const cache = createCache({ clientFactory: () => broken, namespace: 'broken' });
  assert.equal(await cache.get('x'), null);
  assert.equal(await cache.set('x', 1), false);
  assert.equal(await cache.invalidate(), false);
  assert.deepEqual(await cache.wrap('x', 5, async () => 42), 42);
});

test('cache: registry reads are cached and registry writes invalidate it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cacheapp-'));
  const spy = {
    wraps: [],
    async wrap(key, ttl, fn) { this.wraps.push(key); return fn(); },
    async invalidate() { this.invalidated = (this.invalidated ?? 0) + 1; },
  };
  const app = createApp({ dataDir: dir, adminToken: 'op', cache: spy });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  try {
    await call('/api/registry/market');
    await call('/api/registry/reconcile');
    assert.deepEqual(spy.wraps, ['market', 'reconcile']);

    assert.equal(spy.invalidated, undefined);
    const verifier = await makeFarmer();
    assert.equal((await call('/api/registry/verifiers', { method: 'POST', token: 'op', body: { id: 'ver-1', pub: verifier.pub } })).status, 201);
    assert.equal(spy.invalidated, 1, 'adding a verifier invalidates cached reads');

    assert.equal((await call('/api/registry/verifiers', { method: 'POST', token: 'op', body: { id: 'ver-1', pub: verifier.pub } })).status, 409);
    assert.equal(spy.invalidated, 1, 'a rejected write does not invalidate');
  } finally {
    app.server.closeAllConnections?.();
    await new Promise((r) => app.server.close(r));
  }
});
