// rain.test.mjs — CHIRPS rainfall module: expression DAG, parsing, aggregation,
// provider flow through injected fetch, and the farmer-facing route. Follows
// the ndvi.test.mjs harness: no real network, GEE fixtures with a generated
// RSA key, and a createApp server for route behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rainEvidence, rainExpression, rainAggregates, parseChirpsDaily, RAIN_DEFAULTS, RAIN_SOURCE, RAIN_GEE_SOURCE } from './rain.mjs';
import { createApp } from './server.mjs';

const NOW = () => new Date('2026-11-15T12:00:00.000Z');
const NOW_TS = NOW().getTime();

// Small square near every helper in the repo: ~110 m per side — well under the
// 20 ha cap, and its corners exercise the ring normalisation.
const PLOT = [[0, 0], [0, 0.001], [0.001, 0.001], [0.001, 0]].map(([da, db]) => ({ lat: 9.9 + da, lon: 8.9 + db }));

test('rain: the stub returns a clearly-labelled placeholder without any network call', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  const out = await rainEvidence({ polygon: PLOT, fetchImpl, now: NOW });

  assert.equal(out.status, 'stub');
  assert.equal(out.source, RAIN_SOURCE);
  assert.equal(out.series, null);
  assert.equal(out.monthly, null);
  assert.equal(out.totalMm, null);
  assert.equal(out.checkedAt, '2026-11-15T12:00:00.000Z');
  assert.match(out.message, /not yet live/i);
  assert.equal(called, false, 'no provider is called while the module is a stub');
});

test('rain: bad polygons refuse before any request, months clamp honestly', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, json: async () => ({}) }; };

  const empty = await rainEvidence({ polygon: [], env: {}, fetchImpl, now: NOW });
  assert.equal(empty.status, 'bad_polygon');
  assert.match(empty.error, /corners/);

  const shape = await rainEvidence({ polygon: [[9.9, 8.9], [9.91, 8.91], [9.92, 8.9]], env: {}, fetchImpl, now: NOW });
  assert.equal(shape.status, 'bad_polygon', 'points must be {lat, lon} objects');

  const oversized = await rainEvidence({
    polygon: [{ lat: 9.9, lon: 8.9 }, { lat: 9.9, lon: 9.4 }, { lat: 10.4, lon: 9.4 }, { lat: 10.4, lon: 8.9 }],
    env: {}, fetchImpl, now: NOW,
  });
  assert.equal(oversized.status, 'bad_polygon');
  assert.match(oversized.error, /too large/);

  for (const bad of ['x', 7, {}]) {
    assert.equal((await rainEvidence({ polygon: bad, env: {}, fetchImpl, now: NOW })).status, 'bad_polygon');
  }

  // months clamps 1..24; the stub echo carries the clamped window
  const clamped = await rainEvidence({ polygon: PLOT, months: 99, env: {}, fetchImpl, now: NOW });
  assert.equal(clamped.months, RAIN_DEFAULTS.maxMonths);
  assert.equal((await rainEvidence({ polygon: PLOT, months: 0, env: {}, fetchImpl, now: NOW })).months, RAIN_DEFAULTS.minMonths);

  assert.equal(called, false);
});

test('rain: the GEE expression asks CHIRPS for daily sums in one reduce', () => {
  const geojson = { type: 'Polygon', coordinates: [[[8.9, 9.9], [8.899, 9.9], [8.899, 9.899], [8.9, 9.899], [8.9, 9.9]]] };
  const dag = rainExpression({ polygonGeo: geojson, from: '2026-05-15T12:00:00.000Z', to: '2026-11-15T12:00:00.000Z' });

  // node ids: `result` names the root; every argument is a valueReference into
  // `values`, where each node is a functionInvocationValue variant.
  const walk = (id, seen = new Set()) => {
    const node = dag.values[id]?.functionInvocationValue;
    assert.ok(node, `node ${id} exists and is an invocation`);
    if (seen.has(id)) return [];
    seen.add(id);
    return [node, ...Object.values(node.arguments ?? {})
      .filter((a) => a?.valueReference != null)
      .flatMap((a) => walk(a.valueReference, seen))];
  };
  const nodes = walk(dag.result);

  const load = nodes.find((n) => n.functionName === 'ImageCollection.load');
  assert.equal(load.arguments.id.constantValue, 'UCSB-CHG/CHIRPS/DAILY');

  // date filtering rides on system:index strings (CHIRPS ids are YYYYMMDD);
  // the reduceRegion geometry does the spatial restriction, so no bounds filter.
  const gte = nodes.find((n) => n.functionName === 'Filter.gte');
  assert.equal(gte.arguments.leftField.constantValue, 'system:index');
  assert.equal(gte.arguments.rightValue.constantValue, '20260515');
  const lte = nodes.find((n) => n.functionName === 'Filter.lt');
  assert.equal(lte.arguments.rightValue.constantValue, '20261116', 'Filter.lt is exclusive — day after `to`');
  const filters = nodes.filter((n) => n.functionName === 'Collection.filter');
  assert.equal(filters.length, 2, 'two stacked Collection.filter calls');

  const banded = nodes.find((n) => n.functionName === 'ImageCollection.toBands');
  assert.ok(banded, 'each day becomes a band so one call returns every day');

  const reduce = nodes.find((n) => n.functionName === 'Image.reduceRegion');
  assert.equal(typeof reduce.arguments.reducer?.valueReference, 'string', 'reducer passed as a digestible node');
  const mean = nodes.find((n) => n.functionName === 'Reducer.mean');
  assert.ok(mean, 'per-day mean reducer (a CHIRPS day is single-band)');
  assert.equal(reduce.arguments.scale.constantValue, 5566, 'CHIRPS native 0.05° pixel scale');
  assert.equal(reduce.arguments.maxPixels.constantValue, 1e13);
  assert.equal(reduce.arguments.bestEffort.constantValue, true);

  const polygon = nodes.find((n) => n.functionName === 'GeometryConstructors.Polygon');
  assert.ok(polygon, 'the walked polygon, built directly (flat ring)');
});

test('rain: parsing accepts both CHIRPS band-name styles and refuses noise', () => {
  // the live answer shape: one flat key per band under `result`
  const flat = parseChirpsDaily({
    result: { '20260115_prcp': 1.5, '20260114_prcp': 2.5, '20260201': 12.25 },
  });
  assert.deepEqual(flat, [{ date: '2026-01-14', mm: 2.5 }, { date: '2026-01-15', mm: 1.5 }, { date: '2026-02-01', mm: 12.25 }], 'chrono sorted');

  const underscored = parseChirpsDaily({
    result: { '20260115_prcp': 3.4, '20260116': 0 },
  });
  assert.deepEqual(underscored, [{ date: '2026-01-15', mm: 3.4 }, { date: '2026-01-16', mm: 0 }]);

  const dashedLikeOtherProducts = parseChirpsDaily({ result: { '2026-01-15': 1.0 } });
  assert.equal(dashedLikeOtherProducts?.length, 1);

  assert.equal(parseChirpsDaily({ values: { 0: { ndvi: 3, junk: 'x' } } }), null, 'no daily bands → null, never fabricated');
  assert.equal(parseChirpsDaily({ values: { 0: { '20260115': 'oops' } } }), null, 'non-numeric sums are dropped');
  assert.equal(parseChirpsDaily({}), null);
  assert.equal(parseChirpsDaily([]), null);
  assert.equal(parseChirpsDaily(null), null);
});

test('rain: aggregation — weekly and monthly buckets, totals, and dry spells', () => {
  // 19 observed days: Jan 01..15 stepping 0.3 (with a 14.2 storm on Jan 08),
  // a 22 mm storm on Jan 16, then Feb 01/14/15 wet. The dry runs around the
  // storms are what the dry-spell counter must see.
  const daily = [
    ...Array.from({ length: 15 }, (_, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, mm: i === 7 ? 14.2 : 0.3 })),
    { date: '2026-01-16', mm: 22 },
    { date: '2026-02-01', mm: 5 },
    { date: '2026-02-14', mm: 6 },
    { date: '2026-02-15', mm: 4 },
  ];

  const agg = rainAggregates(daily, { now: NOW() });

  assert.equal(agg.totalMm, 55.4, '14×0.3 + 14.2 + 22 + 5 + 6 + 4');
  assert.equal(agg.series.length, 3, '19 observed days → two fixed 7-day weeks + one 5-day tail');
  assert.equal(agg.series[0].from, '2026-01-01');
  assert.equal(agg.series[0].to, '2026-01-07');
  assert.equal(agg.series[0].mm, 2.1, 'seven 0.3 days');
  assert.equal(agg.series[1].mm, 16, 'Jan08 storm inside its week');
  assert.equal(agg.series[2].mm, 37.3, 'slices are positional, not calendar-aligned');
  assert.equal(agg.series[2].to, '2026-02-15');
  assert.equal(agg.monthly.length, 2);
  assert.equal(agg.monthly[0].mm, 40.4, 'January total even though its weeks split awkwardly');
  assert.equal(agg.monthly[1].mm, 15);

  assert.equal(agg.longestDrySpellDays, 7);
  // two 7-day runs (Jan01–07 and Jan09–15) tie; the FIRST max keeps its end date
  assert.equal(agg.longestDrySpellEndedTs, '2026-01-07T00:00:00Z');

  assert.equal(agg.lastRainTs, '2026-02-15T00:00:00Z');
});

test('rain: dry-spell edges — everything-dry, everything-wet, and the first wet day', () => {
  const dry = [{ date: '2026-01-03', mm: 0 }, { date: '2026-01-04', mm: 1.9 }, { date: '2026-01-05', mm: 0.01 }];
  const d = rainAggregates(dry);
  assert.equal(d.longestDrySpellDays, 3);
  assert.equal(d.lastRainTs, null, 'no day reached the wet threshold — lastRainTs stays null, not 0');

  const wet = [{ date: '2026-01-03', mm: 9 }, { date: '2026-01-04', mm: 12 }];
  const w = rainAggregates(wet);
  assert.equal(w.longestDrySpellDays, 0);
  assert.equal(w.longestDrySpellEndedTs, null);
  assert.equal(w.lastRainTs, '2026-01-04T00:00:00Z');

  assert.equal(rainAggregates([]), null);
  assert.equal(rainAggregates(null), null);
});

// ---------- GEE provider flow (injected fetch, no real network) ----------

import { generateKeyPairSync } from 'node:crypto';
import { geeServiceAccount } from './ndvi.mjs';

const RSA = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = RSA.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const GEE_ENV = {
  GEE_PROJECT_ID: 'plotline-sat',
  GEE_CLIENT_EMAIL: 'rain-bot@plotline-sat.iam.gserviceaccount.com',
  GEE_PRIVATE_KEY: PEM.replace(/\n/g, '\\n'),
};
const GEE_TOKEN = { ok: true, status: 200, json: async () => ({ access_token: 'gee-tok', expires_in: 3600 }) };

// The compute result shape: toBands keys are CHIRPS image ids (optionally with
// the band suffix). 30ish observed days around NOW.
const CHIRPS_DAYS = [
  ...Array.from({ length: 60 }, (_, i) => {
    const t = NOW_TS - i * 86_400_000;
    const key = new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
    return [key, i % 9 === 0 ? 15.4 : i % 3 === 0 ? 0.4 : 0];
  }),
];
const CHIRPS_RESULT = { ok: true, status: 200, json: async () => ({ values: { 0: Object.fromEntries(CHIRPS_DAYS) } }) };

test('rain: the GEE service account survives a pasted JSON fragment', async () => {
  // Operators frequently paste the `"private_key": "…"` member of the service
  // account JSON rather than the bare PEM — the key material is recoverable.
  const fragment = '"private_key": "' + PEM.replace(/\n/g, '\\n') + '"';
  const sa = geeServiceAccount({ GEE_CLIENT_EMAIL: 'rain-bot@plotline-sat.iam.gserviceaccount.com', GEE_PRIVATE_KEY: fragment });
  assert.equal(sa.clientEmail, 'rain-bot@plotline-sat.iam.gserviceaccount.com');
  assert.match(sa.privateKey, /BEGIN PRIVATE KEY-----\n/);

  const bare = geeServiceAccount({ GEE_CLIENT_EMAIL: 'a@b.c', GEE_PRIVATE_KEY: PEM });
  assert.match(bare.privateKey, /BEGIN PRIVATE KEY-----\n/, 'the normal unescaped case keeps working');

  assert.equal(geeServiceAccount({ GEE_CLIENT_EMAIL: 'a@b.c', GEE_PRIVATE_KEY: 'not a key' }), null,
    "a value with no PEM inside is 'not configured', not a crash");
});

test('rain: GEE is asked for one compute; the daily record lands aggregated', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), body: opts.body });
    return String(url).includes('oauth2') ? GEE_TOKEN : CHIRPS_RESULT;
  };
  const out = await rainEvidence({ polygon: PLOT, months: 6, env: GEE_ENV, fetchImpl, now: NOW });

  assert.equal(geeServiceAccount(GEE_ENV).clientEmail, 'rain-bot@plotline-sat.iam.gserviceaccount.com');

  const compute = calls.find((c) => c.url.includes('earthengine.googleapis.com'));
  assert.match(compute.url, /\/v1\/projects\/plotline-sat\/value:compute/);
  const body = JSON.parse(compute.body);
  assert.equal(body.workloadTag, 'plotline-rain');
  assert.equal(calls.filter((c) => c.url.includes('earthengine')).length, 1, 'ONE value:compute — the toBands trick');

  assert.equal(out.status, 'ok');
  assert.equal(out.source, RAIN_GEE_SOURCE);
  assert.equal(out.months, 6);
  assert.equal(out.totalMm, Math.round(CHIRPS_DAYS.reduce((s, [, mm]) => s + mm, 0) * 100) / 100, 'sums never drift');
  assert.ok(out.series.length >= 6, 'weekly buckets for the chart');
  assert.ok(out.monthly.length >= 3, 'calendar months covering the window');
  assert.ok(out.dateFrom.startsWith('2026-05-'), 'a 6-month window before now');
  assert.ok(/5 km/.test(out.note), 'the precision caveat ships with the data');
  assert.deepEqual(out.centroid, { lat: 9.9005, lon: 8.9005 }, 'the polygon centre is reported for provenance');
  assert.equal(out.longestDrySpellEndedTs != null, true, 'a real dry run comes out of the fixture');
});

test('rain: last30Mm counts only observed days inside the window', () => {
  const mk = (days) => rainAggregates(days, { now: NOW() });
  // NOW is 2026-11-15; the 30-day cutoff is 2026-10-16
  assert.equal(mk([{ date: '2026-10-20', mm: 10 }, { date: '2026-07-01', mm: 50 }]).last30Mm, 10);
  assert.equal(mk([{ date: '2026-10-15', mm: 50 }, { date: '2026-10-20', mm: 2 }]).last30Mm, 2);
  assert.equal(mk([{ date: '2026-10-20' , mm: 0 }]).last30Mm, 0);
});

test('rain: GEE failures surface the exact reason, and empty results stay answers-not-zeros', async () => {
  const refuse = (status, body) => async (url) => (String(url).includes('oauth2') ? GEE_TOKEN : { ok: false, status, text: async () => body });
  let out = await rainEvidence({ polygon: PLOT, env: GEE_ENV, fetchImpl: refuse(403, '{"error":"PERMISSION_DENIED: caller is not an EE layer"}'), now: NOW });
  assert.equal(out.status, 'unavailable');
  assert.equal(out.error, 'auth_failed');
  assert.match(out.detail, /PERMISSION_DENIED/);

  out = await rainEvidence({ polygon: PLOT, env: GEE_ENV, fetchImpl: refuse(400, '{"error":"ImageCollection.toBands: unknown function name"}'), now: NOW });
  assert.equal(out.error, 'bad_request');
  assert.match(out.detail, /unknown function name/);

  out = await rainEvidence({ polygon: PLOT, env: GEE_ENV, fetchImpl: refuse(503, '{"error":"backend exploded"}'), now: NOW });
  assert.equal(out.error, 'provider_error');

  out = await rainEvidence({ polygon: PLOT, env: GEE_ENV, fetchImpl: async (url) => (String(url).includes('oauth2') ? GEE_TOKEN : { ok: true, status: 200, json: async () => ({ values: { 0: {} } }) }), now: NOW });
  assert.equal(out.status, 'unavailable', 'an empty window is explicit no-data, never a fabricated zero');
  assert.equal(out.error, 'no_valid_pixels');

  const thrown = await rainEvidence({ polygon: PLOT, env: GEE_ENV, fetchImpl: async (url) => { if (!String(url).includes('oauth2')) throw new Error('dns died'); return GEE_TOKEN; }, now: NOW });
  assert.equal(thrown.status, 'unavailable');
  assert.equal(thrown.error, 'provider_error', 'network exceptions degrade gracefully');
});

// ---------- route ----------

test('rain API: farmer-facing route validates the polygon and serves the stub', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rainapi-'));
  const app = createApp({ dataDir: dir, adminToken: 'op', now: NOW });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (body) => {
    const res = await fetch(base + '/api/registry/rain', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  try {
    assert.equal((await post({})).status, 400, 'missing polygon');
    const wrong = await post({ polygon: [[9.9, 8.9], [9.91, 8.91], [9.92, 8.9]] });
    assert.equal(wrong.status, 400, 'wrong point shape');
    assert.equal((await post({ polygon: PLOT.slice(0, 2) })).status, 400, 'needs 3 corners');

    const big = [{ lat: 9.9, lon: 8.9 }, { lat: 9.9, lon: 9.4 }, { lat: 10.4, lon: 9.4 }, { lat: 10.4, lon: 8.9 }];
    const oversized = await post({ polygon: big });
    assert.equal(oversized.status, 400);
    assert.match(oversized.json.error, /too large/, 'the 20 ha per-plot cap holds at the route');

    const okres = await post({ polygon: PLOT, months: 99 });
    assert.equal(okres.status, 200, 'no operator token: farmers never hold one');
    assert.equal(okres.json.status, 'stub');
    assert.equal(okres.json.months, RAIN_DEFAULTS.maxMonths, 'window clamped at the route');
    assert.equal(okres.json.series, null);

    const cached = await post({ polygon: PLOT });
    assert.equal(cached.json.checkedAt, okres.json.checkedAt, 'same plot resolves from the 6 h cache');
  } finally {
    app.server.closeAllConnections?.();
    await new Promise((r) => app.server.close(r));
  }
});
