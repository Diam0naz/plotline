import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './server.mjs';
import { makeFarmer, makeSubmission, signDecision, square } from './testkit.mjs';

async function boot(dir = mkdtempSync(join(tmpdir(), 'carbon-'))) {
  const app = createApp({ dataDir: dir, adminToken: 'op' });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  const close = async () => {
    app.server.closeAllConnections?.();
    await new Promise((r) => app.server.close(r));
  };
  return { dir, call, close };
}

async function addVerifier(call) {
  const verifier = await makeFarmer();
  const r = await call('/api/registry/verifiers', { method: 'POST', token: 'op', body: { id: 'ver-1', pub: verifier.pub } });
  assert.equal(r.status, 201);
  return verifier;
}

async function submitAndApprove(call, verifier, opts = {}) {
  const farmer = await makeFarmer();
  const sub = await makeSubmission(farmer, { polygon: square(9.9, 8.9, 100), ...opts });
  const s = await call('/api/submit', { method: 'POST', body: { ...sub, ...(opts.methodologyId ? { methodologyId: opts.methodologyId } : {}) } });
  assert.equal(s.status, 201, JSON.stringify(s.json));
  assert.equal(s.json.status, 'pending', JSON.stringify(s.json.checks));
  const decision = await signDecision(verifier, { subId: s.json.subId, decision: 'approve', note: 'Checked the plot' });
  const d = await call('/api/registry/decide', { method: 'POST', body: decision });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  assert.equal(d.json.status, 'approved');
  return { farmer, subId: s.json.subId, issuance: d.json.issuance };
}

test('methodology: each submission records its version and baseline', async () => {
  const a = await boot();
  try {
    const verifier = await addVerifier(a.call);

    const old = await submitAndApprove(a.call, verifier, { methodologyId: 'DEMO-AGROFORESTRY-0' });
    assert.equal(old.issuance.methodology, 'DEMO-AGROFORESTRY-0');
    assert.equal(old.issuance.methodologyVersion, 1);
    assert.equal(old.issuance.baselineId, 'baseline:none');
    assert.equal(old.issuance.bufferUnits, 0, 'v1 has no buffer');

    // A second plot, far enough away not to trip overlap detection.
    const current = await submitAndApprove(a.call, verifier, { polygon: square(9.93, 8.93, 100), msisdn: '08039999999' });
    assert.equal(current.issuance.methodology, 'DEMO-AGROFORESTRY-1');
    assert.equal(current.issuance.methodologyVersion, 2);
    assert.equal(current.issuance.baselineId, 'baseline:ng-agroforestry-demo-2026');
    assert.equal(current.issuance.kgCO2e, current.issuance.units * 18, 'v2 uses its own factor');

    const market = await a.call('/api/registry/market');
    assert.equal(market.json.methodologyVersion, 2);
    assert.equal(market.json.baselineId, 'baseline:ng-agroforestry-demo-2026');
    assert.equal(market.json.methodologies.length, 2);
    assert.ok(market.json.methodologies.some((m) => m.id === 'DEMO-AGROFORESTRY-0' && m.current === false));

    const slots = await a.call('/api/registry/submissions', { token: 'op' });
    assert.equal(slots.json.submissions.find((s) => s.subId === current.subId).methodology, 'DEMO-AGROFORESTRY-1');

    // An unknown version cannot be used to pick different thresholds.
    const farmer = await makeFarmer();
    const bad = await makeSubmission(farmer, { polygon: square(9.95, 8.95, 120) });
    const refused = await a.call('/api/submit', { method: 'POST', body: { ...bad, methodologyId: 'MADE-UP-9' } });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.error, 'unknown_methodology');
  } finally { await a.close(); }
});

test('buffer and reversal: unsold serials are cancelled and the books still balance', async () => {
  const a = await boot();
  let aClosed = false;
  let b = null;
  try {
    const verifier = await addVerifier(a.call);
    const { issuance } = await submitAndApprove(a.call, verifier);

    assert.equal(issuance.units, 340);
    assert.equal(issuance.bufferUnits, 34);
    assert.equal((await a.call('/api/registry/market')).json.available, 306);

    const reversed = await a.call('/api/registry/reverse', {
      method: 'POST', token: 'op', body: { issuanceId: issuance.id, units: 20, reason: 'Fire crossed the eastern boundary' },
    });
    assert.equal(reversed.status, 201, JSON.stringify(reversed.json));
    assert.equal(reversed.json.cancellation.units, 20);
    assert.match(reversed.json.cancellation.serialFrom, /^PL-NG-\d{8}$/);

    const after = await a.call('/api/registry/market');
    assert.equal(after.json.available, 286);
    const rec = (await a.call('/api/registry/reconcile')).json;
    assert.equal(rec.unitsReversed, 20);
    assert.equal(rec.unitsBuffered, 34);
    assert.equal(rec.unitsBalanced, true);

    assert.equal((await a.call('/api/registry/reverse', { method: 'POST', token: 'op', body: { issuanceId: issuance.id, units: 999, reason: 'Too many units' } })).json.error, 'insufficient_unsold');
    assert.equal((await a.call('/api/registry/reverse', { method: 'POST', token: 'op', body: { issuanceId: issuance.id, units: 1, reason: 'x' } })).json.error, 'bad_reason');
    assert.equal((await a.call('/api/registry/reverse', { method: 'POST', token: 'op', body: { issuanceId: 'ISS-9999', units: 1, reason: 'Unknown issuance' } })).json.error, 'unknown_issuance');

    // Replay the log in a fresh process view: buffer and cancellation survive a restart.
    const dir = a.dir;
    await a.close();
    aClosed = true;
    b = await boot(dir);
    const m2 = await b.call('/api/registry/market');
    assert.equal(m2.json.available, 286);
    assert.equal(m2.json.lots[0].bufferUnits, 34);
    assert.equal((await b.call('/api/registry/reconcile')).json.unitsReversed, 20);
  } finally {
    if (!aClosed) await a.close().catch(() => {});
    if (b) await b.close().catch(() => {});
  }
});

test('Article 6: authorisation is recorded, signed into the certificate, and blocks double claims', async () => {
  const a = await boot();
  try {
    const verifier = await addVerifier(a.call);
    const { issuance } = await submitAndApprove(a.call, verifier);

    const noAdjustment = await a.call('/api/registry/authorize', {
      method: 'POST', token: 'op',
      body: { issuanceId: issuance.id, scope: 'international', authority: 'NCCC', reference: 'NG-A6-0001' },
    });
    assert.equal(noAdjustment.json.error, 'adjustment_required');

    const domestic = await a.call('/api/registry/authorize', {
      method: 'POST', token: 'op',
      body: { issuanceId: issuance.id, scope: 'domestic', authority: 'NCCC', reference: 'NG-DOM-0001' },
    });
    assert.equal(domestic.status, 201, JSON.stringify(domestic.json));
    assert.equal(domestic.json.authorization.scope, 'domestic');

    const international = await a.call('/api/registry/authorize', {
      method: 'POST', token: 'op',
      body: { issuanceId: issuance.id, scope: 'international', authority: 'NCCC', reference: 'NG-A6-0001', correspondingAdjustment: true },
    });
    assert.equal(international.status, 201, JSON.stringify(international.json));
    assert.equal(international.json.authorization.correspondingAdjustment, true);

    const lot = (await a.call('/api/registry/market')).json.lots.find((l) => l.id === issuance.id);
    assert.equal(lot.authorization.scope, 'international');
    assert.equal(lot.authorization.reference, 'NG-A6-0001');

    assert.equal((await a.call('/api/registry/authorize', {
      method: 'POST', token: 'op',
      body: { issuanceId: issuance.id, scope: 'international', authority: 'NCCC', reference: 'NG-A6-0002', correspondingAdjustment: true },
    })).json.error, 'already_authorized');

    const order = await a.call('/api/registry/order', { method: 'POST', token: 'op', body: { buyer: 'Acme Ltd', units: 10, key: 'k-a6' } });
    assert.equal(order.status, 201);
    const retired = await a.call('/api/registry/retire', { method: 'POST', token: 'op', body: { orderId: order.json.order.orderId, beneficiary: 'Acme Ltd' } });
    assert.equal(retired.status, 201);

    const cert = (await a.call('/api/registry/certificate/' + order.json.order.orderId)).json;
    assert.equal(cert.article6.correspondingAdjustment, true);
    assert.equal(cert.article6.international, true);
    assert.deepEqual(cert.article6.authorities, ['NCCC']);
    assert.equal(cert.lots[0].authorization.scope, 'international');
    assert.equal(cert.methodology, 'DEMO-AGROFORESTRY-1');
    assert.equal(cert.baselineId, 'baseline:ng-agroforestry-demo-2026');
  } finally { await a.close(); }
});

test('Article 6: a plot already retired domestically cannot be transferred abroad', async () => {
  const a = await boot();
  try {
    const verifier = await addVerifier(a.call);
    const { issuance } = await submitAndApprove(a.call, verifier);

    const order = await a.call('/api/registry/order', { method: 'POST', token: 'op', body: { buyer: 'Local buyer', units: 5, key: 'k-local' } });
    assert.equal(order.status, 201);
    assert.equal((await a.call('/api/registry/retire', { method: 'POST', token: 'op', body: { orderId: order.json.order.orderId, beneficiary: 'Local buyer' } })).status, 201);

    const denied = await a.call('/api/registry/authorize', {
      method: 'POST', token: 'op',
      body: { issuanceId: issuance.id, scope: 'international', authority: 'NCCC', reference: 'NG-A6-0003', correspondingAdjustment: true },
    });
    assert.equal(denied.json.error, 'already_claimed');
  } finally { await a.close(); }
});
