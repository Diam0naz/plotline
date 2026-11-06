// ndvi.mjs — NDVI / satellite vegetation index check for a plot.
//
// WHY: Self-reported survival counts are the primary evidence in this build. A
// satellite-derived vegetation index (NDVI or EVI) would provide an independent
// check: a plot with healthy canopy cover should show NDVI > ~0.4 in growing
// season. A sudden drop between monitoring periods is a red flag for clearing or
// significant dieback, even if the farmer reports good survival.
//
// This module is a STUB. It returns a clearly-labelled placeholder so the
// operator console can display the check without crashing when a real provider
// is not yet wired in. Replace `_fetchNdvi` with a real provider call when ready.
//
// ── Potential data sources ────────────────────────────────────────────────────
//
// 1. Google Earth Engine (GEE) — Sentinel-2 / Landsat NDVI via the REST API or
//    the Python / JavaScript client. Requires a GEE project and OAuth token.
//    https://developers.google.com/earth-engine/reference/rest
//
// 2. Microsoft Planetary Computer — STAC API + xarray / stackstac analysis.
//    Free tier available. Requires Azure subscription for large pulls.
//    https://planetarycomputer.microsoft.com/
//
// 3. Copernicus Data Space (SentinelHub) — Sentinel-2 NDVI via the Process API.
//    Free up to 30 000 processing units/month.
//    https://documentation.dataspace.copernicus.eu/APIs/SentinelHub.html
//
// 4. NASA AppEEARS — MODIS MOD13Q1 (250 m, 16-day composite) via REST.
//    Good for sparse areas with cloud cover; lower resolution than Sentinel.
//    https://appeears.earthdatacloud.nasa.gov/
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
// Cloud cover, sensor noise, and seasonal variation all affect the value.
//
// ─────────────────────────────────────────────────────────────────────────────

export const NDVI_SOURCE = 'stub (no provider configured)';
export const NDVI_DEFAULTS = Object.freeze({ bufferKm: 0.5, cloudMaxPct: 30 });

/**
 * Fetch the mean NDVI over a circular buffer around a point for a given
 * date range.  Returns a structured result in the same shape as fire.mjs so
 * the verifier console can display both checks uniformly.
 *
 * @param {{ lat: number, lon: number, bufferKm?: number, dateFrom?: string, dateTo?: string, cloudMaxPct?: number, fetchImpl?: Function, now?: () => Date }} opts
 * @returns {Promise<NdviResult>}
 */
export async function ndviEvidence({
  lat,
  lon,
  bufferKm = NDVI_DEFAULTS.bufferKm,
  dateFrom,
  dateTo,
  cloudMaxPct = NDVI_DEFAULTS.cloudMaxPct,
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

  // ── Replace this block with a real provider call ──────────────────────
  //
  // Example shape for a Sentinel-2 query via SentinelHub Process API:
  //
  //   const payload = {
  //     input: {
  //       bounds: { geometry: pointBuffer(lat, lon, bufferKm) },
  //       data: [{ type: 'S2L2A', dataFilter: { maxCloudCoverage: cloudMaxPct } }],
  //     },
  //     evalscript: `
  //       //VERSION=3
  //       function setup() { return { input: ['B04','B08'], output: { bands: 1 } }; }
  //       function evaluatePixel(s) {
  //         let ndvi = (s.B08 - s.B04) / (s.B08 + s.B04 + 0.0001);
  //         return [ndvi];
  //       }
  //     `,
  //     output: { responses: [{ identifier: 'default', format: { type: 'application/json' } }] },
  //   };
  //   const res = await fetchImpl('https://services.sentinel-hub.com/api/v1/process', {
  //     method: 'POST',
  //     headers: { Authorization: `Bearer ${process.env.SENTINELHUB_TOKEN}`, 'Content-Type': 'application/json' },
  //     body: JSON.stringify(payload),
  //   });
  //   const json = await res.json();
  //   const mean = json?.outputs?.default?.bands?.B0?.stats?.mean ?? null;
  //   return { status: 'ok', ...meta, ndvi: mean };
  //
  // ─────────────────────────────────────────────────────────────────────

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

/**
 * @typedef {Object} NdviResult
 * @property {'ok'|'unavailable'|'stub'} status
 * @property {string} source
 * @property {number} bufferKm
 * @property {string|null} dateFrom
 * @property {string|null} dateTo
 * @property {number} cloudMaxPct
 * @property {string} checkedAt
 * @property {number|null} ndvi       - mean NDVI over the buffer (null if unavailable)
 * @property {number|null} ndviMin
 * @property {number|null} ndviMax
 * @property {number|null} ndviStdDev
 * @property {number|null} pixelCount
 * @property {string} [error]
 * @property {string} [message]
 */
