// pgstore.mjs — Neon Postgres backing store for console accounts, sessions and the
// live-events feed the console subscribes to over Neon Realtime.
//
// This app's source of truth stays the append-only JSONL ledger and registry files:
// Postgres only mirrors operator-side console state (accounts, session hashes) which
// would otherwise live in data/*.json, plus app_events (an auditable log of registry
// happenings whose last 20 rows are a live query). When DATABASE_URL is unset the
// app runs exactly as before on the local JSON stores.
//
// Driver per the Neon skill for long-running Node servers: node-postgres (`pg`)
// against the pooled DATABASE_URL, with a small pool and a bumped idle timeout so a
// scale-to-zero wake costs one connection, and pool errors are logged, never thrown.

import pg from 'pg';
import net from 'node:net';

// The pooler and compute endpoints resolve to several IPv4 + IPv6 addresses. On
// hosts where one family is unreachable (and where a cold Ep wake-up takes seconds),
// Node's default 250 ms per-family attempt timeout loses connections that would
// succeed within a few seconds. Raise the per-attempt budget; the pool's own
// connectionTimeoutMillis still bounds the total.
if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === 'function') {
  net.setDefaultAutoSelectFamilyAttemptTimeout(5_000);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  role          TEXT NOT NULL,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ,
  last_changed  TIMESTAMPTZ,
  disabled      TIMESTAMPTZ,
  PRIMARY KEY (role, username)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  role       TEXT NOT NULL,
  username   TEXT NOT NULL,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS app_events (
  id         BIGSERIAL PRIMARY KEY,
  kind       TEXT NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_events_recent ON app_events (id DESC);
`;

export class PgStore {
  constructor(pool) {
    this.pool = pool;
  }

  /** Connect, verify the wire works, and create the schema idempotently. */
  static async create(url) {
    const pool = new pg.Pool({
      connectionString: url,
      max: 5,
      idleTimeoutMillis: 45_000, // tolerate Neon scale-to-zero between quiet spells
      connectionTimeoutMillis: 30_000, // cold compute + TLS opener can take seconds
    });
    // So an idle-connection drop (the compute went to sleep) logs instead of crashing.
    pool.on('error', (e) => console.error(`Neon Postgres pool error: ${e.message}`));
    const store = new PgStore(pool);
    await store.query('SELECT 1');
    await store.query(SCHEMA);
    return store;
  }

  query(text, params = []) {
    return this.pool.query(text, params);
  }

  /** Cheap liveness probe for /api/neon/status. */
  async health() {
    const { rows } = await this.query('SELECT count(*)::int AS n FROM app_events');
    return rows[0].n;
  }

  // ---- console accounts (single-document mirroring; the datasets are small) ----

  async loadAccounts() {
    const { rows } = await this.query(
      `SELECT role, username, password_hash, created_at, last_changed, disabled FROM accounts`,
    );
    const out = { admins: {}, verifiers: {} };
    for (const r of rows) {
      const store = r.role === 'admin' ? out.admins : out.verifiers;
      store[r.username] = {
        hash: r.password_hash,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        lastChanged: r.last_changed ? new Date(r.last_changed).toISOString() : null,
        disabled: r.disabled ? new Date(r.disabled).toISOString() : null,
      };
    }
    return out;
  }

  async saveAccounts(data) {
    await this.query('BEGIN');
    try {
      await this.query('DELETE FROM accounts');
      const rows = [];
      for (const [username, a] of Object.entries(data.admins || {})) {
        rows.push({ role: 'admin', username, a });
      }
      for (const [username, v] of Object.entries(data.verifiers || {})) {
        rows.push({ role: 'verifier', username, a: v });
      }
      for (const r of rows) {
        await this.query(
          `INSERT INTO accounts (role, username, password_hash, created_at, last_changed, disabled)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [r.role, r.username, r.a.hash, r.a.createdAt ?? null, r.a.lastChanged ?? null, r.a.disabled ? new Date(r.a.disabled) : null],
        );
      }
      await this.query('COMMIT');
    } catch (e) {
      await this.query('ROLLBACK').catch(() => {});
      throw e;
    }
  }

  // ---- sessions keyed by sha256(token); only hashes are ever transported ----

  async loadSessions() {
    const { rows } = await this.query(
      `SELECT token_hash, data, created_at, expires_at FROM sessions WHERE expires_at > now()`,
    );
    return rows.map((r) => [
      r.token_hash,
      {
        ...r.data,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : r.data.createdAt,
        expiresAt: new Date(r.expires_at).toISOString(),
      },
    ]);
  }

  async saveSessions(list) {
    await this.query('BEGIN');
    try {
      await this.query('DELETE FROM sessions');
      for (const [tokenHash, s] of list) {
        await this.query(
          `INSERT INTO sessions (token_hash, role, username, data, created_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [tokenHash, s.role, s.username, JSON.stringify(s), s.createdAt ? new Date(s.createdAt) : null, new Date(s.expiresAt)],
        );
      }
      await this.query('COMMIT');
    } catch (e) {
      await this.query('ROLLBACK').catch(() => {});
      throw e;
    }
  }

  // ---- app_events: what the console's realtime feed streams ----

  async logEvent(kind, detail = {}) {
    const { rows } = await this.query(
      `INSERT INTO app_events (kind, detail) VALUES ($1, $2) RETURNING id`,
      [String(kind), JSON.stringify(detail)],
    );
    return rows[0].id;
  }

  async events(limit = 20) {
    const { rows } = await this.query(
      `SELECT id, kind, detail, created_at FROM app_events ORDER BY id DESC LIMIT $1`,
      [Math.min(100, Math.max(1, limit | 0))],
    );
    return rows;
  }

  async close() {
    await this.pool.end();
  }
}
