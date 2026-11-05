import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger, verifyChain, entryHash, ZERO } from './ledger.mjs';
import { createApp } from './server.mjs';

const root = (n) => n.toString(16).padStart(64, '0');
const tmp = () => mkdtempSync(join(tmpdir(), 'plotline-'));

test('ledger entries chain together and verify', () => {
  const l = new Ledger(join(tmp(), 'l.jsonl'));
  const a = l.add(root(1), 5).entry;
  const b = l.add(root(2), 3).entry;
  assert.equal(a.prev, ZERO);
  assert.equal(b.prev, a.hash);
  assert.equal(b.seq, 2);
  assert.deepEqual(verifyChain(l.entries), { ok: true, length: 2, head: b.hash });
});

test('publishing the same root twice returns the original entry', () => {
  const l = new Ledger(join(tmp(), 'l.jsonl'));
  const first = l.add(root(1), 5);
  const again = l.add(root(1), 5);
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(again.entry.seq, 1);
  assert.equal(l.entries.length, 1);
});

test('altering, reordering or removing a past entry is detected', () => {
  const l = new Ledger(join(tmp(), 'l.jsonl'));
  for (let i = 1; i <= 4; i++) l.add(root(i), i);
  const copy = () => l.entries.map((e) => ({ ...e }));

  const edited = copy(); edited[1].count = 99;
  assert.equal(verifyChain(edited).ok, false);

  const rooted = copy(); rooted[1].root = root(77);
  assert.equal(verifyChain(rooted).ok, false);

  const removed = copy(); removed.splice(1, 1);
  assert.equal(verifyChain(removed).ok, false);

  const swapped = copy(); [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
  assert.equal(verifyChain(swapped).ok, false);

  // Rewriting an entry AND recomputing its own hash still breaks the next entry's link.
  const forged = copy(); forged[1].count = 99;
  forged[1].hash = entryHash(forged[1]);
  const v = verifyChain(forged);
  assert.equal(v.ok, false);
  assert.equal(v.at, 3);
});

test('ledger survives a restart and refuses a tampered file', () => {
  const dir = tmp();
  const file = join(dir, 'l.jsonl');
  const l = new Ledger(file);
  l.add(root(1), 2); l.add(root(2), 4);
  const reopened = new Ledger(file);
  assert.equal(reopened.head().seq, 2);
  assert.equal(reopened.find(root(2)).count, 4);

  const text = readFileSync(file, 'utf8').replace('"count":4', '"count":5');
  writeFileSync(file, text);
  assert.throws(() => new Ledger(file), /failed verification/);
});

async function withServer(fn) {
  const { server } = createApp({ dataDir: tmp() });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise((ok) => server.close(ok)); }
}
const post = (base, body, raw) =>
  fetch(base + '/api/anchor', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ?? JSON.stringify(body) });

test('API: publish, look up, and idempotent retry', async () => {
  await withServer(async (base) => {
    const r1 = await post(base, { root: root(1), count: 7 });
    assert.equal(r1.status, 201);
    const e1 = await r1.json();
    assert.equal(e1.seq, 1);

    const r2 = await post(base, { root: root(1), count: 7 });
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).hash, e1.hash);

    const got = await fetch(`${base}/api/anchor/${root(1)}`);
    assert.equal(got.status, 200);
    assert.equal((await got.json()).hash, e1.hash);

    assert.equal((await fetch(`${base}/api/anchor/${root(9)}`)).status, 404);
    const head = await (await fetch(`${base}/api/head`)).json();
    assert.equal(head.seq, 1);
    const full = await (await fetch(`${base}/api/ledger`)).json();
    assert.equal(verifyChain(full.entries).ok, true);
  });
});

test('API rejects malformed input', async () => {
  await withServer(async (base) => {
    assert.equal((await post(base, { root: 'abc', count: 1 })).status, 400);
    assert.equal((await post(base, { root: root(1).toUpperCase().replace(/0/g, 'A'), count: 1 })).status, 400);
    assert.equal((await post(base, { root: root(1), count: 0 })).status, 400);
    assert.equal((await post(base, { root: root(1), count: 1.5 })).status, 400);
    assert.equal((await post(base, null, 'not json')).status, 400);
    assert.equal((await post(base, null, 'x'.repeat(5000))).status, 413);
    assert.equal((await fetch(`${base}/api/anchor/zzz`)).status, 400);
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  });
});

test('API rate-limits bursts of writes', async () => {
  await withServer(async (base) => {
    let limited = 0;
    for (let i = 1; i <= 40; i++) if ((await post(base, { root: root(i), count: 1 })).status === 429) limited++;
    assert.ok(limited >= 5, `expected some 429s, got ${limited}`);
  });
});

test('static files: app is served, server code and data are not', async () => {
  await withServer(async (base) => {
    for (const p of ['/', '/index.html', '/app.js', '/core.js', '/sw.js', '/manifest.webmanifest', '/vendor/leaflet/leaflet.js']) {
      assert.equal((await fetch(base + p)).status, 200, p);
    }
    const idx = await fetch(base + '/');
    assert.match(idx.headers.get('content-type'), /text\/html/);
    for (const p of ['/server/ledger.mjs', '/server/server.mjs', '/data/ledger.jsonl', '/core.test.mjs', '/package.json', '/..%2fserver%2fserver.mjs', '/%2e%2e/%2e%2e/etc/passwd', '/nothing.html']) {
      assert.equal((await fetch(base + p)).status, 404, p);
    }
  });
});
