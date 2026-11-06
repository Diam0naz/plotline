// realtime.mjs — Neon Realtime wiring for the console's live registry feed.
//
// The SDK pattern from the Neon skill: the server defines one deterministic raw-SQL
// query (read-only, single SELECT, no now()/random()), seals it locally with
// NEON_REALTIME_SECRET so it becomes a short-lived, unforgeable capability, and hands
// ONLY the capability plus the public wss URL to the browser. The secret, the SQL and
// the database name never leave this process. The browser subscribes with
// @neon/realtime/client (vendored to vendor/neon-realtime-client.js for this no-build
// app) and renews by fetching a fresh seal before the capability's expiresAt.
//
// The example query streams the app_events table — the Postgres mirror of registry
// happenings (submissions, decisions, retirements) written by pgstore.logEvent().

import { createRealtime, rawSql } from '@neon/realtime/server';

// One deterministic, read-only live query. `created_at` arrives decoded as a Date;
// `id DESC LIMIT 20` keeps the feed small and makes renewal a same-query refresh
// (same parameters ⇒ same fingerprint, which is what renewal requires).
export const recentEventsSql = `SELECT id, kind, detail, created_at FROM app_events ORDER BY id DESC LIMIT 20`;

export const recentEventsQuery = () => rawSql(recentEventsSql);

export function createRealtimeServer({ secret, db = 'neondb' } = {}) {
  if (!secret) throw new Error('NEON_REALTIME_SECRET is not configured');
  const realtime = createRealtime({ secret, db });

  /** Seal the events feed for an (already-authorized) browser. Never cache this: */
  async function sealRecentEvents() {
    // The returned shape is the SDK's SealedLiveQuery (capability, queryFingerprint,
    // expiresAt) — the client takes it verbatim into subscribe()/renew().
    const sealed = await realtime.seal({ query: recentEventsQuery() });
    return {
      capability: sealed.capability,
      queryFingerprint: sealed.queryFingerprint,
      expiresAt: sealed.expiresAt,
    };
  }

  return {
    realtime,
    sealRecentEvents,
    /** Same query, sealed, for direct subscription from trusted server-side code. */
    async subscribeRecentEvents(onChange) {
      const sub = await realtime.subscribe(recentEventsQuery());
      sub.onChange(onChange);
      return sub;
    },
    close() {
      realtime.close();
    },
  };
}
