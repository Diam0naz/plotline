// Helpers shared by tests and the seed script: build properly signed records the way the phone does.
import { fingerprint, generateKeys, geohash, hashBody, signBody } from '../core.js';

// A square plot of roughly `sideM` metres whose south-west corner is lat/lon.
export function square(lat, lon, sideM = 100) {
  const dLat = sideM / 111_320;
  const dLon = sideM / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [
    { lat, lon }, { lat, lon: lon + dLon }, { lat: lat + dLat, lon: lon + dLon }, { lat: lat + dLat, lon },
  ];
}

export async function makeFarmer() {
  const keys = await generateKeys();
  return { ...keys, fp: await fingerprint(keys.pub) };
}

async function rec(farmer, kind, farmId, pt, data, ts, score = 95, flags = []) {
  const body = {
    id: `${kind}-${ts}`, kind, farmId, lat: pt.lat, lon: pt.lon, acc: 6, ts, geohash: geohash(pt.lat, pt.lon, 7),
    quality: { score, flags }, data, signer: farmer.fp,
  };
  const { hash, sig } = await signBody(body, farmer.priv);
  return { body, hash, sig };
}

// Three signed records: farm boundary, planting, survival.
export async function makeSubmission(farmer, {
  farmId = 'f1', name = 'Demo plot', polygon, trees = 400, sample = 40, alive = 34,
  plantTs = Date.parse('2026-06-01T09:00:00Z'), survTs = Date.parse('2026-10-01T09:00:00Z'), score = 95, flags = [],
  msisdn = '08031234567',
} = {}) {
  const c = { lat: (polygon[0].lat + polygon[2].lat) / 2, lon: (polygon[0].lon + polygon[2].lon) / 2 };
  const records = [
    await rec(farmer, 'farm', farmId, c, { name, crop: 'agroforestry', polygon }, plantTs - 1000, score, flags),
    await rec(farmer, 'planting', farmId, c, { count: trees, species: 'Mixed' }, plantTs, score, flags),
    await rec(farmer, 'survival', farmId, c, { sampleSize: sample, alive }, survTs, score, flags),
  ];
  return { records, pub: farmer.pub, msisdn };
}

export async function signDecision(verifier, { subId, decision, note = '', verifierId = 'ver-1', ts = '2026-11-05T10:00:00.000Z', fire }) {
  const body = { subId, decision, note, verifierId, ts };
  if (fire) body.fire = fire;
  const { sig } = await signBody(body, verifier.priv);
  return { subId, decision, note, verifierId, ts, sig, ...(fire ? { fire } : {}), hash: await hashBody(body) };
}
