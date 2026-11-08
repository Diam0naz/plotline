// rain.mjs — CHIRPS daily rainfall for one walked polygon via the GEE Value API.
//
// WHY CHIRPS: rainfall is the smallholder's real weather risk (dry spells, false
// onsets, planting windows). CHIRPS is a 5 km resolution daily product going back
// to 1981 — every farm in our beachhead has a record for its exact coordinates,
// no weather station needed. Among Plotline's configured providers only GEE
// carries CHIRPS, so this module is GEE-or-stub: no GEE_* credentials → the
// same honest stub shape the NDVI module returns unconfigured.
//
// HOW IT STAYS ONE NETWORK CALL: `ImageCollection.toBands()` turns each daily
// image into a band named by its acquisition date; `Reducer.forEachBand(sum)`
// then reduces every band independently, so one value:compute returns the full
// daily series. That is the same trick the NDVI series uses to dodge the Value
// API's inability to run client-defined per-element functions.
//
// HONESTY GUARDRAILS:
//   • CHIRPS is satellite-derived rainfall, not a rain gauge on the plot — 5 km
//     pixels cannot see a thunderstorm between the house and the far field.
//     Evidence for season feedback, not a forecast; never a gate.
//   • The CHIRPS *final* product lands with a lag of a few weeks; the tail of
//     the series can therefore be incomplete — gaps stay gaps, never zeros.
//
// Configuration: GEE_PROJECT_ID + GEE_CLIENT_EMAIL + GEE_PRIVATE_KEY (or inline
// GEE_SERVICE_ACCOUNT_JSON), and the service account must have Earth Engine API
// access. Everything unset → the stub, no network calls.

import { geeToken, geeServiceAccount } from './ndvi.mjs';
import { normalizePolygon, clampMonths } from './geo.mjs';
import { eeGraph } from './ee.mjs';

export const RAIN_SOURCE = 'stub (no provider configured)';
export const RAIN_GEE_SOURCE = 'gee chirps daily';

export const RAIN_DEFAULTS = Object.freeze({
  months: 6, // enough seasonal context, small enough to keep the call cheap
  minMonths: 1,
  maxMonths: 24,
  drySpellMm: 2, // a day below this counts as dry (standard CHIRPS conventions)
});

const GEE_VALUE_URL = (projectId) =>
  `https://earthengine.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/value:compute`;

// ---------- the Value API expression (one call, daily sums) ----------
// Serialized by server/ee.mjs. The shape below was verified live against the
// Value API (2026-11-09): GeometryConstructors.* for geometries, stacked
// Collection.filter calls with binary Filter.* comparisons, and
// ImageCollection.toBands turning each daily image into one band named
// `<YYYYMMDD>_precipitation`. Filters on `system:index` work because CHIRPS
// image ids are their acquisition dates; the reduceRegion geometry does the
// spatial restriction, so no bounds filter is needed. Reducer.mean over a
// single-band daily image is that day's precipitation average over the plot.
export function rainExpression({ polygonGeo, from, to }) {
  const ee = eeGraph();
  const ring = polygonGeo.coordinates[0]; // GLON/GLAT pairs, one closed ring
  const poly = ee.invoke('GeometryConstructors.Polygon', { coordinates: ee.constant(ring) });
  const collection = ee.invoke('ImageCollection.load', { id: ee.constant('UCSB-CHG/CHIRPS/DAILY') });
  // Filter.lt bounds EXCLUSIVELY, so the upper filter is the calendar day
  // after `to`; the product's own end (CHIRPS lands with a lag) stays honest.
  const idxFrom = new Date(from).toISOString().slice(0, 10).replace(/-/g, '');
  const idxToExcl = new Date(new Date(to).getTime() + 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');
  const fromDay = ee.invoke('Filter.gte', { leftField: ee.constant('system:index'), rightValue: ee.constant(idxFrom) });
  const untilDay = ee.invoke('Filter.lt', { leftField: ee.constant('system:index'), rightValue: ee.constant(idxToExcl) });
  const afterFrom = ee.invoke('Collection.filter', { collection: ee.ref(collection), filter: ee.ref(fromDay) });
  const local = ee.invoke('Collection.filter', { collection: ee.ref(afterFrom), filter: ee.ref(untilDay) });
  const banded = ee.invoke('ImageCollection.toBands', { collection: ee.ref(local) });
  const perDayMean = ee.invoke('Reducer.mean', {});
  const reduce = ee.invoke('Image.reduceRegion', {
    image: ee.ref(banded),
    reducer: ee.ref(perDayMean),
    geometry: ee.ref(poly),
    scale: ee.constant(5566), // CHIRPS native resolution: 0.05° ≈ 5.5 km
    maxPixels: ee.constant(1e13),
    bestEffort: ee.constant(true),
  });
  return { result: reduce, values: ee.nodes };
}

// ---------- parse: band names are dates ----------
// toBands sanitises names (dots → underscores): '20260115_…' style keys. Returns
// chronological [{ date: 'YYYY-MM-DD', mm }] for every band that yields a finite
// sum; days the product has not produced stay absent rather than zero.
export function parseChirpsDaily(result) {
  // value:compute answers `{"result": {"<band>": mm, ...}}` with one entry per
  // toBands band; older shapes stay accepted for tolerance.
  const bands = result?.result && !Array.isArray(result.result)
    ? result.result
    : result?.values?.[0] ?? result;
  if (!bands || typeof bands !== 'object' || Array.isArray(bands)) return null;
  const days = [];
  for (const [key, v] of Object.entries(bands)) {
    // band names come from the image ids: '20260115', '20260115_prcp', or
    // '2026_01_15'-style if a differently-dated collection ever swaps in
    const m = key.match(/^(\d{4})[-_]?(\d{2})[-_]?(\d{2})(?:[-_].*)?$/);
    const mm = Number(v);
    if (!m || !Number.isFinite(mm)) continue;
    days.push({ date: `${m[1]}-${m[2]}-${m[3]}`, mm: Math.round(mm * 100) / 100 });
  }
  if (!days.length) return null;
  return days.sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ---------- aggregations (pure, tested independently) ----------
// Weekly buckets: fixed-width 7-day slices starting at the first observed day —
// simple, honest, chartable. Monthly buckets: calendar months.
export function rainAggregates(daily, { now = new Date(), drySpellMm = RAIN_DEFAULTS.drySpellMm } = {}) {
  if (!Array.isArray(daily) || !daily.length) return null;
  const sorted = [...daily].sort((a, b) => (a.date < b.date ? -1 : 1));

  const weekSeries = [];
  for (let i = 0; i < sorted.length; i += 7) {
    const slice = sorted.slice(i, i + 7);
    weekSeries.push({
      from: slice[0].date,
      to: slice[slice.length - 1].date,
      mm: Math.round(slice.reduce((s, d) => s + d.mm, 0) * 100) / 100,
    });
  }
  const monthlySeries = [];
  let cursor = null;
  for (const d of sorted) {
    const key = d.date.slice(0, 7);
    if (!cursor || cursor.key !== key) {
      cursor = { key, from: d.date, to: d.date, mm: 0 };
      monthlySeries.push(cursor);
    }
    cursor.to = d.date;
    cursor.mm += d.mm;
  }
  for (const m of monthlySeries) m.mm = Math.round(m.mm * 100) / 100;

  // last-30-day total: only observed days count, and gaps never count as dry
  const cutoff30 = new Date(new Date(now).getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  const recent30 = sorted.filter((d) => d.date >= cutoff30);
  const last30Mm = Math.round(recent30.reduce((s, d) => s + d.mm, 0) * 100) / 100;

  // longest dry spell: consecutive observed days, each under the dry threshold
  let run = 0;
  let best = { days: 0 };
  for (const d of sorted) {
    if (d.mm < drySpellMm) {
      run++;
      if (run > best.days) best = { days: run, endedTs: d.date + 'T00:00:00Z' };
    } else {
      run = 0;
    }
  }

  const lastRain = [...sorted].reverse().find((d) => d.mm >= drySpellMm) ?? null;
  return {
    series: weekSeries,
    monthly: monthlySeries,
    totalMm: Math.round(sorted.reduce((s, d) => s + d.mm, 0) * 100) / 100,
    last30Mm,
    lastRainTs: lastRain ? lastRain.date + 'T00:00:00Z' : null,
    longestDrySpellDays: best.days,
    longestDrySpellEndedTs: best.days >= 1 ? best.endedTs : null,
  };
}

/**
 * Daily CHIRPS rainfall aggregated for one walked polygon.
 *
 * @param {{ polygon?: Array<{lat: number, lon: number}>, months?: number,
 *           env?: object, fetchImpl?: Function, now?: () => Date }} opts
 */
export async function rainEvidence({
  polygon,
  months = RAIN_DEFAULTS.months,
  env = process.env,
  fetchImpl = fetch,
  now = () => new Date(),
} = {}) {
  const checkedAt = now().toISOString();
  const effectiveMonths = clampMonths(months, { min: RAIN_DEFAULTS.minMonths, max: RAIN_DEFAULTS.maxMonths, fallback: RAIN_DEFAULTS.months });
  const meta = { source: RAIN_SOURCE, months: effectiveMonths, checkedAt };

  const norm = normalizePolygon(polygon);
  if (!norm.ok) return { status: 'bad_polygon', error: norm.error, ...meta };

  const dateTo = checkedAt;
  const dateFrom = new Date(new Date(checkedAt).getTime() - effectiveMonths * 30.44 * 86_400_000).toISOString();

  const sa = geeServiceAccount(env);
  if (!sa) {
    return {
      status: 'stub',
      ...meta,
      dateFrom,
      dateTo,
      series: null,
      monthly: null,
      totalMm: null,
      message: 'Rainfall check not yet live. Add the GEE service account credentials to enable CHIRPS daily rainfall for this plot.',
    };
  }

  try {
    const token = await geeToken({ env, fetchImpl, now: new Date(checkedAt) });
    const res = await fetchImpl(GEE_VALUE_URL(sa.projectId), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ expression: rainExpression({ polygonGeo: norm.geojson, from: dateFrom, to: dateTo }), workloadTag: 'plotline-rain' }),
    });
    if (!res.ok) {
      // EE errors name the exact algorithm that refused — surface it for debugging
      let detail = '';
      try { detail = String(await res.text()).replace(/\s+/g, ' ').slice(0, 300); } catch { /* empty body */ }
      const code = res.status >= 500 ? 'provider_error' : res.status === 401 || res.status === 403 ? 'auth_failed' : 'bad_request';
      return { status: 'unavailable', error: code, detail, ...meta };
    }
    const json = await res.json().catch(() => null);
    const daily = parseChirpsDaily(json);
    if (!daily) return { status: 'unavailable', error: 'no_valid_pixels', ...meta };
    const agg = rainAggregates(daily, { now: new Date(checkedAt) });
    if (!agg) return { status: 'unavailable', error: 'no_valid_pixels', ...meta };
    return {
      status: 'ok',
      source: RAIN_GEE_SOURCE,
      months: effectiveMonths,
      dateFrom,
      dateTo,
      checkedAt,
      centroid: norm.centroid,
      areaM2: Math.round(norm.areaM2),
      series: agg.series,
      monthly: agg.monthly,
      totalMm: agg.totalMm,
      last30Mm: agg.last30Mm,
      lastRainTs: agg.lastRainTs,
      longestDrySpellDays: agg.longestDrySpellDays,
      longestDrySpellEndedTs: agg.longestDrySpellEndedTs,
      note: 'satellite rainfall on 5 km CHIRPS pixels — not a gauge on the plot; the CHIRPS final product lags a few weeks',
    };
  } catch (err) {
    return { status: 'unavailable', error: err.code || 'provider_error', ...meta };
  }
}
