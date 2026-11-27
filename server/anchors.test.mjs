import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnchorReceipts, verifyAnchors } from './anchors.mjs';
import { createApp } from './server.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'anchors-'));
const r = (seq, hash, over = {}) => ({ seq, hash, mode: 'live', ts: '2026-11-26T00:00:00.000Z', ...over });

test('AnchorReceipts: record, list, last, and reload from disk', () => {
  const file = join(tmp(), 'anchors.jsonl');
  const a = new AnchorReceipts(file);
  assert.equal(a.last(), null);
  a.record(r(1, 'aa', { mode: 'dry_run' }));
  a.record(r(2, 'bb', { signature: 'sig2', explorer: 'https://x/tx/sig2' }));
  assert.equal(a.entries.length, 2);
  assert.equal(a.last().seq, 2);
  assert.equal(a.lastLive().seq, 2);        // the live one, skipping the dry_run
  assert.equal(a.lastLive().signature, 'sig2');

  const reloaded = new AnchorReceipts(file); // persistence
  assert.equal(reloaded.entries.length, 2);
  assert.equal(reloaded.lastLive().hash, 'bb');
});

test('AnchorReceipts.lastLive returns null when every receipt is a dry run', () => {
  const a = new AnchorReceipts(join(tmp(), 'a.jsonl'));
  a.record(r(1, 'aa', { mode: 'dry_run' }));
  assert.equal(a.lastLive(), null);
  assert.equal(a.last().seq, 1);
});

test('verifyAnchors: intact when every anchored head is still present', () => {
  const entries = [{ seq: 1, hash: 'a' }, { seq: 2, hash: 'b' }, { seq: 3, hash: 'c' }];
  const out = verifyAnchors(entries, [r(1, 'a'), r(3, 'c')]);
  assert.equal(out.intact, true);
  assert.equal(out.checks.every((c) => c.present), true);
});

test('verifyAnchors: a rewritten head is caught (hash differs at that seq)', () => {
  const entries = [{ seq: 1, hash: 'a' }, { seq: 2, hash: 'REWRITTEN' }];
  const out = verifyAnchors(entries, [r(2, 'b')]);
  assert.equal(out.intact, false);
  assert.equal(out.checks[0].present, false);
  assert.equal(out.checks[0].currentHashAtSeq, 'REWRITTEN');
});

test('verifyAnchors: a rewound chain is caught (anchored seq no longer exists)', () => {
  const entries = [{ seq: 1, hash: 'a' }]; // chain truncated below the anchored head
  const out = verifyAnchors(entries, [r(2, 'b')]);
  assert.equal(out.intact, false);
  assert.equal(out.checks[0].present, false);
  assert.equal(out.checks[0].currentHashAtSeq, null);
});

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'anchorapi-'));
  const app = createApp({ dataDir: dir, adminToken: 'secret-token' });
  await new Promise((res) => app.server.listen(0, res));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  return { call, close: () => new Promise((res) => app.server.close(res)) };
}

const hex = (n) => n.toString(16).padStart(64, '0');

test('anchor flow over HTTP: publish records a receipt, verify proves it public', async () => {
  const a = await boot();
  try {
    await a.call('/api/anchor', { method: 'POST', body: { root: hex(1), count: 5 } });
    await a.call('/api/anchor', { method: 'POST', body: { root: hex(2), count: 3 } });

    // publish is operator-only
    assert.equal((await a.call('/api/anchor/publish', { method: 'POST' })).status, 401);

    const pub = await a.call('/api/anchor/publish', { method: 'POST', token: 'secret-token' });
    assert.equal(pub.status, 200);
    assert.equal(pub.json.mode, 'dry_run');   // no SOLANA_RPC_URL in tests
    assert.equal(pub.json.recorded, true);
    assert.equal(pub.json.head.seq, 2);

    // verify is public (no token) and reports an intact chain carrying the head
    const v = await a.call('/api/anchor/verify');
    assert.equal(v.status, 200);
    assert.equal(v.json.chain.ok, true);
    assert.equal(v.json.chain.length, 2);
    assert.equal(v.json.anchorsIntact, true);
    assert.equal(v.json.lastAnchored.seq, 2);
    assert.equal(v.json.lastLiveAnchored, null); // dry_run only
    assert.equal(v.json.anchors[0].present, true);
  } finally {
    await a.close();
  }
});

test('anchor publish on an empty ledger records nothing', async () => {
  const a = await boot();
  try {
    const pub = await a.call('/api/anchor/publish', { method: 'POST', token: 'secret-token' });
    assert.equal(pub.status, 200);
    assert.equal(pub.json.head.seq, 0);
    assert.equal(pub.json.recorded, false);

    const v = await a.call('/api/anchor/verify');
    assert.equal(v.json.anchorsIntact, true); // nothing anchored yet
    assert.equal(v.json.lastAnchored, null);
    assert.equal(v.json.anchors.length, 0);
  } finally {
    await a.close();
  }
});
