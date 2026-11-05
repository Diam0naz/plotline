import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanFireEvidence, fireConcern, recentFires, FIRE_SOURCE } from './fire.mjs';
import { createApp } from './server.mjs';
import { makeFarmer, makeSubmission, signDecision, square } from './testkit.mjs';

const NOW = () => new Date('2026-11-15T12:00:00.000Z');

test('fire: queries VIIRS for the right point, radius and window, and summarises detections', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(new URL(url));
    return {
      ok: true,
      json: async () => ({
        features: [
          { attributes: { latitude: 0, longitude: 0.009, acq_date: Date.parse('2026-11-14T00:00:00Z'), confidence: 'high', bright_ti4: 360.2, satellite: 'N20' } },
          { attributes: { latitude: 0, longitude: 0.045, acq_date: Date.parse('2026-11-10T00:00:00Z'), confidence: 'nominal', bright_ti4: 330.7, satellite: 'N20' } },
        ],
      }),
    };
  };
  const out = await recentFires({ lat: 0, lon: 0, radiusKm: 5, days: 14, fetchImpl, now: NOW });

  assert.equal(out.status, 'ok');
  assert.equal(out.count, 2);
  assert.equal(out.source, FIRE_SOURCE);
  assert.equal(out.nearestKm, 1, 'nearest detection is ~1 km away');
  assert.equal(out.latestAcq, '2026-11-14');
  assert.equal(out.maxBrightness, 360.2);
  assert.equal(out.confidence.high, 1);
  assert.equal(out.confidence.nominal, 1);

  const q = seen[0].searchParams;
  assert.equal(q.get('geometry'), '0,0');
  assert.equal(q.get('distance'), '5');
  assert.equal(q.get('units'), 'esriSRUnit_Kilometer');
  assert.equal(q.get('where'), "acq_date >= DATE '2026-11-01'");
  assert.match(q.get('outFields'), /acq_date/);
  assert.equal(q.get('f'), 'json');
});

test('fire: a failing service returns unavailable instead of throwing', async () => {
  const boom = async () => { throw new Error('no network'); };
  const out = await recentFires({ lat: 9.9, lon: 8.9, fetchImpl: boom, now: NOW });
  assert.equal(out.status, 'unavailable');
  assert.equal(out.error, 'network');

  const http = async () => ({ ok: false, status: 503, json: async () => ({}) });
  assert.equal((await recentFires({ lat: 9.9, lon: 8.9, fetchImpl: http, now: NOW })).error, 'http_503');

  const svc = async () => ({ ok: true, json: async () => ({ error: { message: 'Invalid where clause' } }) });
  assert.equal((await recentFires({ lat: 9.9, lon: 8.9, fetchImpl: svc, now: NOW })).error, 'Invalid where clause');
});

test('fire: bad arguments are refused before any request', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  const out = await recentFires({ lat: 200, lon: 8.9, fetchImpl, now: NOW });
  assert.equal(out.status, 'unavailable');
  assert.equal(out.error, 'bad_arguments');
  assert.equal(called, false);
});

test('fire: evidence is normalised, bounded and idempotent', () => {
  const raw = await_clean();
  assert.equal(raw.radiusKm, 5);
  assert.equal(raw.days, 30);
  assert.equal(raw.count, 3);
  assert.equal(raw.nearestKm, 1.2);
  assert.deepEqual(cleanFireEvidence(raw), raw, 'cleaning twice changes nothing');

  assert.equal(cleanFireEvidence(null), null);
  assert.equal(cleanFireEvidence({ status: 'whatever' }), null);
  assert.equal(cleanFireEvidence([1, 2]), null);
  const junk = cleanFireEvidence({ status: 'ok', count: -5, nearestKm: 1e9, radiusKm: 999, days: 0, checkedAt: 'not-a-date', confidence: { high: 'x' } });
  assert.equal(junk.count, 0);
  assert.equal(junk.nearestKm, null);
  assert.equal(junk.radiusKm, 5);
  assert.equal(junk.days, 14);
  assert.equal(junk.checkedAt, null);
  assert.equal(junk.confidence.high, 0);
});

function await_clean() {
  return cleanFireEvidence({
    status: 'ok', source: FIRE_SOURCE, radiusKm: 5, days: 30, checkedAt: '2026-11-15T12:00:00.000Z',
    count: 3, nearestKm: 1.2, latestAcq: '2026-11-14', maxBrightness: 361, confidence: { high: 1, nominal: 2, low: 0, other: 0 },
    error: null,
  });
}

test('fire: concern only when detections are close and recent', () => {
  const base = { status: 'ok', count: 2, nearestKm: 0.6, radiusKm: 5, days: 30 };
  assert.equal(fireConcern(base), true);
  assert.equal(fireConcern({ ...base, count: 0 }), false);
  assert.equal(fireConcern({ ...base, status: 'unavailable' }), false);
  assert.equal(fireConcern({ ...base, nearestKm: null }), false);
  assert.equal(fireConcern({ ...base, days: 60 }), false);
});

test('fire API: token required, coordinates validated, evidence normalised', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fireapi-'));
  let asked = null;
  const app = createApp({
    dataDir: dir,
    adminToken: 'op',
    now: NOW,
    fireCheck: async (args) => { asked = args; return { status: 'ok', count: 1, nearestKm: 2, radiusKm: args.radiusKm, days: args.days, checkedAt: NOW().toISOString(), capped: false }; },
  });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = async (path, token) => {
    const res = await fetch(base + path, { headers: token ? { authorization: 'Bearer ' + token } : {} });
    return { status: res.status, json: await res.json() };
  };
  try {
    assert.equal((await get('/api/registry/fires?lat=9.9&lon=8.9')).status, 401);
    assert.equal((await get('/api/registry/fires?lat=9.9', 'op')).status, 400);
    assert.equal((await get('/api/registry/fires?lat=999&lon=8.9', 'op')).status, 400);
    assert.equal((await get('/api/registry/fires?lat=9.9&lon=8.9&radiusKm=500', 'op')).status, 400);

    const ok = await get('/api/registry/fires?lat=9.9&lon=8.9&radiusKm=5&days=30', 'op');
    assert.equal(ok.status, 200);
    assert.equal(ok.json.count, 1);
    assert.equal(ok.json.capped, undefined, 'internal fields are not exposed');
    assert.deepEqual(cleanFireEvidence(ok.json), ok.json, 'the client can sign exactly what it received');
    assert.deepEqual(asked, { lat: 9.9, lon: 8.9, radiusKm: 5, days: 30, now: NOW });
  } finally {
    app.server.closeAllConnections?.();
    await new Promise((r) => app.server.close(r));
  }
});

test('fire: a verifier signs the evidence into the decision and the registry keeps it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'firedecide-'));
  const app = createApp({ dataDir: dir, adminToken: 'op', now: NOW });
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
  try {
    const verifier = await makeFarmer();
    assert.equal((await call('/api/registry/verifiers', { method: 'POST', token: 'op', body: { id: 'ver-1', pub: verifier.pub } })).status, 201);

    const farmer = await makeFarmer();
    const sub = await makeSubmission(farmer, { polygon: square(9.9, 8.9, 100) });
    const submitted = await call('/api/submit', { method: 'POST', body: sub });
    assert.equal(submitted.status, 201);

    const evidence = cleanFireEvidence({
      status: 'ok', source: FIRE_SOURCE, radiusKm: 5, days: 30, checkedAt: NOW().toISOString(),
      count: 2, nearestKm: 0.8, latestAcq: '2026-11-14', maxBrightness: 359.4,
      confidence: { high: 1, nominal: 1, low: 0, other: 0 }, error: null,
    });
    const decision = await signDecision(verifier, { subId: submitted.json.subId, decision: 'approve', note: 'Checked the plot', fire: evidence });
    const decided = await call('/api/registry/decide', { method: 'POST', body: decision });
    assert.equal(decided.status, 200, JSON.stringify(decided.json));
    assert.equal(decided.json.status, 'approved');

    const queue = await call('/api/registry/submissions', { token: 'op' });
    const stored = queue.json.submissions.find((s) => s.subId === submitted.json.subId);
    assert.deepEqual(stored.decision.fire, evidence, 'the signed evidence is unchanged');

    // Tampering with the evidence after signing breaks the signature.
    const forged = { ...decision, fire: { ...evidence, count: 0 } };
    const back = await call('/api/registry/decide', { method: 'POST', body: forged });
    assert.equal(back.status, 400);
  } finally {
    app.server.closeAllConnections?.();
    await new Promise((r) => app.server.close(r));
  }
});
