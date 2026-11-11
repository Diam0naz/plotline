import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './server.mjs';
import { makeFarmer, makeSubmission, signDecision, square } from './testkit.mjs';

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'regapi-'));
  const app = createApp({ dataDir: dir, adminToken: 'secret-token' });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  return { ...app, dir, call, close: () => new Promise((r) => app.server.close(r)) };
}

test('registry API: whole flow over HTTP, with operator-only routes protected', async () => {
  const a = await boot();
  try {
    const verifier = await makeFarmer();
    assert.equal((await a.call('/api/registry/verifiers', { method: 'POST', body: { id: 'ver-1', pub: verifier.pub } })).status, 401);
    const added = await a.call('/api/registry/verifiers', { method: 'POST', token: 'secret-token', body: { id: 'ver-1', pub: verifier.pub } });
    assert.equal(added.status, 201);
    assert.equal((await a.call('/api/registry/verifiers', { method: 'POST', token: 'secret-token', body: { id: 'ver-1', pub: verifier.pub } })).status, 409);

    const farmer = await makeFarmer();
    const sub = await makeSubmission(farmer, { polygon: square(9.9, 8.9, 100), msisdn: '08031234567' });
    const s = await a.call('/api/submit', { method: 'POST', body: sub });
    assert.equal(s.status, 201);
    assert.equal(s.json.status, 'pending');

    assert.equal((await a.call('/api/registry/submissions')).status, 401);
    const q = await a.call('/api/registry/submissions', { token: 'secret-token' });
    assert.equal(q.json.submissions.length, 1);
    assert.equal(q.json.submissions[0].payoutTo, '+234803•••••67');

    const d = await a.call('/api/registry/decide', { method: 'POST', body: await signDecision(verifier, { subId: s.json.subId, decision: 'approve' }) });
    assert.equal(d.status, 200);
    assert.equal(d.json.status, 'approved');

    assert.equal((await a.call('/api/registry/order', { method: 'POST', body: { buyer: 'Acme', units: 10 } })).status, 401);
    const o = await a.call('/api/registry/order', { method: 'POST', token: 'secret-token', body: { buyer: 'Acme', units: 5, key: 'x1' } });
    assert.equal(o.status, 201);
    assert.equal((await a.call('/api/registry/order', { method: 'POST', token: 'secret-token', body: { buyer: 'Acme', units: 9999 } })).status, 400);

    const r = await a.call('/api/registry/reconcile');
    assert.equal(r.json.balanced, true);
    const fv = await a.call(`/api/registry/farmer/${farmer.fp}`);
    assert.equal(fv.json.paidKobo + fv.json.heldKobo, o.json.order.split.farmers);

    const ret = await a.call('/api/registry/retire', { method: 'POST', token: 'secret-token', body: { orderId: o.json.order.orderId, beneficiary: 'Acme' } });
    assert.equal(ret.status, 201);
    assert.equal((await a.call(`/api/registry/certificate/${o.json.order.orderId}`)).status, 200);

    const log = await a.call('/api/registry/log');
    assert.equal(log.json.check.ok, true);
    const text = JSON.stringify(log.json) + readFileSync(join(a.dir, 'registry.jsonl'), 'utf8');
    assert.ok(!text.includes('08031234567') && !text.includes('2348031234567'), 'phone number leaked into the public log');
  } finally { await a.close(); }
});

test('registry API: bad input and oversized bodies are refused', async () => {
  const a = await boot();
  try {
    assert.equal((await a.call('/api/submit', { method: 'POST', body: { records: [] } })).status, 400);
    const big = await fetch(a.server.address() && `http://127.0.0.1:${a.server.address().port}/api/submit`, { method: 'POST', body: 'x'.repeat(70000) }).then((r) => r.status).catch(() => 413);
    assert.equal(big, 413);
    assert.equal((await a.call('/api/registry/farmer/not-a-key')).status, 400);
    assert.equal((await a.call('/api/registry/certificate/ORD-0001')).status, 404);
    assert.equal((await a.call('/api/registry/nope', { token: 'secret-token' })).status, 404);
    assert.equal((await a.call('/api/registry/decide', { method: 'POST', body: { subId: 'x' } })).status, 400);
  } finally { await a.close(); }
});

test('registry API: submissions are rate limited', async () => {
  const a = await boot();
  try {
    let last;
    for (let i = 0; i < 12; i++) last = await a.call('/api/submit', { method: 'POST', body: { records: [] } });
    assert.equal(last.status, 429);
  } finally { await a.close(); }
});

test('registry data files are never served as static files', async () => {
  const a = await boot();
  try {
    const base = `http://127.0.0.1:${a.server.address().port}`;
    for (const p of ['/data/private.json', '/data/registry.jsonl', '/server/registry.mjs']) {
      assert.equal((await fetch(base + p)).status, 404, p);
    }
  } finally { await a.close(); }
});

test('projects and serials: a credit belongs to a registered project and anyone can trace it', async () => {
  const a = await boot();
  try {
    const project = {
      name: 'Kaduna community agroforestry', proponent: 'Test Proponent',
      boundaryHash: 'a'.repeat(64), ecoregion: 'Sudan savanna',
      creditingStart: '2026-01-01T00:00:00Z', creditingEnd: '2036-01-01T00:00:00Z',
      additionality: 'The baseline is degraded cropland with no tree cover; planting needs carbon revenue to be viable.',
      landUsePrior: 'Degraded cropland and fallow', tenure: 'customary',
      fpicRef: 'FPIC-2026-001', validationRef: 'DEMO-VAL-2026-01',
    };
    assert.equal((await a.call('/api/registry/projects', { method: 'POST', body: project })).status, 401);
    const incomplete = await a.call('/api/registry/projects', { method: 'POST', token: 'secret-token', body: { ...project, additionality: 'More trees' } });
    assert.equal(incomplete.status, 400);
    assert.equal(incomplete.json.error, 'additionality_required');
    const made = await a.call('/api/registry/projects', { method: 'POST', token: 'secret-token', body: project });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    const projectId = made.json.project.id;
    assert.match(projectId, /^PRJ-\d{4}$/);
    assert.equal((await a.call('/api/registry/projects')).json.projects.length, 1);

    const verifier = await makeFarmer();
    await a.call('/api/registry/verifiers', { method: 'POST', token: 'secret-token', body: { id: 'ver-1', pub: verifier.pub } });

    // A submission cannot point at a project that does not exist.
    const farmer = await makeFarmer();
    const sub = await makeSubmission(farmer, { polygon: square(9.9, 8.9, 300), trees: 6000, sample: 60, alive: 51 });
    const unknown = await a.call('/api/submit', { method: 'POST', body: { ...sub, projectId: 'PRJ-9999' } });
    assert.equal(unknown.json.error, 'unknown_project');

    const s = await a.call('/api/submit', { method: 'POST', body: { ...sub, projectId } });
    assert.equal(s.status, 201);
    const d = await a.call('/api/registry/decide', { method: 'POST', body: await signDecision(verifier, { subId: s.json.subId, decision: 'approve', note: 'Checked the plot and the project boundary' }) });
    assert.equal(d.status, 200, JSON.stringify(d.json));
    assert.equal(d.json.status, 'approved', JSON.stringify(d.json));
    assert.equal(d.json.issuance.projectId, projectId);
    assert.equal(d.json.issuance.vintage, 2026);
    assert.equal(d.json.issuance.activityUnits, 5100);
    assert.equal(d.json.issuance.kgCO2e, d.json.issuance.units * 1000);

    const before = await a.call(`/api/registry/serial/${d.json.issuance.serialFrom}`);
    assert.equal(before.status, 200);
    assert.equal(before.json.status, 'available');
    assert.equal(before.json.projectId, projectId);
    assert.equal(before.json.kgCO2e, 1000);
    assert.equal((await a.call('/api/registry/serial/PL-NG-99999999')).status, 404);

    const order = await a.call('/api/registry/order', { method: 'POST', token: 'secret-token', body: { buyer: 'Auditor Ltd', units: 3, key: 'p1' } });
    assert.equal(order.status, 201);
    const sold = await a.call(`/api/registry/serial/${order.json.order.serialFrom}`);
    assert.equal(sold.json.status, 'sold');
    assert.equal(sold.json.sale.orderId, order.json.order.orderId);

    assert.equal((await a.call('/api/registry/retirements')).json.retirements.length, 0);
    const ret = await a.call('/api/registry/retire', { method: 'POST', token: 'secret-token', body: { orderId: order.json.order.orderId, beneficiary: 'Auditor Ltd' } });
    assert.equal(ret.status, 201);
    const retirements = (await a.call('/api/registry/retirements')).json.retirements;
    assert.equal(retirements.length, 1);
    assert.equal(retirements[0].tCO2e, 3);
    assert.deepEqual(retirements[0].projectIds, [projectId]);
    assert.match(ret.json.certificate.claim.statement, /retired 3 serialised tCO2e/);
    assert.equal(ret.json.certificate.tCO2e, 3);

    // A project registered under one methodology version cannot host another version's submissions.
    const oldProject = await a.call('/api/registry/projects', { method: 'POST', token: 'secret-token', body: { ...project, methodologyId: 'DEMO-AGROFORESTRY-0' } });
    const mismatch = await a.call('/api/submit', { method: 'POST', body: { ...sub, projectId: oldProject.json.project.id } });
    assert.equal(mismatch.json.error, 'project_methodology_mismatch');
  } finally { await a.close(); }
});

test('verifier list carries real key fingerprints, accreditation survives a restart, renew is routed', async () => {
  const a = await boot();
  try {
    const farmer = await makeFarmer();
    assert.equal((await a.call('/api/registry/verifiers', { method: 'POST', token: 'secret-token', body: { id: 'ver-9', pub: farmer.pub } })).status, 201);
    assert.equal((await a.call('/api/registry/verifiers/accredit', { method: 'POST', token: 'secret-token', body: { id: 'ver-9', standard: 'ISO 14065', expiresAt: '2099-01-01' } })).status, 200);
    const { json } = await a.call('/api/registry/projects');
    assert.match(json.verifiers[0].key, /^[0-9a-f]{16}$/, 'a fingerprint, not a serialised Promise');

    // /api/renew reaches the registry (a validation error, not "unknown endpoint").
    const renew = await a.call('/api/renew', { method: 'POST', body: { priorSubId: 'SUB-9999' } });
    assert.notEqual(renew.json.error, 'unknown endpoint');
  } finally {
    await a.close();
  }
  const again = createApp({ dataDir: a.dir, adminToken: 'secret-token' });
  await new Promise((r) => again.server.listen(0, r));
  try {
    const res = await fetch(`http://127.0.0.1:${again.server.address().port}/api/registry/verifiers`, { headers: { authorization: 'Bearer secret-token' } });
    const v = (await res.json()).verifiers.find((x) => x.id === 'ver-9');
    assert.equal(v.accreditation?.standard, 'ISO 14065');
  } finally {
    await new Promise((r) => again.server.close(r));
  }
});
