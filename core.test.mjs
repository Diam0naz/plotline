import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from './core.js';

const near = (a, b, tol) => Math.abs(a - b) <= tol;

test('geohash matches the reference example', () => {
  assert.equal(C.geohash(57.64911, 10.40744, 11), 'u4pruydqqvj');
});

test('polygon area of a 0.001 degree square at the equator (~12,364 m2)', () => {
  const sq = [
    { lat: 0, lon: 0 }, { lat: 0, lon: 0.001 },
    { lat: 0.001, lon: 0.001 }, { lat: 0.001, lon: 0 },
  ];
  const a = C.polygonAreaM2(sq);
  assert.ok(near(a, 12364, 120), `area was ${a}`);
});

test('haversine: one degree of latitude is ~111.2 km', () => {
  const d = C.haversine({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
  assert.ok(near(d, 111195, 200), `distance was ${d}`);
});

test('point in polygon', () => {
  const sq = [
    { lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }, { lat: 1, lon: 0 },
  ];
  assert.equal(C.pointInPolygon({ lat: 0.5, lon: 0.5 }, sq), true);
  assert.equal(C.pointInPolygon({ lat: 1.5, lon: 0.5 }, sq), false);
});

test('assessFix flags poor accuracy, jumps, round coordinates and outside boundary', () => {
  const now = Date.now();
  const farm = { polygon: [
    { lat: 9.9, lon: 8.9 }, { lat: 9.9, lon: 8.901 }, { lat: 9.901, lon: 8.901 }, { lat: 9.901, lon: 8.9 },
  ] };
  const good = { lat: 9.9005123, lon: 8.9005123, acc: 8, ts: now };
  assert.deepEqual(C.assessFix(good, null, farm, now), { score: 100, flags: [] });

  const bad = { lat: 9.95, lon: 8.95, acc: 80, ts: now };
  const prev = { lat: 9.9005123, lon: 8.9005123, ts: now - 5000 };
  const r = C.assessFix(bad, prev, farm, now);
  for (const f of ['low_accuracy', 'impossible_jump', 'outside_boundary']) assert.ok(r.flags.includes(f), f);
  assert.ok(r.score < 50);

  const round = C.assessFix({ lat: 9.9, lon: 8.9, acc: 5, ts: now }, null, null, now);
  assert.ok(round.flags.includes('suspicious_precision'));
});

test('input plan: maize 75x25 cm gives 53,333 plants per hectare', () => {
  const p = C.inputPlan(2, C.CROPS.maize);
  assert.ok(near(p.plants, 106667, 2));
  assert.equal(p.seedKg, 40);
  assert.equal(p.npkBags, 12);
});

test('outbreak clusters need enough nearby recent reports of the same type', () => {
  const now = Date.now();
  const mk = (i, type, dLat, daysAgo = 1) => ({
    id: 'r' + i, type, severity: 2, lat: 9.9 + dLat, lon: 8.9,
    ts: new Date(now - daysAgo * 86400000).toISOString(),
  });
  const reports = [
    mk(1, 'pest', 0), mk(2, 'pest', 0.001), mk(3, 'pest', 0.002),
    mk(4, 'disease', 0), mk(5, 'pest', 0.5), mk(6, 'pest', 0.0005, 30),
  ];
  const c = C.findClusters(reports, { now });
  assert.equal(c.length, 1);
  assert.equal(c[0].type, 'pest');
  assert.equal(c[0].count, 3);
});

test('canonical JSON is key-order independent', () => {
  assert.equal(C.canonical({ b: 1, a: [2, { d: 1, c: 2 }] }), C.canonical({ a: [2, { c: 2, d: 1 }], b: 1 }));
});

test('sign and verify; tampering breaks the hash', async () => {
  const keys = await C.generateKeys();
  const body = { id: 'x', lat: 9.9, lon: 8.9, data: { type: 'pest' } };
  const { hash, sig } = await C.signBody(body, keys.priv);
  assert.equal(await C.verifySig(hash, sig, keys.pub), true);
  assert.equal(hash, await C.hashBody(body));
  assert.notEqual(hash, await C.hashBody({ ...body, lat: 9.9001 }));
  const other = await C.generateKeys();
  assert.equal(await C.verifySig(hash, sig, other.pub), false);
});

test('merkle proofs verify for every leaf size, and fail on wrong data', async () => {
  for (const n of [1, 2, 3, 4, 5, 7, 8, 9]) {
    const leaves = [];
    for (let i = 0; i < n; i++) leaves.push(await C.sha256Hex('record-' + i));
    const root = await C.merkleRoot(leaves);
    for (let i = 0; i < n; i++) {
      const proof = await C.merkleProof(leaves, i);
      assert.equal(await C.verifyProof(leaves[i], proof, root), true, `n=${n} i=${i}`);
    }
    const proof0 = await C.merkleProof(leaves, 0);
    assert.equal(await C.verifyProof(await C.sha256Hex('forged'), proof0, root), false);
  }
  assert.equal(await C.merkleRoot([]), null);
});

test('weak-quality reports are kept out of outbreak alerts', () => {
  const now = Date.now();
  const mk = (i, q) => ({
    id: 'q' + i, type: 'pest', severity: 3, lat: 9.9 + i * 0.0002, lon: 8.9, q,
    ts: new Date(now - 86400000).toISOString(),
  });
  // Three spoofed/poor reports alone must not raise an alert...
  const spoofed = [mk(1, 40), mk(2, 20), mk(3, 45)];
  assert.equal(C.findClusters(C.usableReports(spoofed), { now }).length, 0);
  // ...but the same three with good fixes do, and a missing score is treated as usable.
  const good = [mk(1, 90), mk(2, 100), { ...mk(3), q: undefined }];
  assert.equal(C.findClusters(C.usableReports(good), { now }).length, 1);
  assert.equal(C.usableReports([mk(1, 50), mk(2, 49)]).length, 1);
});
