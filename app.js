import * as C from './core.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
// Set per deployment in app.html; submissions are linked to this registered project.
const PROJECT_ID = $('meta[name="plotline-project"]')?.content.trim() || null;
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
let S = { farms: [], records: [], batches: [], keys: null, fp: null, activeFarm: null, msisdn: '', outbox: [], sent: [], onboarded: false, ndvi: {}, rain: {} };

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

// ── Global motion utilities (the 20 UI animation rules) ─────────────────────
// Small helpers above CSS tokens + the View Transitions API — no framework.
const GN_MOTION = (() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const vtOkay = typeof document.startViewTransition === 'function';
  return {
    reduced,
    // Rules 1 & 15/18 inside a wrapped View Transition (overlap + crossfade).
    async transition(fn) {
      if (reduced || !vtOkay) return fn();
      return document.startViewTransition(fn).finished;
    },
    // Rule 1: ease-out entrance with an opt-out at 30ms-per-row stagger.
    enter(el, i = null) {
      if (!el) return;
      el.classList.remove('gn-enter');
      if (i !== null && !reduced) {
        el.style.setProperty('--i', i);
        el.classList.add('gn-stagger'); // applied to the container
      } else {
        el.classList.add('gn-enter');
      }
    },
    // Rule 4: press stays static — only the CSS :active scale, no tween on hold.
    press(el) { el?.classList.add('gn-press'); },
    // Rule 8: success state gets a single pulse.
    pulse(el) {
      if (reduced) return;
      el?.classList.remove('gn-pulse');
      void el?.offsetWidth; // restart the animation
      el?.classList.add('gn-pulse');
      el?.addEventListener('animationend', () => el.classList.remove('gn-pulse'), { once: true });
    },
    // Rule 13: crossfade an icon's content with a slight blur mid-swap.
    swapIcon(el, apply) {
      if (!el || reduced) return apply?.();
      apply?.();
      el.classList.remove('gn-icon-swap');
      void el.offsetWidth;
      el.classList.add('gn-icon-swap');
      el.addEventListener('animationend', () => el.classList.remove('gn-icon-swap'), { once: true });
    },
  };
})();

// Stagger any freshly rendered list: rows settle one after another at 30ms.
function gnStag(el) {
  if (!el) return;
  if (GN_MOTION.reduced) return;
  el.classList.remove('gn-stagger');
  [...el.children].forEach((child, i) => child.style.setProperty('--i', i));
  void el.offsetWidth; // reflow so the keyframes restart on re-render
  el.classList.add('gn-stagger');
}

// Tab-render skip: rebuilding lists and replaying the stagger on EVERY tab
// visit is the per-tab flash — the crossfade reveals a view that then
// re-animates from scratch. Views are pure functions of stored data, so a
// signature over that data drops repeat visits entirely (the "render once,
// leave the DOM alone" pattern). Data mutations produce a new signature and
// re-render naturally.
const lastRenderSig = new Map();
function renderSeen(key, sig) {
  const seen = lastRenderSig.get(key) === sig;
  if (!seen) lastRenderSig.set(key, sig);
  return seen;
}
function renderOnce(key, sig, fn) {
  if (!renderSeen(key, sig)) fn();
}

// Success toasts pulse their chip — the visual handshake for rule 8.
const gnToastPulse = toast;

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
      updateGpsChip(); updateHud();
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
  L.tileLayer(C.TILE_URL, {
    maxZoom: 19,
    attribution: C.TILE_ATTRIBUTION,
    // CORS mode makes tile responses status-readable: without it the browser
    // answers with opaque responses (status 0), res.ok is false for those, and
    // the service worker silently failed to cache any tile. With it, explicit
    // 403s still never enter the cache, and res.ok==200 tiles do.
    crossOrigin: true,
    // Tab-switch smoothing: keep neighbours around so returning to a tab
    // shows the map already drawn instead of blank squares fading in.
    keepBuffer: 4,
    updateWhenIdle: false,
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

function updateHud() {
  // Mission-control HUD over the map (app.html). Guards: HUD exists only in the app shell.
  const accEl = $('#hud-acc'), ptsEl = $('#hud-pts'), areaEl = $('#hud-area');
  if (!accEl && !ptsEl && !areaEl) return;
  const f = activeFarm();
  const n = (walk.on || walk.done) ? walk.pts.length : (f ? f.polygon.length : 0);
  const poly = (walk.on || walk.done) ? (n >= 3 ? walk.pts : null) : (f ? f.polygon : null);
  const areaHa = poly ? C.m2ToHa(C.polygonAreaM2(poly)) : (f ? C.m2ToHa(f.areaM2) : 0);
  if (accEl) accEl.textContent = lastFix ? '±' + Math.round(lastFix.acc) + ' m' : '±— m';
  if (ptsEl) ptsEl.textContent = n + ' pts';
  if (areaEl) areaEl.textContent = areaHa > 0 ? areaHa.toFixed(2) + ' ha' : '0.00 ha';
}
function walkStats() {
  const el = $('#walk-stats');
  const n = walk.pts.length;
  el.textContent = '';
  if (!walk.on && !walk.done) { updateHud(); return; }
  const area = n >= 3 ? C.m2ToHa(C.polygonAreaM2(walk.pts)).toFixed(3) + ' ha' : '—';
  const per = n >= 2 ? Math.round(C.perimeterM(walk.pts)) + ' m' : '—';
  el.textContent = `${n} point${n === 1 ? '' : 's'} · ${area} · perimeter ${per}`;
  updateHud();
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
  gnStag(el);
  $$('#farm-list [data-farm]').forEach((b) => b.addEventListener('click', () => {
    S.activeFarm = b.dataset.farm; save();
    const f = farmById(S.activeFarm);
    if (farmMap && f) farmMap.fitBounds(latlngs(f.polygon), { padding: [30, 30] });
    drawFarmMap(); renderFarmList(); renderScoutHeader(); prefillInputs();
    loadNdviPanel();
    loadRainPanel();
  }));
}

// ---------- NDVI trend panel ----------
// The server computes the series — this phone never talks to a satellite
// provider. The service worker passes /api/ requests straight to the network,
// so localStorage is the offline cache: without signal the panel shows the
// last saved series, and a plot that has been checked online once keeps its
// 12-month trend available offline.
const NDVI_FRESH_MS = 6 * 3600 * 1000; // matches the server-side cache window

const ndviMonth = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en', { month: 'short', year: '2-digit' });
};

function ndviSvg(series, trend) {
  // Fixed 0–0.9 NDVI scale so every farm reads the same way:
  // 0 bare soil … 0.3 sparse … 0.6 moderate canopy … 0.9 dense.
  const W = 320, H = 128, padL = 30, padR = 10, padT = 8, padB = 18;
  const n = series.length;
  const x = (i) => padL + (n > 1 ? (i * (W - padL - padR)) / (n - 1) : (W - padL - padR) / 2);
  const y = (v) => padT + (1 - Math.min(1, Math.max(0, v / 0.9))) * (H - padT - padB);
  const grid = [0, 0.3, 0.6, 0.9].map((g) =>
    `<line x1="${padL}" y1="${y(g).toFixed(1)}" x2="${W - padR}" y2="${y(g).toFixed(1)}" class="ndvi-grid"></line>`
    + `<text x="${padL - 6}" y="${(y(g) + 3).toFixed(1)}" class="ndvi-label" text-anchor="end">${g.toFixed(1)}</text>`,
  ).join('');
  const median = trend?.medianPrev != null && n >= 4
    ? `<line x1="${padL}" y1="${y(trend.medianPrev).toFixed(1)}" x2="${W - padR}" y2="${y(trend.medianPrev).toFixed(1)}" class="ndvi-median"></line>`
    : '';
  const dip = trend?.dip
    ? `<circle cx="${x(n - 1).toFixed(1)}" cy="${y(series[n - 1].ndvi).toFixed(1)}" r="5" class="ndvi-dip"></circle>`
    : '';
  const pts = series.map((p, i) => x(i).toFixed(1) + ',' + y(p.ndvi).toFixed(1)).join(' ');
  const labels = n > 1
    ? `<text x="${x(0).toFixed(1)}" y="${H - 4}" class="ndvi-label" text-anchor="start">${ndviMonth(series[0].to || series[0].from)}</text>`
      + `<text x="${x(n - 1).toFixed(1)}" y="${H - 4}" class="ndvi-label" text-anchor="end">${ndviMonth(series[n - 1].to || series[n - 1].from)}</text>`
    : '';
  const summary = 'NDVI by month: '
    + series.map((p) => ndviMonth(p.to || p.from) + ' ' + p.ndvi.toFixed(2)).join(', ');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${summary}">${grid}${median}<polyline points="${pts}" class="ndvi-line"></polyline>${dip}${labels}</svg>`;
}

function renderNdvi(entry, { stale = false } = {}) {
  const src = $('#ndvi-src');
  const chart = $('#ndvi-chart');
  const note = $('#ndvi-note');
  if (!src || !chart || !note) return;
  const status = entry?.status;
  const series = status === 'ok' ? (entry.series ?? []) : [];
  chart.innerHTML = series.length ? ndviSvg(series, entry.trend) : '';
  if (status === 'ok') {
    src.textContent = 'satellite · '
      + (entry.fetchedTs ? 'checked ' + ndviMonth(entry.fetchedTs).replace(' ', ' \u2019') : 'just now');
    src.className = 'ndvi-src good';
    if (entry.trend?.dip) {
      note.textContent = 'Last month is ' + Math.abs(entry.trend.drop).toFixed(2)
        + ' below this plot\u2019s own median (' + entry.trend.medianPrev.toFixed(2)
        + '). Possible stress \u2014 check the crop in person; satellites see clouds and soil, not causes.';
    } else if (series.length < 4) {
      note.textContent = 'History is building: a dip verdict needs at least 4 clear months.';
    } else {
      note.textContent = 'No dip: the latest month sits within this plot\u2019s own recent median ('
        + (entry.trend?.medianPrev ?? series[series.length - 1].ndvi).toFixed(2) + ').';
    }
    if (stale) note.textContent += ' (offline \u2014 showing the saved series)';
  } else if (status === 'stub') {
    src.textContent = 'not connected';
    src.className = 'ndvi-src warn';
    note.textContent = entry.message || 'NDVI trend is not live yet.' + (stale ? ' (offline)' : '');
  } else if (status) {
    src.textContent = 'unavailable';
    src.className = 'ndvi-src warn';
    note.textContent = 'The satellite service did not answer this time. The trend appears as soon as a check succeeds.';
  } else if (!navigator.onLine) {
    src.textContent = '\u2014';
    src.className = 'ndvi-src';
    note.textContent = 'No connection yet. Check this plot once online; its trend then stays readable offline.';
  } else {
    note.textContent = 'Checking this plot\u2019s boundary against the satellite record\u2026';
  }
}

async function loadNdviPanel() {
  const panel = $('#ndvi-panel');
  if (!panel) return;
  const farm = activeFarm();
  if (!farm || !farm.polygon || farm.polygon.length < 3) { panel.hidden = true; return; }
  panel.hidden = false;
  const cachedEntry = S.ndvi?.[farm.id];
  if (!navigator.onLine) { renderNdvi(cachedEntry, { stale: true }); return; } // offline: the saved series is the whole experience
  renderNdvi(cachedEntry);
  if (cachedEntry && Date.now() - (cachedEntry.fetchedTs ?? 0) < NDVI_FRESH_MS) return;
  try {
    const res = await fetch('api/registry/ndvi-series', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ polygon: farm.polygon, months: 12 }),
    });
    if (activeFarm()?.id !== farm.id) return; // farm switched mid-request: skip the stale redraw
    if (!res.ok) return renderNdvi({ status: 'unavailable' });
    const data = await res.json();
    if (data.status === 'ok') {
      S.ndvi[farm.id] = { ...data, fetchedTs: Date.now() }; // server data only: stubs are never stored
      save();
    }
    renderNdvi(data.status === 'ok' ? S.ndvi[farm.id] : data);
  } catch { /* offline mid-request: the cached render stands */ }
}

// ---------- Rainfall panel (CHIRPS via the server) ----------
// Same discipline as the NDVI panel: the server holds the provider credential,
// localStorage holds the offline copy, and stubs are never persisted. Weekly
// buckets are fixed-width 7-day slices from the server, so the bars read
// consistently regardless of when the check runs.

const rainWeek = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
};

function rainSvg(weekly) {
  // Dynamic mm scale rounded to a clean grid so no bar hugs the ceiling.
  const W = 320, H = 128, padL = 30, padR = 10, padT = 8, padB = 18;
  const n = weekly.length;
  const maxMm = Math.max(1, ...weekly.map((w) => w.mm));
  const top = Math.ceil(maxMm / 10) * 10; // clean gridline, bars never touch it
  const bw = Math.min(18, (W - padL - padR) / Math.max(1, n) * 0.6);
  const x = (i) => padL + (i + 0.5) * ((W - padL - padR) / Math.max(1, n)) - bw / 2;
  const y = (v) => padT + (1 - Math.min(1, Math.max(0, v / top))) * (H - padT - padB);
  const grid = [0, top / 2, top].map((g) =>
    `<line x1="${padL}" y1="${y(g).toFixed(1)}" x2="${W - padR}" y2="${y(g).toFixed(1)}" class="ndvi-grid"></line>`
    + `<text x="${padL - 6}" y="${(y(g) + 3).toFixed(1)}" class="ndvi-label" text-anchor="end">${Math.round(g)}</text>`,
  ).join('');
  const bars = weekly.map((w, i) => {
    const hpx = Math.max(1.5, y(0) - y(w.mm)); // a mizzle week still shows a sliver
    return `<rect x="${x(i).toFixed(1)}" y="${(y(w.mm)).toFixed(1)}" width="${bw.toFixed(1)}" height="${hpx.toFixed(1)}" rx="1.5" class="rain-bar"><title>${rainWeek(w.from)} – ${rainWeek(w.to)}: ${w.mm} mm</title></rect>`;
  }).join('');
  const labels = n > 1
    ? `<text x="${x(0).toFixed(1)}" y="${H - 4}" class="ndvi-label" text-anchor="middle">${rainWeek(weekly[0].from)}</text>`
      + `<text x="${x(n - 1).toFixed(1)}" y="${H - 4}" class="ndvi-label" text-anchor="middle">${rainWeek(weekly[n - 1].to)}</text>`
    : '';
  const summary = 'Rainfall by week: ' + weekly.map((w) => rainWeek(w.from) + ' ' + w.mm + ' mm').join(', ');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${summary}">${grid}${bars}${labels}</svg>`;
}

function renderRain(entry, { stale = false } = {}) {
  const src = $('#rain-src');
  const chart = $('#rain-chart');
  const note = $('#rain-note');
  if (!src || !chart || !note) return;
  const status = entry?.status;
  const weekly = status === 'ok' ? (entry.series ?? []) : [];
  chart.innerHTML = weekly.length ? rainSvg(weekly) : '';
  if (status === 'ok') {
    src.textContent = 'satellite · '
      + (entry.fetchedTs ? 'checked ' + rainWeek(entry.fetchedTs) : 'just now');
    src.className = 'ndvi-src good';
    const dry = entry.longestDrySpellDays
      ? ` Longest stretch without real rain: ${entry.longestDrySpellDays} day${entry.longestDrySpellDays === 1 ? '' : 's'}.`
      : '';
    note.textContent = 'Last 30 days: ' + (entry.last30Mm ?? 0) + ' mm of rain.' + dry
      + ' Satellite rainfall on 5 km pixels — use it to time planting, not as a gauge on the plot.';
    if (stale) note.textContent += ' (offline — showing the saved series)';
  } else if (status === 'stub') {
    src.textContent = 'not connected';
    src.className = 'ndvi-src warn';
    note.textContent = entry.message || 'Rainfall check is not live yet.' + (stale ? ' (offline)' : '');
  } else if (status) {
    src.textContent = 'unavailable';
    src.className = 'ndvi-src warn';
    note.textContent = 'The rainfall service did not answer this time. It appears as soon as a check succeeds.';
  } else if (!navigator.onLine) {
    src.textContent = '—';
    src.className = 'ndvi-src';
    note.textContent = 'No connection yet. Check this plot once online; its rainfall record then stays readable offline.';
  } else {
    note.textContent = 'Reading this plot\u2019s rainfall from the satellite record…';
  }
}

async function loadRainPanel() {
  const panel = $('#rain-panel');
  if (!panel) return;
  const farm = activeFarm();
  if (!farm || !farm.polygon || farm.polygon.length < 3) { panel.hidden = true; return; }
  panel.hidden = false;
  const cachedEntry = S.rain?.[farm.id];
  if (!navigator.onLine) { renderRain(cachedEntry, { stale: true }); return; }
  renderRain(cachedEntry);
  if (cachedEntry && Date.now() - (cachedEntry.fetchedTs ?? 0) < NDVI_FRESH_MS) return; // same 6 h freshness
  try {
    const res = await fetch('api/registry/rain', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ polygon: farm.polygon, months: 6 }),
    });
    if (activeFarm()?.id !== farm.id) return; // farm switched mid-request
    if (!res.ok) return renderRain({ status: 'unavailable' });
    const data = await res.json();
    if (data.status === 'ok') {
      S.rain[farm.id] = { ...data, fetchedTs: Date.now() }; // server data only: stubs are never stored
      save();
    }
    renderRain(data.status === 'ok' ? S.rain[farm.id] : data);
  } catch { /* offline mid-request: the cached render stands */ }
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
    // Provenance stays honest offline: only the photo hashes go in the record —
    // the images themselves belong to the phone, not to localStorage.
    const rec = await addRecord('scout', f, fix, {
      type: $('#scout-type').value,
      severity: Number($('#scout-sev').value),
      note: $('#scout-note').value.trim().slice(0, 200),
      photos: scoutShots.length,
      photoHashes: scoutShots.map((s) => s.hash),
      ai: scoutAi ? { label: scoutAi.label, confidence: scoutAi.confidence, severity: scoutAi.severity, provider: scoutAi.provider, pathogenName: scoutAi.pathogenName } : null,
    });
    const q = rec.body.quality;
    const aiLine = rec.body.data.ai ? `<br><span class="muted small">AI check: ${esc(rec.body.data.ai.label)} (${Math.round((rec.body.data.ai.confidence || 0) * 100)}%, ${esc(rec.body.data.ai.provider)})</span>` : '';
    $('#scout-result').innerHTML = `
      <div class="result">
        <b>Saved and signed.</b> Location quality: <span class="badge ${q.score >= 80 ? 'good' : q.score >= 50 ? 'ok' : 'bad'}">${q.score}/100</span>
        ${q.flags.length ? '<br>' + q.flags.map((x) => esc(FLAG_TEXT[x] || x)).join('<br>') : ''}
        ${scoutShots.length ? `<br><span class="muted small">${scoutShots.length} photo${scoutShots.length === 1 ? '' : 's'} hashed into the record</span>` : ''}
        ${aiLine}
        <br><span class="muted small">Accuracy ±${rec.body.acc} m · geohash ${esc(rec.body.geohash)} · waiting to be sealed in a batch</span>
      </div>`;
    $('#scout-note').value = '';
    clearScoutShots();
    drawFarmMap(); renderAll();
  } catch (err) { toast(err.message); }
  btn.disabled = false; btn.textContent = 'Save report';
});

// ---------- scout photos & AI classification ----------
// Photos are downscaled to a long edge of 1024 px / JPEG 0.6 on this phone and
// kept in memory only — preview + hashing for provenance, never localStorage.
// The AI check posts them to /api/classify and REQUIRES A SIGNAL: the offline
// path is unchanged (save the report, no AI label). Like every AI verdict, the
// suggestion is shown, never imposed — the scout confirms the type before saving.
const SCOUT_PHOTOS_MAX = 3;
const PHOTO_MAX_EDGE = 1024;
const PHOTO_JPEG_QUALITY = 0.6;
const PHOTO_PAYLOAD_BUDGET = 3_000_000; // JSON envelope room under the server's 4.5 MB cap
const SEV_NUM = Object.freeze({ high: 3, medium: 2, low: 1, none: 1 });

let scoutShots = []; // { b64, mimeType, hash }
let scoutAi = null;
const scoutAiBtn = $('#scout-ai-btn');

$('#scout-photo-btn')?.addEventListener('click', () => $('#scout-photos')?.click());
$('#scout-photos')?.addEventListener('change', (e) => addScoutPhotos([...e.target.files]).finally(() => { e.target.value = ''; }));

async function downscaleShot(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const b64 = canvas.toDataURL('image/jpeg', PHOTO_JPEG_QUALITY).split(',')[1] || '';
  return { b64, mimeType: 'image/jpeg', bytes: Math.round(b64.length * 0.75) };
}

async function addScoutPhotos(files) {
  const extras = scoutShots.length + files.length - SCOUT_PHOTOS_MAX;
  const usable = extras > 0 ? files.slice(0, files.length - extras) : [...files];
  if (extras > 0) toast(`Keeping the first ${SCOUT_PHOTOS_MAX} photos`);
  for (const file of usable) {
    try {
      const shot = await downscaleShot(file);
      const bytes = scoutShots.reduce((a, s) => a + s.b64.length, 0) * 0.75 + shot.bytes;
      if (bytes > PHOTO_PAYLOAD_BUDGET) { toast('Photo budget reached — earlier shots kept'); break; }
      shot.hash = await C.sha256Hex(shot.b64);
      scoutShots.push(shot);
    } catch { toast('A photo could not be read on this phone'); }
  }
  renderScoutShots();
}

function clearScoutShots() {
  scoutShots = [];
  scoutAi = null;
  renderScoutShots();
}

function renderScoutShots() {
  const strip = $('#scout-thumbs');
  if (!strip) return;
  strip.innerHTML = scoutShots.map((s, i) => `
    <button class="shoot-thumb" type="button" data-shot="${i}" title="Remove photo">
      <img alt="" src="data:${s.mimeType};base64,${s.b64}">
      <span class="shoot-x">×</span>
    </button>`).join('');
  strip.querySelectorAll('[data-shot]').forEach((el) => el.addEventListener('click', () => {
    scoutShots.splice(Number(el.dataset.shot), 1);
    renderScoutShots();
  }));
  if (scoutAiBtn) scoutAiBtn.disabled = !scoutShots.length;
}

function aiChip(text, cls = 'soft') {
  const chip = $('#scout-ai-chip');
  if (!chip) return;
  chip.className = `chip ${cls}`;
  chip.textContent = text;
  if (text) { chip.hidden = false; } else chip.hidden = true;
}

const AI_TYPE_HINTS = [
  [/(aphid|worm|beetle|locust|insect|bug|borer|thrip|mite)/i, 'pest'],
  [/(mildew|rust|blight|rot|spot|canker|wilt|fungus|virus|lesion)/i, 'disease'],
  [/(nutrient|chlorosis|deficien|yellowing)/i, 'nutrient'],
  [/(weed)/i, 'weeds'],
  [/(drought|stress|scorch|burn|water)/i, 'water_stress'],
  [/(healthy|no crop|unclear)/i, 'healthy'],
];
function aiTypeFor(label) {
  for (const [re, type] of AI_TYPE_HINTS) if (re.test(label)) return type;
  return null;
}

scoutAiBtn?.addEventListener('click', async () => {
  if (!scoutShots.length) return;
  const btn = scoutAiBtn;
  btn.disabled = true; btn.textContent = 'Checking…';
  aiChip('Checking with AI…');
  try {
    const res = await fetch('api/classify', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ images: scoutShots.map((s) => ({ imageBase64: s.b64, mimeType: s.mimeType })) }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 503 || data.error === 'ai_unconfigured') {
      aiChip('AI not configured on this server');
      $('#scout-ai-verdict').innerHTML = '<div class="alert-box amber sm">AI check is not available on this deployment. Save the report as usual.</div>';
      return;
    }
    if (!res.ok) throw new Error(data.error || 'the AI check failed');
    scoutAi = data;
    const conf = Math.round((data.confidence || 0) * 100);
    const hint = aiTypeFor(data.label);
    if (hint) { $('#scout-type').value = hint; }
    $('#scout-sev').value = String(SEV_NUM[data.severity] || 2);
    $('#scout-ai-verdict').innerHTML = `
      <b>${esc(data.label)}</b> <span class="badge ${conf >= 85 ? 'good' : conf >= 50 ? 'ok' : 'bad'}">${conf}%</span>
      <span class="text-faint text-xs">via ${esc(data.provider || 'AI')} — suggestion, confirm before saving</span>
      ${data.notes ? `<br><span class="muted small">${esc(data.notes)}</span>` : ''}
      ${data.pathogenName ? `<br><span class="muted small">Causal agent: ${esc(data.pathogenName)}</span>` : ''}`;
    if (!$('#scout-note').value.trim() && data.notes) $('#scout-note').value = `${data.label} — ${data.notes}`.slice(0, 200);
    aiChip(`AI: ${data.label} · ${conf}%`, conf >= 85 ? 'good' : conf >= 50 ? 'ok' : 'bad');
  } catch (err) {
    aiChip('AI unavailable');
    $('#scout-ai-verdict').innerHTML = `<div class="alert-box red sm">${esc(err.message || 'AI check failed — save the report as usual.')}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = 'Check with AI';
  }
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
  gnStag(al);
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
  // Find the most recent survival record that was created after the most recent planting.
  const plantingTs = planting ? new Date(planting.body.ts).getTime() : 0;
  const survival = planting
    ? mine('survival').filter((r) => new Date(r.body.ts).getTime() > plantingTs).pop()
    : null;
  const hashes = farmRec && planting && survival ? [farmRec.hash, planting.hash, survival.hash] : null;
  const sent = hashes && S.sent.includes(hashes.join('|'));
  return { farmRec, planting, survival, hashes, sent };
}

function renderTrees() {
  // Skip the rebuild when nothing the view draws has changed — repeat tab
  // visits replaying stat/step/list markup and the stagger is the flash.
  if (renderSeen('trees', JSON.stringify([S.records, S.farms, S.outbox, S.msisdn, treeView, navigator.onLine]))) return;
  const f = activeFarm();
  $('#tr-farm').textContent = f ? `Farm: ${f.name} · ${C.m2ToHa(f.areaM2).toFixed(2)} ha` : 'Save a farm first (Farm tab).';
  const ev = treeEvidence(f);

  // ── Stat strip ──────────────────────────────────────────────────────────
  const strip = $('#tr-stats-strip');
  if (ev.planting) {
    $('#tr-count-stat').textContent = ev.planting.body.data.count;
    const survPct = ev.survival
      ? Math.round((ev.survival.body.data.alive / ev.survival.body.data.sampleSize) * 100) + '%'
      : '—';
    $('#tr-surv-stat').textContent = survPct;
    const pending = treeView ? treeView.submissions.filter((s) => s.status === 'pending').length : (ev.sent ? '…' : '—');
    $('#tr-pend-stat').textContent = pending;
    $('#tr-cred-stat').textContent = treeView
      ? treeView.submissions.reduce((a, s) => a + (s.units || 0), 0)
      : '—';
    strip.hidden = false;
  } else {
    strip.hidden = true;
  }
  // ── Step indicators ─────────────────────────────────────────────────────
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
        return `<div class="item"><span>${esc(s.farmName || 'Plot')} · ${s.units} tCO₂e credits<br><span class="sub">${s.activityUnits ? s.activityUnits + ' verified tree-years · ' : ''}${s.alive}/${s.sample} alive of ${s.trees} planted · ${esc(fmtTime(s.receivedAt))}</span>${issues}${dec}</span><span class="badge ${cls}">${label}</span></div>`;
      }).join('')
    : '<div class="muted">Nothing submitted yet.</div>';
  $('#tr-pay').innerHTML = v && v.payouts.length
    ? v.payouts.map((p) => `<div class="item"><span>${naira(p.amountKobo)} · ${esc(p.orderId)}<br><span class="sub">${p.status === 'paid' ? `Sent to ${esc(p.to)} · ref ${esc(p.ref)} (sandbox)` : esc(PAY_REASON[p.reason] || 'Held')}</span></span><span class="badge ${p.status === 'paid' ? 'good' : 'ok'}">${p.status}</span></div>`).join('')
    : '<div class="muted">No payouts yet. They appear after a buyer purchases units from verified plots.</div>';
  gnStag($('#tr-list')); gnStag($('#tr-pay'));
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
    S.outbox.push({ key: ev.hashes.join('|'), projectId: PROJECT_ID, records: [ev.farmRec, ev.planting, ev.survival].map(({ body, hash, sig }) => ({ body, hash, sig })), pub: S.keys.pub, msisdn: S.msisdn });
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
      const res = await fetch('api/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ records: item.records, pub: item.pub, msisdn: item.msisdn, projectId: item.projectId ?? PROJECT_ID }) });
      if (res.status === 429 || res.status >= 500) break; // try again later
      const out = await res.json().catch(() => ({}));
      S.outbox = S.outbox.filter((x) => x.key !== item.key);
      if (!res.ok) S.sent = S.sent.filter((k) => k !== item.key); // refused outright: let the farmer fix and resend
      save();
      toast(res.ok
        ? (out.status === 'rejected' ? 'Submission rejected by the automatic checks' : 'Sent. An independent verifier will review it.')
        : out.error === 'unknown_project'
          ? `This app is not linked to a registered project (${PROJECT_ID || 'no project set'}). Ask the operator to register it.`
          : (out.message || 'The registry refused this submission'));
    }
  } catch { /* offline: the outbox is kept */ }
  flushing = false;
  refreshTrees();
}
$('#tr-refresh').addEventListener('click', refreshTrees);

// ---------- records, batches, verification ----------
function renderRecords() {
  renderOnce('records', JSON.stringify([S.records, S.batches]), () => {
    const pending = S.records.filter((r) => !r.batchId).length;
    $('#rec-summary').textContent = `${S.records.length} records · ${pending} waiting to be sealed · ${S.batches.length} batches`;
    $('#seal-btn').disabled = pending === 0;
    $('#batch-list').innerHTML = S.batches.length
      ? [...S.batches].reverse().map((b) => `<div class="item"><span>Batch ${esc(b.id)} · ${b.count} record${b.count === 1 ? '' : 's'}<br><span class="sub">root <code>${esc(short(b.root, 16))}</code> · ${esc(fmtTime(b.ts))}</span></span>${b.anchor ? `<span class="badge good">ledger #${b.anchor.seq}</span>` : '<span class="badge ok">not anchored</span>'}</div>`).join('')
      : '<div class="muted">No batches yet. Sealing groups pending records under one fingerprint (a Merkle root).</div>';
    gnStag($('#batch-list'));
    $('#record-list').innerHTML = S.records.length
      ? [...S.records].reverse().slice(0, 100).map((r) => {
          const b = r.body, q = b.quality.score;
          const label = b.kind === 'farm' ? `Farm: ${b.data.name}` : b.kind === 'planting' ? `Planted ${b.data.count} trees` : b.kind === 'survival' ? `Survival: ${b.data.alive} of ${b.data.sampleSize} alive` : TYPES[b.data.type] || b.data.type;
          return `<button class="item" data-rec="${esc(b.id)}"><span>${esc(label)}<br><span class="sub">${esc(fmtTime(b.ts))} · ${r.batchId ? 'sealed' : 'pending'}</span></span><span class="badge ${q >= 80 ? 'good' : q >= 50 ? 'ok' : 'bad'}">${q}</span></button>`;
        }).join('')
      : '<div class="muted">No records yet.</div>';
    gnStag($('#record-list'));
    $$('#record-list [data-rec]').forEach((b) => b.addEventListener('click', () => openVerify(b.dataset.rec)));
  });
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
      // When the operator requires a ledger key (ANCHOR_API_KEY on the server), the farmer
      // keeps one on the device and sends it here; without a key the open endpoint still works.
      const anchorKey = (stateAnchorKey() || '').trim();
      const res = await fetch('api/anchor', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(anchorKey ? { authorization: 'Bearer ' + anchorKey } : {}) },
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

// ── Session & Verifier State ─────────────────────────────────────────────────
let currentSession = null; // { role: 'admin'|'verifier'|'user', username, expiresAt }
let vsubs = [];
let vSelected = null;
const VKEY = 'plotline.verifier';
let vKey = null;

async function ensureVerifierKey() {
  if (vKey) return vKey;
  try { vKey = JSON.parse(localStorage.getItem(VKEY)); } catch { vKey = null; }
  if (!vKey || !vKey.keys) {
    const keys = await C.generateKeys();
    vKey = { keys, fp: await C.fingerprint(keys.pub) };
    try { localStorage.setItem(VKEY, JSON.stringify(vKey)); } catch {}
  }
  return vKey;
}

function updateAuthUI() {
  const userBtn = $('#app-user-btn');
  const authBtn = $('#app-auth-btn');
  const signoutItem = $('#app-logout-btn');
  const loggedOutSection = $('#verifier-logged-out');
  const standardSection = $('#verifier-standard-user');
  const activeVerifierSection = $('#verifier-active-user');
  const subTabBtn = $('#tab-btn-submissions');
  const subSection = $('#tab-submissions');
  const dashVerifierBtn = $('#dash-submissions');

  // The identity gateway sits in front of the app shell, so any unlocked
  // identity — server account or device-only — gets the avatar menu. The
  // quick "Sign in" button is only needed while there is no identity at all.
  if (userBtn) { userBtn.style.display = ''; renderUserMenu(); }
  if (authBtn) authBtn.style.display = S.keys?.priv ? 'none' : '';
  if (signoutItem) signoutItem.style.display = currentSession ? '' : 'none';

  if (!currentSession) {
    if (loggedOutSection) loggedOutSection.style.display = '';
    if (standardSection) standardSection.style.display = 'none';
    if (activeVerifierSection) activeVerifierSection.style.display = 'none';
    if (subTabBtn) subTabBtn.style.display = 'none';
    if (subSection) subSection.style.display = 'none';
    if (dashVerifierBtn) dashVerifierBtn.style.display = 'none';
  } else {
    const isVerifier = currentSession.role === 'verifier';
    if (loggedOutSection) loggedOutSection.style.display = 'none';
    if (standardSection) standardSection.style.display = isVerifier ? 'none' : '';
    if (activeVerifierSection) activeVerifierSection.style.display = isVerifier ? '' : 'none';
    if (subTabBtn) subTabBtn.style.display = isVerifier ? '' : 'none';
    if (subSection) subSection.style.display = isVerifier ? '' : 'none';
    if (dashVerifierBtn) dashVerifierBtn.style.display = isVerifier ? '' : 'none';
  }

  renderProfileAccount();
  renderDashboard();
}

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '—';
  return parts.slice(0, 2).map((p) => p[0].toUpperCase()).join('');
}

function renderUserMenu() {
  const name = S.name || currentSession?.username || 'Field identity';
  const sub = currentSession
    ? `${currentSession.role === 'verifier' ? 'Verifier' : 'User'} · ${currentSession.username}`
    : 'Local identity · not signed in';
  const avatar = initialsOf(name);
  for (const el of [$('#user-avatar'), $('#user-avatar-menu'), $('#profile-avatar')]) {
    if (el) el.textContent = avatar;
  }
  const pill = $('#app-user-pill');
  if (pill) pill.textContent = name;
  const menuName = $('#user-menu-name');
  if (menuName) menuName.textContent = name;
  const menuRole = $('#user-menu-role');
  if (menuRole) menuRole.textContent = sub;
}

function toggleUserMenu(open) {
  const dd = $('#user-dropdown');
  if (!dd) return;
  const show = open ?? dd.hidden;
  dd.hidden = !show;
  $('#app-user-btn')?.setAttribute('aria-expanded', String(show));
}

function closeUserMenu() { toggleUserMenu(false); }

async function signOut() {
  try {
    await fetch('api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  } finally {
    currentSession = null;
    closeUserMenu();
    updateAuthUI();
    toast('Signed out.');
    const activeTab = $('.tab.active')?.id;
    if (activeTab === 'tab-submissions' || activeTab === 'tab-profile') {
      showTab('dashboard');
    }
  }
}

function handleRoleRedirection(s) {
  const role = s?.role;
  if (role === 'admin') {
    // Route admin to console/admin dashboard
    window.location.href = 'console.html';
  } else if (role === 'verifier') {
    // Route verifier to the submissions queue
    updateAuthUI();
    ensureVerifierKey();
    showTab('submissions');
  } else {
    // Standard user: land on the dashboard — unless they came here to apply
    // as a verifier, then land straight on the application.
    updateAuthUI();
    if (takeVerifierIntent()) {
      showTab('profile');
      setTimeout(() => {
        const box = $('#apply-box') || $('#verifier-flow-section');
        box?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 350);
      toast('Account ready — submit your verifier application below.');
    } else if (currentSession) {
      showTab('profile');
    } else {
      showTab('dashboard');
    }
  }
}

function wireAuthEvents() {
  $('#app-user-btn')?.addEventListener('click', (e) => { e.stopPropagation(); toggleUserMenu(); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.user-menu')) closeUserMenu(); });
  $$('.user-dropdown-item[data-tab-jump]')?.forEach((el) => el.addEventListener('click', () => {
    const target = el.dataset.tabJump;
    closeUserMenu();
    showTab(target);
  }));
  // Auth is never a popup: every route lands on the full-page dark gateway.
  $('#app-auth-btn')?.addEventListener('click', () => showGateway('server-in'));
  $('#profile-signin-btn')?.addEventListener('click', () => showGateway('server-in'));

  // "Apply to be a verifier": with a session it opens the application form;
  // without one it routes through the auth gateway and comes back after.
  $('#verifier-apply-btn')?.addEventListener('click', () => {
    if (!currentSession) {
      rememberVerifierIntent();
      showGateway('server-in');
      return;
    }
    updateAuthUI();
    showTab('profile');
    setTimeout(() => {
      const box = $('#apply-box') || $('#verifier-flow-section');
      box?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 350);
  });

  // Server-account sign in (verifiers, operators, standard users)
  $('#gw-srv-login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#gw-srv-login-btn');
    const errBox = $('#gw-srv-login-err');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    if (errBox) { errBox.hidden = true; errBox.textContent = ''; }

    try {
      const res = await fetch('api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: $('#gw-srv-login-user').value.trim(),
          password: $('#gw-srv-login-pass').value,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (errBox) {
          errBox.textContent = json.error || 'Sign-in failed.';
          errBox.hidden = false;
        }
        return;
      }
      $('#gw-srv-login-pass').value = '';
      currentSession = json.session;
      // Server sessions ride on the unlocked app shell, so the device identity
      // flow runs first when this phone has not created one yet.
      await continueInit();
      handleRoleRedirection(currentSession);
      toast(`Signed in as ${currentSession?.username}.`);
    } catch (err) {
      if (errBox) {
        errBox.textContent = err.message || 'Network error.';
        errBox.hidden = false;
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in →';
    }
  });

  // Server-account sign up (standard users; verifiers upgrade via application)
  $('#gw-srv-signup-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#gw-srv-signup-btn');
    const errBox = $('#gw-srv-signup-err');
    btn.disabled = true;
    btn.textContent = 'Creating account…';
    if (errBox) { errBox.hidden = true; errBox.textContent = ''; }

    try {
      const res = await fetch('api/auth/signup', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: $('#gw-srv-signup-name').value.trim(),
          email: $('#gw-srv-signup-email').value.trim(),
          username: $('#gw-srv-signup-user').value.trim(),
          password: $('#gw-srv-signup-pass').value,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (errBox) {
          errBox.textContent = json.error || 'Sign-up failed.';
          errBox.hidden = false;
        }
        return;
      }
      $('#gw-srv-signup-pass').value = '';
      currentSession = json.session; // standard user role
      await continueInit();
      handleRoleRedirection(currentSession);
      toast(`Account created. Welcome, ${currentSession?.username}!`);
    } catch (err) {
      if (errBox) {
        errBox.textContent = err.message || 'Network error.';
        errBox.hidden = false;
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Create account →';
    }
  });

  // Logout (user dropdown + profile card)
  $('#app-logout-btn')?.addEventListener('click', signOut);
  $('#profile-signout-btn')?.addEventListener('click', signOut);

  // Task 2: Verifier Application UI Flow
  $('#apply-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentSession) {
      // Applications need a server account: route to the full-page auth gateway.
      rememberVerifierIntent();
      showGateway('server-in');
      return;
    }
    const btn = $('#apply-btn');
    const resultBox = $('#apply-result');
    btn.disabled = true;
    btn.textContent = 'Submitting application…';
    if (resultBox) resultBox.innerHTML = '';

    try {
      const payload = {
        name: $('#apply-name').value.trim(),
        email: $('#apply-email').value.trim(),
        org: $('#apply-org').value.trim(),
        reason: $('#apply-reason').value.trim(),
      };
      const res = await fetch('api/auth/apply', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (resultBox) {
          resultBox.innerHTML = `<div class="alert-box red text-sm" style="margin-top:var(--s2)">${esc(json.error || 'Application failed.')}</div>`;
        }
        return;
      }
      if (resultBox) {
        resultBox.innerHTML = `<div class="alert-box green text-sm" style="margin-top:var(--s2)">Application submitted successfully! Reference: <code>${esc(json.id || '')}</code>. Once approved by the administrator, you will receive an activation code off-band.</div>`;
        GN_MOTION.pulse(resultBox.firstElementChild);
      }
      $('#apply-reason').value = '';
      toast('Application submitted.');
    } catch (err) {
      if (resultBox) {
        resultBox.innerHTML = `<div class="alert-box red text-sm" style="margin-top:var(--s2)">${esc(err.message || 'Network error')}</div>`;
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Submit application';
    }
  });

  // Task 2: Verifier Activation UI Component
  $('#activation-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentSession) {
      rememberVerifierIntent();
      showGateway('server-in');
      return;
    }
    const codeInput = $('#activation-code');
    const code = codeInput ? codeInput.value.trim() : '';
    const btn = $('#activate-btn');
    const resultBox = $('#activation-result');

    if (!code) return;
    btn.disabled = true;
    btn.textContent = 'Activating verifier role…';
    if (resultBox) resultBox.innerHTML = '';

    try {
      const res = await fetch('api/auth/activate', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, username: currentSession.username }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (resultBox) {
          resultBox.innerHTML = `<div class="alert-box red text-sm" style="margin-top:var(--s2)">${esc(json.error || 'Activation failed.')}</div>`;
        }
        return;
      }

      // Upgrades local state/session to unlock and display Verifier tabs
      currentSession = json.session || { ...currentSession, role: 'verifier' };
      updateAuthUI();
      await ensureVerifierKey();
      if (codeInput) codeInput.value = '';
      toast('Verifier access activated! Unlocking submissions queue…');

      // Route directly to submissions queue
      showTab('submissions');
    } catch (err) {
      if (resultBox) {
        resultBox.innerHTML = `<div class="alert-box red text-sm" style="margin-top:var(--s2)">${esc(err.message || 'Network error')}</div>`;
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Activate Verifier Access';
    }
  });

  // Verifier Queue UI Controls
  $('#v-refresh-btn')?.addEventListener('click', loadSubmissionsQueue);
  $('#v-filter-status')?.addEventListener('change', renderSubmissionsQueue);
  $('#v-close-detail-btn')?.addEventListener('click', () => {
    const d = $('#v-submission-detail');
    if (d) d.hidden = true;
    vSelected = null;
  });
  $('#v-approve-btn')?.addEventListener('click', () => handleDecision('approve'));
  $('#v-reject-btn')?.addEventListener('click', () => handleDecision('reject'));
  $('#goto-submissions-btn')?.addEventListener('click', () => showTab('submissions'));
}

async function initAuth() {
  wireAuthEvents();
  try {
    const res = await fetch('api/auth/session', { credentials: 'same-origin' });
    if (res.ok) {
      const data = await res.json();
      currentSession = data.session || null;
      if (currentSession?.role === 'admin') {
        window.location.href = 'console.html';
        return;
      }
      if (currentSession?.role === 'verifier') {
        ensureVerifierKey();
      }
    } else {
      currentSession = null;
    }
  } catch {
    currentSession = null;
  }
  updateAuthUI();
}

async function loadSubmissionsQueue() {
  if (!currentSession || currentSession.role !== 'verifier') return;
  try {
    const res = await fetch('api/registry/submissions', { credentials: 'same-origin' });
    if (!res.ok) {
      if (res.status === 401) toast('Verifier authentication required.');
      return;
    }
    const data = await res.json();
    vsubs = data.submissions || [];
    renderSubmissionsQueue();
  } catch (err) {
    console.error('Failed to load submissions queue:', err);
  }
}

function renderSubmissionsQueue() {
  const listEl = $('#v-submissions-list');
  const emptyEl = $('#v-submissions-empty');
  if (!listEl) return;
  const filter = $('#v-filter-status')?.value || '';
  const filtered = filter ? vsubs.filter(s => s.status === filter) : vsubs;
  if (!filtered.length) {
    listEl.innerHTML = '';
    if (emptyEl) emptyEl.hidden = false;
    return;
  }
  if (emptyEl) emptyEl.hidden = true;
  listEl.innerHTML = filtered.map((s) => {
    const flags = (s.flags?.length || 0) + (s.hard?.length || 0);
    const badgeClass = s.status === 'approved' ? 'good' : s.status === 'pending' ? 'ok' : 'bad';
    return `
      <div class="item" data-vid="${esc(s.subId)}" style="cursor:pointer">
        <div class="lead">
          <strong>${esc(s.farmName || 'Plot')} · ${s.units || 0} tCO₂e</strong>
          <span class="sub">${esc(short(s.farmerKey, 12))} · ${esc(fmtTime(s.receivedAt))}${flags ? ` · <span class="text-amber">${flags} flag(s)</span>` : ''}</span>
        </div>
        <span class="badge ${badgeClass}">${esc(s.status)}</span>
      </div>`;
  }).join('');

  gnStag(listEl);
  listEl.querySelectorAll('[data-vid]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.vid;
      const sub = vsubs.find(s => s.subId === id);
      if (sub) renderSubmissionDetail(sub);
    });
  });
}

function renderSubmissionDetail(sub) {
  vSelected = sub;
  const detailEl = $('#v-submission-detail');
  const contentEl = $('#v-detail-content');
  const noteEl = $('#v-decision-note');
  const msgEl = $('#v-decision-msg');
  if (!detailEl || !contentEl) return;
  if (noteEl) noteEl.value = '';
  if (msgEl) msgEl.textContent = '';

  const flags = [...(sub.flags || []), ...(sub.hard || [])];
  const badgeClass = sub.status === 'approved' ? 'good' : sub.status === 'pending' ? 'ok' : 'bad';

  contentEl.innerHTML = `
    <div class="row between" style="margin-bottom:var(--s2)">
      <h3 style="font-size:16px">${esc(sub.farmName || 'Plot')} <span class="badge ${badgeClass}">${esc(sub.status)}</span></h3>
      <span class="muted small">${esc(fmtTime(sub.receivedAt))}</span>
    </div>
    <div class="muted small" style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin-bottom:var(--s3)">
      <span>ID:</span><code class="mono">${esc(sub.subId)}</code>
      <span>Farmer:</span><code class="mono">${esc(short(sub.farmerKey, 16))}</code>
      <span>Trees:</span><span>${sub.treesPlanted ?? '—'} (alive: ${sub.treesAlive ?? '—'} / ${sub.sampleSize ?? '—'})</span>
      <span>Area:</span><span>${sub.areaHa ? sub.areaHa.toFixed(3) + ' ha' : '—'}</span>
      <span>Units:</span><span>${sub.units ?? 0} tCO₂e</span>
    </div>
    ${flags.length ? `<div class="alert-box amber text-sm" style="margin-bottom:var(--s3)"><b>${flags.length} flag(s):</b><br>${flags.map(f => `· ${esc(f)}`).join('<br>')}</div>` : ''}
    ${sub.decision ? `<div class="alert-box ${sub.decision.decision === 'approve' ? 'green' : 'red'} text-sm" style="margin-bottom:var(--s3)"><b>Decided: ${esc(sub.decision.decision)}</b> by ${esc(sub.decision.verifier || sub.decision.verifierId || 'verifier')} · ${esc(fmtTime(sub.decision.decidedAt))}${sub.decision.reason ? `<br>"${esc(sub.decision.reason)}"` : ''}</div>` : ''}
  `;

  const isPending = sub.status === 'pending';
  const approveBtn = $('#v-approve-btn');
  const rejectBtn = $('#v-reject-btn');
  if (approveBtn) approveBtn.disabled = !isPending;
  if (rejectBtn) rejectBtn.disabled = !isPending;

  detailEl.hidden = false;
  detailEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function handleDecision(action) {
  if (!vSelected) return;
  if (!currentSession || currentSession.role !== 'verifier') {
    toast('Verifier session required');
    return;
  }
  const note = $('#v-decision-note')?.value.trim() || '';
  const msgEl = $('#v-decision-msg');
  const approveBtn = $('#v-approve-btn');
  const rejectBtn = $('#v-reject-btn');
  if (approveBtn) approveBtn.disabled = true;
  if (rejectBtn) rejectBtn.disabled = true;
  if (msgEl) msgEl.textContent = 'Submitting decision…';

  try {
    const vk = await ensureVerifierKey();
    const verifierId = currentSession.username;
    const nowTs = new Date().toISOString();
    const payload = {
      subId: vSelected.subId,
      verifierId,
      verifier: vk.fp,
      decision: action,
      note,
      ts: nowTs,
    };
    const bodyToSign = {
      subId: vSelected.subId,
      decision: action,
      note: String(note).slice(0, 500),
      verifierId,
      ts: nowTs,
    };
    // core.js has no C.sign — signature is over the canonical body the
    // registry rebuilds server-side (server/registry.mjs decide()).
    const { sig } = await C.signBody(bodyToSign, vk.keys.priv);
    const res = await fetch('api/registry/decide', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, sig, pub: vk.keys.pub }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      toast(`Submission ${action}d successfully`);
      if (msgEl) msgEl.textContent = `Decision recorded (${action}).`;
      await loadSubmissionsQueue();
      const updated = vsubs.find(s => s.subId === vSelected.subId);
      if (updated) renderSubmissionDetail(updated);
    } else {
      const err = json.error || `Decision failed (${res.status})`;
      if (msgEl) msgEl.textContent = err;
      toast(err);
    }
  } catch (err) {
    if (msgEl) msgEl.textContent = err.message;
    toast('Decision error: ' + err.message);
  } finally {
    if (approveBtn && vSelected?.status === 'pending') approveBtn.disabled = false;
    if (rejectBtn && vSelected?.status === 'pending') rejectBtn.disabled = false;
  }
}

// ---------- tabs & init ----------
// Four bottom tabs. Heat map is part of Scout and the input calculator part of Farm.
const PARENT = { inputs: 'farm', heat: 'scout' };
function renderAll() {
  renderFarmList(); renderScoutHeader(); renderRecords(); prefillInputs(); renderTrees();
  renderDashboard(); renderProfileIdentity();
  loadNdviPanel();
  loadRainPanel();
  if ($('#tab-heat').classList.contains('active')) renderHeat();
}

// ---------- dashboard / profile / settings ----------
function dashLabel(rec) {
  const kinds = {
    farm: 'Boundary saved',
    scout: TYPES[rec.data?.type] ? `Scout: ${TYPES[rec.data.type]}` : 'Scout report',
    planting: 'Trees planted',
    survival: 'Survival check',
  };
  return kinds[rec.body.kind] || rec.body.kind;
}

function renderDashboard() {
  const dash = $('#dash-hello');
  if (!dash) return;
  // hour bucket too: the greeting text picks morning/afternoon/evening
  renderOnce('dashboard', JSON.stringify([S.farms, S.records, S.name, currentSession?.username, Date.now() / 360e5 | 0]), () => {
    const nf = S.farms.length;
    const areaHa = S.farms.reduce((a, f) => a + (f.areaM2 ? C.m2ToHa(f.areaM2) : 0), 0);
    const nScout = S.records.filter((r) => r.body.kind === 'scout').length;
    const nTrees = S.records.filter((r) => r.body.kind === 'planting' || r.body.kind === 'survival').length;
    const nSealed = S.records.filter((r) => r.batchId != null).length;

    $('#dash-farms').textContent = nf;
    $('#dash-area').textContent = `${areaHa.toFixed(2)} ha`;
    $('#dash-reports').textContent = nScout;
    $('#dash-records').textContent = S.records.length;
    $('#dash-sealed').textContent = `${nSealed} sealed`;
    $('#dash-trees').textContent = nTrees;

    const hour = new Date().getHours();
    const dayPart = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const who = S.name || (currentSession?.username) || 'there';
    dash.textContent = `${dayPart}, ${who}`;
    $('#dash-sub').textContent = nf
      ? `${nf} farm${nf === 1 ? '' : 's'} · ${areaHa.toFixed(2)} ha · ${S.records.length} signed record${S.records.length === 1 ? '' : 's'} on this phone`
      : 'Everything below is signed on this phone. Start by walking your boundary.';

    const recent = [...S.records].slice(-5).reverse();
    const list = $('#dash-recent');
    const empty = $('#dash-recent-empty');
    if (!recent.length) {
      if (list) list.innerHTML = '';
      if (empty) empty.hidden = false;
    } else {
      if (empty) empty.hidden = true;
      if (list) list.innerHTML = recent.map((r) => `
        <div class="item">
          <div class="lead">
            <strong>${esc(dashLabel(r))}</strong>
            <span class="sub">${esc(farmById(r.body.farmId)?.name || 'No farm')} · ${esc(fmtTime(r.body.ts))}</span>
          </div>
          <span class="badge ${r.batchId != null ? 'good' : 'ok'}">${r.batchId != null ? 'sealed' : 'pending'}</span>
        </div>`).join('');
    }
  });
}

function renderProfileIdentity() {
  const heroName = $('#profile-hero-name');
  if (!heroName) return;
  const name = S.name || 'Field identity';
  heroName.textContent = name;
  const sub = $('#profile-hero-sub');
  if (sub) sub.textContent = S.fp ? `Device-only identity · works offline` : 'No identity on this phone';
  const fpEl = $('#profile-fp');
  if (fpEl) fpEl.textContent = fmtFingerprint(S.fp);
  const nf = S.farms.length, nr = S.records.length, nb = S.batches.length;
  const statsEl = $('#profile-stats');
  if (statsEl) statsEl.textContent = `${nf} farm${nf === 1 ? '' : 's'} · ${nr} record${nr === 1 ? '' : 's'} · ${nb} batch${nb === 1 ? '' : 'es'}`;
  const nameInput = $('#profile-name');
  if (nameInput && document.activeElement !== nameInput) nameInput.value = S.name || '';
  const projEl = $('#profile-project');
  if (projEl) projEl.textContent = PROJECT_ID || '(not set)';
  const av = $('#profile-avatar');
  if (av) av.textContent = initialsOf(name);
  renderUserMenu();
}

function renderProfileAccount() {
  const ac = $('#profile-account');
  if (!ac) return;
  const signinBtn = $('#profile-signin-btn');
  const signoutBtn = $('#profile-signout-btn');
  const note = $('#profile-account-note');

  if (!currentSession) {
    ac.innerHTML = `<div class="profile-row"><span>Account</span><b>Signed out — offline only</b></div>`;
    if (signinBtn) signinBtn.style.display = '';
    if (signoutBtn) signoutBtn.style.display = 'none';
    if (note) note.textContent = 'A server account is only needed to act as a verifier. Your farm records never depend on it.';
    return;
  }

  const role = currentSession.role === 'verifier' ? 'Verifier' : 'User';
  const friendlyExpires = currentSession.expiresAt ? fmtTime(currentSession.expiresAt) : '—';
  ac.innerHTML = `
    <div class="profile-row"><span>Account</span><b>${esc(currentSession.username)}</b></div>
    <div class="profile-row"><span>Role</span><b>${esc(role)}</b></div>
    <div class="profile-row"><span>Session expires</span><b class="text-sm">${esc(friendlyExpires)}</b></div>`;
  if (signinBtn) signinBtn.style.display = 'none';
  if (signoutBtn) signoutBtn.style.display = '';
  if (note) note.textContent = currentSession.role === 'verifier'
    ? 'Verifier sessions last 12 hours. Sign in again after that to continue reviewing.'
    : 'A server account is only used for the verifier role. Your farm records never depend on it.';
}
function showTab(name) {
  // Verifier route guard: standard users cannot see verifier routes
  if (name === 'submissions' && (!currentSession || currentSession.role !== 'verifier')) {
    toast('Verifier access required.');
    name = 'farm';
  }
  const applySwitch = () => {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
    const parent = PARENT[name] || name;
    $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === parent));
    $$('[data-sub]').forEach((b) => b.classList.toggle('on', b.dataset.sub === name));
  };
  // Rules 15/18: old and new tab states overlap in a crossfade, old leaves
  // 20% shorter — the View Transitions API handles the pairing.
  // Map tabs hold the transition open until the freshly revealed map has
  // been resized and re-laid out: its container was display:none while
  // hidden, so Leaflet's cached size went stale, and a mid-fade resize is
  // what flickers. The new-state snapshot is only taken once the awaited
  // promise resolves, so it captures the corrected, drawn map.
  const resizeMap = (m) => new Promise((resolve) => requestAnimationFrame(() => { m.invalidateSize(); resolve(); }));
  // Non-map tab content also renders inside the awaited update phase, so the
  // new-state snapshot shows finished content instead of catching a
  // mid-fade rebuild.
  GN_MOTION.transition(() => {
    applySwitch();
    if (name === 'farm') { loadNdviPanel(); loadRainPanel(); if (farmMap) return resizeMap(farmMap); }
    if (name === 'heat' && heatMap) return resizeMap(heatMap).then(() => renderHeat());
    if (name === 'inputs') calcInputs();
    if (name === 'records') renderRecords();
    if (name === 'trees') refreshTrees();
    if (name === 'dashboard' || name === 'profile') { renderDashboard(); renderProfileIdentity(); }
    if (name === 'submissions') loadSubmissionsQueue();
  });
  window.scrollTo(0, 0);
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
$$('[data-sub]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.sub)));

// Dashboard quick actions
$('#dash-walk')?.addEventListener('click', () => { showTab('farm'); setTimeout(() => $('#walk-btn')?.click(), 120); });
$('#dash-scout')?.addEventListener('click', () => showTab('scout'));
$('#dash-seal')?.addEventListener('click', () => showTab('records'));
$('#dash-view-all')?.addEventListener('click', () => showTab('records'));
$('#dash-submissions')?.addEventListener('click', () => showTab('submissions'));

// Profile: the farm display name stays on this phone only
$('#profile-name')?.addEventListener('input', (e) => {
  const v = e.target.value.trim().slice(0, 60);
  if (v) S.name = v; else delete S.name;
  save();
  renderProfileIdentity();
  renderDashboard();
});

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

// init() is invoked at the very end of this module, after LOCK_STORAGE and the
// other consts below are defined (the gateway reads the device PIN at boot).
// "Sign up" on the landing page routes straight here — never a popup. Honor
// the intent on boot: a fresh phone opens the device-identity panel, a phone
// that already has a field identity opens the server sign-up instead.
function joinParamMode() {
  const join = new URLSearchParams(location.search).get('join');
  if (join !== 'signup') return null;
  const registered = !!(S.keys && S.keys.priv && S.fp);
  return registered ? 'server-up' : 'signup';
}
function clearJoinParam() {
  if (location.search) history.replaceState(null, '', location.pathname);
}

async function init() {
  load();
  wireGateway(); // the split-screen signup / login gate
  wirePasswordReveal(); // eye toggles on every password / PIN field
  // A set PIN lock is the privacy screen: nothing renders (not even the gateway)
  // until the correct PIN unlocks this phone.
  if (getLock()) { showLockOverlay(); return; }
  const join = joinParamMode();
  const registered = !!(S.keys && S.keys.priv && S.fp);
  showGateway(join || (registered ? 'login' : 'signup'));
}

async function unlockFromLockScreen() {
  $('#lock-overlay').hidden = true;
  document.body.classList.remove('locked');
  const join = joinParamMode();
  const registered = !!(S.keys && S.keys.priv && S.fp);
  if (!join && registered) return continueInit();
  showGateway(join || 'signup');
}

// ── Identity gateway (split-screen signup / login) ───────────────────────────
// The farmer's identity is the key on this phone, not a server account:
//   "signup"    = generate the device identity (no network, nothing leaves the phone)
//   "login"     = unlock the identity already on this phone (PIN when set)
function showGateway(mode) {
  // The gateway is fullscreen: suspend the app shell's bottom-bar padding so
  // it doesn't extend the document past the viewport (leaving a white band
  // under the panels).
  document.body.classList.add('auth-page');
  $('#auth-gateway').style.display = '';
  $('#app-shell').style.display = 'none';
  setGatewayMode(mode);
}
function setGatewayMode(mode) {
  // "signup"/"login" = the device identity (key on this phone);
  // "server-in"/"server-up" = a server account (verifier/operator/standard),
  // never a popup — always the same full-page dark card.
  const server = mode === 'server-in' || mode === 'server-up';
  const up = mode === 'signup';
  $('#gw-tab-signup')?.classList.toggle('active', up);
  $('#gw-tab-signin')?.classList.toggle('active', mode === 'login');
  $('#gw-srv-tab-in')?.classList.toggle('active', mode === 'server-in');
  $('#gw-srv-tab-up')?.classList.toggle('active', mode === 'server-up');
  $('#gw-mode-switch')?.classList.toggle('hidden', server);
  $('#gw-srv-switch')?.classList.toggle('hidden', !server);
  const pill = $('#gw-pill-mode'); if (pill) pill.textContent = server ? 'Server account' : 'Device identity';
  $('#gw-panel-signup')?.toggleAttribute('hidden', mode !== 'signup');
  $('#gw-panel-signin')?.toggleAttribute('hidden', mode !== 'login');
  $('#gw-panel-server-in')?.toggleAttribute('hidden', mode !== 'server-in');
  $('#gw-panel-server-up')?.toggleAttribute('hidden', mode !== 'server-up');
  if (mode === 'login') {
    $('#gw-id-name').textContent = S.name || 'Field identity';
    $('#gw-id-fp').textContent = fmtFingerprint(S.fp);
    const nf = (S.farms || []).length, nr = (S.records || []).length, nb = (S.batches || []).length;
    $('#gw-id-stats').textContent = `${nf} farm${nf === 1 ? '' : 's'} · ${nr} record${nr === 1 ? '' : 's'} · ${nb} batch${nb === 1 ? '' : 'es'}`;
    $('#gw-login-pin-row').hidden = !getLock();
    const errBox = $('#gw-login-err'); if (errBox) { errBox.hidden = true; errBox.textContent = ''; }
  } else if (mode === 'signup') {
    const errBox = $('#gw-signup-err'); if (errBox) { errBox.hidden = true; errBox.textContent = ''; }
  } else if (server) {
    for (const id of ['gw-srv-login-err', 'gw-srv-signup-err']) {
      const box = $('#' + id); if (box) { box.hidden = true; box.textContent = ''; }
    }
  }
}

// The "Apply" intent survives the detour through the auth gateway: after the
// account is created or signed in, the user lands straight on the application.
const VERIFIER_INTENT = 'plotline-apply-verifier';
function rememberVerifierIntent() { try { sessionStorage.setItem(VERIFIER_INTENT, '1'); } catch { /* in-memory only */ } }
function takeVerifierIntent() {
  try { return sessionStorage.getItem(VERIFIER_INTENT) === '1' && (sessionStorage.removeItem(VERIFIER_INTENT), true); }
  catch { return false; }
}
function fmtFingerprint(fp) {
  if (!fp) return '—';
  return (fp.match(/.{1,4}/g) || [fp]).slice(0, 4).join('·').toUpperCase() + '…';
}
// Password reveal: the eye toggle flips the input between password/text.
// Rule 13 — the eye / eye-off icons crossfade with a slight blur mid-swap.
function wirePasswordReveal() {
  $$('.pw-toggle').forEach((btn) => {
    const input = document.getElementById(btn.dataset.pwFor);
    if (!input) return;
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      btn.title = btn.getAttribute('aria-label');
      const eye = btn.querySelector('.pw-eye');
      const off = btn.querySelector('.pw-eye-off');
      eye.hidden = show;
      off.hidden = !show;
      GN_MOTION.swapIcon(btn);
      input.focus({ preventScroll: true });
    });
  });
}

function wireGateway() {
  $('#gw-tab-signup')?.addEventListener('click', () => setGatewayMode('signup'));
  $('#gw-tab-signin')?.addEventListener('click', () => setGatewayMode('login'));
  $('#gw-go-signin')?.addEventListener('click', (e) => { e.preventDefault(); setGatewayMode('login'); });
  $('#gw-go-signup')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (!(S.keys && S.keys.priv && S.fp)) return setGatewayMode('signup');
    if (!confirm('This clears this phone\'s identity — all farms, records and the signing key. Continue?')) return;
    try { localStorage.removeItem(KEY); localStorage.removeItem(LOCK_STORAGE); } catch { /* ignore */ }
    location.reload();
  });
  $('#gw-signup-pin')?.addEventListener('input', (e) => { const row = $('#gw-signup-pin2-row'); if (row) row.hidden = !e.target.value; });
  $('#gw-signup-form')?.addEventListener('submit', onGatewaySignup);
  $('#gw-login-form')?.addEventListener('submit', onGatewayLogin);
  $('#gw-verifier-link')?.addEventListener('click', (e) => { e.preventDefault(); rememberVerifierIntent(); showGateway('server-in'); });
  $('#gw-srv-tab-in')?.addEventListener('click', () => setGatewayMode('server-in'));
  $('#gw-srv-tab-up')?.addEventListener('click', () => setGatewayMode('server-up'));
  $('#gw-go-srv-in')?.addEventListener('click', (e) => { e.preventDefault(); setGatewayMode('server-in'); });
  $('#gw-go-srv-up')?.addEventListener('click', (e) => { e.preventDefault(); setGatewayMode('server-up'); });
  $('#gw-back-device')?.addEventListener('click', (e) => { e.preventDefault(); setGatewayMode(S.keys?.priv ? 'login' : 'signup'); });
  $('#gw-back-device-up')?.addEventListener('click', (e) => { e.preventDefault(); setGatewayMode(S.keys?.priv ? 'login' : 'signup'); });
}
async function onGatewaySignup(e) {
  e.preventDefault();
  const errBox = $('#gw-signup-err');
  const fail = (msg) => { if (errBox) { errBox.textContent = msg; errBox.hidden = false; } };
  const name = $('#gw-signup-name').value.trim();
  if (!name) return fail('Please enter your name');
  const pin = $('#gw-signup-pin').value;
  const pin2 = $('#gw-signup-pin2').value;
  if (pin && pin.length < 4) return fail('The PIN needs at least 4 characters');
  if (pin && pin !== pin2) return fail('The two PIN entries differ');
  const btn = $('#gw-signup-btn');
  btn.disabled = true; btn.textContent = 'Generating your key…';
  try {
    S.name = name;
    S.msisdn = $('#gw-signup-msisdn').value.trim();
    S.keys = await C.generateKeys();
    S.fp = await C.fingerprint(S.keys.pub);
    save();
    if (pin) {
      try { localStorage.setItem(LOCK_STORAGE, JSON.stringify(await makeLock(pin))); }
      catch { toast('Could not create the PIN lock on this device'); }
    }
    toast('Identity created — it lives on this phone only');
    await continueInit();
  } catch (err) {
    fail('Could not create the identity on this device: ' + (err.message || err));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Create my identity →'; }
  }
}
async function onGatewayLogin(e) {
  e.preventDefault();
  const errBox = $('#gw-login-err');
  const fail = (msg) => { if (errBox) { errBox.textContent = msg; errBox.hidden = false; } };
  const lock = getLock();
  if (lock) {
    const pin = $('#gw-login-pin').value;
    if (!pin) return fail('Enter your PIN to unlock');
    const btn = $('#gw-login-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    try {
      if (!(await lockOk(pin, lock))) return fail('Wrong PIN. Try again.');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Unlock & continue →'; }
    }
  }
  continueInit();
}
// Everything that used to run at boot now runs once the device identity is created or unlocked.
async function continueInit() {
  $('#auth-gateway').style.display = 'none';
  // Back into the app shell: restore the bottom-tab-bar padding.
  document.body.classList.remove('auth-page');
  $('#app-shell').style.display = '';
  await ensureKeys();
  $('#farm-crop').innerHTML = Object.entries(C.CROPS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  $('#in-crop').innerHTML = $('#farm-crop').innerHTML;
  $('#tr-species').innerHTML = SPECIES.map((x) => `<option>${x}</option>`).join('');
  $('#scout-type').innerHTML = Object.entries(TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('#heat-type').innerHTML = '<option value="all">All problems</option>' + Object.entries(TYPES).filter(([k]) => k !== 'healthy').map(([k, v]) => `<option>${v}</option>`).join('');
  $('#heat-type').addEventListener('change', renderHeat);

  farmMap = makeMap($('#map-farm'));
  heatMap = makeMap($('#map-heat'));
  if (farmMap) { farmLayer = L.layerGroup().addTo(farmMap); walkLayer = L.layerGroup().addTo(farmMap); }
  if (heatMap) heatLayerGroup = L.layerGroup().addTo(heatMap);

  const f = activeFarm();
  if (f && farmMap) farmMap.fitBounds(latlngs(f.polygon), { padding: [30, 30] });
  drawFarmMap(); walkStats(); walkButtons(); renderAll(); netChip(); updateHud();
  maybeOnboarding();
  publishBatches(); flushOutbox();

  // Auto-upgrade of the service worker moved to sw-update.js (shared with the
  // landing page and console): it checks, activates and reloads automatically.
  await initAuth();
}

// ─────────────────────────────────────────────────────────────────────────────
// MEDIUM-2: Key backup and encrypted export/import
// ─────────────────────────────────────────────────────────────────────────────
//
// The ECDSA P-256 private key lives in localStorage. Clearing site data loses it
// permanently. This section lets the farmer export an encrypted backup (AES-GCM,
// 256-bit key derived from a passphrase via PBKDF2) and import it on the same or
// another device.
//
// Security properties:
//   • The private key is wrapped with a 256-bit AES-GCM key.
//   • The wrapping key is derived with PBKDF2-SHA-256, 310 000 iterations (NIST SP 800-132).
//   • A fresh random salt and IV are generated for every export.
//   • The export file contains: { version, salt (hex), iv (hex), ciphertext (base64) }.
//   • The plaintext is the full key pair JWK object.
//
// To test in the browser console:
//   const backup = await exportEncryptedKey('mypassphrase');
//   const restored = await importEncryptedKey(backup, 'mypassphrase');
//   console.log(restored.pub.x === S.keys.pub.x); // true
//
// ─────────────────────────────────────────────────────────────────────────────

const KEY_BACKUP_VERSION = 1;
const PBKDF2_ITERATIONS = 310_000;

/**
 * Derive a 256-bit AES-GCM key from a passphrase + salt using PBKDF2-SHA-256.
 * @param {string} passphrase
 * @param {Uint8Array} salt
 * @returns {Promise<CryptoKey>}
 */
async function deriveWrapKey(passphrase, salt) {
  const raw = new TextEncoder().encode(passphrase);
  const base = await crypto.subtle.importKey('raw', raw, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => Uint8Array.from(h.match(/.{2}/g).map((b) => parseInt(b, 16)));
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Export the current key pair as an encrypted JSON backup object.
 *
 * @param {string} passphrase - user-chosen passphrase (min 8 chars recommended)
 * @returns {Promise<object>} - JSON-serialisable backup object
 */
async function exportEncryptedKey(passphrase) {
  if (!S.keys) throw new Error('No key pair to export');
  if (!passphrase || passphrase.length < 1) throw new Error('Passphrase must not be empty');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapKey = await deriveWrapKey(passphrase, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(S.keys));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, plaintext);
  return {
    version: KEY_BACKUP_VERSION,
    fp: S.fp,
    salt: toHex(salt),
    iv: toHex(iv),
    ciphertext: toB64(ciphertext),
  };
}

/**
 * Import and decrypt a key backup.
 *
 * @param {object} backup - the backup object from exportEncryptedKey
 * @param {string} passphrase
 * @returns {Promise<{ pub: object, priv: object }>} - decrypted key pair
 */
async function importEncryptedKey(backup, passphrase) {
  if (!backup || backup.version !== KEY_BACKUP_VERSION) throw new Error('Unrecognised backup format');
  const salt = fromHex(backup.salt);
  const iv = fromHex(backup.iv);
  const wrapKey = await deriveWrapKey(passphrase, salt);
  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, wrapKey, fromB64(backup.ciphertext));
  } catch {
    throw new Error('Wrong passphrase or corrupted backup');
  }
  const keys = JSON.parse(new TextDecoder().decode(plaintext));
  if (!keys?.pub?.x || !keys?.priv?.d) throw new Error('Backup does not contain a valid key pair');
  return keys;
}

// ── UI wiring for key backup ─────────────────────────────────────────────────

// The optional ledger key is a device-level setting, never synced in a bundle
// and never part of any export, because it belongs to the operator.
const ANCHOR_KEY_STORAGE = 'plotline.anchorKey';
function stateAnchorKey() {
  try { return localStorage.getItem(ANCHOR_KEY_STORAGE) || ''; } catch { return ''; }
}

document.addEventListener('click', async (e) => {
  // Ledger key: id="anchor-key-btn"
  if (e.target.id === 'anchor-key-btn') {
    try {
      const next = prompt(
        'Ledger API key (only needed when the operator requires one to anchor batches). Leave empty to clear it:',
        stateAnchorKey(),
      );
      if (next === null) return;
      if (next.trim()) localStorage.setItem(ANCHOR_KEY_STORAGE, next.trim());
      else localStorage.removeItem(ANCHOR_KEY_STORAGE);
      toast(next.trim() ? 'Ledger key saved on this device' : 'Ledger key cleared');
    } catch (err) { toast('Could not store the ledger key on this device'); }
  }

  // Export button: id="key-export-btn"
  if (e.target.id === 'key-export-btn') {
    const passphrase = prompt('Enter a passphrase to encrypt your key backup (keep this safe — you will need it to restore):\n\nMinimum 8 characters recommended.');
    if (!passphrase) return;
    if (passphrase.length < 8) {
      if (!confirm('Passphrase is shorter than 8 characters. Continue anyway?')) return;
    }
    try {
      const backup = await exportEncryptedKey(passphrase);
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `plotline-key-backup-${S.fp ?? 'unknown'}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast('Key backup downloaded. Store it somewhere safe.');
    } catch (err) { toast('Export failed: ' + err.message); }
  }

  // Import button: id="key-import-btn" (triggers hidden file input id="key-import-file")
  if (e.target.id === 'key-import-btn') {
    $('#key-import-file')?.click();
  }
});

document.getElementById('key-import-file')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const passphrase = prompt('Enter the passphrase you used when creating this backup:');
  if (passphrase === null) return;
  try {
    const text = await file.text();
    const backup = JSON.parse(text);
    const keys = await importEncryptedKey(backup, passphrase);
    const { fingerprint: fp } = await import('./core.js').catch(() => C);
    const newFp = await C.fingerprint(keys.pub);
    if (S.fp && S.fp !== newFp) {
      if (!confirm(`This backup belongs to a different key (${newFp}). Your current key is ${S.fp}.\n\nImporting will replace your current key. Continue?`)) {
        e.target.value = '';
        return;
      }
    }
    S.keys = keys;
    S.fp = newFp;
    save();
    toast(`Key restored for ${newFp}. Restart the app to use it.`);
  } catch (err) { toast('Import failed: ' + err.message); }
  e.target.value = '';
});


// ─────────────────────────────────────────────────────────────────────────────
// MEDIUM-5: Multi-device sync bundle (export/import)
// ─────────────────────────────────────────────────────────────────────────────
//
// There are no user accounts in Plotline. Each phone keeps its own state in
// localStorage. This sync bundle lets a farmer move their pending records,
// farm boundaries and payout number to a new or second device without a server
// round-trip, and without exposing the private key.
//
// What the bundle contains (PUBLIC data only):
//   • Public key + fingerprint (so the receiving device can verify signatures)
//   • Farm records (boundaries, names)
//   • Pending outbox items (unsigned or signed records not yet submitted)
//   • Sent/submitted records
//   • Active farm reference
//   • Payout number preference (msisdn)
//
// What the bundle does NOT contain:
//   • The private signing key (use the encrypted key backup above for that)
//   • Batches that are already sealed and on the ledger (those are public)
//
// The bundle is signed with the current private key so the receiving device can
// confirm it was not tampered with after export.
//
// To transfer to a new device:
//   1. Export sync bundle on the old device → download JSON file.
//   2. Export encrypted key backup on the old device → download JSON file.
//   3. On the new device: import key backup first, then import sync bundle.
//
// ─────────────────────────────────────────────────────────────────────────────

const SYNC_BUNDLE_VERSION = 1;

/**
 * Build and sign a sync bundle from the current state.
 * @returns {Promise<object>} - JSON-serialisable bundle
 */
async function exportSyncBundle() {
  if (!S.keys) throw new Error('No key pair — generate keys first');
  const payload = {
    version: SYNC_BUNDLE_VERSION,
    fp: S.fp,
    pub: S.keys.pub,
    exportedAt: new Date().toISOString(),
    farms: S.farms ?? [],
    outbox: S.outbox ?? [],
    sent: S.sent ?? [],
    activeFarm: S.activeFarm ?? null,
    msisdn: S.msisdn ?? '',
  };
  // Sign the canonical JSON of the payload so the receiving device can verify it.
  const { hash, sig } = await C.signBody(payload, S.keys.priv);
  return { ...payload, hash, sig };
}

/**
 * Verify and import a sync bundle.
 * Does NOT overwrite keys — the user must import the key backup separately.
 * @param {object} bundle
 * @returns {Promise<{ farms: number, outbox: number, sent: number }>} counts of imported items
 */
async function importSyncBundle(bundle) {
  if (!bundle || bundle.version !== SYNC_BUNDLE_VERSION) throw new Error('Unrecognised sync bundle format');
  if (!bundle.pub?.x || !bundle.fp) throw new Error('Bundle missing public key');

  // Verify signature.
  const { sig, hash, ...payload } = bundle;
  const computedHash = await C.hashBody(payload);
  if (computedHash !== hash) throw new Error('Bundle hash mismatch — bundle may have been tampered with');
  const valid = await C.verifySig(hash, sig, bundle.pub);
  if (!valid) throw new Error('Bundle signature is invalid');

  // Merge farms (add new ones, skip duplicates by id). Farms carry `id`, not `farmId`.
  const existingFarmIds = new Set((S.farms ?? []).map((f) => f.id));
  const newFarms = (bundle.farms ?? [])
    .filter((f) => f && typeof f === 'object' && f.id && Array.isArray(f.polygon) && f.polygon.length >= 3 && !existingFarmIds.has(f.id));
  S.farms = [...(S.farms ?? []), ...newFarms];

  // Merge outbox (skip duplicates by submission key — an outbox item's identity is its `key`).
  const existingKeys = new Set((S.outbox ?? []).map((x) => (x && typeof x === 'object' ? x.key : null)));
  const newOutbox = (bundle.outbox ?? []).filter((x) => x && typeof x === 'object' && x.key && !existingKeys.has(x.key));
  S.outbox = [...(S.outbox ?? []), ...newOutbox];

  // Merge sent keys (they are plain strings of joined record hashes).
  const sentKeys = new Set(S.sent ?? []);
  const newSent = (bundle.sent ?? []).filter((k) => typeof k === 'string' && !sentKeys.has(k));
  S.sent = [...(S.sent ?? []), ...newSent];

  // Apply activeFarm and msisdn only if the device currently has none.
  if (!S.activeFarm && bundle.activeFarm) S.activeFarm = bundle.activeFarm;
  if (!S.msisdn && bundle.msisdn) S.msisdn = bundle.msisdn;

  // If no key pair on this device, apply the public key reference (but NOT priv).
  if (!S.keys) {
    S.keys = { pub: bundle.pub, priv: null }; // priv is null until key backup is imported
    S.fp = bundle.fp;
  }

  save();
  return { farms: newFarms.length, outbox: newOutbox.length, sent: newSent.length };
}

// ── UI wiring for sync bundle ────────────────────────────────────────────────

document.addEventListener('click', async (e) => {
  // Export sync bundle: id="sync-export-btn"
  if (e.target.id === 'sync-export-btn') {
    try {
      const bundle = await exportSyncBundle();
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `plotline-sync-${S.fp ?? 'unknown'}-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast('Sync bundle downloaded. Import it on your new device after restoring your key.');
    } catch (err) { toast('Sync export failed: ' + err.message); }
  }

  // Import sync bundle: id="sync-import-btn"
  if (e.target.id === 'sync-import-btn') {
    $('#sync-import-file')?.click();
  }
});

document.getElementById('sync-import-file')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const bundle = JSON.parse(text);
    const result = await importSyncBundle(bundle);
    renderAll();
    toast(`Sync complete: ${result.farms} farm(s), ${result.outbox} outbox item(s), ${result.sent} sent record(s) imported.`);
  } catch (err) { toast('Sync import failed: ' + err.message); }
  e.target.value = '';
});

// ─────────────────────────────────────────────────────────────────────────────
// Device lock: the farmer's sign in / sign out
// ─────────────────────────────────────────────────────────────────────────────
// Farmers deliberately have no server accounts: their identity is the ECDSA key on
// the phone and offline-first access must never depend on a connection. This optional
// PIN lock is their device-local equivalent of signing in — nothing outside the lock
// screen renders until the PIN is entered, every time the app is reopened.
//
// The PIN is checked by decrypting a marked value with an AES-GCM key derived via
// PBKDF2 (the same primitives as the key backup). Wrong PIN = wrong key = failure,
// with no plaintext stored. Removing the lock requires the current PIN; a forgotten
// PIN can only end in an app reset (losing local data), which we surface honestly.
const LOCK_STORAGE = 'plotline.lock';
const LOCK_MARKER = 'plotline-lock-v1';

function getLock() {
  try { return JSON.parse(localStorage.getItem(LOCK_STORAGE) || 'null'); } catch { return null; }
}

async function makeLock(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapKey = await deriveWrapKey(pin, salt);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, new TextEncoder().encode(LOCK_MARKER));
  return { version: 1, salt: toHex(salt), iv: toHex(iv), ct: toB64(ciphertext) };
}

async function lockOk(pin, lock = getLock()) {
  if (!lock) return true; // no lock set
  if (typeof pin !== 'string' || !pin.length) return false;
  try {
    const wrapKey = await deriveWrapKey(pin, fromHex(lock.salt));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromHex(lock.iv) }, wrapKey, fromB64(lock.ct));
    return new TextDecoder().decode(plain) === LOCK_MARKER;
  } catch { return false; }
}

// The PIN lock overlay: shown at boot instead of the gateway when a lock is set.
function showLockIfNeeded() {
  if (!getLock()) return;
  document.body.classList.add('locked');
  const overlay = $('#lock-overlay');
  if (overlay) {
    overlay.hidden = false;
    $('#lock-pin')?.focus();
  }
}

$('#lock-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pin = $('#lock-pin').value;
  $('#lock-err').textContent = 'Checking…';
  if (await lockOk(pin)) {
    $('#lock-pin').value = '';
    $('#lock-err').textContent = '';
    toast('Unlocked');
    await unlockFromLockScreen();
  } else {
    $('#lock-err').textContent = 'Wrong PIN. Try again.';
  }
});
$('#lock-reset')?.addEventListener('click', async () => {
  if (!confirm('This clears all farms, records and the signing key on this phone, and the PIN lock. Continue?')) return;
  try {
    localStorage.removeItem(LOCK_STORAGE);
    localStorage.removeItem(KEY);
  } catch { /* ignore */ }
  location.reload();
});

document.addEventListener('click', async (e) => {
  if (e.target.id === 'lock-set') {
    try {
      if (getLock()) return toast('The app already has a PIN lock');
      const pin = prompt('Choose a PIN of at least 4 characters.\n\nIt will be required every time this app opens on this phone.');
      if (pin === null) return;
      if (pin.length < 4) return toast('The PIN needs at least 4 characters');
      const again = prompt('Enter the same PIN once more to confirm:');
      if (again !== pin) return toast('The two entries differ — nothing was changed');
      localStorage.setItem(LOCK_STORAGE, JSON.stringify(await makeLock(pin)));
      toast('PIN lock set. It applies from the next time this app opens.');
    } catch (err) { toast('Could not set the PIN lock on this device'); }
  }
  if (e.target.id === 'lock-remove') {
    try {
      const lock = getLock();
      if (!lock) return toast('This app has no PIN lock');
      const pin = prompt('Enter the current PIN to remove the lock:');
      if (pin === null) return;
      if (!(await lockOk(pin, lock))) return toast('Wrong PIN — the lock is kept');
      localStorage.removeItem(LOCK_STORAGE);
      toast('PIN lock removed');
    } catch (err) { toast('Could not remove the PIN lock on this device'); }
  }
});

// Expose helpers for use in app.html and for testing in the console.
window._plotline = {
  exportEncryptedKey,
  importEncryptedKey,
  exportSyncBundle,
  importSyncBundle,
};

// Boot last so every const below is defined before the gateway reads device state.
init().catch((err) => { console.error(err); toast('Startup problem: ' + err.message); });
