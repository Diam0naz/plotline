import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ndviEvidence, NDVI_DEFAULTS, NDVI_SOURCE, bboxFor, parseNdviStats, statsRequest, ndviConfigured, ndviEndpoints, credsFor } from './ndvi.mjs';
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

// ---------- Sentinel Hub provider (injected fetch, no real network) ----------

const SH_ENV_BEARER = { SENTINELHUB_TOKEN: 'sh-bearer' };
const SH_ENV_OAUTH = { SENTINELHUB_CLIENT_ID: 'sh-id', SENTINELHUB_CLIENT_SECRET: 'sh-secret' };

const SH_BUCKETS = {
  data: {
    C0: {
      interval: { from: '2026-08-15T00:00:00Z', to: '2026-09-15T00:00:00Z' },
      basic: { ndvi: { mean: 0.50, min: 0.20, max: 0.80, stDev: 0.10 } },
      totalCount: 1000, noDataCount: 100,
    },
    C1: {
      interval: { from: '2026-09-15T00:00:00Z', to: '2026-11-15T00:00:00Z' },
      basic: { ndvi: { mean: 0.60, min: 0.30, max: 0.90, stDev: 0.05 } },
      totalCount: 900, noDataCount: 900,
    },
    C2: {
      interval: { from: '2026-11-15T00:00:00Z', to: '2026-11-15T12:00:00Z' },
      basic: { ndvi: { mean: 0.70, min: 0.5, max: 0.85, stDev: 0.08 } },
      totalCount: 500, noDataCount: 500,
    },
  },
};

const SH_BODY = (verdicts) => ({
  ok: verdicts,
  status: verdicts ? 200 : undefined,
  json: async () => SH_BUCKETS,
});
const ok = () => SH_BODY(true);

test('ndvi: unconfigured deployments still get the honest stub, even with a fetchImpl', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return ok(); };
  const out = await ndviEvidence({ lat: 9.9, lon: 8.9, env: {}, fetchImpl });
  assert.equal(out.status, 'stub');
  assert.equal(out.source, NDVI_SOURCE);
  assert.equal(called, false);
  assert.equal(ndviConfigured({}), false);
  assert.equal(ndviConfigured(SH_ENV_BEARER), true);
  assert.equal(ndviConfigured({ SENTINELHUB_CLIENT_ID: 'only-id' }), false);
});

test('ndvi: a bearer token runs one statistical request with sensible defaults', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return ok();
  };
  const out = await ndviEvidence({ lat: 9.9, lon: 8.9, bufferKm: 2, cloudMaxPct: 20, env: SH_ENV_BEARER, fetchImpl, now: NOW });

  assert.equal(calls.length, 1, 'a bearer skips the token step');
  assert.match(calls[0].url, /\/api\/v1\/statistical$/);
  assert.match(calls[0].url, /^https:\/\/services\.sentinel-hub\.com/);
  assert.equal(calls[0].opts.headers.authorization, 'Bearer sh-bearer');

  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.input.data[0].type, 'sentinel-2-l2a');
  assert.equal(body.input.data[0].dataFilter.maxCloudCoverage, 20);
  assert.equal(body.aggregation.aggregationInterval.of, 'P1M');
  // Buffer around (9.9, 8.9): ±2 km ≈ ±0.018°
  const [x1, y1, x2, y2] = body.input.bounds.bbox;
  assert.equal(x1.toFixed(3), '8.882');
  assert.equal(x2.toFixed(3), '8.918');
  assert.equal(y1.toFixed(3), '9.882');
  assert.equal(y2.toFixed(3), '9.918');
  assert.equal(body.input.bounds.properties.crs.includes('4326'), true);
  // Defaults: the 90 days ending at the check time
  assert.equal(out.dateFrom, '2026-08-17T12:00:00.000Z');
  assert.equal(out.dateTo, '2026-11-15T12:00:00.000Z');

  assert.equal(out.status, 'ok');
  assert.equal(out.source, 'sentinel-hub statistical api');
  assert.equal(out.pixelCount, 900, 'only C0 has valid pixels');
  // Weighted mean = C0's mean (it holds every valid pixel)
  assert.equal(out.ndvi, 0.5);
  assert.equal(out.ndviMin, 0.2);
  assert.equal(out.ndviMax, 0.8);
  assert.deepEqual(out.periods, [{ from: '2026-08-15T00:00:00Z', to: '2026-09-15T00:00:00Z', ndvi: 0.5, pixels: 900 }]);
});

test('ndvi: the OAuth client-credentials flow signs up front and reuses the token', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes('openid-connect')) {
      return { ok: true, json: async () => ({ access_token: 'tok-1', expires_in: 900 }) };
    }
    return ok();
  };
  await ndviEvidence({ lat: 9, lon: 9, env: SH_ENV_OAUTH, fetchImpl, now: NOW });
  await ndviEvidence({ lat: 9, lon: 9, env: SH_ENV_OAUTH, fetchImpl, now: NOW });

  assert.equal(calls.filter((c) => c.url.includes('openid-connect')).length, 1, 'the token is reused while fresh');
  const tokenCall = calls.find((c) => c.url.includes('openid-connect'));
  assert.match(tokenCall.opts.body, /grant_type=client_credentials/);
  assert.match(tokenCall.opts.body, /client_id=sh-id/);
  const statsCall = calls.find((c) => c.url.includes('/api/v1/statistical'));
  assert.equal(statsCall.opts.headers.authorization, 'Bearer tok-1');
});

test('ndvi: explicit dates are honoured and passed through to the provider', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => { calls.push({ url: String(url), body: opts.body }); return ok(); };
  const out = await ndviEvidence({
    lat: 9, lon: 9, dateFrom: '2026-01-01', dateTo: '2026-03-01',
    env: SH_ENV_BEARER, fetchImpl, now: NOW,
  });
  assert.equal(out.dateFrom, '2026-01-01T00:00:00.000Z');
  assert.equal(out.dateTo, '2026-03-01T00:00:00.000Z');
  const body = JSON.parse(calls[0].body);
  assert.equal(body.aggregation.timeRange.from, '2026-01-01T00:00:00.000Z');
});

test('ndvi: provider failures are reported honestly, with the reason', async () => {
  const fail = (status) => async (url, opts = {}) => {
    if (String(url).includes('openid-connect')) return { ok: true, json: async () => ({ access_token: 't', expires_in: 900 }) };
    return ({ ok: false, status, json: async () => ({}) });
  };
  for (const [status, code] of [[400, 'bad_request'], [401, 'auth_failed'], [500, 'provider_error']]) {
    const out = await ndviEvidence({ lat: 9, lon: 9, env: SH_ENV_BEARER, fetchImpl: fail(status), now: NOW });
    assert.equal(out.status, 'unavailable');
    assert.equal(out.error, code, `HTTP ${status} maps to ${code}`);
  }
  // A distinct client_id: the token cache from the OAuth test above is keyed by
  // `${base}|${client_id}`, so reusing 'sh-id' would silently skip the auth call.
  const authFail = async (url) => (String(url).includes('openid-connect')
    ? ({ ok: false, json: async () => ({}) })
    : ok());
  const out = await ndviEvidence({ lat: 9, lon: 9, env: { SENTINELHUB_CLIENT_ID: 'sh-id-unreachable', SENTINELHUB_CLIENT_SECRET: 'x' }, fetchImpl: authFail, now: NOW });
  assert.equal(out.status, 'unavailable');
  assert.equal(out.error, 'auth_failed');
});

test('ndvi: cloud-free imagery must contain pixels; all-noData is ' + 'unavailable', async () => {
  const empty = () => ({ ok: true, json: async () => ({ data: { C0: { interval: { from: '2026-08-15T00:00:00Z', to: '2026-09-15T00:00:00Z' }, basic: { ndvi: { mean: 0.5 } }, totalCount: 100, noDataCount: 100 } } }) });
  const out = await ndviEvidence({ lat: 9, lon: 9, env: SH_ENV_BEARER, fetchImpl: empty, now: NOW });
  assert.equal(out.status, 'unavailable');
  assert.equal(out.error, 'no_valid_pixels');
  assert.equal(out.ndvi, undefined, 'no number is invented when the satellite saw nothing usable');
});

test('ndvi: parse and geometry helpers behave in isolation', () => {
  const parsed = parseNdviStats(SH_BUCKETS);
  assert.equal(parsed.pixelCount, 900);
  assert.equal(parsed.ndvi, 0.5);
  assert.equal(parseNdviStats({ data: {} }), null);
  assert.equal(parseNdviStats(null), null);

  assert.deepEqual(bboxFor(0, 0, 0.5).map((v) => v.toFixed(3)), ['-0.004', '-0.004', '0.004', '0.004']);
  // Near the pole the lon half-width widens; lat stays inside the clamp
  const polar = bboxFor(84.9, 10, 10);
  assert.ok(polar[3] > 84.9 && polar[3] <= 85);
  assert.ok(Math.abs(polar[0] - 10) > 0.5, '10 km of longitude at lat 84.9 spans about a degree');
});

// ---------- Copernicus Data Space aliases (the free Sentinel Hub brother) ----------

test('ndvi: COPERNICUS_* credentials resolve the CDSE endpoints', () => {
  assert.equal(ndviConfigured({ COPERNICUS_CLIENT_ID: 'c-id', COPERNICUS_CLIENT_SECRET: 'c-secret' }), true);
  assert.equal(ndviConfigured({ COPERNICUS_TOKEN: 'c-bearer' }), true);
  assert.equal(ndviConfigured({ COPERNICUS_CLIENT_ID: 'only' }), false, 'a lone id is not a credential');

  const cdse = ndviEndpoints({ COPERNICUS_CLIENT_ID: 'c-id', COPERNICUS_CLIENT_SECRET: 'c-secret' });
  assert.equal(cdse.base, 'https://sh.dataspace.copernicus.eu');
  assert.match(cdse.tokenUrl, /identity\.dataspace\.copernicus\.eu\/auth\/realms\/CDSE\//);

  const sh = ndviEndpoints({});
  assert.equal(sh.base, 'https://services.sentinel-hub.com');
  assert.match(sh.tokenUrl, /services\.sentinel-hub\.com\/auth\/realms\/main\//);

  // An explicit base wins, and a CDSE base implies the CDSE realm.
  assert.equal(ndviEndpoints({ COPERNICUS_TOKEN: 't', SENTINELHUB_BASE_URL: 'https://custom.example' }).base, 'https://custom.example');
  assert.match(ndviEndpoints({ SENTINELHUB_BASE_URL: 'https://sh.dataspace.copernicus.eu' }).tokenUrl, /realms\/CDSE\//);
  // ...unless the token URL itself is set.
  assert.equal(ndviEndpoints({ SENTINELHUB_AUTH_URL: 'https://id.example/token',SENTINELHUB_BASE_URL: 'https://sh.dataspace.copernicus.eu' }).tokenUrl, 'https://id.example/token');

  const creds = credsFor({ SENTINELHUB_CLIENT_ID: 'a', SENTINELHUB_CLIENT_SECRET: 'b', COPERNICUS_CLIENT_ID: 'c' });
  assert.equal(creds.mode, 'oauth');
  assert.equal(creds.clientId, 'a');
});

test('ndvi: a COPERNICUS bearer token signs statistics on the CDSE host', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return ok();
  };
  const out = await ndviEvidence({ lat: 9, lon: 9, env: { COPERNICUS_TOKEN: 'c-bearer' }, fetchImpl, now: NOW });

  assert.equal(calls.length, 1, 'a bearer skips the token step');
  assert.match(calls[0].url, /^https:\/\/sh\.dataspace\.copernicus\.eu\/api\/v1\/statistical$/);
  assert.equal(calls[0].opts.headers.authorization, 'Bearer c-bearer');
  assert.equal(out.status, 'ok');
});

test('ndvi: the CDSE OAuth flow authenticates against the CDSE realm', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), body: opts.body, opts });
    if (String(url).includes('identity.dataspace.copernicus.eu')) {
      return { ok: true, json: async () => ({ access_token: 'cdse-tok', expires_in: 300 }) };
    }
    return ok();
  };
  const out = await ndviEvidence({
    lat: 9, lon: 9,
    env: { COPERNICUS_CLIENT_ID: 'c-id', COPERNICUS_CLIENT_SECRET: 'c-secret' },
    fetchImpl, now: NOW,
  });

  const tokenCall = calls.find((c) => c.url.includes('openid-connect/token'));
  assert.ok(tokenCall, 'the token endpoint is called');
  assert.match(tokenCall.url, /identity\.dataspace\.copernicus\.eu/);
  assert.match(tokenCall.body, /client_id=c-id/);
  const statsCall = calls.find((c) => c.url.includes('/api/v1/statistical'));
  assert.equal(statsCall.opts.headers.authorization, 'Bearer cdse-tok');
  assert.equal(out.status, 'ok');
});
