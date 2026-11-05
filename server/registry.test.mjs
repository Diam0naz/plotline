import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from './registry.mjs';
import { allocate, normalizeMsisdn, splitKobo } from './payments.mjs';
import { makeFarmer, makeSubmission, signDecision, square } from './testkit.mjs';
import { overlapFraction } from '../core.js';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'reg-')), 'registry.jsonl');
const clock = (iso = '2026-11-05T10:00:00Z') => { let t = new Date(iso); return { now: () => t, set: (x) => { t = new Date(x); } }; };

async function setup() {
  const verifier = await makeFarmer();
  const c = clock();
  const reg = new Registry({ file: tmp(), verifiers: { 'ver-1': verifier.pub }, now: c.now });
  return { reg, verifier, c };
}
async function approved(reg, verifier, farmer, opts) {
  const sub = await makeSubmission(farmer, opts);
  const r = await reg.submit(sub);
  assert.equal(r.status, 'pending', JSON.stringify(r.checks));
  const d = await reg.decide(await signDecision(verifier, { subId: r.subId, decision: 'approve', note: 'Checked in test' }));
  assert.equal(d.ok, true, JSON.stringify(d));
  return r.subId;
}

test('money split always adds up exactly', () => {
  for (const total of [0, 1, 7, 99, 30000, 1234567, 9_999_999_999]) {
    const s = splitKobo(total, { a: 6000, b: 2500, c: 500, d: 1000 });
    assert.equal(s.a + s.b + s.c + s.d, total);
  }
  const m = allocate(100, [{ key: 'x', weight: 1 }, { key: 'y', weight: 1 }, { key: 'z', weight: 1 }]);
  assert.equal([...m.values()].reduce((a, b) => a + b, 0), 100);
});

test('phone numbers are normalised, junk is refused', () => {
  assert.equal(normalizeMsisdn('0803 123 4567'), '+2348031234567');
  assert.equal(normalizeMsisdn('+2348031234567'), '+2348031234567');
  assert.equal(normalizeMsisdn('2349031234567'), '+2349031234567');
  assert.equal(normalizeMsisdn('0603123456'), null);
  assert.equal(normalizeMsisdn('abc'), null);
});

test('overlap fraction: identical plots, half-shifted plots, distant plots', () => {
  const a = square(9.9, 8.9, 100);
  assert.ok(overlapFraction(a, a) > 0.99);
  const half = square(9.9, 8.9 + 50 / (111320 * Math.cos(9.9 * Math.PI / 180)), 100);
  const f = overlapFraction(a, half);
  assert.ok(f > 0.4 && f < 0.6, String(f));
  assert.equal(overlapFraction(a, square(10.5, 9.5, 100)), 0);
});

test('full flow: submit, verify, issue, sell, pay, retire, reconcile', async () => {
  const { reg, verifier } = await setup();
  const farmer = await makeFarmer();
  await approved(reg, verifier, farmer, { polygon: square(9.9, 8.9, 300), trees: 6000, sample: 60, alive: 51 });
  // 5,100 verified tree-years x 18 kg / 1000 = 91.8, rounded down to 91 tCO2e credits;
  // the current methodology withholds 10% as buffer.
  assert.equal(reg.reconcile().unitsIssued, 91);
  assert.equal(reg.reconcile().unitsBuffered, 9);
  assert.equal(reg.available(), 82);
  const r = reg.placeOrder({ buyer: 'Acme Ltd', units: 50, key: 'k1' });
  assert.equal(r.ok, true);
  assert.equal(r.order.totalKobo, 50 * 1_200_000);
  const rec = reg.reconcile();
  assert.equal(rec.balanced, true);
  assert.equal(rec.unitsAvailable, 32);
  assert.equal(rec.unitsBalanced, true);
  assert.equal(rec.serialsContiguous, true);
  const v = reg.farmerView(farmer.fp);
  assert.equal(v.paidKobo + v.heldKobo, r.order.split.farmers);
  const ret = reg.retire({ orderId: r.order.orderId, beneficiary: 'Acme Ltd' });
  assert.equal(ret.ok, true);
  assert.equal(reg.retire({ orderId: r.order.orderId, beneficiary: 'Acme Ltd' }).error, 'already_retired');
  assert.equal(reg.verifyLog().ok, true);
});

test('serials are unique and a sold unit can never be sold again', async () => {
  const { reg, verifier } = await setup();
  const f1 = await makeFarmer(), f2 = await makeFarmer();
  await approved(reg, verifier, f1, { polygon: square(9.9, 8.9, 100), msisdn: '08031111111' });
  await approved(reg, verifier, f2, { polygon: square(9.95, 8.95, 100), msisdn: '08032222222' });
  const [a, b] = reg.issuances;
  assert.equal(b.from, a.to + 1);
  assert.equal(reg.placeOrder({ buyer: 'Buyer A', units: reg.available() }).ok, true);
  assert.equal(reg.placeOrder({ buyer: 'Buyer B', units: 1 }).error, 'not_enough_units');
});

test('the same land registered by a second farmer is caught', async () => {
  const { reg, verifier } = await setup();
  const f1 = await makeFarmer(), f2 = await makeFarmer();
  await approved(reg, verifier, f1, { polygon: square(9.9, 8.9, 100), msisdn: '08031111111' });
  const dup = await reg.submit(await makeSubmission(f2, { polygon: square(9.9, 8.9, 100), msisdn: '08032222222' }));
  assert.equal(dup.status, 'rejected');
  assert.ok(dup.checks.hard.some((h) => h.code === 'duplicate_plot'));
  const lon = 8.9 + 60 / (111320 * Math.cos(9.9 * Math.PI / 180)); // 40% overlap: flagged, not rejected
  const part = await reg.submit(await makeSubmission(f2, { polygon: square(9.9, lon, 100), msisdn: '08032222222' }));
  assert.equal(part.status, 'pending');
  assert.ok(part.checks.flags.some((x) => x.code === 'plot_overlap'));
});

test('a flagged submission needs a written reason to approve', async () => {
  const { reg, verifier } = await setup();
  const f = await makeFarmer();
  const r = await reg.submit(await makeSubmission(f, { polygon: square(9.9, 8.9, 100), score: 55 }));
  assert.ok(r.checks.flags.some((x) => x.code === 'low_gnss_quality'));
  const noNote = await reg.decide(await signDecision(verifier, { subId: r.subId, decision: 'approve' }));
  assert.equal(noNote.error, 'note_required');
  const ok = await reg.decide(await signDecision(verifier, { subId: r.subId, decision: 'approve', note: 'Visited the plot, trees are there' }));
  assert.equal(ok.ok, true);
});

test('forged evidence and forged verifier decisions are refused', async () => {
  const { reg, verifier } = await setup();
  const f = await makeFarmer(), other = await makeFarmer();
  const sub = await makeSubmission(f, { polygon: square(9.9, 8.9, 100) });
  const tampered = structuredClone(sub);
  tampered.records[1].body.data.count = 4000;
  assert.equal((await reg.submit(tampered)).error, 'bad_hash');
  const wrongKey = { ...sub, pub: other.pub };
  assert.equal((await reg.submit(wrongKey)).error, 'bad_signature');
  const r = await reg.submit(sub);
  const impostor = await makeFarmer();
  const bad = await reg.decide(await signDecision(impostor, { subId: r.subId, decision: 'approve' }));
  assert.equal(bad.error, 'bad_signature');
  assert.equal((await reg.decide({ ...(await signDecision(verifier, { subId: r.subId, decision: 'approve' })), verifierId: 'ghost' })).error, 'unknown_verifier');
});

test('resubmitting identical evidence does nothing twice', async () => {
  const { reg, verifier } = await setup();
  const f = await makeFarmer();
  const sub = await makeSubmission(f, { polygon: square(9.9, 8.9, 100) });
  const a = await reg.submit(sub);
  const b = await reg.submit(sub);
  assert.equal(b.duplicate, true);
  assert.equal(a.subId, b.subId);
  await reg.decide(await signDecision(verifier, { subId: a.subId, decision: 'approve' }));
  assert.equal(reg.issuances.length, 1);
});

test('impossible numbers are rejected outright', async () => {
  const { reg } = await setup();
  const f = await makeFarmer();
  const r = await reg.submit(await makeSubmission(f, { polygon: square(9.9, 8.9, 100), sample: 40, alive: 50 }));
  assert.equal(r.status, 'rejected');
  assert.ok(r.checks.hard.some((h) => h.code === 'invalid_alive'));
  const late = await reg.submit(await makeSubmission(f, { polygon: square(9.9, 8.9, 100), plantTs: Date.parse('2026-10-05T00:00:00Z'), survTs: Date.parse('2026-09-01T00:00:00Z') }));
  assert.ok(late.checks.hard.some((h) => h.code === 'out_of_order'));
});

test('payout rules: first-payout cap, invalid number hold, cooling after a number change', async () => {
  const { reg, verifier, c } = await setup();
  const rich = await makeFarmer();
  await approved(reg, verifier, rich, { polygon: square(9.9, 8.9, 300), trees: 4000, sample: 400, alive: 380, msisdn: '08031111111' });
  const o = reg.placeOrder({ buyer: 'Big Buyer', units: reg.available() });
  const v = reg.farmerView(rich.fp);
  assert.equal(v.paidKobo, 2_000_000);            // capped at N20,000
  assert.ok(v.heldKobo > 0);
  assert.equal(v.paidKobo + v.heldKobo, o.order.split.farmers);
  assert.equal(reg.releaseHeld(rich.fp).ok, true); // cap lifts after first payout, nothing blocks release
  assert.equal(reg.farmerView(rich.fp).heldKobo, 0);

  const nobody = await makeFarmer();
  await approved(reg, verifier, nobody, { polygon: square(9.95, 8.95, 100), msisdn: 'not-a-number' });
  reg.placeOrder({ buyer: 'Another', units: 5 });
  const nv = reg.farmerView(nobody.fp);
  assert.equal(nv.paidKobo, 0);
  assert.ok(nv.heldKobo > 0);
  assert.equal(reg.releaseHeld(nobody.fp).error, 'no_number');

  // changes number: held for 72 hours
  const sub2 = await makeSubmission(nobody, { farmId: 'f2', polygon: square(10.2, 9.2, 100), msisdn: '08039998888' });
  const r2 = await reg.submit(sub2);
  await reg.decide(await signDecision(verifier, { subId: r2.subId, decision: 'approve' }));
  const swapper = await makeFarmer();
  await approved(reg, verifier, swapper, { polygon: square(10.4, 9.4, 100), msisdn: '08037770000' });
  const sub3 = await makeSubmission(swapper, { farmId: 'f9', polygon: square(10.6, 9.6, 100), msisdn: '08035550000' });
  const r3 = await reg.submit(sub3);
  await reg.decide(await signDecision(verifier, { subId: r3.subId, decision: 'approve' }));
  assert.ok(reg.farmerView(swapper.fp).cooldownUntil);
  reg.placeOrder({ buyer: 'Third', units: reg.available() });
  assert.ok(reg.payouts.some((p) => p.fp === swapper.fp && p.reason === 'new_number_cooling_off'));
  assert.equal(reg.releaseHeld(swapper.fp).error, 'cooling');
  c.set('2026-11-09T10:00:00Z');
  assert.equal(reg.releaseHeld(swapper.fp).ok, true);
  assert.equal(reg.reconcile().balanced, true);
});

test('one payout number cannot belong to two farmer keys', async () => {
  const { reg, verifier } = await setup();
  const a = await makeFarmer(), b = await makeFarmer();
  await approved(reg, verifier, a, { polygon: square(9.9, 8.9, 100), msisdn: '08031111111' });
  const r = await reg.submit(await makeSubmission(b, { polygon: square(10.5, 9.5, 100), msisdn: '08031111111' }));
  assert.equal(r.status, 'rejected');
  assert.ok(r.checks.hard.some((h) => h.code === 'number_in_use'));
});

test('a farmer cannot verify their own submission', async () => {
  const f = await makeFarmer();
  const reg = new Registry({ file: tmp(), verifiers: { 'ver-1': f.pub } });
  const r = await reg.submit(await makeSubmission(f, { polygon: square(9.9, 8.9, 100) }));
  const d = await reg.decide(await signDecision(f, { subId: r.subId, decision: 'approve' }));
  assert.equal(d.error, 'self_verification');
});

test('state survives a restart and the log catches tampering', async () => {
  const verifier = await makeFarmer();
  const file = tmp();
  const reg = new Registry({ file, verifiers: { 'ver-1': verifier.pub } });
  const f = await makeFarmer();
  await approved(reg, verifier, f, { polygon: square(9.9, 8.9, 100) });
  reg.placeOrder({ buyer: 'Acme', units: 5 });
  const before = reg.reconcile();
  const again = new Registry({ file, verifiers: { 'ver-1': verifier.pub } });
  assert.deepEqual(again.reconcile(), before);
  assert.equal(again.log.head().hash, reg.log.head().hash);

  const text = readFileSync(file, 'utf8').replace('"buyer":"Acme"', '"buyer":"Evil"');
  writeFileSync(file, text);
  assert.throws(() => new Registry({ file, verifiers: {} }), /failed verification/);
});
