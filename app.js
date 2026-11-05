import * as C from './core.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const short = (h, n = 10) => (h ? h.slice(0, n) + '…' : '—');
const uid = () => crypto.randomUUID().slice(0, 8);
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

const TYPES = {
  pest: 'Pest damage',
  disease: 'Disease symptoms',
  water_stress: 'Water stress',
  weeds: 'Heavy weeds',
  nutrient: 'Nutrient deficiency',
  healthy: 'Looks healthy',
};
const FLAG_TEXT = {
  low_accuracy: 'Low accuracy (worse than 50 m)',
  moderate_accuracy: 'Moderate accuracy (worse than 20 m)',
  clock_drift: 'Phone clock differs from the GPS time',
  impossible_jump: 'Moved implausibly fast since the last fix',
  suspicious_precision: 'Coordinates are unusually round',
  outside_boundary: 'Outside the saved farm boundary',
};

// ---------- storage ----------
const KEY = 'plotline.v1';
let S = { farms: [], records: [], batches: [], keys: null, fp: null, activeFarm: null, msisdn: '', outbox: [], sent: [], onboarded: false };

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) S = { ...S, ...JSON.parse(raw) };
  } catch { /* storage blocked: run in memory */ }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); }
  catch { toast('Storage is unavailable, so data will not persist'); }
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

async function ensureKeys() {
  if (!S.keys) {
    S.keys = await C.generateKeys();
    S.fp = await C.fingerprint(S.keys.pub);
    save();
  } else if (!S.fp) {
    S.fp = await C.fingerprint(S.keys.pub);
    save();
  }
}

// ---------- GNSS ----------
let lastFix = null;       // latest watch fix
let lastKnown = null;     // last fix used for a record (jump check)
let watchId = null;

function geoMsg(e) {
  if (e && e.code === 1) return 'Location permission was denied. Allow it in your browser settings.';
  if (e && e.code === 3) return 'Timed out waiting for a GPS fix. Try again outdoors.';
  return 'Could not get a GPS fix.';
}
function updateGpsChip() {
  const chip = $('#gps-chip');
  if (!lastFix) { chip.className = 'chip'; chip.hidden = true; return; }
  const a = lastFix.acc;
  chip.className = 'chip ' + (a <= 20 ? 'good' : a <= 50 ? 'ok' : 'bad');
  chip.hidden = false;
  chip.textContent = `GPS ±${Math.round(a)} m`;
}
function startGps() {
  if (!('geolocation' in navigator)) { toast('This browser has no location support'); return false; }
  if (watchId !== null) return true;
  watchId = navigator.geolocation.watchPosition(
    (p) => {
      lastFix = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, ts: p.timestamp };
      updateGpsChip();
      onLiveFix();
    },
    // Brief signal drops are normal in the field; only complain when there has been no fix for a while.
    (e) => { if (!lastFix || Date.now() - lastFix.ts > 15000) toast(geoMsg(e)); },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
  );
  return true;
}
function stopGps() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  lastFix = null;
  updateGpsChip();
}
function getFix() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('This browser has no location support'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, ts: p.timestamp }),
      (e) => reject(new Error(geoMsg(e))),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    );
  });
}

// ---------- records ----------
const farmById = (id) => S.farms.find((f) => f.id === id);
const activeFarm = () => farmById(S.activeFarm) || S.farms[0] || null;

async function addRecord(kind, farm, fix, data, opts = {}) {
  const prev = 'prev' in opts ? opts.prev : lastKnown;
  const now = opts.now || Date.now();
  const check = C.assessFix(fix, prev, kind === 'farm' ? null : farm, now);
  const body = {
    id: uid(),
    kind,
    farmId: farm.id,
    lat: round(fix.lat, 7),
    lon: round(fix.lon, 7),
    acc: round(fix.acc, 1),
    ts: new Date(fix.ts).toISOString(),
    geohash: C.geohash(fix.lat, fix.lon, 7),
    quality: check,
    data,
    signer: S.fp,
  };
  const { hash, sig } = await C.signBody(body, S.keys.priv);
  const rec = { body, hash, sig, batchId: null, index: null };
  S.records.push(rec);
  if (!opts.demo) lastKnown = fix;
  save();
  return rec;
}

const scoutReports = () =>
  S.records
    .filter((r) => r.body.kind === 'scout')
    .map((r) => ({
      id: r.body.id,
      type: r.body.data.type,
      severity: r.body.data.severity,
      lat: r.body.lat,
      lon: r.body.lon,
      ts: r.body.ts,
      q: r.body.quality.score,
    }));

// ---------- maps ----------
function makeMap(el) {
  if (typeof L === 'undefined') {
    el.innerHTML = '<div class="nomap">The map library did not load. Everything else still works.</div>';
    return null;
  }
  const m = L.map(el).setView([9.8965, 8.8583], 15);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors',
  }).addTo(m);
  return m;
}
let farmMap, heatMap, farmLayer, walkLayer, heatLayerGroup;
let heat = null;

function latlngs(poly) { return poly.map((p) => [p.lat, p.lon]); }

function drawFarmMap() {
  if (!farmMap) return;
  farmLayer.clearLayers();
  const act = activeFarm();
  for (const f of S.farms) {
    L.polygon(latlngs(f.polygon), {
      color: act && f.id === act.id ? '#476633' : '#9aab88',
      weight: 2,
      fillOpacity: 0.15,
    }).bindTooltip(esc(f.name)).addTo(farmLayer);
  }
  for (const r of scoutReports()) {
    L.circleMarker([r.lat, r.lon], {
      radius: 5,
      color: r.type === 'healthy' ? '#476633' : '#b4761e',
      weight: 1,
      fillOpacity: 0.8,
    }).bindTooltip(esc(TYPES[r.type] || r.type)).addTo(farmLayer);
  }
}

// ---------- boundary walk ----------
const walk = { on: false, pts: [], done: false };

function walkStats() {
  const el = $('#walk-stats');
  const n = walk.pts.length;
  el.textContent = '';
  if (!walk.on && !walk.done) return;
  const area = n >= 3 ? C.m2ToHa(C.polygonAreaM2(walk.pts)).toFixed(3) + ' ha' : '—';
  const per = n >= 2 ? Math.round(C.perimeterM(walk.pts)) + ' m' : '—';
  el.textContent = `${n} point${n === 1 ? '' : 's'} · ${area} · perimeter ${per}`;
}
function walkButtons() {
  const naming = !$('#farm-form').classList.contains('hidden');
  const busy = walk.on || walk.done || naming;
  $('#walk-idle').classList.toggle('hidden', busy);
  $('#walk-tools').classList.toggle('hidden', !walk.on);
  $('#undo-btn').disabled = walk.pts.length === 0;
  $('#finish-btn').disabled = walk.pts.length < 3;
}
function drawWalk() {
  if (!farmMap) return;
  walkLayer.clearLayers();
  if (walk.pts.length) {
    const ll = latlngs(walk.pts);
    (walk.pts.length >= 3 ? L.polygon(ll, { color: '#b4761e', dashArray: '6 6', weight: 2, fillOpacity: 0.1 }) : L.polyline(ll, { color: '#b4761e', weight: 2 })).addTo(walkLayer);
    ll.forEach((p) => L.circleMarker(p, { radius: 4, color: '#b4761e', fillOpacity: 1 }).addTo(walkLayer));
  }
  if (walk.on && lastFix) {
    L.circle([lastFix.lat, lastFix.lon], { radius: Math.max(lastFix.acc, 2), color: '#476633', weight: 1, fillOpacity: 0.12 }).addTo(walkLayer);
    L.circleMarker([lastFix.lat, lastFix.lon], { radius: 6, color: '#fff', fillColor: '#476633', fillOpacity: 1, weight: 2 }).addTo(walkLayer);
  }
}
let centered = false;
function onLiveFix() {
  if (walk.on) {
    if (!centered && farmMap && lastFix) { farmMap.setView([lastFix.lat, lastFix.lon], 18); centered = true; }
    drawWalk();
    walkStats();
  }
}

$('#walk-btn').addEventListener('click', () => {
  if (!startGps()) return;
  walk.on = true; walk.pts = []; walk.done = false; centered = false;
  $('#farm-form').classList.add('hidden');
  toast('Walk to the first corner, then tap Mark corner');
  walkButtons(); walkStats(); drawWalk();
});
$('#walk-cancel').addEventListener('click', () => {
  walk.on = false; walk.pts = []; walk.done = false; centered = false;
  stopGps();
  $('#farm-form').classList.add('hidden');
  walkButtons(); walkStats(); drawWalk();
});
$('#drop-btn').addEventListener('click', () => {
  if (!lastFix) return toast('Waiting for a GPS fix…');
  if (lastFix.acc > 50) return toast(`Fix is too weak (±${Math.round(lastFix.acc)} m). Wait for it to improve.`);
  if (lastFix.acc > 20) toast(`Point saved with ±${Math.round(lastFix.acc)} m accuracy`);
  walk.pts.push({ lat: lastFix.lat, lon: lastFix.lon, acc: lastFix.acc });
  if (farmMap && walk.pts.length >= 2) farmMap.fitBounds(latlngs(walk.pts), { padding: [30, 30], maxZoom: 19 });
  walkButtons(); walkStats(); drawWalk();
});
$('#undo-btn').addEventListener('click', () => {
  walk.pts.pop();
  walkButtons(); walkStats(); drawWalk();
});
$('#finish-btn').addEventListener('click', () => {
  if (walk.pts.length < 3) return;
  walk.on = false; walk.done = true;
  stopGps();
  walkButtons(); walkStats(); drawWalk();
  $('#farm-form').classList.remove('hidden');
  $('#farm-name').focus();
});
$('#farm-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const name = $('#farm-name').value.trim();
    if (!name) return;
    const c = C.centroid(walk.pts);
    const farm = {
      id: uid(),
      name,
      crop: $('#farm-crop').value,
      polygon: walk.pts.map((p) => ({ lat: round(p.lat, 7), lon: round(p.lon, 7) })),
      areaM2: C.polygonAreaM2(walk.pts),
      perimeterM: C.perimeterM(walk.pts),
      createdTs: new Date().toISOString(),
    };
    S.farms.push(farm);
    S.activeFarm = farm.id;
    await addRecord('farm', farm, {
      lat: c.lat, lon: c.lon, ts: Date.now(),
      acc: Math.max(...walk.pts.map((p) => p.acc)),
    }, { name, crop: farm.crop, areaM2: round(farm.areaM2, 1), polygon: farm.polygon }, { prev: null });
    walk.pts = []; walk.done = false;
    $('#farm-form').reset();
    $('#farm-form').classList.add('hidden');
    walkStats(); walkButtons(); drawWalk(); drawFarmMap(); renderFarmList(); renderAll();
    toast('Farm saved and signed');
  } catch (err) { toast(err.message); }
});

function renderFarmList() {
  const el = $('#farm-list');
  if (!S.farms.length) { el.innerHTML = '<div class="muted">No farms yet. Walk your boundary to add one.</div>'; return; }
  const act = activeFarm();
  el.innerHTML = S.farms.map((f) => {
    const on = act && act.id === f.id;
    return `
    <button class="item" data-farm="${esc(f.id)}">
      <span>${esc(f.name)}<br><span class="sub">${esc(C.CROPS[f.crop]?.label || f.crop)} · ${C.m2ToHa(f.areaM2).toFixed(3)} ha</span></span>
      ${on ? '<span class="badge good">active</span>' : ''}
    </button>`;
  }).join('');
  $$('#farm-list [data-farm]').forEach((b) => b.addEventListener('click', () => {
    S.activeFarm = b.dataset.farm; save();
    const f = farmById(S.activeFarm);
    if (farmMap && f) farmMap.fitBounds(latlngs(f.polygon), { padding: [30, 30] });
    drawFarmMap(); renderFarmList(); renderScoutHeader(); prefillInputs();
  }));
}

// ---------- scouting ----------
function renderScoutHeader() {
  const f = activeFarm();
  $('#scout-farm').textContent = f ? `Reporting for: ${f.name}` : 'Save a farm first (Farm tab) so reports can be checked against its boundary.';
  $('#scout-btn').disabled = !f;
}
$('#scout-btn').addEventListener('click', async () => {
  const f = activeFarm();
  if (!f) return;
  const btn = $('#scout-btn');
  btn.disabled = true; btn.textContent = 'Getting a GPS fix…';
  try {
    const fix = await getFix();
    const rec = await addRecord('scout', f, fix, {
      type: $('#scout-type').value,
      severity: Number($('#scout-sev').value),
      note: $('#scout-note').value.trim().slice(0, 200),
    });
    const q = rec.body.quality;
    $('#scout-result').innerHTML = `
      <div class="result">
        <b>Saved and signed.</b> Location quality: <span class="badge ${q.score >= 80 ? 'good' : q.score >= 50 ? 'ok' : 'bad'}">${q.score}/100</span>
        ${q.flags.length ? '<br>' + q.flags.map((x) => esc(FLAG_TEXT[x] || x)).join('<br>') : ''}
        <br><span class="muted small">Accuracy ±${rec.body.acc} m · geohash ${esc(rec.body.geohash)} · waiting to be sealed in a batch</span>
      </div>`;
    $('#scout-note').value = '';
    drawFarmMap(); renderAll();
  } catch (err) { toast(err.message); }
  btn.disabled = false; btn.textContent = 'Save report';
});

// ---------- heat map & alerts ----------
function renderHeat() {
  const f = $('#heat-type').value;
  const candidates = scoutReports().filter((r) => r.type !== 'healthy' && (f === 'all' || r.type === f));
  const reports = C.usableReports(candidates);
  const excluded = candidates.length - reports.length;
  const clusters = C.findClusters(reports);
  if (heatMap) {
    heatLayerGroup.clearLayers();
    if (heat) { heatMap.removeLayer(heat); heat = null; }
    for (const fm of S.farms) L.polygon(latlngs(fm.polygon), { color: '#9aab88', weight: 1, fillOpacity: 0.05 }).addTo(heatLayerGroup);
    const pts = reports.map((r) => [r.lat, r.lon, (r.severity / 3) * (r.q / 100)]);
    if (pts.length) {
      if (L.heatLayer) {
        heat = L.heatLayer(pts, { radius: 32, blur: 26, maxZoom: 17, gradient: { 0.2: '#dce5d2', 0.45: '#9aab88', 0.7: '#476633', 1: '#8a3b12' } }).addTo(heatMap);
      } else {
        reports.forEach((r) => L.circle([r.lat, r.lon], { radius: 40, color: '#476633', weight: 0, fillOpacity: 0.3 }).addTo(heatLayerGroup));
      }
    }
    clusters.forEach((c) => L.circle([c.lat, c.lon], { radius: 500, color: '#b4761e', weight: 2, dashArray: '6 6', fillOpacity: 0.05 }).bindTooltip(`${c.count} ${esc(TYPES[c.type] || c.type)}`).addTo(heatLayerGroup));
    const all = [...reports.map((r) => [r.lat, r.lon]), ...S.farms.flatMap((fm) => latlngs(fm.polygon))];
    if (all.length) heatMap.fitBounds(all, { padding: [30, 30], maxZoom: 17 });
  }
  const al = $('#alerts');
  al.innerHTML = clusters.length
    ? clusters.map((c) => `<div class="item alert"><span>${c.count} reports of ${esc((TYPES[c.type] || c.type).toLowerCase())} within 1 km<br><span class="sub">Highest severity ${c.maxSeverity}/3 · needs expert verification</span></span></div>`).join('')
    : '<div class="muted">No outbreak clusters right now.</div>';
  if (excluded) al.innerHTML += `<div class="muted small">${excluded} report${excluded > 1 ? 's' : ''} with a weak or suspicious GNSS fix (quality under 50) ${excluded > 1 ? 'are' : 'is'} left out of the map and alerts.</div>`;
}

// ---------- inputs calculator ----------
function prefillInputs() {
  const f = activeFarm();
  $('#in-farm').textContent = f ? `Using: ${f.name}` : 'No saved farm. Enter an area by hand.';
  if (f) {
    $('#in-area').value = C.m2ToHa(f.areaM2).toFixed(3);
    $('#in-crop').value = f.crop;
  }
  applyCropDefaults();
}
function applyCropDefaults() {
  const p = C.CROPS[$('#in-crop').value];
  $('#in-row').value = p.rowCm; $('#in-plant').value = p.plantCm;
  $('#in-seed').value = p.seedKgHa; $('#in-npk').value = p.npkKgHa; $('#in-urea').value = p.ureaKgHa;
  calcInputs();
}
function calcInputs() {
  const n = (id) => Math.max(0, Number($(id).value) || 0);
  const area = n('#in-area');
  const r = C.inputPlan(area, { rowCm: n('#in-row'), plantCm: n('#in-plant'), seedKgHa: n('#in-seed'), npkKgHa: n('#in-npk'), ureaKgHa: n('#in-urea') });
  $('#in-out').innerHTML = area
    ? `Plants: <b>${r.plants.toLocaleString()}</b><br>Seed: <b>${r.seedKg.toFixed(1)} kg</b><br>NPK: <b>${r.npkKg.toFixed(0)} kg</b> (${r.npkBags} × 50 kg bags)<br>Urea: <b>${r.ureaKg.toFixed(0)} kg</b> (${r.ureaBags} × 50 kg bags)`
    : 'Enter an area to see quantities.';
}
$('#in-crop').addEventListener('change', applyCropDefaults);
['#in-area', '#in-row', '#in-plant', '#in-seed', '#in-npk', '#in-urea'].forEach((id) => $(id).addEventListener('input', calcInputs));

// ---------- trees: planting, survival, verification, payouts ----------
const SPECIES = ['Mixed native', 'Moringa', 'Cashew', 'Mango', 'Neem', 'Gmelina', 'Teak'];
const PAY_REASON = {
  first_payout_cap: 'Part held: a first payout is capped at ₦20,000 for safety',
  new_number_cooling_off: 'Held for 72 hours because the payout number changed',
  no_valid_number: 'Held: add a valid payout number',
  destination_unavailable: 'Held: payout number unavailable',
};
const naira = (kobo) => '₦' + (kobo / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 });
let treeView = null;

function treeEvidence(farm) {
  if (!farm) return {};
  const mine = (k) => S.records.filter((r) => r.body.kind === k && r.body.farmId === farm.id);
  const farmRec = mine('farm')[0];
  const planting = mine('planting').pop();
  const survival = planting ? mine('survival').filter((r) => S.records.indexOf(r) > S.records.indexOf(planting)).pop() : null;
  const hashes = farmRec && planting && survival ? [farmRec.hash, planting.hash, survival.hash] : null;
  const sent = hashes && S.sent.includes(hashes.join('|'));
  return { farmRec, planting, survival, hashes, sent };
}

function renderTrees() {
  const f = activeFarm();
  $('#tr-farm').textContent = f ? `Farm: ${f.name} · ${C.m2ToHa(f.areaM2).toFixed(2)} ha` : 'Save a farm first (Farm tab).';
  const ev = treeEvidence(f);
  const step = (id, done, text, warn) => { const el = $(id); el.className = 'step ' + (done ? 'done' : warn ? 'warn' : ''); el.innerHTML = `<span class="mark">${done ? '✓' : warn ? '!' : '○'}</span><span>${text}</span>`; };
  step('#tr-s1', !!ev.planting, ev.planting ? `Planting signed: ${ev.planting.body.data.count} trees` : 'Planting not recorded yet');
  const survStale = ev.planting && !ev.survival;
  step('#tr-s2', !!ev.survival, ev.survival ? `Survival check signed: ${ev.survival.body.data.alive} of ${ev.survival.body.data.sampleSize} alive` : 'Survival check not recorded yet', survStale && false);
  step('#tr-s3', !!ev.sent, ev.sent ? 'Sent for verification' : 'Not sent yet');
  $('#tr-plant-btn').disabled = !f;
  $('#tr-surv-btn').disabled = !f || !ev.planting;
  $('#tr-send-btn').disabled = !ev.hashes || !!ev.sent;
  // One step at a time: the next form appears only when the previous one is saved.
  $('#tr-step-1').classList.toggle('hidden', !!ev.planting);
  $('#tr-step-2').classList.toggle('hidden', !ev.planting || !!ev.survival);
  $('#tr-step-3').classList.toggle('hidden', !ev.survival || !!ev.sent);
  $('#tr-msisdn').value = $('#tr-msisdn').value || S.msisdn || '';
  $('#tr-outbox').textContent = S.outbox.length ? `${S.outbox.length} submission waiting for a connection. It will send automatically.` : '';

  const v = treeView;
  $('#tr-earn').innerHTML = v ? `Paid: <b>${naira(v.paidKobo)}</b> · Held: <b>${naira(v.heldKobo)}</b>${v.payoutTo ? ` · Number ${esc(v.payoutTo)}` : ''}` : (navigator.onLine ? 'Tap Refresh to load your status.' : 'Offline: status will load when you reconnect.');
  const badge = { pending: ['ok', 'awaiting verifier'], approved: ['good', 'approved'], rejected: ['bad', 'rejected'] };
  $('#tr-list').innerHTML = v && v.submissions.length
    ? v.submissions.map((s) => {
        const [cls, label] = badge[s.status];
        const issues = [...s.hard, ...s.flags].map((x) => `<div class="flag">${esc(x.text)}</div>`).join('');
        const dec = s.decision ? `<div class="sub">Verifier note: ${esc(s.decision.note || 'none')}</div>` : '';
        return `<div class="item"><span>${esc(s.farmName || 'Plot')} · ${s.units} verified tree-years<br><span class="sub">${s.alive}/${s.sample} alive of ${s.trees} planted · ${esc(fmtTime(s.receivedAt))}</span>${issues}${dec}</span><span class="badge ${cls}">${label}</span></div>`;
      }).join('')
    : '<div class="muted">Nothing submitted yet.</div>';
  $('#tr-pay').innerHTML = v && v.payouts.length
    ? v.payouts.map((p) => `<div class="item"><span>${naira(p.amountKobo)} · ${esc(p.orderId)}<br><span class="sub">${p.status === 'paid' ? `Sent to ${esc(p.to)} · ref ${esc(p.ref)} (sandbox)` : esc(PAY_REASON[p.reason] || 'Held')}</span></span><span class="badge ${p.status === 'paid' ? 'good' : 'ok'}">${p.status}</span></div>`).join('')
    : '<div class="muted">No payouts yet. They appear after a buyer purchases units from verified plots.</div>';
}

async function refreshTrees() {
  if (!navigator.onLine || !S.fp) return renderTrees();
  try {
    const r = await fetch('api/registry/farmer/' + S.fp);
    if (r.ok) treeView = await r.json();
  } catch { /* offline or server down: keep the last view */ }
  renderTrees();
}

async function captureTreeRecord(kind, data, btn, label) {
  const f = activeFarm();
  if (!f) return;
  btn.disabled = true; btn.textContent = 'Getting a GPS fix…';
  try {
    const fix = await getFix();
    const rec = await addRecord(kind, f, fix, data);
    const q = rec.body.quality;
    toast(`Signed. Location quality ${q.score}/100${q.flags.length ? ' (' + q.flags.map((x) => FLAG_TEXT[x] || x).join('; ') + ')' : ''}`);
  } catch (err) { toast(err.message); }
  btn.textContent = label;
  renderAll();
}
const wholeNumber = (id) => { const v = Number($(id).value); return Number.isInteger(v) ? v : NaN; };
$('#tr-plant-btn').addEventListener('click', () => {
  const count = wholeNumber('#tr-count');
  if (!(count >= 1)) return toast('Enter how many trees you planted (a whole number)');
  captureTreeRecord('planting', { count, species: $('#tr-species').value }, $('#tr-plant-btn'), 'Save planting');
});
$('#tr-surv-btn').addEventListener('click', () => {
  const sampleSize = wholeNumber('#tr-sample'), alive = wholeNumber('#tr-alive');
  if (!(sampleSize >= 1)) return toast('Enter how many trees you counted');
  if (!(alive >= 0) || alive > sampleSize) return toast('Alive trees cannot be more than the trees counted');
  captureTreeRecord('survival', { sampleSize, alive }, $('#tr-surv-btn'), 'Save survival check');
});

$('#tr-send-btn').addEventListener('click', async () => {
  const ev = treeEvidence(activeFarm());
  if (!ev.hashes || ev.sent) return;
  S.msisdn = $('#tr-msisdn').value.trim();
  try {
    await sealPending();
    S.outbox.push({ key: ev.hashes.join('|'), records: [ev.farmRec, ev.planting, ev.survival].map(({ body, hash, sig }) => ({ body, hash, sig })), pub: S.keys.pub, msisdn: S.msisdn });
    S.sent.push(ev.hashes.join('|'));
    save(); renderTrees();
    await flushOutbox();
  } catch (err) { toast(err.message); }
});

// Submissions made offline wait in the outbox and go out when a connection returns.
let flushing = false;
async function flushOutbox() {
  if (flushing || !navigator.onLine || !S.outbox.length) return;
  flushing = true;
  try {
    for (const item of [...S.outbox]) {
      const res = await fetch('api/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ records: item.records, pub: item.pub, msisdn: item.msisdn }) });
      if (res.status === 429 || res.status >= 500) break; // try again later
      const out = await res.json().catch(() => ({}));
      S.outbox = S.outbox.filter((x) => x.key !== item.key);
      if (!res.ok) S.sent = S.sent.filter((k) => k !== item.key); // refused outright: let the farmer fix and resend
      save();
      toast(res.ok ? (out.status === 'rejected' ? 'Submission rejected by the automatic checks' : 'Sent. An independent verifier will review it.') : (out.message || 'The registry refused this submission'));
    }
  } catch { /* offline: the outbox is kept */ }
  flushing = false;
  refreshTrees();
}
$('#tr-refresh').addEventListener('click', refreshTrees);

// ---------- records, batches, verification ----------
function renderRecords() {
  const pending = S.records.filter((r) => !r.batchId).length;
  $('#rec-summary').textContent = `${S.records.length} records · ${pending} waiting to be sealed · ${S.batches.length} batches`;
  $('#seal-btn').disabled = pending === 0;
  $('#batch-list').innerHTML = S.batches.length
    ? [...S.batches].reverse().map((b) => `<div class="item"><span>Batch ${esc(b.id)} · ${b.count} record${b.count === 1 ? '' : 's'}<br><span class="sub">root <code>${esc(short(b.root, 16))}</code> · ${esc(fmtTime(b.ts))}</span></span>${b.anchor ? `<span class="badge good">ledger #${b.anchor.seq}</span>` : '<span class="badge ok">not anchored</span>'}</div>`).join('')
    : '<div class="muted">No batches yet. Sealing groups pending records under one fingerprint (a Merkle root).</div>';
  $('#record-list').innerHTML = S.records.length
    ? [...S.records].reverse().slice(0, 100).map((r) => {
        const b = r.body, q = b.quality.score;
        const label = b.kind === 'farm' ? `Farm: ${b.data.name}` : b.kind === 'planting' ? `Planted ${b.data.count} trees` : b.kind === 'survival' ? `Survival: ${b.data.alive} of ${b.data.sampleSize} alive` : TYPES[b.data.type] || b.data.type;
        return `<button class="item" data-rec="${esc(b.id)}"><span>${esc(label)}<br><span class="sub">${esc(fmtTime(b.ts))} · ${r.batchId ? 'sealed' : 'pending'}</span></span><span class="badge ${q >= 80 ? 'good' : q >= 50 ? 'ok' : 'bad'}">${q}</span></button>`;
      }).join('')
    : '<div class="muted">No records yet.</div>';
  $$('#record-list [data-rec]').forEach((b) => b.addEventListener('click', () => openVerify(b.dataset.rec)));
}

async function sealPending() {
  const pending = S.records.filter((r) => !r.batchId);
  if (!pending.length) return null;
  const hashes = pending.map((r) => r.hash);
  const root = await C.merkleRoot(hashes);
  const batch = { id: uid(), ts: new Date().toISOString(), root, hashes, count: hashes.length, anchor: null };
  pending.forEach((r, i) => { r.batchId = batch.id; r.index = i; });
  S.batches.push(batch);
  save(); renderRecords();
  publishBatches();
  return batch;
}
$('#seal-btn').addEventListener('click', async () => {
  try {
    const b = await sealPending();
    if (b) toast(`Sealed ${b.count} records`);
  } catch (err) { toast(err.message); }
});

// Publishing is free for the farmer: the app sends only the batch fingerprint (a Merkle root) to the
// ledger, never the records. Offline, batches simply wait and are published when the network returns.
let publishing = false;
async function publishBatches() {
  if (publishing || !navigator.onLine) return;
  const todo = S.batches.filter((b) => !b.anchor);
  if (!todo.length) return;
  publishing = true;
  try {
    for (const b of todo) {
      const res = await fetch('api/anchor', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root: b.root, count: b.count }),
      });
      if (!res.ok) throw new Error('ledger refused the batch');
      const e = await res.json();
      b.anchor = { seq: e.seq, hash: e.hash, ts: e.ts };
      save(); renderRecords();
    }
    toast('Batch published to the ledger');
  } catch { /* no ledger reachable: the batch stays pending and is retried later */ }
  publishing = false;
}

let verifyId = null;
async function runVerify(rec, tamper) {
  const body = tamper ? { ...rec.body, lat: rec.body.lat + 0.0001 } : rec.body;
  const h = await C.hashBody(body);
  const sigOk = await C.verifySig(h, rec.sig, S.keys.pub);
  const fpOk = h === rec.hash;
  let batchLine;
  if (rec.batchId) {
    const batch = S.batches.find((b) => b.id === rec.batchId);
    const proof = await C.merkleProof(batch.hashes, rec.index);
    const inOk = await C.verifyProof(h, proof, batch.root);
    batchLine = line(inOk, `Included in batch ${esc(batch.id)}`, `Not found in batch ${esc(batch.id)}`) + `<br><span class="muted small">Batch root <code>${esc(batch.root)}</code></span>`;
  } else {
    batchLine = '<span class="pend-t">PENDING</span> Not sealed in a batch yet';
  }
  let anchorLine = '<span class="pend-t">NOT ANCHORED</span> This batch has not been published to the ledger yet';
  const bt = rec.batchId && S.batches.find((b) => b.id === rec.batchId);
  if (bt && bt.anchor) {
    let live = null; // null = could not check, false = ledger has no such root
    if (navigator.onLine) {
      try {
        const r = await fetch('api/anchor/' + bt.root);
        live = r.ok ? await r.json() : false;
      } catch { live = null; }
    }
    if (live && live.hash === bt.anchor.hash) {
      anchorLine = line(true, `Batch root is in ledger entry #${live.seq} (${esc(short(live.hash, 12))}), recorded ${esc(fmtTime(live.ts))}`, '');
    } else if (live !== null) {
      anchorLine = line(false, '', 'The ledger does not match this batch');
    } else {
      anchorLine = `<span class="pend-t">UNCHECKED</span> Published as ledger #${bt.anchor.seq}. Reconnect to re-check it`;
    }
  }
  const q = rec.body.quality;
  $('#verify-body').innerHTML = `
    <h2>${tamper ? 'Tampered copy (simulated)' : 'Record check'}</h2>
    ${line(fpOk, 'Content matches its fingerprint', 'Content does NOT match its fingerprint')}<br>
    ${line(sigOk, `Signature valid for key ${esc(rec.body.signer)}`, 'Signature is NOT valid')}<br>
    ${batchLine}<br>
    ${anchorLine}<br>
    <p class="muted small">Location ${rec.body.lat}, ${rec.body.lon} · ±${rec.body.acc} m · quality ${q.score}/100${q.flags.length ? ' · ' + esc(q.flags.map((x) => FLAG_TEXT[x] || x).join('; ')) : ''}<br>Fingerprint <code>${esc(rec.hash)}</code></p>`;
}
function line(ok, yes, no) {
  return ok ? `<span class="ok-t">PASS</span> ${yes}` : `<span class="bad-t">FAIL</span> ${no}`;
}
async function openVerify(id) {
  const rec = S.records.find((r) => r.body.id === id);
  if (!rec) return;
  verifyId = id;
  await runVerify(rec, false);
  $('#verify-dialog').showModal();
}
$('#tamper-btn').addEventListener('click', async () => {
  const rec = S.records.find((r) => r.body.id === verifyId);
  if (rec) await runVerify(rec, true);
});
$('#close-verify').addEventListener('click', () => $('#verify-dialog').close());

$('#export-btn').addEventListener('click', () => {
  const data = { app: 'plotline', exportedAt: new Date().toISOString(), signerPublicKey: S.keys.pub, farms: S.farms, records: S.records, batches: S.batches };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'plotline-export.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('#reset-btn').addEventListener('click', () => {
  if (!confirm('Delete all farms, records and your signing key from this device?')) return;
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  location.reload();
});

// ---------- demo data ----------
$('#demo-btn').addEventListener('click', async () => {
  if (S.farms.some((f) => f.demo)) return toast('Demo data is already loaded');
  try {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const base = { lat: 9.8965, lon: 8.8583 };
    const polygon = [[0, 0], [0, 0.0024], [0.0018, 0.0024], [0.0018, 0]].map(([a, b]) => ({ lat: round(base.lat + a, 7), lon: round(base.lon + b, 7) }));
    const farm = { id: uid(), name: 'Demo plot (maize)', crop: 'maize', polygon, areaM2: C.polygonAreaM2(polygon), perimeterM: C.perimeterM(polygon), createdTs: new Date().toISOString(), demo: true };
    S.farms.push(farm);
    S.activeFarm = farm.id;
    const c = C.centroid(polygon);
    await addRecord('farm', farm, { lat: c.lat, lon: c.lon, acc: 5, ts: Date.now() }, { name: farm.name, crop: 'maize', areaM2: round(farm.areaM2, 1), polygon, demo: true }, { prev: null, demo: true });
    const spots = [
      ['pest', 4, 0.0014, 0.002, 3], ['water_stress', 3, 0.0004, 0.0004, 2],
      ['disease', 2, 0.0009, 0.0012, 2], ['healthy', 3, 0.0007, 0.0016, 1],
    ];
    for (const [type, n, dLat, dLon, sev] of spots) {
      for (let i = 0; i < n; i++) {
        const days = 1 + Math.floor(rnd() * 9);
        const fix = { lat: base.lat + dLat + (rnd() - 0.5) * 0.0004, lon: base.lon + dLon + (rnd() - 0.5) * 0.0004, acc: 4 + rnd() * 8, ts: Date.now() - days * 86400000 };
        await addRecord('scout', farm, fix, { type, severity: Math.max(1, Math.min(3, sev + (i % 2 ? 0 : -1) + (type === 'pest' && i === 0 ? 1 : 0))), note: 'demo', demo: true }, { prev: null, now: fix.ts, demo: true });
      }
    }
    if (farmMap) farmMap.fitBounds(latlngs(polygon), { padding: [30, 30] });
    drawFarmMap(); renderAll();
    toast('Demo data loaded. Try the Heat map tab.');
  } catch (err) { toast(err.message); }
});

// ---------- tabs & init ----------
// Four bottom tabs. Heat map is part of Scout and the input calculator part of Farm.
const PARENT = { inputs: 'farm', heat: 'scout' };
function renderAll() {
  renderFarmList(); renderScoutHeader(); renderRecords(); prefillInputs(); renderTrees();
  if ($('#tab-heat').classList.contains('active')) renderHeat();
}
function showTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  const parent = PARENT[name] || name;
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === parent));
  $$('[data-sub]').forEach((b) => b.classList.toggle('on', b.dataset.sub === name));
  if (name === 'farm' && farmMap) setTimeout(() => farmMap.invalidateSize(), 50);
  if (name === 'heat') { setTimeout(() => { if (heatMap) heatMap.invalidateSize(); renderHeat(); }, 50); }
  if (name === 'inputs') calcInputs();
  if (name === 'records') renderRecords();
  if (name === 'trees') refreshTrees();
  window.scrollTo(0, 0);
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
$$('[data-sub]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.sub)));

// ---------- first run ----------
function closeOnboarding(start) {
  S.onboarded = true;
  save();
  const d = $('#onboard');
  if (d.open) d.close();
  if (start) { showTab('farm'); $('#walk-btn').click(); }
}
$('#onboard-go').addEventListener('click', () => closeOnboarding(true));
$('#onboard-skip').addEventListener('click', () => closeOnboarding(false));
$('#onboard').addEventListener('cancel', (e) => { e.preventDefault(); closeOnboarding(false); });
function maybeOnboarding() {
  if (!S.onboarded && !S.farms.length) $('#onboard').showModal();
}

function netChip() {
  const c = $('#net-chip');
  // Only speak up when there is something to say.
  c.hidden = navigator.onLine;
  c.className = 'chip ok';
  c.textContent = 'offline';
}
window.addEventListener('online', () => { netChip(); publishBatches(); flushOutbox(); });
window.addEventListener('offline', netChip);

async function init() {
  load();
  await ensureKeys();
  $('#farm-crop').innerHTML = Object.entries(C.CROPS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  $('#in-crop').innerHTML = $('#farm-crop').innerHTML;
  $('#tr-species').innerHTML = SPECIES.map((x) => `<option>${x}</option>`).join('');
  $('#scout-type').innerHTML = Object.entries(TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('#heat-type').innerHTML = '<option value="all">All problems</option>' + Object.entries(TYPES).filter(([k]) => k !== 'healthy').map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('#heat-type').addEventListener('change', renderHeat);

  farmMap = makeMap($('#map-farm'));
  heatMap = makeMap($('#map-heat'));
  if (farmMap) { farmLayer = L.layerGroup().addTo(farmMap); walkLayer = L.layerGroup().addTo(farmMap); }
  if (heatMap) heatLayerGroup = L.layerGroup().addTo(heatMap);

  const f = activeFarm();
  if (f && farmMap) farmMap.fitBounds(latlngs(f.polygon), { padding: [30, 30] });
  drawFarmMap(); walkStats(); walkButtons(); renderAll(); netChip();
  maybeOnboarding();
  publishBatches(); flushOutbox();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init().catch((err) => { console.error(err); toast('Startup problem: ' + err.message); });
