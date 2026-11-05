// Redis read-through cache for the expensive read-only registry views.
// Caching is an optimisation, never a requirement: if Redis is missing, slow or dies mid-request,
// every call falls through to the real source and the app keeps working.
import { createClient } from 'redis';

export function createCache({
  url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  namespace = 'plotline',
  ttlSeconds = Number(process.env.CACHE_TTL_SECONDS) || 5,
  clientFactory = createClient,
  log = () => {},
} = {}) {
  const prefix = `plotline:cache:${namespace}:`;
  let client = null;
  let connecting = null;
  let disabled = !url || url === 'off';
  let warned = false;

  async function connection() {
    if (disabled) return null;
    if (client?.isReady) return client;
    if (connecting) return connecting;
    connecting = (async () => {
      let c;
      try {
        c = clientFactory({ url, socket: { connectTimeout: 400, reconnectStrategy: false } });
        c.on?.('error', () => {});
        await c.connect();
        client = c;
        return c;
      } catch {
        disabled = true;
        if (!warned) { warned = true; log('Redis unavailable: serving without cache'); }
        try { await c?.destroy?.(); } catch { /* already gone */ }
        return null;
      } finally {
        connecting = null;
      }
    })();
    return connecting;
  }

  // A version key makes invalidation O(1): bumping it orphans every old entry.
  async function version(c) {
    const key = prefix + 'ver';
    const current = await c.get(key);
    if (current) return current;
    await c.set(key, '1', { NX: true });
    return (await c.get(key)) ?? '1';
  }

  async function get(name) {
    const c = await connection();
    if (!c) return null;
    try {
      const raw = await c.get(prefix + (await version(c)) + ':' + name);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  async function set(name, value, ttl = ttlSeconds) {
    const c = await connection();
    if (!c) return false;
    try {
      await c.set(prefix + (await version(c)) + ':' + name, JSON.stringify(value), { EX: Math.max(1, Math.round(ttl)) });
      return true;
    } catch {
      return false;
    }
  }

  async function wrap(name, ttl, fn) {
    const hit = await get(name);
    if (hit !== null) return hit;
    const value = await fn();
    await set(name, value, ttl);
    return value;
  }

  async function invalidate() {
    const c = await connection();
    if (!c) return false;
    try { await c.incr(prefix + 'ver'); return true; } catch { return false; }
  }

  async function close() {
    const c = client;
    client = null;
    if (!c) return;
    try { await c.quit(); } catch { try { await c.destroy(); } catch { /* already gone */ } }
  }

  return { get, set, wrap, invalidate, close, get enabled() { return !disabled; } };
}
