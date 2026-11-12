import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ndviEvidence, ndviSeriesEvidence, NDVI_DEFAULTS, NDVI_SERIES_DEFAULTS, NDVI_SOURCE, NDVI_SH_SOURCE, NDVI_GEE_SOURCE, bboxFor, parseNdviStats, statsRequest, seriesRequest, ndviTrend, normalizePolygon, clampMonths, ndviConfigured, ndviEndpoints, credsFor } from './ndvi.mjs';
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

// ---------- Google Earth Engine provider (service account, Value API) ----------

import { generateKeyPairSync, createVerify } from 'node:crypto';
import { geeServiceAccount, geeNdviExpression, parseGeeNdvi, ndviProvider } from './ndvi.mjs';

const RSA = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = RSA.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const GEE_ENV = {
  GEE_PROJECT_ID: 'plotline-sat',
  // .env files are line-based; prove the literal \n escape path works.
  GEE_CLIENT_EMAIL: 'ndvi-bot@plotline-sat.iam.gserviceaccount.com',
  GEE_PRIVATE_KEY: PEM.replace(/\n/g, '\\n'),
};
const GEE_TOKEN = { ok: true, status: 200, json: async () => ({ access_token: 'gee-tok', expires_in: 3600 }) };
const GEE_OK = (stats) => ({
  ok: true, status: 200,
  json: async () => ({ result: { ...stats, ...(stats || {}) } }),
});
const GEE_STATS = { ndvi_mean: 0.5, ndvi_min: 0.2, ndvi_max: 0.8, ndvi_stdDev: 0.1 };

test('ndvi: the GEE service account parses from both env shapes; provider precedence holds', () => {
  const sa = geeServiceAccount(GEE_ENV);
  assert.match(sa.privateKey, /BEGIN PRIVATE KEY/);
  assert.match(sa.privateKey, /\n/);
  assert.equal(sa.projectId, 'plotline-sat');
  const inline = geeServiceAccount({ GEE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'a@b.c', private_key: PEM, project_id: 'p1' }) });
  assert.equal(inline.clientEmail, 'a@b.c');
  assert.equal(geeServiceAccount({ GEE_SERVICE_ACCOUNT_JSON: '{nope' }), null);
  assert.equal(geeServiceAccount({ GEE_CLIENT_EMAIL: 'a@b.c' }), null);

  assert.equal(ndviProvider({}), null);
  assert.equal(ndviProvider({ COPERNICUS_CLIENT_ID: 'i', COPERNICUS_CLIENT_SECRET: 's' }), 'sentinel-hub');
  assert.equal(ndviProvider(GEE_ENV), 'gee');
  assert.equal(ndviProvider({ ...GEE_ENV, COPERNICUS_CLIENT_ID: 'i', COPERNICUS_CLIENT_SECRET: 's' }), 'sentinel-hub', 'SH wins ties; NDVI_PROVIDER=gee overrides');
  assert.equal(ndviProvider({ ...GEE_ENV, NDVI_PROVIDER: 'gee' }), 'gee');
});

test('ndvi: the GEE token request carries a genuinely signed RS256 JWT', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), body: opts.body });
    return GEE_TOKEN;
  };
  const token = await (await import('./ndvi.mjs')).geeToken({ env: GEE_ENV, fetchImpl, now: new Date('2026-11-15T12:00:00.000Z') });
  assert.equal(token, 'gee-tok');

  const call = calls.find((c) => c.url === 'https://oauth2.googleapis.com/token');
  assert.ok(call);
  const body = new URLSearchParams(call.body);
  assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [h, p] = body.get('assertion').split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.equal(claims.iss, 'ndvi-bot@plotline-sat.iam.gserviceaccount.com');
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/earthengine.readonly');
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  // The signature must actually verify against our injected key — a malformed
  // JWT would fail at Google with a confusing 401, so check the signing here.
  // Reconstruct the signed input from the assertion itself.
  const assertion = body.get('assertion');
  const signed = assertion.slice(0, assertion.lastIndexOf('.'));
  const sig = Buffer.from(assertion.slice(assertion.lastIndexOf('.') + 1), 'base64url');
  assert.equal(createVerify('RSA-SHA256').update(signed).verify(RSA.publicKey, sig), true);
});

test('ndvi: GEE is asked for a region NDVI reduce; the result maps into the evidence', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), body: opts.body });
    return String(url).includes('oauth2') ? GEE_TOKEN : GEE_OK(GEE_STATS);
  };
  const out = await ndviEvidence({ lat: 9.5, lon: 8.4, bufferKm: 1, dateFrom: '2026-06-01', dateTo: '2026-10-01', env: GEE_ENV, fetchImpl, now: NOW });

  const stats = calls.find((c) => c.url.includes('earthengine.googleapis.com'));
  assert.match(stats.url, /\/v1\/projects\/plotline-sat\/value:compute/);
  const body = JSON.parse(stats.body);
  assert.equal(body.workloadTag, 'plotline-ndvi');
  const dag = body.expression;
  // node ids: `result` names the root; every argument is a valueReference into
  // `values`, where each node is a functionInvocationValue variant.
  assert.equal(typeof dag.result, 'string');
  const walk = (id) => {
    const node = dag.values[id]?.functionInvocationValue;
    assert.ok(node, `node ${id} exists and is an invocation`);
    const childRefs = Object.values(node.arguments ?? {})
      .filter((a) => a?.valueReference != null)
      .flatMap((a) => walk(a.valueReference));
    return [node, ...childRefs];
  };
  const nodes = walk(dag.result);
  assert.ok(nodes.some((n) => n.functionName === 'Image.reduceRegion'));
  // NDVI = (B8 − B4) / (B8 + B4): the selects and the arithmetic prove band order.
  const sel = nodes.filter((n) => n.functionName === 'Image.select');
  assert.deepEqual(sel[0].arguments.bandSelectors, { constantValue: ['B8'] }, 'NIR first');
  assert.deepEqual(sel[1].arguments.bandSelectors, { constantValue: ['B4'] });
  const diff = nodes.find((n) => n.functionName === 'Image.subtract');
  const sum = nodes.find((n) => n.functionName === 'Image.add');
  const div = nodes.find((n) => n.functionName === 'Image.divide');
  assert.ok(diff && sum && div, 'NDVI built as (NIR − red)/(NIR + red)');
  const buffer = nodes.find((n) => n.functionName === 'Geometry.buffer');
  assert.equal(buffer.arguments.distance.constantValue, 1000, '1 km buffer in metres');
  const cloudFilter = nodes.find((n) => n.functionName === 'Filter.lt'
    && n.arguments.leftField?.constantValue === 'CLOUDY_PIXEL_OVER_LAND_PERCENTAGE');
  assert.equal(cloudFilter.arguments.rightValue.constantValue, 30);
  const timeGte = nodes.find((n) => n.functionName === 'Filter.gte');
  assert.equal(timeGte.arguments.leftField?.constantValue, 'system:time_start');
  assert.equal(timeGte.arguments.rightValue?.constantValue, Date.parse('2026-06-01'), 'epoch-ms comparison');

  assert.equal(out.status, 'ok');
  assert.equal(out.source, 'gee value api');
  assert.equal(out.ndvi, 0.5);
  assert.equal(out.ndviMin, 0.2);
  assert.equal(out.ndviMax, 0.8);
  assert.equal(out.ndviStdDev, 0.1);
  assert.equal(out.dateFrom, '2026-06-01T00:00:00.000Z');
});

test('ndvi: GEE failures surface the exact reason, with the provider detail attached', async () => {
  const refuse = (status, body) => async (url) => (String(url).includes('oauth2') ? GEE_TOKEN : { ok: false, status, text: async () => body });
  let out = await ndviEvidence({ lat: 9, lon: 9, env: GEE_ENV, fetchImpl: refuse(403, '{"error":"PERMISSION_DENIED: caller has no earthengine scope"}'), now: NOW });
  assert.equal(out.status, 'unavailable');
  assert.equal(out.error, 'auth_failed');
  assert.match(out.detail, /PERMISSION_DENIED/);

  out = await ndviEvidence({ lat: 9, lon: 9, env: GEE_ENV, fetchImpl: refuse(400, '{"error":"Image.reduceRegion: unknown function name"}'), now: NOW });
  assert.equal(out.error, 'bad_request');
  assert.match(out.detail, /unknown function name/);

  // An empty compute result is an explicit no-data answer, never a fabricated value.
  out = await ndviEvidence({ lat: 9, lon: 9, env: GEE_ENV, fetchImpl: async (url) => (String(url).includes('oauth2') ? GEE_TOKEN : { ok: true, status: 200, json: async () => ({ result: {} }) }), now: NOW });
  assert.equal(out.status, 'unavailable');
  assert.equal(out.error, 'no_valid_pixels');

  assert.equal(parseGeeNdvi(null), null);
  assert.equal(parseGeeNdvi({ mean: 0.4 }).ndvi, 0.4, 'fallback key without the ndvi_ prefix');
  assert.equal(parseGeeNdvi({}), null);
  assert.equal(parseGeeNdvi({ ndvi_mean: Number.NaN }), null);
});

// ---------- NDVI series: polygon validation, trend, providers, route ----------

// ~1.2 ha square around the demo plot — the app shape ({lat, lon}), walk order.
const PLOT = [[0, 0], [0, 0.001], [0.001, 0.001], [0.001, 0]].map(([da, db]) => ({ lat: 9.9 + da, lon: 8.9 + db }));

const SERIES_BUCKETS = {
  // Arrived out of chronological order on purpose: the series must be sorted.
  data: {
    B4: { interval: { from: '2026-04-15T00:00:00Z', to: '2026-05-15T00:00:00Z' }, basic: { ndvi: { mean: 0.35, min: 0.1, max: 0.6, stDev: 0.04 } }, totalCount: 400, noDataCount: 50 },
    B2: { interval: { from: '2026-02-15T00:00:00Z', to: '2026-03-15T00:00:00Z' }, basic: { ndvi: { mean: 0.62, min: 0.4, max: 0.8, stDev: 0.03 } }, totalCount: 400, noDataCount: 50 },
    B0: { interval: { from: '2025-12-15T00:00:00Z', to: '2026-01-15T00:00:00Z' }, basic: { ndvi: { mean: 0.50, min: 0.2, max: 0.7, stDev: 0.05 } }, totalCount: 400, noDataCount: 50 },
    B3: { interval: { from: '2026-03-15T00:00:00Z', to: '2026-04-15T00:00:00Z' }, basic: { ndvi: { mean: 0.52, min: 0.3, max: 0.8, stDev: 0.04 } }, totalCount: 400, noDataCount: 50 },
    B1: { interval: { from: '2026-01-15T00:00:00Z', to: '2026-02-15T00:00:00Z' }, basic: { ndvi: { mean: 0.55, min: 0.3, max: 0.75, stDev: 0.03 } }, totalCount: 400, noDataCount: 50 },
  },
};

test('ndvi series: normalizePolygon accepts the app shape, closes the ring, refuses junk', () => {
  const n = normalizePolygon(PLOT);
  assert.equal(n.ok, true);
  const ring = n.geojson.coordinates[0]; // [[lon, lat], ...] with the first point repeated last
  assert.equal(ring.length, PLOT.length + 1);
  assert.deepEqual(ring[ring.length - 1], ring[0]);
  assert.equal(ring[0][0], 8.9, 'GeoJSON order is lon first');
  assert.ok(n.areaM2 > 6000 && n.areaM2 < 15000, '~1.2 ha');

  // walked boundaries usually end where they start: the closing duplicate must vanish
  const closed = normalizePolygon([...PLOT, PLOT[0]]);
  assert.equal(closed.ok, true);
  assert.equal(closed.pts.length, 4);

  assert.equal(normalizePolygon([{ lat: 9.9, lon: 8.9 }]).ok, false, 'needs 3 corners');
  assert.equal(normalizePolygon([[9.9, 8.9], [9.91, 8.91], [9.92, 8.9]]).ok, false, 'arrays are not points');
  assert.equal(normalizePolygon([{ lat: 999, lon: 8.9 }, { lat: 9.9, lon: 8.9 }, { lat: 9.91, lon: 8.91 }]).ok, false);
  assert.equal(normalizePolygon(null).ok, false, 'missing polygon refused');
  // bigger than a plot: series is capped at one walked field, not a farm block
  const huge = [{ lat: 9.9, lon: 8.9 }, { lat: 9.9, lon: 9.4 }, { lat: 10.4, lon: 9.4 }, { lat: 10.4, lon: 8.9 }];
  const h = normalizePolygon(huge);
  assert.equal(h.ok, false);
  assert.match(h.error, /too large/);
});

test('ndvi series: months clamp into the honest window', () => {
  assert.equal(clampMonths(1), NDVI_SERIES_DEFAULTS.minMonths);
  assert.equal(clampMonths(96), NDVI_SERIES_DEFAULTS.maxMonths);
  assert.equal(clampMonths('x'), NDVI_SERIES_DEFAULTS.months);
  assert.equal(clampMonths(6.4), 6);
});

test('ndvi series: ndviTrend flags the plot-own dip and refuses short histories', () => {
  const mk = (vals) => vals.map((v) => ({ from: '2026-01-01', to: '2026-02-01', ndvi: v }));
  const dipped = ndviTrend(mk([0.50, 0.55, 0.52, 0.62, 0.35]));
  assert.equal(dipped.dip, true);
  assert.equal(dipped.medianPrev, 0.535, 'even count of priors: mean of the middle two');
  assert.equal(dipped.drop, 0.185);

  assert.equal(ndviTrend(mk([0.5, 0.5, 0.5, 0.49])).dip, false, 'within 0.05 is no dip');
  assert.equal(ndviTrend(mk([0.5, 0.3, 0.6])).reason, 'insufficient_history', 'needs 3 priors + latest');
  assert.equal(ndviTrend(null).reason, 'insufficient_history');
  assert.equal(ndviTrend(mk([0.5, NaN, 0.55, 0.6, 0.7])).monthsSampled, 4, 'gaps are skipped, not zeros');
});

test('ndvi series: the statistical request carries the walked ring, not a bbox', () => {
  const req = seriesRequest({ polygonGeo: normalizePolygon(PLOT).geojson, cloudMaxPct: 30, from: 'X', to: 'Y' });
  assert.equal(req.input.bounds.geometry.type, 'Polygon', 'bounds.geometry instead of bounds.bbox');
  assert.equal(req.input.bounds.bbox, undefined);
  assert.equal(req.input.bounds.properties.crs, 'http://www.opengis.net/def/crs/EPSG/0/4326');
  assert.equal(req.aggregation.aggregationInterval.of, 'P1M');
  assert.equal(req.input.data[0].dataFilter.maxCloudCoverage, 30);
});

test('ndvi series: without a provider the stub comes back, series honestly empty', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return ok(); };
  const out = await ndviSeriesEvidence({ polygon: PLOT, env: {}, fetchImpl, now: NOW });
  assert.equal(out.status, 'stub');
  assert.equal(out.source, NDVI_SOURCE);
  assert.equal(out.series, null);
  assert.equal(out.trend, null);
  assert.match(out.message, /not yet live/i);
  assert.equal(called, false);
  // Site elsewhere: bad geometry is its own status, never confused with the stub.
  assert.equal((await ndviSeriesEvidence({ polygon: null, env: {}, fetchImpl, now: NOW })).status, 'bad_polygon');
});

test('ndvi series: sentinel-hub flow clips to the polygon and reports the dip', async () => {
  let sent = null;
  const fetchImpl = async (url, opts) => {
    assert.match(String(url), /\/api\/v1\/statistical$/, 'the statistical endpoint, like the point check');
    sent = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => SERIES_BUCKETS };
  };
  const out = await ndviSeriesEvidence({ polygon: PLOT, env: SH_ENV_BEARER, fetchImpl, now: NOW });
  assert.equal(out.status, 'ok');
  assert.equal(out.source, NDVI_SH_SOURCE);
  const geometry = sent.input.bounds.geometry;
  assert.equal(geometry.type, 'Polygon');
  const ring = geometry.coordinates[0];
  assert.equal(ring.length, 5, 'walked corners plus the implicit closing point');
  assert.deepEqual(ring[0], ring[4]);
  assert.equal(sent.aggregation.aggregationInterval.of, 'P1M');

  assert.equal(out.series.length, 5, 'all months that carry values');
  assert.deepEqual(out.series.map((p) => p.from), [
    '2025-12-15T00:00:00Z', '2026-01-15T00:00:00Z', '2026-02-15T00:00:00Z',
    '2026-03-15T00:00:00Z', '2026-04-15T00:00:00Z',
  ], 'chronological regardless of bucket order');
  assert.equal(out.series[4].ndvi, 0.35);
  assert.equal(out.trend.dip, true, '0.35 vs median 0.535 is the dipped last month');
  assert.equal(out.trend.drop, 0.185);
  assert.ok(out.areaM2 > 6000);
  assert.deepEqual(out.centroid, { lat: 9.9005, lon: 8.9005 });
});

test('ndvi series: provider failure and no-data are reported, never fabricated', async () => {
  const refused = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const out = await ndviSeriesEvidence({ polygon: PLOT, env: SH_ENV_BEARER, fetchImpl: refused, now: NOW });
  assert.equal(out.status, 'unavailable');
  assert.equal(out.error, 'auth_failed');

  const empty = { data: { B0: { interval: { from: 'X', to: 'Y' }, basic: { ndvi: { mean: 0.5 } }, totalCount: 200, noDataCount: 200 } } };
  const nopixels = await ndviSeriesEvidence({ polygon: PLOT, env: SH_ENV_BEARER, fetchImpl: async () => ({ ok: true, status: 200, json: async () => empty }), now: NOW });
  assert.equal(nopixels.status, 'unavailable');
  assert.equal(nopixels.error, 'no_valid_pixels');
});

test('ndvi series: a Sentinel Hub outage falls back to Earth Engine when both are configured', async () => {
  const env = { ...GEE_ENV, GEE_PROJECT_ID: GEE_ENV.GEE_PROJECT_ID + ' ', COPERNICUS_TOKEN: 't' };
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (String(url).includes('dataspace.copernicus.eu')) return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
    if (String(url).includes('oauth2')) return GEE_TOKEN;
    return GEE_OK(GEE_STATS);
  };
  const out = await ndviSeriesEvidence({ polygon: PLOT, env, fetchImpl, now: NOW });
  assert.equal(out.status, 'ok');
  assert.equal(out.source, NDVI_GEE_SOURCE);
  assert.ok(!urls.some((u) => u.includes('%20')), 'a trailing space in the project id is trimmed');

  const pinned = await ndviSeriesEvidence({ polygon: PLOT, env: { ...env, NDVI_PROVIDER: 'sentinel-hub' }, fetchImpl, now: NOW });
  assert.equal(pinned.error, 'provider_error', 'an explicit provider choice is never overridden');
});

test('ndvi series: the GEE fallback is one honest average, explicitly not a series', async () => {
  let sentBody = null;
  const fetchImpl = async (url, opts) => {
    if (String(url).includes('oauth2')) return GEE_TOKEN;
    sentBody = JSON.parse(opts.body);
    return GEE_OK(GEE_STATS);
  };
  const out = await ndviSeriesEvidence({ polygon: PLOT, env: GEE_ENV, fetchImpl, now: NOW });
  assert.equal(out.status, 'ok');
  assert.equal(out.source, NDVI_GEE_SOURCE);
  assert.equal(out.series.length, 1, 'the value API cannot make monthly buckets in one call');
  assert.match(out.note, /not a monthly series/);
  assert.equal(out.trend.reason, 'insufficient_history');
  assert.ok(out.bufferKm >= 0.05, 'buffer derived from the polygon area');
  const expr = JSON.stringify(sentBody.expression);
  assert.match(expr, /Geometry.buffer/, 'the reduce centres on the walked polygon');
});

test('ndvi series API: farmer-facing route validates the polygon and serves the stub', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ndviseries-'));
  const app = createApp({ dataDir: dir, adminToken: 'op', now: NOW });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (body) => {
    const res = await fetch(base + '/api/registry/ndvi-series', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  try {
    assert.equal((await post({})).status, 400, 'missing polygon');
    assert.equal((await post({ polygon: [[9.9, 8.9], [9.91, 8.91], [9.92, 8.9]] })).status, 400, 'wrong point shape');
    assert.equal((await post({ polygon: PLOT.slice(0, 2) })).status, 400, 'needs 3 corners');
    const big = [{ lat: 9.9, lon: 8.9 }, { lat: 9.9, lon: 9.4 }, { lat: 10.4, lon: 9.4 }, { lat: 10.4, lon: 8.9 }];
    const oversized = await post({ polygon: big });
    assert.equal(oversized.status, 400);
    assert.match(oversized.json.error, /too large/, 'per-plot size cap is enforced at the route');

    const okres = await post({ polygon: PLOT, months: 99 });
    assert.equal(okres.status, 200, 'no operator token needed: farmers never hold one');
    assert.equal(okres.json.status, 'stub');
    assert.equal(okres.json.months, NDVI_SERIES_DEFAULTS.maxMonths, 'months clamped at the route');
    assert.equal(okres.json.series, null);
  } finally {
    app.server.closeAllConnections?.();
    await new Promise((r) => app.server.close(r));
  }
});
