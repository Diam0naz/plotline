// geo.mjs — polygon helpers shared by the satellite modules (NDVI series, rain).
//
// The farmer app owns the boundary client-side (farms store polygon: [{lat,lon}]),
// so every per-plot service request carries the polygon instead of an id. These
// helpers normalise and sanity-gate that shape once, so NDVI and rainfall stay
// consistent about what "one walked plot" means.

import { polygonAreaM2 } from '../core.js';

// Accepts [{lat, lon}] (the app shape), rounds to 7 dp, drops consecutive and
// closing duplicates (walked boundaries usually end where they start), closes
// the ring, and refuses implausible geometry. Returns
// { ok, pts, areaM2, centroid, geojson } — geojson ring is [[lon, lat], ...] —
// or { ok: false, error } with a message fit for the farmer's screen.
export function normalizePolygon(
  polygon,
  { maxVertices = 64, maxAreaM2 = 20 * 10_000, capLabel = '20 ha per plot' } = {},
) {
  if (!Array.isArray(polygon)) return { ok: false, error: 'polygon must be an array of {lat, lon} points' };
  const pts = [];
  for (const p of polygon) {
    if (!p || typeof p !== 'object' || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)
      || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) {
      return { ok: false, error: 'polygon points must carry a valid lat and lon within range' };
    }
    const q = { lat: Math.round(p.lat * 1e7) / 1e7, lon: Math.round(p.lon * 1e7) / 1e7 };
    const prev = pts[pts.length - 1];
    if (prev && prev.lat === q.lat && prev.lon === q.lon) continue;
    pts.push(q);
  }
  if (pts.length > 1 && pts[0].lat === pts[pts.length - 1].lat && pts[0].lon === pts[pts.length - 1].lon) pts.pop();
  if (pts.length < 3) return { ok: false, error: 'polygon needs at least 3 distinct corners' };
  if (pts.length > maxVertices) return { ok: false, error: 'polygon exceeds ' + maxVertices + ' corners — simplify the boundary' };
  const areaM2 = polygonAreaM2(pts);
  if (!(areaM2 > 0)) return { ok: false, error: 'polygon area is zero — the corners likely sit on one line' };
  if (areaM2 > maxAreaM2) {
    return { ok: false, error: 'polygon is too large (' + (areaM2 / 10_000).toFixed(1) + ' ha; capped at ' + capLabel + ')' };
  }
  const centroid = {
    lat: Math.round((pts.reduce((s, p) => s + p.lat, 0) / pts.length) * 1e7) / 1e7,
    lon: Math.round((pts.reduce((s, p) => s + p.lon, 0) / pts.length) * 1e7) / 1e7,
  };
  const ring = pts.map((p) => [p.lon, p.lat]);
  return {
    ok: true,
    pts,
    areaM2,
    centroid,
    geojson: { type: 'Polygon', coordinates: [[...ring, ring[0]]] },
  };
}

// Pull a "months" knob into an honest range. Generic here: each module passes
// its own window rules (NDVI clamps 3..24 with default 12; rainfall 1..24).
export function clampMonths(v, { min, max, fallback }) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
