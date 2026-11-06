// Verifier accreditation enforcement: a verifier the operator accredited must be
// current, cover the submission's methodology, and hold the right scope.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from './registry.mjs';
import { makeFarmer, makeSubmission, signDecision, square } from './testkit.mjs';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'accred-')), 'registry.jsonl');
const clock = (iso = '2026-11-05T10:00:00.000Z') => { let t = new Date(iso); return { now: () => t }; };

const accred = (over = {}) => ({ standard: 'ISO 14065 (demo)', scope: 'full', methodologyId: null, expiresAt: '2099-01-01T00:00:00.000Z', ...over });

async function decideUnder(accreditation, { decision = 'approve', note = 'Checked in test', methodologyId } = {}) {
  const verifier = await makeFarmer();
  const farmer = await makeFarmer();
  const reg = new Registry({
    file: tmp(),
    verifiers: { 'ver-1': verifier.pub },
    verifiersAccred: accreditation ? new Map([['ver-1', accred(accreditation)]]) : null,
    now: clock().now,
  });
  const sub = await makeSubmission(farmer, { polygon: square(9.9, 8.9, 300), trees: 6000, sample: 60, alive: 51, methodologyId });
  const submitted = await reg.submit(sub);
  assert.equal(submitted.status, 'pending', JSON.stringify(submitted.checks ?? submitted));
  return reg.decide(await signDecision(verifier, { subId: submitted.subId, decision, note }));
}

test('accreditation: an expired verifier cannot decide', async () => {
  const d = await decideUnder({ expiresAt: '2026-11-01T00:00:00.000Z' });
  assert.equal(d.ok, false);
  assert.equal(d.error, 'verifier_accreditation_expired');
});

test('accreditation: a verifier accredited for another methodology cannot decide here', async () => {
  const d = await decideUnder({ methodologyId: 'DEMO-AGROFORESTRY-0' });
  assert.equal(d.ok, false);
  assert.equal(d.error, 'verifier_methodology_mismatch');
});

test('accreditation: a review-only verifier cannot validate an initial submission', async () => {
  const d = await decideUnder({ scope: 'review-only' });
  assert.equal(d.ok, false);
  assert.equal(d.error, 'verifier_scope_mismatch');
});

test('accreditation: a current, in-scope verifier decides normally and the accreditation rides the issuance', async () => {
  const d = await decideUnder({ scope: 'full', methodologyId: null });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.status, 'approved');
  assert.equal(d.issuance.verifierAccreditation.standard, 'ISO 14065 (demo)');
  assert.equal(d.issuance.verifierAccreditation.scope, 'full');
});

test('accreditation: no accreditation recorded means today still works', async () => {
  const d = await decideUnder(null);
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.status, 'approved');
  assert.equal(d.issuance.verifierAccreditation, undefined, 'nothing was claimed about an unaccredited verifier');
});
