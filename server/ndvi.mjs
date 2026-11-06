// ndvi.mjs — satellite NDVI vegetation check for a plot verification.
//
// WHY: Self-reported survival counts are the primary evidence in this build. A
// satellite-derived vegetation index provides an independent check: a plot with
// healthy canopy cover should show NDVI > ~0.4 in growing season. A sudden drop
// between monitoring periods is a red flag for clearing or significant dieback,
// even if the farmer reports good survival.
//
// ── Provider choice ───────────────────────────────────────────────────────────
//
// The Sentinel Hub **Statistical API** (option 3 of the candidates below) fits
// this zero-dependency Node backend by a wide margin:
//   • it computes NDVI statistics server-side and returns plain JSON
//     (mean / min / max / stDev / valid-pixel counts per time bucket) — no
//     raster code, no Python sidecar, no COG range requests;
//   • one authenticated POST, a normalised JSON result in exactly the shape the
//     fire check uses, so a verifier can sign it into the decision.
// Alternatives (kept for the record, not wired):
//   • Microsoft Planetary Computer: Python-native (pystac-client + odc-stac).
//     Great free data, but pixels must be downloaded and reduced ourselves —
//     that is a Python-service job, out of place in this app. Data access also
//     needs Azure SAS signing; their STAC metadata is open but limited by
//     rate-limits without a (free) subscription key.
//   • carbonplan.org's open tools (ndpyramid, maps, forest-risks): strong for
//     organising/visualising multi-scale rasters, but they contain no NDVI
//     computation. Relevant only if the console ever renders NDVI heatmaps;
//     for now our console shows the numbers the verifier signs.
//   • Google Earth Engine / NASA AppEEARS: heavier auth and service shape than
//     one POST; revisit if Sentinel Hub quotas ever bite.
//             https://docs.sentinel-hub.com/api/latest/api/statistical/
//             https://planetarycomputer.microsoft.com/
//             https://github.com/carbonplan
//
// ── NDVI interpretation (indicative only) ────────────────────────────────────
//
//   < 0.1  : bare soil or built surface
//   0.1–0.2: sparse vegetation / degraded land
//   0.2–0.4: open shrubland or early-stage agroforestry
//   0.4–0.6: moderate canopy, established agroforestry
//   0.6–0.8: dense canopy, closed-canopy forest / agroforestry
//   > 0.8  : very dense tropical canopy
//
// A verifier should treat NDVI as one data point among several, not as proof.
// Cloud cover, sensor noise, and seasonal variation all affect the value — the
// per-month buckets are included so the trend is visible, not just the mean.
//
// ── Configuration ────────────────────────────────────────────────────────────
//
//   SENTINELHUB_TOKEN                bearer token (fastest; expires fast)
//   SENTINELHUB_CLIENT_ID + SECRET   or OAuth client credentials (recommended)
//   SENTINELHUB_BASE_URL             default https://services.sentinel-hub.com
// Copernicus Data Space (free, same API): COPERNICUS_CLIENT_ID + SECRET (or
// COPERNICUS_TOKEN) resolve to sh.dataspace.copernicus.eu + CDSE realm.
// Google Earth Engine (service account): GEE_PROJECT_ID + GEE_CLIENT_EMAIL +
// GEE_PRIVATE_KEY (or inline GEE_SERVICE_ACCOUNT_JSON) use the Value API.
//   NDVI_PROVIDER=sentinel-hub|gee   force one; default SH/Copernicus, then GEE.
// Everything unset → the honest stub result, no network calls.
// ─────────────────────────────────────────────────────────────────────────────

import { createSign } from 'node:crypto';

export const NDVI_SOURCE = 'stub (no provider configured)';
export const NDVI_SH_SOURCE = 'sentinel-hub statistical api';
export const NDVI_GEE_SOURCE = 'gee value api';
export const NDVI_DEFAULTS = Object.freeze({ bufferKm: 0.5, cloudMaxPct: 30, periodDays: 90 });
const TOKEN_GRACE_MS = 30_000;
const GEE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GEE_SCOPE = 'https://www.googleapis.com/auth/earthengine.readonly';
const GEE_TOKEN_CACHE_MS = 300_000; // EE access tokens live 1 h; refresh 5 min early
const GEE_OAUTH2_ARG = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

// Sentinel-2 L2A: B04 = red, B08 = NIR, 10 m pixels, DN units (0 = no data).
const NDVI_EVALSCRIPT = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ['B04', 'B08', 'dataMask'], units: 'DN' }],
    output: [
      { id: 'ndvi', bands: 1, sampleType: 'FLOAT32' },
      { id: 'mask', bands: 1, sampleType: 'UINT8' },
    ],
  };
}
function evaluatePixel(s) {
  const denom = s.B08 + s.B04;
  const ndvi = denom > 0 ? (s.B08 - s.B04) / denom : 0;
  const valid = s.dataMask > 0 && s.B04 > 0 && s.B08 > 0 ? 1 : 0;
  return { ndvi: [ndvi], mask: [valid] };
}`;

export function ndviConfigured(env = process.env) {
  return !!ndviProvider(env);
}

// Which service is actually being addressed. Two providers speak the same
// Sentinel Hub API protocol:
//   • commercial Sentinel Hub (services.sentinel-hub.com, SINERGISE/Planet)
//   • the free Copernicus Data Space Ecosystem (sh.dataspace.copernicus.eu)
// CDSE is recognised by its COPERNICUS_* credentials, or an explicit base URL —
// the token realm differs (`identity.dataspace.copernicus.eu`, realm CDSE).
export function ndviEndpoints(env = {}) {
  const isCdse = !!(env.COPERNICUS_CLIENT_ID || env.COPERNICUS_CLIENT_SECRET || env.COPERNICUS_TOKEN);
  const base = env.SENTINELHUB_BASE_URL || (isCdse ? 'https://sh.dataspace.copernicus.eu' : 'https://services.sentinel-hub.com');
  const tokenUrl = env.SENTINELHUB_AUTH_URL
    || (base.includes('dataspace.copernicus.eu')
      ? 'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token'
      : `${base}/auth/realms/main/protocol/openid-connect/token`);
  return { base, tokenUrl };
}

export function credsFor(env = {}) {
  // SENTINELHUB_* names first (they also let you point a custom base URL);
  // COPERNICUS_* are the free Data Space equivalent, same API protocol.
  if (env.SENTINELHUB_TOKEN) return { mode: 'bearer', token: env.SENTINELHUB_TOKEN };
  if (env.SENTINELHUB_CLIENT_ID && env.SENTINELHUB_CLIENT_SECRET) {
    return { mode: 'oauth', clientId: env.SENTINELHUB_CLIENT_ID, clientSecret: env.SENTINELHUB_CLIENT_SECRET };
  }
  if (env.COPERNICUS_TOKEN) return { mode: 'bearer', token: env.COPERNICUS_TOKEN };
  if (env.COPERNICUS_CLIENT_ID && env.COPERNICUS_CLIENT_SECRET) {
    return { mode: 'oauth', clientId: env.COPERNICUS_CLIENT_ID, clientSecret: env.COPERNICUS_CLIENT_SECRET };
  }
  return { mode: 'none' };
}

// ---------- Google Earth Engine provider ----------
// GEE speaks a different protocol: its Value API takes a JSON expression tree
// (an EE computation DAG) and returns the computed value. Auth is a service
// account signing a JWT with RS256 — pure node:crypto, no dependency. Because
// the expression tree is hand-built here rather than compiled by an EE client
// library, treat this provider as the fallback; the Sentinel Hub providers are
// the well-trodden path. NDVI_PROVIDER=gee forces it regardless.

export function ndviProvider(env = {}) {
  const forced = env.NDVI_PROVIDER;
  if (forced === 'gee' || forced === 'sentinel-hub') return forced;
  if (credsFor(env).mode !== 'none') return 'sentinel-hub';
  if (geeServiceAccount(env)) return 'gee';
  return null;
}

export function geeServiceAccount(env = {}) {
  if (env.GEE_SERVICE_ACCOUNT_JSON) {
    try {
      const j = JSON.parse(env.GEE_SERVICE_ACCOUNT_JSON);
      if (!j?.client_email || !j?.private_key) return null;
      return {
        clientEmail: j.client_email,
        privateKey: String(j.private_key).replace(/\\n/g, '\n'),
        projectId: j.project_id || env.GEE_PROJECT_ID || 'earthengine-legacy',
      };
    } catch {
      return null; // malformed inline JSON counts as "not configured"
    }
  }
  if (env.GEE_CLIENT_EMAIL && env.GEE_PRIVATE_KEY) {
    return {
      clientEmail: env.GEE_CLIENT_EMAIL,
      // .env files are line-based, so the PEM travels with literal \n escapes.
      privateKey: env.GEE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      projectId: env.GEE_PROJECT_ID || 'earthengine-legacy',
    };
  }
  return null;
}

let geeTokenCache = null;
const b64urlJson = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

export async function geeToken({ env = {}, fetchImpl = fetch, now = new Date() } = {}) {
  const sa = geeServiceAccount(env);
  if (!sa) throw Object.assign(new Error('gee: no service account'), { code: 'auth_failed' });
  if (geeTokenCache && geeTokenCache.key === sa.clientEmail && Date.now() < geeTokenCache.expiresAt) {
    return geeTokenCache.token;
  }
  const iat = Math.floor(now.getTime() / 1000);
  const claims = { iss: sa.clientEmail, scope: GEE_SCOPE, aud: GEE_TOKEN_URL, iat, exp: iat + 3600 };
  const input = `${b64urlJson({ alg: 'RS256', typ: 'JWT' })}.${b64urlJson(claims)}`;
  const signature = createSign('RSA-SHA256').update(input).sign(sa.privateKey);
  const assertion = `${input}.${Buffer.from(signature).toString('base64url')}`;
  const res = await fetchImpl(GEE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: GEE_OAUTH2_ARG, assertion }).toString(),
  });
  if (!res.ok) throw Object.assign(new Error(`gee auth ${res.status}`), { code: 'auth_failed' });
  const tok = await res.json().catch(() => null);
  if (!tok?.access_token) throw Object.assign(new Error('gee auth: no token'), { code: 'auth_failed' });
  // Cache hard by clock here (unlike the Sentinel Hub cache) so injected `now`
  // values in tests can't trick it into serving a token twice beyond its TTL.
  const ttlMs = Math.min((Number(tok.expires_in) || 3600) * 1000, 3_600_000) - GEE_TOKEN_CACHE_MS;
  geeTokenCache = { key: sa.clientEmail, token: tok.access_token, expiresAt: Date.now() + Math.max(60_000, ttlMs) };
  return geeTokenCache.token;
}

// Sentinel-2 Surface Reflectance, harmonized to old band naming (B4 red, B8 NIR).
// Cloud filter uses the scene-level CLOUDY_PIXEL_OVER_LAND_COVER property, which
// exists on every S2 SR image; the mean composite then gets NDVI computed once,
// and one reduceRegion sums up mean/min/max/stdDev over the buffered point.
export function geeNdviExpression({ lat, lon, bufferKm, cloudMaxPct, from, to }) {
  const P = (value) => ({ value });
  const F = (functionName, args) => ({ functionName, arguments: args });
  const region = F('Geometry.buffer', {
    geometry: F('Geometry.Point', { coordinates: P([lon, lat]) }),
    distance: P(bufferKm * 1000),
  });
  const collection = F('ImageCollection.load', { id: P('COPERNICUS/S2_SR_HARMONIZED') });
  const dated = F('Collection.filterDate', { collection, start: P(from.slice(0, 10)), end: P(to.slice(0, 10)) });
  const cloudFree = F('Collection.filterMetadata', {
    collection: dated,
    name: P('CLOUDY_PIXEL_OVER_LAND_COVER'),
    operator: P('less_than'),
    value: P(cloudMaxPct),
  });
  const composite = F('reduce.mean', { collection: cloudFree });
  const ndvi = F('Image.normalizedDifference', { image: composite, bandNames: P(['B8', 'B4']) });
  const reducer = F('Reducer.combine', {
    reducer1: F('Reducer.mean', {}),
    reducer2: F('Reducer.combine', {
      reducer1: F('Reducer.stdDev', {}),
      reducer2: F('Reducer.minMax', {}),
      sharedInputs: P(true),
    }),
    sharedInputs: P(true),
  });
  const reduce = F('Image.reduceRegion', {
    image: ndvi,
    reducer,
    geometry: region,
    scale: P(10),
    maxPixels: P(1e13),
    bestEffort: P(true),
  });
  return { result: '0', values: { 0: reduce } };
}

export function parseGeeNdvi(result) {
  const o = result && typeof result === 'object' ? result : null;
  if (!o) return null;
  const num = (k) => {
    const v = Number(o[k]);
    return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
  };
  const mean = num('ndvi_mean') ?? num('mean');
  if (mean === null) return null;
  return {
    ndvi: mean,
    ndviMin: num('ndvi_min') ?? num('min'),
    ndviMax: num('ndvi_max') ?? num('max'),
    ndviStdDev: num('ndvi_stdDev') ?? num('standard_deviation') ?? num('stdDev'),
  };
}

// ---------- degrees → bbox for a buffer around a point ----------
export function bboxFor(lat, lon, bufferKm) {
  const dLat = bufferKm / 111.32; // ≈ degrees of latitude per km, good enough for ≤ 10 km buffers
  const dLon = bufferKm / (111.32 * Math.max(0.1, Math.cos(lat * Math.PI / 180)));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  return [
    clamp(lon - dLon, -180, 180),
    clamp(lat - dLat, -85, 85),
    clamp(lon + dLon, -180, 180),
    clamp(lat + dLat, -85, 85),
  ];
}

function isoDaysAgo(iso, days) { return new Date(new Date(iso).getTime() - days * 86_400_000).toISOString(); }

// ---------- auth (client-credentials OAuth; a raw bearer skips this) ----------
let tokenCache = null;
export async function sentinelHubToken({ env = process.env, fetchImpl = fetch }) {
  const creds = credsFor(env);
  if (creds.mode === 'bearer') return creds.token;
  const { tokenUrl } = ndviEndpoints(env);
  const key = `${tokenUrl}|${creds.clientId}`;
  if (tokenCache && tokenCache.key === key && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const res = await fetchImpl(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }).toString(),
  });
  if (!res.ok) throw Object.assign(new Error(`sentinel hub auth ${res.status}`), { code: 'auth_failed' });
  const tok = await res.json().catch(() => null);
  if (!tok?.access_token) throw Object.assign(new Error('sentinel hub auth: no token'), { code: 'auth_failed' });
  const ttl = Math.max(5, (Number(tok.expires_in) || 300) - 3) * 1000;
  tokenCache = { key, token: tok.access_token, expiresAt: Date.now() + ttl - TOKEN_GRACE_MS };
  return tokenCache.token;
}

// ---------- build the statistical request ----------
export function statsRequest({ lat, lon, bufferKm, cloudMaxPct, from, to }) {
  const timeRange = { from, to };
  return {
    input: {
      bounds: {
        bbox: bboxFor(lat, lon, bufferKm),
        properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' },
      },
      data: [{
        type: 'sentinel-2-l2a',
        dataFilter: { timeRange, maxCloudCoverage: cloudMaxPct },
        reprocessing: 'latest',
      }],
    },
    aggregation: {
      timeRange,
      aggregationInterval: { of: 'P1M' }, // monthly buckets: the trend stays visible
      evalscript: NDVI_EVALSCRIPT,
      resamplingMethod: 'BILINEAR',
    },
  };
}

// ---------- parse the response into our honest evidence ----------
// Weighted mean across monthly buckets (pixels weighted by valid count), overall
// min/max, stDev combined across buckets (within-month variance plus spread of
// month means). Empty result = null, and the caller reports it as unavailable.
export function parseNdviStats(data) {
  const buckets = Object.values(data?.data || {});
  const parts = buckets.map((b) => {
    const s = b?.statistics?.ndvi ?? b?.basic?.ndvi;
    const valid = (Number(b?.totalCount) || 0) - (Number(b?.noDataCount) || 0);
    if (!s || !Number.isFinite(s.mean) || valid <= 0) return null;
    const period = [];
    if (b.interval?.from) period.push(b.interval.from);
    if (b.interval?.to) period.push(b.interval.to);
    return { mean: s.mean, min: s.min, max: s.max, stDev: s.stDev ?? 0, valid, period };
  }).filter(Boolean);
  if (!parts.length) return null;
  const pixels = parts.reduce((a, p) => a + p.valid, 0);
  const mean = parts.reduce((a, p) => a + p.mean * p.valid, 0) / pixels;
  const within = parts.reduce((a, p) => {
    const w = p.stDev * p.stDev;
    return a + (p.mean - mean) * (p.mean - mean) * (p.valid / pixels) + (w * p.valid) / pixels;
  }, 0);
  return {
    ndvi: Math.round(mean * 1000) / 1000,
    ndviMin: Math.round(Math.min(...parts.map((p) => p.min)) * 1000) / 1000,
    ndviMax: Math.round(Math.max(...parts.map((p) => p.max)) * 1000) / 1000,
    ndviStdDev: Math.round(Math.sqrt(Math.max(0, within)) * 1000) / 1000,
    pixelCount: pixels,
    periods: parts.map((p) => ({ from: p.period[0] ?? null, to: p.period[1] ?? null, ndvi: Math.round(p.mean * 1000) / 1000, pixels: p.valid })),
  };
}

/**
 * Fetch NDVI statistics over a circular buffer around a point for a given
 * date range. Returns a structured result in the same shape as fire.mjs so
 * the verifier console can display both checks uniformly.
 *
 * @param {{ lat: number, lon: number, bufferKm?: number, dateFrom?: string, dateTo?: string,
 *           cloudMaxPct?: number, env?: object, fetchImpl?: Function, now?: () => Date }} opts
 */
export async function ndviEvidence({
  lat,
  lon,
  bufferKm = NDVI_DEFAULTS.bufferKm,
  dateFrom,
  dateTo,
  cloudMaxPct = NDVI_DEFAULTS.cloudMaxPct,
  env = process.env,
  fetchImpl = fetch,
  now = () => new Date(),
} = {}) {
  const checkedAt = now().toISOString();
  const meta = {
    source: NDVI_SOURCE,
    bufferKm,
    dateFrom: dateFrom ?? null,
    dateTo: dateTo ?? null,
    cloudMaxPct,
    checkedAt,
  };

  if (
    !Number.isFinite(lat) || !Number.isFinite(lon) ||
    Math.abs(lat) > 90 || Math.abs(lon) > 180
  ) {
    return { status: 'unavailable', error: 'bad_arguments', ...meta };
  }

  if (!ndviConfigured(env)) {
    return {
      status: 'stub',
      ...meta,
      ndvi: null,
      ndviMin: null,
      ndviMax: null,
      ndviStdDev: null,
      pixelCount: null,
      message: 'NDVI check not yet implemented. Wire a satellite data provider (e.g. SentinelHub, GEE, Planetary Computer) to enable this check.',
    };
  }

  const effectiveFrom = validIso(dateFrom) ? new Date(dateFrom).toISOString() : isoDaysAgo(checkedAt, NDVI_DEFAULTS.periodDays);
  const effectiveTo = validIso(dateTo) ? new Date(dateTo).toISOString() : checkedAt;

  try {
    if (ndviProvider(env) === 'gee') return await geeEvidence({ lat, lon, bufferKm, cloudMaxPct, effectiveFrom, effectiveTo, env, fetchImpl, meta });
    const { base } = ndviEndpoints(env);
    const token = await sentinelHubToken({ env, fetchImpl });
    const res = await fetchImpl(`${base}/api/v1/statistical`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(statsRequest({ lat, lon, bufferKm, cloudMaxPct, from: effectiveFrom, to: effectiveTo })),
    });
    if (!res.ok) {
      const code = res.status >= 500 ? 'provider_error' : res.status === 401 || res.status === 403 ? 'auth_failed' : 'bad_request';
      return { status: 'unavailable', error: code, ...meta };
    }
    const json = await res.json().catch(() => null);
    const stats = parseNdviStats(json);
    if (!stats) return { status: 'unavailable', error: 'no_valid_pixels', ...meta };
    return {
      status: 'ok',
      source: NDVI_SH_SOURCE,
      bufferKm,
      dateFrom: effectiveFrom,
      dateTo: effectiveTo,
      cloudMaxPct,
      checkedAt,
      ndvi: stats.ndvi,
      ndviMin: stats.ndviMin,
      ndviMax: stats.ndviMax,
      ndviStdDev: stats.ndviStdDev,
      pixelCount: stats.pixelCount,
      periods: stats.periods,
    };
  } catch (err) {
    return { status: 'unavailable', error: err.code || 'provider_error', ...meta };
  }
}

// ---------- GEE flow (Value API) ----------
async function geeEvidence({ lat, lon, bufferKm, cloudMaxPct, effectiveFrom, effectiveTo, env, fetchImpl, meta }) {
  const token = await geeToken({ env, fetchImpl, now: new Date(meta.checkedAt) });
  const sa = geeServiceAccount(env);
  const url = `https://earthengine.googleapis.com/v1/projects/${encodeURIComponent(sa.projectId)}/value:compute`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      expression: geeNdviExpression({ lat, lon, bufferKm, cloudMaxPct, from: effectiveFrom, to: effectiveTo }),
      workloadTag: 'plotline-ndvi',
    }),
  });
  if (!res.ok) {
    // Surface the provider's own message: EE expression errors name the exact
    // algorithm that refused, which is how this hand-built DAG gets debugged.
    let detail = '';
    try { detail = String(await res.text()).replace(/\s+/g, ' ').slice(0, 300); } catch { /* empty body */ }
    const code = res.status >= 500 ? 'provider_error' : res.status === 401 || res.status === 403 ? 'auth_failed' : 'bad_request';
    return { status: 'unavailable', error: code, detail, ...meta };
  }
  const json = await res.json().catch(() => null);
  const stats = parseGeeNdvi(json?.result ?? json);
  if (!stats) return { status: 'unavailable', error: 'no_valid_pixels', ...meta };
  return {
    status: 'ok',
    source: NDVI_GEE_SOURCE,
    bufferKm,
    dateFrom: effectiveFrom,
    dateTo: effectiveTo,
    cloudMaxPct,
    checkedAt: meta.checkedAt,
    ndvi: stats.ndvi,
    ndviMin: stats.ndviMin,
    ndviMax: stats.ndviMax,
    ndviStdDev: stats.ndviStdDev,
    pixelCount: null, // the Value API returns one reduced blob, not per-bucket counts
    periods: null,
  };
}

function validIso(v) {
  return typeof v === 'string' && v.length > 0 && !Number.isNaN(new Date(v).getTime());
}
