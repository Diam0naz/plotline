// core.js — pure logic for Plotline. Runs in the browser and in Node (>=20).
// No DOM access here, so everything is unit-testable.

const R = 6371008.8; // mean Earth radius, metres
const toRad = (d) => (d * Math.PI) / 180;

// ---------- geometry ----------

export function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function perimeterM(poly) {
  if (poly.length < 2) return 0;
  let d = 0;
  for (let i = 0; i < poly.length; i++) d += haversine(poly[i], poly[(i + 1) % poly.length]);
  return d;
}

// Spherical polygon area (Chamberlain–Duquette). Accurate for farm-sized plots.
export function polygonAreaM2(poly) {
  if (poly.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const p1 = poly[i];
    const p2 = poly[(i + 1) % poly.length];
    sum += toRad(p2.lon - p1.lon) * (2 + Math.sin(toRad(p1.lat)) + Math.sin(toRad(p2.lat)));
  }
  return Math.abs((sum * R * R) / 2);
}

export const m2ToHa = (m2) => m2 / 10000;

export function centroid(poly) {
  const n = poly.length || 1;
  return {
    lat: poly.reduce((s, p) => s + p.lat, 0) / n,
    lon: poly.reduce((s, p) => s + p.lon, 0) / n,
  };
}

// Ray casting; fine at farm scale.
export function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].lon, yi = poly[i].lat;
    const xj = poly[j].lon, yj = poly[j].lat;
    const hit = yi > pt.lat !== yj > pt.lat && pt.lon < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

const B32 = '0123456789bcdefghjkmnpqrstuvwxyz';
export function geohash(lat, lon, precision = 7) {
  let idx = 0, bit = 0, even = true, hash = '';
  const latR = [-90, 90], lonR = [-180, 180];
  while (hash.length < precision) {
    const r = even ? lonR : latR;
    const v = even ? lon : lat;
    const mid = (r[0] + r[1]) / 2;
    if (v >= mid) { idx = idx * 2 + 1; r[0] = mid; } else { idx = idx * 2; r[1] = mid; }
    even = !even;
    if (++bit === 5) { hash += B32[idx]; bit = 0; idx = 0; }
  }
  return hash;
}

// ---------- GNSS fix quality ----------
// Browsers expose position + accuracy only (no raw satellite data, no mock-provider flag),
// so these are plausibility checks, not proof. A native Android build can add raw GNSS later.

export function assessFix(fix, prev, farm, now = Date.now()) {
  const flags = [];
  let score = 100;

  if (fix.acc > 50) { score -= 40; flags.push('low_accuracy'); }
  else if (fix.acc > 20) { score -= 15; flags.push('moderate_accuracy'); }

  if (Math.abs(now - fix.ts) > 300000) { score -= 25; flags.push('clock_drift'); }

  if (prev) {
    const dt = (fix.ts - prev.ts) / 1000;
    if (dt > 0 && dt < 600) {
      const v = haversine(prev, fix) / dt;
      if (v > 40) { score -= 40; flags.push('impossible_jump'); }
    }
  }

  const dec = (x) => (String(x).split('.')[1] || '').length;
  // Round-coordinate heuristic: 5 decimal places ≈ 1 m precision.
   // Raised from 3 to reduce false positives (motorbikes, legitimate notes).
  if (dec(fix.lat) <= 5 && dec(fix.lon) <= 5) { score -= 20; flags.push('suspicious_precision'); }

  if (farm && farm.polygon && farm.polygon.length >= 3 && !pointInPolygon(fix, farm.polygon)) {
    score -= 20; flags.push('outside_boundary');
  }
  return { score: Math.max(0, score), flags };
}

// ---------- input calculator ----------
// Defaults are starting points only; the UI lets the user edit every number.

export const CROPS = {
  maize:   { label: 'Maize',   rowCm: 75,  plantCm: 25,  seedKgHa: 20,  npkKgHa: 300, ureaKgHa: 100 },
  rice:    { label: 'Rice',    rowCm: 20,  plantCm: 20,  seedKgHa: 60,  npkKgHa: 200, ureaKgHa: 100 },
  cassava: { label: 'Cassava', rowCm: 100, plantCm: 100, seedKgHa: 0,   npkKgHa: 200, ureaKgHa: 0 },
  tomato:  { label: 'Tomato',  rowCm: 60,  plantCm: 50,  seedKgHa: 0.3, npkKgHa: 300, ureaKgHa: 100 },
};

export function inputPlan(areaHa, p) {
  const spacingM2 = (p.rowCm / 100) * (p.plantCm / 100);
  const plantsPerHa = spacingM2 > 0 ? 10000 / spacingM2 : 0;
  const seedKg = areaHa * p.seedKgHa;
  const npkKg = areaHa * p.npkKgHa;
  const ureaKg = areaHa * p.ureaKgHa;
  return {
    plants: Math.round(areaHa * plantsPerHa),
    seedKg, npkKg, ureaKg,
    npkBags: Math.ceil(npkKg / 50),
    ureaBags: Math.ceil(ureaKg / 50),
  };
}

// ---------- outbreak clusters ----------

export function findClusters(reports, opts = {}) {
  const { radiusM = 1000, days = 14, min = 3, now = Date.now() } = opts;
  const cutoff = now - days * 86400000;
  const recent = reports.filter(
    (r) => r.type !== 'healthy' && new Date(r.ts).getTime() >= cutoff
  );
  const used = new Set();
  const clusters = [];
  const types = [...new Set(recent.map((r) => r.type))];
  for (const type of types) {
    const same = recent.filter((r) => r.type === type);
    for (const c of same) {
      if (used.has(c.id)) continue;
      const near = same.filter((r) => !used.has(r.id) && haversine(c, r) <= radiusM);
      if (near.length >= min) {
        near.forEach((r) => used.add(r.id));
        clusters.push({
          type,
          count: near.length,
          lat: near.reduce((s, r) => s + r.lat, 0) / near.length,
          lon: near.reduce((s, r) => s + r.lon, 0) / near.length,
          maxSeverity: Math.max(...near.map((r) => r.severity || 1)),
        });
      }
    }
  }
  return clusters.sort((a, b) => b.count - a.count);
}

// Share of polygon a that lies inside polygon b, by grid sampling over a's bounding box.
// Used to catch the same land being registered twice (double counting).
export function overlapFraction(a, b, grid = 60) {
  if (a.length < 3 || b.length < 3) return 0;
  const box = (p) => ({
    minLat: Math.min(...p.map((q) => q.lat)), maxLat: Math.max(...p.map((q) => q.lat)),
    minLon: Math.min(...p.map((q) => q.lon)), maxLon: Math.max(...p.map((q) => q.lon)),
  });
  const A = box(a), B = box(b);
  if (A.maxLat < B.minLat || B.maxLat < A.minLat || A.maxLon < B.minLon || B.maxLon < A.minLon) return 0;
  let inA = 0, inBoth = 0;
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      const pt = {
        lat: A.minLat + ((i + 0.5) / grid) * (A.maxLat - A.minLat),
        lon: A.minLon + ((j + 0.5) / grid) * (A.maxLon - A.minLon),
      };
      if (pointInPolygon(pt, a)) { inA++; if (pointInPolygon(pt, b)) inBoth++; }
    }
  }
  return inA ? inBoth / inA : 0;
}

// Reports with a weak or suspicious GNSS fix must not drive heat maps or outbreak alerts,
// otherwise a few spoofed reports could raise a false alert or hide a real one.
export function usableReports(reports, minScore = 50) {
  return reports.filter((r) => (r.q ?? 100) >= minScore);
}

// ---------- hashing, signing, Merkle ----------

const enc = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function sha256Hex(str) {
  return hex(await subtle().digest('SHA-256', enc.encode(str)));
}

// Deterministic JSON: sorted keys, so the same record always hashes the same.
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

export const hashBody = (body) => sha256Hex(canonical(body));

export async function generateKeys() {
  const kp = await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return {
    pub: await subtle().exportKey('jwk', kp.publicKey),
    priv: await subtle().exportKey('jwk', kp.privateKey),
  };
}

export async function fingerprint(pubJwk) {
  return (await sha256Hex(canonical({ x: pubJwk.x, y: pubJwk.y }))).slice(0, 16);
}

export async function signBody(body, privJwk) {
  const hash = await hashBody(body);
  const key = await subtle().importKey('jwk', privJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(hash));
  return { hash, sig: b64(sig) };
}

export async function verifySig(hash, sig, pubJwk) {
  try {
    const key = await subtle().importKey('jwk', pubJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unb64(sig), enc.encode(hash));
  } catch {
    return false;
  }
}

const leafHash = (h) => sha256Hex('leaf:' + h);
const nodeHash = (l, r) => sha256Hex('node:' + l + r);

async function buildLevels(hashes) {
  let level = await Promise.all(hashes.map(leafHash));
  const levels = [level];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? await nodeHash(level[i], level[i + 1]) : level[i]); // odd node is promoted
    }
    level = next;
    levels.push(level);
  }
  return levels;
}

export async function merkleRoot(hashes) {
  if (!hashes.length) return null;
  const levels = await buildLevels(hashes);
  return levels[levels.length - 1][0];
}

export async function merkleProof(hashes, index) {
  const levels = await buildLevels(hashes);
  const proof = [];
  let idx = index;
  for (let l = 0; l < levels.length - 1; l++) {
    const sib = idx ^ 1;
    if (sib < levels[l].length) proof.push({ hash: levels[l][sib], side: idx % 2 === 0 ? 'R' : 'L' });
    idx >>= 1;
  }
  return proof;
}

export async function verifyProof(hash, proof, root) {
  let cur = await leafHash(hash);
  for (const step of proof) {
    cur = step.side === 'R' ? await nodeHash(cur, step.hash) : await nodeHash(step.hash, cur);
  }
  return cur === root;
}

// ---------- hash-chained event log (used by the registry; verifiable in the browser too) ----------

export const CHAIN_ZERO = '0'.repeat(64);

export const chainHash = (e) => sha256Hex(canonical({ seq: e.seq, ts: e.ts, type: e.type, data: e.data, prev: e.prev }));

export async function verifyChainAsync(entries) {
  let prev = CHAIN_ZERO;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.seq !== i + 1) return { ok: false, at: e.seq, reason: 'sequence gap' };
    if (e.prev !== prev) return { ok: false, at: e.seq, reason: 'previous-hash mismatch' };
    if ((await chainHash(e)) !== e.hash) return { ok: false, at: e.seq, reason: 'entry was altered' };
    prev = e.hash;
  }
  return { ok: true, length: entries.length, head: prev };
}
