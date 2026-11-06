import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ndviEvidence, NDVI_DEFAULTS, NDVI_SOURCE } from './ndvi.mjs';
import { createApp } from './server.mjs';

const NOW = () => new Date('2026-11-15T12:00:00.000Z');

test('ndvi: the stub returns a clearly-labelled placeholder without any network call', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  const out = await ndviEvidence({ lat: 9.9, lon: 8.9, bufferKm: 0.5, fetchImpl, now: NOW });

  assert.equal(out.status, 'stub');
  assert.equal(out.source, NDVI_SOURCE);
  assert.equal(out.ndvi, null);
  assert.equal(out.ndviMin, null);
  assert.equal(out.ndviMax, null);
  assert.equal(out.checkedAt, '2026-11-15T12:00:00.000Z');
  assert.equal(out.bufferKm, 0.5);
  assert.match(out.message, /not yet implemented/i);
  assert.equal(called, false, 'no provider is called while the module is a stub');
});

test('ndvi: defaults are applied to the result', async () => {
  const out = await ndviEvidence({ lat: 0, lon: 0, now: NOW });
  assert.equal(out.bufferKm, NDVI_DEFAULTS.bufferKm);
  assert.equal(out.cloudMaxPct, NDVI_DEFAULTS.cloudMaxPct);
});

test('ndvi: bad arguments come back unavailable before any request', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  assert.equal((await ndviEvidence({ lat: 200, lon: 0, fetchImpl, now: NOW })).status, 'unavailable');
  const out = await ndviEvidence({ lat: 9.9, lon: 500, fetchImpl, now: NOW });
  assert.equal(out.status, 'unavailable');
  assert.equal(out.error, 'bad_arguments');
  assert.equal((await ndviEvidence({ fetchImpl, now: NOW })).status, 'unavailable');
  assert.equal(called, false);
});

test('ndvi API: operator token required, inputs validated, stub served', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ndviapi-'));
  const app = createApp({ dataDir: dir, adminToken: 'op', now: NOW });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = async (path, token) => {
    const res = await fetch(base + path, { headers: token ? { authorization: 'Bearer ' + token } : {} });
    return { status: res.status, json: await res.json() };
  };
  try {
    assert.equal((await get('/api/registry/ndvi?lat=9.9&lon=8.9')).status, 401);
    assert.equal((await get('/api/registry/ndvi?lat=9.9', 'op')).status, 400);
    assert.equal((await get('/api/registry/ndvi?lat=999&lon=8.9', 'op')).status, 400);
    assert.equal((await get('/api/registry/ndvi?lat=9.9&lon=8.9&bufferKm=50', 'op')).status, 400);

    const ok = await get('/api/registry/ndvi?lat=9.9&lon=8.9', 'op');
    assert.equal(ok.status, 200);
    assert.equal(ok.json.status, 'stub');
    assert.equal(ok.json.source, NDVI_SOURCE);
    assert.equal(ok.json.error, undefined, 'a stub result is not an error');
  } finally {
    app.server.closeAllConnections?.();
    await new Promise((r) => app.server.close(r));
  }
});
