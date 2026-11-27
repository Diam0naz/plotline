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

// ── Phase 2: accreditation recorded as logged, replayable chain events ──────────
test('accreditation (logged): accreditVerifier is a replayable event that survives reload', async () => {
  const file = tmp();
  const verifier = await makeFarmer();
  const before = new Registry({ file, verifiers: { 'ver-1': verifier.pub }, now: clock().now });
  const seqBefore = before.log.head().seq;
  const r = before.accreditVerifier({ id: 'ver-1', standard: 'ISO 14065 (demo)', scope: 'full' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(before.log.head().seq, seqBefore + 1, 'accreditation appended one chain event');
  assert.equal(before.verifiersAccred.get('ver-1').standard, 'ISO 14065 (demo)');

  // A fresh registry rebuilt only from the log sees the accreditation — no side file needed.
  const reloaded = new Registry({ file, verifiers: { 'ver-1': verifier.pub }, now: clock().now });
  assert.equal(reloaded.verifiersAccred.get('ver-1').scope, 'full');
  assert.ok(reloaded.verifiersAccred.get('ver-1').accreditedAt, 'accreditation carries the event timestamp');
});

test('accreditation (logged): a revoked verifier cannot decide, and the revocation persists', async () => {
  const file = tmp();
  const verifier = await makeFarmer();
  const farmer = await makeFarmer();
  const reg = new Registry({ file, verifiers: { 'ver-1': verifier.pub }, now: clock().now });
  reg.accreditVerifier({ id: 'ver-1', standard: 'ISO 14065 (demo)', scope: 'full' });
  assert.equal(reg.revokeVerifier({ id: 'ver-1', reason: 'accreditation lapsed in audit' }).ok, true);

  const sub = await makeSubmission(farmer, { polygon: square(9.9, 8.9, 300), trees: 6000, sample: 60, alive: 51 });
  const submitted = await reg.submit(sub);
  assert.equal(submitted.status, 'pending', JSON.stringify(submitted.checks ?? submitted));
  const d = await reg.decide(await signDecision(verifier, { subId: submitted.subId, decision: 'approve', note: 'Looks fine' }));
  assert.equal(d.ok, false);
  assert.equal(d.error, 'verifier_accreditation_revoked');

  const reloaded = new Registry({ file, verifiers: { 'ver-1': verifier.pub }, now: clock().now });
  assert.equal(reloaded.verifiersAccred.get('ver-1').revoked, true);
  assert.equal(reloaded.verifiersAccred.get('ver-1').revokedReason, 'accreditation lapsed in audit');
});

test('accreditation (logged): accredit/revoke input is validated', async () => {
  const reg = new Registry({ file: tmp(), verifiers: { 'ver-1': {} }, now: clock().now });
  assert.equal(reg.accreditVerifier({ id: 'ver-1', standard: 'x' }).error, 'bad_standard');
  assert.equal(reg.accreditVerifier({ id: 'ver-1', standard: 'ISO', scope: 'nonsense' }).error, 'bad_scope');
  assert.equal(reg.accreditVerifier({ id: 'ver-1', standard: 'ISO', methodologyId: 'NOPE' }).error, 'unknown_methodology');
  assert.equal(reg.revokeVerifier({ id: 'ver-1', reason: 'x' }).error, 'no_active_accreditation');
  assert.equal(reg.accreditVerifier({ id: 'ver-1', standard: 'ISO 14065 (demo)' }).ok, true);
  assert.equal(reg.revokeVerifier({ id: 'ver-1', reason: 'no' }).error, 'bad_reason');
  assert.equal(reg.revokeVerifier({ id: 'ver-1', reason: 'genuine audit finding' }).ok, true);
});
