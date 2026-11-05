import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './server.mjs';
import { makeFarmer, makeSubmission, signDecision, square } from './testkit.mjs';

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'regapi-'));
  const app = createApp({ dataDir: dir, adminToken: 'secret-token' });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  return { ...app, dir, call, close: () => new Promise((r) => app.server.close(r)) };
}

test('registry API: whole flow over HTTP, with operator-only routes protected', async () => {
  const a = await boot();
  try {
    const verifier = await makeFarmer();
    assert.equal((await a.call('/api/registry/verifiers', { method: 'POST', body: { id: 'ver-1', pub: verifier.pub } })).status, 401);
    const added = await a.call('/api/registry/verifiers', { method: 'POST', token: 'secret-token', body: { id: 'ver-1', pub: verifier.pub } });
    assert.equal(added.status, 201);
    assert.equal((await a.call('/api/registry/verifiers', { method: 'POST', token: 'secret-token', body: { id: 'ver-1', pub: verifier.pub } })).status, 409);

    const farmer = await makeFarmer();
    const sub = await makeSubmission(farmer, { polygon: square(9.9, 8.9, 100), msisdn: '08031234567' });
    const s = await a.call('/api/submit', { method: 'POST', body: sub });
    assert.equal(s.status, 201);
    assert.equal(s.json.status, 'pending');

    assert.equal((await a.call('/api/registry/submissions')).status, 401);
    const q = await a.call('/api/registry/submissions', { token: 'secret-token' });
    assert.equal(q.json.submissions.length, 1);
    assert.equal(q.json.submissions[0].payoutTo, '+234803•••••67');

    const d = await a.call('/api/registry/decide', { method: 'POST', body: await signDecision(verifier, { subId: s.json.subId, decision: 'approve' }) });
    assert.equal(d.status, 200);
    assert.equal(d.json.status, 'approved');

    assert.equal((await a.call('/api/registry/order', { method: 'POST', body: { buyer: 'Acme', units: 10 } })).status, 401);
    const o = await a.call('/api/registry/order', { method: 'POST', token: 'secret-token', body: { buyer: 'Acme', units: 10, key: 'x1' } });
    assert.equal(o.status, 201);
    assert.equal((await a.call('/api/registry/order', { method: 'POST', token: 'secret-token', body: { buyer: 'Acme', units: 9999 } })).status, 400);

    const r = await a.call('/api/registry/reconcile');
    assert.equal(r.json.balanced, true);
    const fv = await a.call(`/api/registry/farmer/${farmer.fp}`);
    assert.equal(fv.json.paidKobo, o.json.order.split.farmers);

    const ret = await a.call('/api/registry/retire', { method: 'POST', token: 'secret-token', body: { orderId: o.json.order.orderId, beneficiary: 'Acme' } });
    assert.equal(ret.status, 201);
    assert.equal((await a.call(`/api/registry/certificate/${o.json.order.orderId}`)).status, 200);

    const log = await a.call('/api/registry/log');
    assert.equal(log.json.check.ok, true);
    const text = JSON.stringify(log.json) + readFileSync(join(a.dir, 'registry.jsonl'), 'utf8');
    assert.ok(!text.includes('08031234567') && !text.includes('2348031234567'), 'phone number leaked into the public log');
  } finally { await a.close(); }
});

test('registry API: bad input and oversized bodies are refused', async () => {
  const a = await boot();
  try {
    assert.equal((await a.call('/api/submit', { method: 'POST', body: { records: [] } })).status, 400);
    const big = await fetch(a.server.address() && `http://127.0.0.1:${a.server.address().port}/api/submit`, { method: 'POST', body: 'x'.repeat(70000) }).then((r) => r.status).catch(() => 413);
    assert.equal(big, 413);
    assert.equal((await a.call('/api/registry/farmer/not-a-key')).status, 400);
    assert.equal((await a.call('/api/registry/certificate/ORD-0001')).status, 404);
    assert.equal((await a.call('/api/registry/nope', { token: 'secret-token' })).status, 404);
    assert.equal((await a.call('/api/registry/decide', { method: 'POST', body: { subId: 'x' } })).status, 400);
  } finally { await a.close(); }
});

test('registry API: submissions are rate limited', async () => {
  const a = await boot();
  try {
    let last;
    for (let i = 0; i < 12; i++) last = await a.call('/api/submit', { method: 'POST', body: { records: [] } });
    assert.equal(last.status, 429);
  } finally { await a.close(); }
});

test('registry data files are never served as static files', async () => {
  const a = await boot();
  try {
    const base = `http://127.0.0.1:${a.server.address().port}`;
    for (const p of ['/data/private.json', '/data/registry.jsonl', '/server/registry.mjs']) {
      assert.equal((await fetch(base + p)).status, 404, p);
    }
  } finally { await a.close(); }
});
