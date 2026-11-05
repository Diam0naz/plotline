// Fire check for a plot: recent VIIRS thermal detections near a point.
// Source is the public "Satellite (VIIRS) Thermal Hotspots and Fire Activity" layer in ArcGIS
// Living Atlas. It needs no key and is read-only. This is evidence for the verifier, not proof:
// a detection is a 375 m pixel, and absence of detections is not proof that nothing burned.

const QUERY_URL =
  'https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services/Satellite_VIIRS_Thermal_Hotspots_and_Fire_Activity/FeatureServer/0/query';

export const FIRE_SOURCE = 'NASA FIRMS VIIRS (ArcGIS Living Atlas)';
export const FIRE_DEFAULTS = Object.freeze({ radiusKm: 5, days: 14, maxFeatures: 1000 });

const R = 6371;
function kmBetween(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

const round1 = (x) => Math.round(x * 10) / 10;

/**
 * Look for VIIRS detections within `radiusKm` of a point over the last `days`.
 * Never throws: failures come back as { status: 'unavailable', error }.
 */
export async function recentFires({
  lat,
  lon,
  radiusKm = FIRE_DEFAULTS.radiusKm,
  days = FIRE_DEFAULTS.days,
  fetchImpl = fetch,
  timeoutMs = 8000,
  now = () => new Date(),
} = {}) {
  const checkedAt = now().toISOString();
  const meta = { source: FIRE_SOURCE, radiusKm, days, checkedAt };
  if (
    !Number.isFinite(lat) || !Number.isFinite(lon) ||
    Math.abs(lat) > 90 || Math.abs(lon) > 180 ||
    !Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 50 ||
    !Number.isFinite(days) || days < 1 || days > 90
  ) {
    return { status: 'unavailable', error: 'bad_arguments', ...meta };
  }

  const since = new Date(Date.parse(checkedAt) - days * 86_400_000).toISOString().slice(0, 10);
  const url = new URL(QUERY_URL);
  url.search = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    distance: String(radiusKm),
    units: 'esriSRUnit_Kilometer',
    where: `acq_date >= DATE '${since}'`,
    outFields: 'latitude,longitude,acq_date,confidence,bright_ti4,satellite',
    returnGeometry: 'false',
    orderByFields: 'acq_date DESC',
    resultRecordCount: String(FIRE_DEFAULTS.maxFeatures),
    f: 'json',
  }).toString();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let json;
  try {
    const res = await fetchImpl(url.toString(), { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return { status: 'unavailable', error: `http_${res.status}`, ...meta };
    json = await res.json();
  } catch (err) {
    const error = err?.name === 'AbortError' ? 'timeout' : 'network';
    return { status: 'unavailable', error, ...meta };
  } finally {
    clearTimeout(timer);
  }
  if (json?.error) {
    const text = String(json.error.message || 'service_error').slice(0, 120);
    return { status: 'unavailable', error: text, ...meta };
  }

  const rows = (Array.isArray(json?.features) ? json.features : [])
    .map((f) => f?.attributes)
    .filter((a) => Number.isFinite(a?.latitude) && Number.isFinite(a?.longitude));

  let nearestKm = null;
  let latest = null;
  let brightest = null;
  const confidence = { high: 0, nominal: 0, low: 0, other: 0 };
  for (const a of rows) {
    const d = kmBetween(lat, lon, a.latitude, a.longitude);
    if (nearestKm === null || d < nearestKm) nearestKm = d;
    const t = Number(a.acq_date);
    if (Number.isFinite(t) && (latest === null || t > latest)) latest = t;
    if (Number.isFinite(a.bright_ti4) && (brightest === null || a.bright_ti4 > brightest)) brightest = a.bright_ti4;
    const c = String(a.confidence ?? '').toLowerCase();
    if (c in confidence) confidence[c] += 1;
    else confidence.other += 1;
  }

  return {
    status: 'ok',
    ...meta,
    count: rows.length,
    capped: rows.length >= FIRE_DEFAULTS.maxFeatures,
    nearestKm: nearestKm === null ? null : round1(nearestKm),
    latestAcq: latest === null ? null : new Date(latest).toISOString().slice(0, 10),
    maxBrightness: brightest === null ? null : round1(brightest),
    confidence,
  };
}

/**
 * Normalise fire evidence before it is signed into a decision. Returns null for anything that
 * is not a plausible check result, so a verifier cannot smuggle arbitrary payloads into the log.
 */
export function cleanFireEvidence(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (v.status !== 'ok' && v.status !== 'unavailable') return null;
  const inRange = (x, lo, hi) => Number.isFinite(x) && x >= lo && x <= hi;
  const intIn = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;
  const conf = v.confidence && typeof v.confidence === 'object' ? v.confidence : {};
  return {
    status: v.status,
    source: typeof v.source === 'string' ? v.source.slice(0, 80) : FIRE_SOURCE,
    radiusKm: inRange(v.radiusKm, 0.1, 50) ? round1(v.radiusKm) : FIRE_DEFAULTS.radiusKm,
    days: intIn(v.days, 1, 90) ? v.days : FIRE_DEFAULTS.days,
    checkedAt: typeof v.checkedAt === 'string' && !Number.isNaN(Date.parse(v.checkedAt))
      ? new Date(v.checkedAt).toISOString()
      : null,
    count: intIn(v.count, 0, 100_000) ? v.count : 0,
    nearestKm: inRange(v.nearestKm, 0, 100) ? round1(v.nearestKm) : null,
    latestAcq: typeof v.latestAcq === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.latestAcq) ? v.latestAcq : null,
    maxBrightness: inRange(v.maxBrightness, 0, 1000) ? round1(v.maxBrightness) : null,
    confidence: ['high', 'nominal', 'low', 'other'].reduce((o, k) => {
      o[k] = intIn(conf[k], 0, 100_000) ? conf[k] : 0;
      return o;
    }, {}),
    error: typeof v.error === 'string' ? v.error.slice(0, 60) : null,
  };
}

/** True when there is a recent detection close enough that a verifier should look. */
export function fireConcern(fire) {
  if (!fire || fire.status !== 'ok' || !fire.count) return false;
  const near = fire.nearestKm;
  const days = fire.days ?? FIRE_DEFAULTS.days;
  if (near === null || near === undefined) return false;
  return near <= Math.max(1, fire.radiusKm ?? FIRE_DEFAULTS.radiusKm) && days <= 30;
}
