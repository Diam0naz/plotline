// Fills a running Plotline server with a believable demo: approved plots, a sale with payouts,
// a duplicate plot caught automatically, and two submissions waiting for a human verifier.
//   ADMIN_TOKEN=... node scripts/seed.mjs [http://localhost:8123]
// Everything here is simulated. Run it against a fresh data folder.
import { createHash } from 'node:crypto';
import { makeFarmer, makeSubmission, signDecision, square } from '../server/testkit.mjs';

const base = process.argv[2] || 'http://localhost:8123';
const token = process.env.ADMIN_TOKEN;
if (!token) { console.error('Set ADMIN_TOKEN to the operator token the server printed.'); process.exit(1); }

async function call(path, body, auth = false) {
  const res = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok && res.status !== 400) throw new Error(`${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const log = await call('/api/registry/log');
if (log.entries.length && !process.argv.includes('--force')) {
  console.error('The registry already has data. Start with an empty DATA_DIR, or pass --force.');
  process.exit(1);
}

const verifier = await makeFarmer();
await call('/api/registry/verifiers', { id: 'seed-verifier', pub: verifier.pub }, true);
const approve = async (subId, note = '') => call('/api/registry/decide', await signDecision(verifier, { subId, decision: 'approve', note, verifierId: 'seed-verifier' }));

const lat = 9.8965, lon = 8.8583;
const dLon = (m) => m / (111_320 * Math.cos((lat * Math.PI) / 180));
const plot = (eastM, northM, side = 200) => square(lat + northM / 111_320, lon + dLon(eastM), side);
const plotA = plot(0, 0), plotB = plot(400, 0);

// The programme the whole demo submits under: boundary, baseline, additionality and tenure.
const boundaryHash = createHash('sha256').update(JSON.stringify([plotA, plotB])).digest('hex');
const project = await call('/api/registry/projects', {
  name: 'Kaduna community agroforestry (demo)',
  proponent: 'Access Youth Tech Forge',
  boundaryHash,
  ecoregion: 'Sudan savanna',
  creditingStart: '2026-01-01T00:00:00.000Z',
  creditingEnd: '2036-01-01T00:00:00.000Z',
  additionality: 'The baseline is degraded cropland with little tree cover; planting and protection need carbon revenue to be viable.',
  landUsePrior: 'Degraded cropland and fallow',
  tenure: 'customary',
  fpicRef: 'FPIC-PLOTLINE-DEMO-001',
  validationRef: 'DEMO-VAL-2026-01',
}, true);
const projectId = project.project.id;
const submit = async (farmer, opts) => call('/api/submit', { ...(await makeSubmission(farmer, opts)), projectId });

const [a, b, c, d, e, f] = await Promise.all([1, 2, 3, 4, 5, 6].map(makeFarmer));

const A = await submit(a, { farmId: 'a1', name: 'Hillside agroforestry (Amina)', polygon: plotA, trees: 800, sample: 80, alive: 70, msisdn: '08031110001' });
const B = await submit(b, { farmId: 'b1', name: 'Riverbank trees (Bala)', polygon: plotB, trees: 600, sample: 60, alive: 51, msisdn: '08031110002' });
await approve(A.subId, 'Visited the plot, counted trees in two transects');
await approve(B.subId, 'Visited the plot');
const sale = await call('/api/registry/order', { buyer: 'Demo Buyer Ltd', units: 5, key: 'seed-order-1' }, true);

const dup = await submit(c, { farmId: 'c1', name: 'Same hill again (duplicate attempt)', polygon: plotA, trees: 800, sample: 80, alive: 78, msisdn: '08031110003' });
await submit(d, { farmId: 'd1', name: 'Overlaps Bala\'s plot (40%)', polygon: plot(520, 0), trees: 500, sample: 50, alive: 40, msisdn: '08031110004' });
await submit(e, { farmId: 'e1', name: 'Weak GNSS fix (Emeka)', polygon: plot(0, 600), trees: 400, sample: 40, alive: 36, score: 55, flags: ['low_accuracy'], msisdn: '08031110005' });
await submit(f, { farmId: 'f1', name: 'Clean submission (Fatima)', polygon: plot(400, 600), trees: 500, sample: 50, alive: 44, msisdn: '08031110006' });

const rec = await call('/api/registry/reconcile');
console.log(`Seeded.
  project:             ${projectId} (${project.project.name})
  approved plots:      2 (tCO2e credits issued: ${rec.unitsIssued})
  sale:                ${sale.order.orderId}, ${sale.order.units} tCO2e, ${(sale.order.totalKobo / 100).toLocaleString()} NGN
  waiting for review:  3 (one overlap, one weak GNSS, one clean)
  books balanced:      ${rec.balanced}
Open ${base}/console.html, enter the operator token, register the browser as a verifier, and review the queue.`);
