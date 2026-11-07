// console.js — registry console: unified login + dashboards
import * as C from './core.js';
import { createRealtimeClient } from './vendor/neon-realtime-client.js';

/* ── Helpers ── */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const naira = (k) => '₦' + (k / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 });
const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const ago  = (iso) => { const s = Math.floor((Date.now() - +new Date(iso)) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s/60)}m ago` : s < 86400 ? `${Math.floor(s/3600)}h ago` : `${Math.floor(s/86400)}d ago`; };

let tt;
function toast(m) {
  const t = $('#toast'); t.textContent = m; t.classList.add('show');
  clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 3500);
}

/* ── Session state ── */
let session = null; // { role, username, expiresAt }

/* ── API helper ── */
async function api(path, { method = 'GET', body, base = 'api/registry/' } = {}) {
  const res = await fetch(base + path, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}
async function authApi(path, opts = {}) { return api(path, { ...opts, base: 'api/auth/' }); }
const fail = (r) => toast(r.json?.error || r.json?.message || `Request failed (${r.status})`);

/* ══════════════════════════════════════════════
   AUTH SCREEN — unified login + signup
══════════════════════════════════════════════ */

// Mode toggle: sign-in ↔ create account
function setAuthMode(mode) {
  const isSignin = mode === 'signin';
  $('#panel-signin').hidden  = !isSignin;
  $('#panel-signup').hidden  =  isSignin;
  $('#auth-foot-signin').hidden = !isSignin;
  $('#auth-foot-signup').hidden =  isSignin;
  const tabIn  = $('#tab-signin');
  const tabUp  = $('#tab-signup');
  const active = 'border-bottom:2px solid var(--green);color:var(--green);font-weight:600';
  const idle   = 'border-bottom:2px solid transparent;color:var(--text-2);font-weight:500';
  tabIn.style.cssText  = tabIn.style.cssText.replace(/border-bottom:[^;]+;color:[^;]+;font-weight:[^;]+/, isSignin ? active : idle);
  tabUp.style.cssText  = tabUp.style.cssText.replace(/border-bottom:[^;]+;color:[^;]+;font-weight:[^;]+/, !isSignin ? active : idle);
}
$('#tab-signin').addEventListener('click', () => setAuthMode('signin'));
$('#tab-signup').addEventListener('click', () => setAuthMode('signup'));
$('#go-signup')?.addEventListener('click',  (e) => { e.preventDefault(); setAuthMode('signup'); });
$('#go-signin')?.addEventListener('click',  (e) => { e.preventDefault(); setAuthMode('signin'); });

// Role-based redirection upon successful authentication
function handleRoleRedirection(s) {
  const role = s?.role;
  if (role === 'admin') {
    enterConsole();
    activatePanel('overview'); // route admin to console/admin dashboard
  } else if (role === 'verifier') {
    enterConsole();
    activatePanel('verify'); // route verifier to the submissions queue
  } else {
    // Standard users: route to standard app view
    window.location.href = 'app.html';
  }
}

// Sign-in
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#login-btn');
  btn.disabled = true; btn.textContent = 'Signing in…';
  const errBox = $('#login-err');
  errBox.hidden = true;
  try {
    const res = await fetch('api/auth/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: $('#login-user').value.trim(), password: $('#login-pass').value }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { errBox.textContent = json.error || 'Sign-in failed.'; errBox.hidden = false; return; }
    $('#login-pass').value = '';
    session = json.session;
    handleRoleRedirection(session);
  } finally { btn.disabled = false; btn.textContent = 'Sign in →'; }
});

// Sign-up (restricted to standard users)
$('#signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#signup-btn');
  btn.disabled = true; btn.textContent = 'Creating account…';
  const errBox = $('#signup-err');
  errBox.hidden = true;
  try {
    const res = await fetch('api/auth/signup', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: $('#signup-user').value.trim(),
        password: $('#signup-pass').value,
        email:    $('#signup-email').value.trim(),
        name:     $('#signup-name').value.trim(),
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { errBox.textContent = json.error || 'Sign-up failed.'; errBox.hidden = false; return; }
    session = json.session;
    handleRoleRedirection(session);
  } finally { btn.disabled = false; btn.textContent = 'Create account →'; }
});

$('#logout-btn').addEventListener('click', async () => {
  await fetch('api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  session = null;
  exitConsole();
});

async function checkExistingSession() {
  try {
    const r = await fetch('api/auth/session', { credentials: 'same-origin' });
    if (r.ok) {
      const j = await r.json();
      session = j.session;
      if (session?.role === 'user') {
        window.location.href = 'app.html';
        return;
      }
      handleRoleRedirection(session);
      return;
    }
  } catch {}
  showAuthScreen();
}

function showAuthScreen() {
  document.body.classList.add('auth-page');
  $('#auth-screen').hidden    = false;
  $('#console-shell').hidden  = true;
}

function exitConsole() {
  document.body.classList.add('auth-page');
  $('#auth-screen').hidden   = false;
  $('#console-shell').hidden = true;
}

/* ══════════════════════════════════════════════
   CONSOLE SHELL — enter, wire nav
══════════════════════════════════════════════ */
function enterConsole() {
  const role  = session?.role || 'user';
  if (role === 'user') {
    window.location.href = 'app.html';
    return;
  }

  document.body.classList.remove('auth-page');
  $('#auth-screen').hidden    = true;
  $('#console-shell').hidden  = false;

  const uname = session?.username || '?';

  // Session pill
  $('#session-label').textContent = `${uname} · ${role}`;
  $('#role-dot').className = 'role-dot ' + (role === 'admin' ? 'admin' : '');

  // Show correct nav tabs
  $$('.admin-tab').forEach(b    => { b.style.display = role === 'admin'    ? '' : 'none'; });
  $$('.verifier-tab').forEach(b => { b.style.display = role === 'verifier' ? '' : 'none'; });

  // Activate appropriate initial tab for the role
  const targetPanel = role === 'verifier' ? 'verify' : 'overview';
  activatePanel(targetPanel);

  wireVerifierKey();
  loadAll();
  wireRealtime();
  loadNeonStatus();
}

/* ── Panel navigation ── */
$$('.cnav button[data-p]').forEach((b) => b.addEventListener('click', () => activatePanel(b.dataset.p)));

function activatePanel(id) {
  $$('.cnav button').forEach((b) => b.classList.toggle('on', b.dataset.p === id));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'p-' + id));
  if (id === 'log') renderLog();
  if ((id === 'queue' || id === 'verify') && map) setTimeout(() => map.invalidateSize(), 50);
}

/* ══════════════════════════════════════════════
   VERIFIER KEY (browser-local ECDSA key)
══════════════════════════════════════════════ */
const VKEY = 'plotline.verifier';
let V = null;

async function wireVerifierKey() {
  try { V = JSON.parse(localStorage.getItem(VKEY)); } catch { V = null; }
  if (!V) {
    const keys = await C.generateKeys();
    V = { keys, fp: await C.fingerprint(keys.pub) };
    try { localStorage.setItem(VKEY, JSON.stringify(V)); } catch {}
  }
  const box = $('#vinfo');
  if (box) box.innerHTML = `Verifier key <code>${esc(V.fp)}</code>. Decisions are signed with this key — the signature stays in the registry.`;
}

/* ══════════════════════════════════════════════
   NEON REALTIME
══════════════════════════════════════════════ */
let rtClient = null, rtSubscription = null, stopRenewing = null;
const RENEW_EARLY_MS = 10_000;

async function wireRealtime() {
  const statusBox = $('#rt-status');
  const feed = $('#rt-feed');
  if (!statusBox || !feed) return;
  const fetchSealed = () => fetch('api/realtime/events', { credentials: 'same-origin' })
    .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error || `HTTP ${r.status}`); return r.json(); });
  const render = (snap) => {
    const rows = snap.data ?? [];
    statusBox.textContent = `${snap.status} · ${rows.length} event(s)`;
    feed.innerHTML = rows.map((e) =>
      `<div class="rt-entry"><span class="rt-time">${esc(new Date(e.created_at).toLocaleTimeString([], {timeStyle:'short'}))}</span><span class="rt-kind">${esc(e.kind)}</span> ${esc(e.detail?.farmer||e.detail?.order||e.detail?.verifier||'')} </div>`
    ).join('');
  };
  try {
    const { url, sealed } = await fetchSealed();
    rtClient ??= createRealtimeClient({ url });
    rtSubscription?.unsubscribe();
    stopRenewing?.();
    rtSubscription = rtClient.subscribe(sealed);
    rtSubscription.onChange(render);
    let timer;
    const schedule = (delay) => { clearTimeout(timer); timer = setTimeout(renew, delay); };
    async function renew() {
      try { const next = (await fetchSealed()).sealed; schedule(Math.max(0, next.expiresAt - Date.now() - RENEW_EARLY_MS)); rtSubscription.renew(next).catch(()=>{}); }
      catch { schedule(1000); }
    }
    schedule(Math.max(0, sealed.expiresAt - Date.now() - RENEW_EARLY_MS));
    stopRenewing = () => clearTimeout(timer);
  } catch (e) { if (statusBox) statusBox.textContent = e.message; }
}

async function loadNeonStatus() {
  const box = $('#neon-status');
  if (!box) return;
  try {
    const j = await fetch('api/neon/status').then(r => r.json());
    const chip = (v) => v==='up'?'🟢 up':v==='fallback'?'🟡 fallback':v==='not-configured'?'⚪ not configured':`🔴 ${v}`;
    box.innerHTML = [['Postgres',chip(j.postgres)],['Neon Auth',chip(j.auth)],['Realtime',chip(j.realtime)],['Functions',chip(j.function)]]
      .map(([k,v])=>`<div class="recon-row"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
    const nchip = $('#neon-chip');
    if (nchip) nchip.textContent = `Neon: ${j.postgres==='up'?'connected':'local fallback'}`;
  } catch { if (box) box.textContent = 'Could not reach the server.'; }
}

/* ══════════════════════════════════════════════
   LOAD ALL — entry point called on login + reload
══════════════════════════════════════════════ */
async function loadAll() {
  const role = session?.role;
  if (!role) return;

  loadQueue();
  loadProjects();
  loadMarket();
  loadMoney();
  loadFarmers();
  loadOverviewStats();

  if (role === 'admin') {
    loadVerifiersList();
    loadApplications();
  }
}

/* ══════════════════════════════════════════════
   OVERVIEW STATS
══════════════════════════════════════════════ */
async function loadOverviewStats() {
  const r = await api('submissions');
  if (!r.ok) return;
  const all = r.json.submissions || [];
  const set = (id, v) => { const el = $('#' + id); if (el) el.textContent = v; };
  set('stat-submissions', all.length);
  set('stat-pending', all.filter(s => s.status === 'pending').length);
  // Credits from reconcile
  const rc = await api('reconcile');
  if (rc.ok) set('stat-credits', rc.json.issued ?? '—');
  // Unique farmer keys
  const fk = new Set(all.map(s => s.farmerKey));
  set('stat-farmers', fk.size);

  // Render recent submissions in overview panel
  const box = $('#overview-queue');
  if (box) box.innerHTML = all.slice(0, 5).map(s => itemHtml(s)).join('') || '<div class="muted small">No submissions yet.</div>';

  // Application badge
  const ar = await authApi('apply');
  if (ar.ok) {
    const pending = (ar.json.applications || []).filter(a => a.status === 'pending');
    const badge = $('#apply-badge');
    if (badge) { badge.textContent = pending.length + ' pending'; badge.hidden = pending.length === 0; }
    const obox = $('#overview-applies');
    if (obox) obox.innerHTML = pending.slice(0, 3).map(appItemHtml).join('') || '<div class="muted small">No pending applications.</div>';
  }
}

/* ══════════════════════════════════════════════
   SUBMISSIONS QUEUE (admin view + map)
══════════════════════════════════════════════ */
let map = null, mapLayer = null, subs = [], selected = null;
const fires = new Map();

function initMap(mapId) {
  const el = $('#' + mapId);
  if (!el || typeof L === 'undefined') return;
  if (mapId === 'cmap' && map) { map.invalidateSize(); return; }
  const m = L.map(mapId).setView([9.9, 8.9], 12);
  L.tileLayer(C.TILE_URL, {
    maxZoom: 19,
    attribution: C.TILE_ATTRIBUTION,
    crossOrigin: true, // see makeMap in app.js: CORS responses are status-readable
    keepBuffer: 4,
    updateWhenIdle: false,
  }).addTo(m);
  const l = L.layerGroup().addTo(m);
  if (mapId === 'cmap') { map = m; mapLayer = l; }
  return { map: m, layer: l };
}

async function loadQueue() {
  const r = await api('submissions');
  if (!r.ok) return;
  subs = r.json.submissions || [];
  renderQueue();
  if (!map) initMap('cmap');
  drawMap();
}

const STATUS_COLOUR = { pending: '#b4761e', approved: '#476633', rejected: '#a33a32', flagged: '#a33a32' };

function itemHtml(s) {
  const flags = (s.flags?.length || 0) + (s.hard?.length || 0);
  return `<button class="item ${selected === s.subId ? 'sel' : ''}" data-id="${esc(s.subId)}">
    <div class="lead"><strong>${esc(s.farmName || 'Plot')} · ${s.units} tCO₂e</strong>
    <span class="sub">${esc(s.farmerKey?.slice(0,12))}… · ${esc(ago(s.receivedAt))}${flags ? ' · <span class="text-amber">'+flags+' flag(s)</span>' : ''}</span></div>
    <span class="badge ${s.status==='approved'?'good':s.status==='pending'?'ok':'bad'}">${esc(s.status)}</span>
  </button>`;
}

function renderQueue() {
  const box = $('#queue');
  const filter = $('#queue-filter')?.value || '';
  if (!box) return;
  const filtered = filter ? subs.filter(s => s.status === filter) : subs;
  box.innerHTML = filtered.length ? filtered.map(itemHtml).join('') : '<div class="muted small">No submissions.</div>';
  box.querySelectorAll('[data-id]').forEach(b => b.addEventListener('click', () => select(b.dataset.id)));
}

$('#queue-filter')?.addEventListener('change', renderQueue);

function select(id) {
  selected = id;
  renderQueue();
  drawMap();
  renderDetail();
  loadFireCheck();
}

function drawMap() {
  if (!map || !mapLayer) return;
  mapLayer.clearLayers();
  const pts = [];
  for (const s of subs) {
    if (!s.polygon?.length) continue;
    const ll = s.polygon.map(p => [p.lat, p.lon]);
    pts.push(...ll);
    L.polygon(ll, { color: STATUS_COLOUR[s.status] || '#888', weight: selected===s.subId?4:2, fillOpacity: selected===s.subId?.35:.12 })
      .bindTooltip(`${esc(s.farmName||'Plot')} (${s.status})`).addTo(mapLayer)
      .on('click', () => select(s.subId));
  }
  if (pts.length) map.fitBounds(pts, { padding: [24, 24], maxZoom: 16 });
}

function renderDetail() {
  const box = $('#detail');
  if (!box) return;
  const s = subs.find(x => x.subId === selected);
  if (!s) { box.innerHTML = '<div class="placeholder"><span style="font-size:32px">🗂</span><p>Select a submission.</p></div>'; return; }
  const flags = [...(s.flags||[]), ...(s.hard||[])];
  box.innerHTML = `
    <div class="stack">
      <div class="row between">
        <h2 style="font-size:18px">${esc(s.farmName||'Plot')} <span class="badge ${s.status==='approved'?'good':s.status==='pending'?'ok':'bad'}" style="vertical-align:middle">${esc(s.status)}</span></h2>
        <span class="muted small">${esc(when(s.receivedAt))}</span>
      </div>
      <dl class="kv">
        <dt>Submission ID</dt><dd class="mono">${esc(s.subId)}</dd>
        <dt>Farmer key</dt><dd class="mono">${esc(s.farmerKey)}</dd>
        <dt>Trees planted</dt><dd>${s.treesPlanted ?? '—'}</dd>
        <dt>Alive (sample)</dt><dd>${s.treesAlive ?? '—'} / ${s.sampleSize ?? '—'}</dd>
        <dt>Area</dt><dd>${s.areaHa ? s.areaHa.toFixed(3) + ' ha' : '—'}</dd>
        <dt>Credits</dt><dd>${s.units} tCO₂e</dd>
        <dt>Methodology</dt><dd>${esc(s.methodologyId||'—')}</dd>
        <dt>Project</dt><dd>${esc(s.projectId||'—')}</dd>
      </dl>
      ${flags.length ? `<div class="alert-box amber"><div><b>${flags.length} check flag(s)</b><br>${flags.map(f=>`<div class="text-sm" style="margin-top:4px">· ${esc(f)}</div>`).join('')}</div></div>` : ''}
      <div id="fire-box" class="muted small">Fire check loading…</div>
      ${s.status==='pending' ? decisionForm(s) : s.decision ? decisionRecord(s.decision) : ''}
    </div>`;
  bindDecision(s);
}

function decisionForm(s) {
  return `<div style="border-top:1px solid var(--border-2);padding-top:var(--s3)">
    <h3 style="margin-bottom:var(--s3)">Sign a decision</h3>
    <label style="margin-bottom:var(--s3)">Reason <span class="hint">Required when approving a flagged submission.</span>
      <textarea id="dec-reason" rows="2" maxlength="400" placeholder="Brief reason or notes…"></textarea>
    </label>
    <div class="row">
      <button id="dec-approve" class="secondary">✓ Approve</button>
      <button id="dec-reject"  class="danger">✗ Reject</button>
    </div>
    <div id="dec-msg" class="muted small"></div>
  </div>`;
}

function decisionRecord(d) {
  return `<div class="alert-box ${d.decision==='approve'?'green':'red'}">
    <b>${d.decision==='approve'?'Approved':'Rejected'}</b> by ${esc(d.verifier)} · ${esc(when(d.decidedAt))}
    ${d.reason ? `<div class="text-sm" style="margin-top:4px">"${esc(d.reason)}"</div>` : ''}
  </div>`;
}

function bindDecision(s) {
  $('#dec-approve')?.addEventListener('click', () => decide(s, 'approve'));
  $('#dec-reject')?.addEventListener('click',  () => decide(s, 'reject'));
}

async function decide(s, action) {
  if (!V) { toast('No verifier key — cannot sign.'); return; }
  const reason = $('#dec-reason')?.value?.trim() || '';
  const msg = $('#dec-msg');
  if (msg) msg.textContent = 'Signing…';
  const fireEntry = fires.get(s.subId);
  const payload = { subId: s.subId, decision: action, reason, verifier: V.fp, fireEvidence: fireEntry?.evidence ?? null };
  const sig = await C.sign(V.keys.priv, JSON.stringify(payload));
  const r = await api('decide', { method: 'POST', body: { ...payload, sig, pub: V.keys.pub } });
  if (r.ok) { toast(`Submission ${action}d.`); loadAll(); selected = null; }
  else fail(r);
}

/* ── Fire check ── */
function centroid(poly) {
  const n = poly.length||1; return { lat: poly.reduce((a,p)=>a+p.lat,0)/n, lon: poly.reduce((a,p)=>a+p.lon,0)/n };
}
async function loadFireCheck(force=false) {
  const s = subs.find(x => x.subId === selected);
  if (!s) return;
  if (!force && fires.get(s.subId)?.evidence) { paintFire(s); return; }
  fires.set(s.subId, { loading: true });
  paintFire(s);
  const c = centroid(s.polygon||[]);
  const r = await api(`fires?lat=${c.lat.toFixed(6)}&lon=${c.lon.toFixed(6)}&radiusKm=5&days=30`);
  fires.set(s.subId, { loading: false, evidence: r.ok ? r.json : { status:'unavailable', error:`http_${r.status}` } });
  paintFire(s);
}
function paintFire(s) {
  const box = $('#fire-box');
  if (!box) return;
  const entry = fires.get(s.subId);
  if (!entry || entry.loading) { box.innerHTML = '<span class="muted small">Checking fires near plot…</span>'; return; }
  const e = entry.evidence;
  if (!e||e.status!=='ok') { box.innerHTML = `<span class="muted small">Fire check unavailable${e?.error?' ('+esc(e.error)+')':''}.</span>`; return; }
  if (!e.count) box.innerHTML = `<div class="alert-box green" style="padding:var(--s2) var(--s3)">✓ No VIIRS fire detections within ${e.radiusKm} km in ${e.days} days.</div>`;
  else box.innerHTML = `<div class="alert-box ${e.nearestKm<=1?'red':'amber'}" style="padding:var(--s2) var(--s3)">⚠ ${e.count} detection(s) within ${e.radiusKm} km — nearest ${e.nearestKm} km. Inspect before approving.</div>`;
}

/* ══════════════════════════════════════════════
   PROJECTS
══════════════════════════════════════════════ */
async function loadProjects() {
  const r = await api('projects');
  const box = $('#prj-list');
  if (!box || !r.ok) return;
  const list = r.json.projects || [];
  box.innerHTML = list.length ? list.map(p=>`<div class="item" style="cursor:default">
    <div class="lead"><strong>${esc(p.name)}</strong><span class="sub">${esc(p.id)} · ${esc(p.methodology||'—')} · ${esc(p.proponent||'')}</span></div>
    <span class="badge good">active</span></div>`).join('') : '<div class="muted small">No projects registered.</div>';
}

$('#prj-new-btn')?.addEventListener('click', () => { $('#prj-form-card').hidden = false; });
$('#prj-cancel')?.addEventListener('click',  () => { $('#prj-form-card').hidden = true; });
$('#prj-submit')?.addEventListener('click', async () => {
  const body = {
    name: $('#prj-name').value.trim(), proponent: $('#prj-proponent').value.trim(),
    boundaryHash: $('#prj-boundary').value.trim()||null, ecoregion: $('#prj-ecoregion').value.trim()||null,
    methodologyId: $('#prj-methodology').value.trim()||'CURRENT',
    creditingStart: $('#prj-start').value, creditingEnd: $('#prj-end').value,
    additionality: $('#prj-additionality').value.trim(), landUsePrior: $('#prj-tenure').value,
    fpicRef: $('#prj-fpic').value.trim()||null, validationRef: $('#prj-validation').value.trim(),
  };
  const r = await api('projects', { method: 'POST', body });
  const msg = $('#prj-msg');
  if (r.ok) { toast('Project registered: ' + r.json.project.id); msg.textContent = ''; $('#prj-form-card').hidden = true; loadProjects(); }
  else { msg.textContent = r.json.error || 'Failed.'; }
});

/* ══════════════════════════════════════════════
   VERIFIERS MANAGEMENT (admin)
══════════════════════════════════════════════ */
async function loadVerifiersList() {
  const r = await authApi('verifiers');
  const box = $('#ver-list');
  if (!box || !r.ok) return;
  const list = r.json.verifiers || [];
  box.innerHTML = list.length ? list.map(v => `<div class="item" style="cursor:default">
    <div class="lead"><strong>${esc(v.username)}</strong><span class="sub">Created ${esc(when(v.createdAt))}</span></div>
    <div class="row tight" style="gap:var(--s2)">
      ${v.disabledAt ? '<span class="badge bad">disabled</span>' : '<span class="badge good">active</span>'}
      <button class="sm danger ver-del-btn" data-id="${esc(v.username)}">Remove</button>
    </div>
  </div>`).join('') : '<div class="muted small">No verifier accounts yet.</div>';
  box.querySelectorAll('.ver-del-btn').forEach(b => b.addEventListener('click', async () => {
    if (!confirm(`Remove verifier account "${b.dataset.id}"?`)) return;
    const r2 = await authApi(`verifiers/${b.dataset.id}`, { method: 'DELETE' });
    r2.ok ? (toast('Removed.'), loadVerifiersList()) : fail(r2);
  }));
}

$('#ver-create')?.addEventListener('click', async () => {
  const username = $('#ver-username').value.trim();
  const password = $('#ver-password').value;
  const msg = $('#ver-msg');
  if (!username || password.length < 8) { msg.textContent = 'Username required and password must be 8+ chars.'; return; }
  const r = await authApi('verifiers', { method: 'POST', body: { username, password } });
  if (r.ok) { toast(`Account created for ${username}`); msg.textContent = ''; $('#ver-username').value=''; $('#ver-password').value=''; loadVerifiersList(); }
  else { msg.textContent = r.json.error || 'Failed.'; }
});

$('#ver-list-refresh')?.addEventListener('click', loadVerifiersList);

/* ══════════════════════════════════════════════
   VERIFIER APPLICATIONS (admin)
══════════════════════════════════════════════ */
function appItemHtml(a) {
  return `<div class="apply-card ${a.status==='pending'?'new':''}" data-appid="${esc(a.id)}">
    <div class="row between">
      <span class="ac-name">${esc(a.name)}</span>
      <span class="badge ${a.status==='pending'?'ok':a.status==='approved'?'good':'bad'}">${esc(a.status)}</span>
    </div>
    <div class="ac-email">${esc(a.email)}${a.org?' · '+esc(a.org):''}</div>
    <div class="ac-reason">${esc(a.reason)}</div>
    <div class="muted small">${esc(ago(a.submittedAt))}</div>
    ${a.status==='pending' ? `<div class="row" style="margin-top:var(--s2)">
      <button class="sm secondary app-approve-btn" data-id="${esc(a.id)}">Approve &amp; generate activation code</button>
      <button class="sm danger app-reject-btn" data-id="${esc(a.id)}">Reject</button>
    </div>` : ''}
  </div>`;
}

async function loadApplications() {
  const r = await authApi('apply');
  if (!r.ok) return;
  const apps = r.json.applications || [];
  const pending = apps.filter(a => a.status === 'pending');

  const countEl = $('#apps-count');
  if (countEl) { countEl.textContent = pending.length; countEl.hidden = pending.length === 0; }

  const box = $('#applications-list');
  const emptyEl = $('#applications-empty');
  if (!box) return;
  box.innerHTML = apps.map(appItemHtml).join('');
  if (emptyEl) emptyEl.hidden = apps.length > 0;

  box.querySelectorAll('.app-approve-btn').forEach(b => b.addEventListener('click', async () => {
    const r2 = await authApi(`apply/${b.dataset.id}/approve`, { method: 'POST' });
    if (r2.ok) {
      const { username, activationCode, password } = r2.json;
      toast(`Approved! Activation code: ${activationCode || username}`);
      // Show activation code clearly
      const d = $('#apply-dialog');
      $('#apply-dialog-body').innerHTML = `<div class="alert-box green"><b>Application approved!</b></div>
        <p class="muted small" style="margin-top:var(--s3)">Provide this activation code off-band to the applicant. They will enter it in the app to activate their Verifier status.</p>
        <dl class="kv" style="margin-top:var(--s3)">
          <dt>Username</dt><dd class="mono">${esc(username)}</dd>
          ${activationCode ? `<dt>Activation Code</dt><dd class="token-box">${esc(activationCode)}</dd>` : ''}
          ${password ? `<dt>Temporary Password</dt><dd class="mono">${esc(password)}</dd>` : ''}
        </dl>`;
      $('#apply-approve').hidden = true;
      $('#apply-reject').hidden  = true;
      d.showModal();
      loadApplications(); loadVerifiersList();
    } else fail(r2);
  }));

  box.querySelectorAll('.app-reject-btn').forEach(b => b.addEventListener('click', async () => {
    const r2 = await authApi(`apply/${b.dataset.id}/reject`, { method: 'POST' });
    r2.ok ? (toast('Application rejected.'), loadApplications()) : fail(r2);
  }));
}

$('#apply-close')?.addEventListener('click',   () => $('#apply-dialog')?.close());
$('#apply-approve')?.addEventListener('click', () => {});
$('#apply-reject')?.addEventListener('click',  () => $('#apply-dialog')?.close());

/* ══════════════════════════════════════════════
   MARKET
══════════════════════════════════════════════ */
async function loadMarket() {
  const sr = await api('summary');
  const box = $('#mk-sum');
  if (box && sr.ok) box.textContent = `${sr.json.available ?? 0} credits available · ₦${((sr.json.available||0)*12000/100).toLocaleString('en-NG')} notional value`;

  const lr = await api('lots');
  const lots = $('#lots');
  if (lots && lr.ok) lots.innerHTML = (lr.json.lots||[]).length
    ? lr.json.lots.map(l=>`<div class="item" style="cursor:default">
        <div class="lead"><strong>${esc(l.id)}</strong><span class="sub">${l.issued} issued · ${l.available} available · buffer ${l.buffer}</span></div>
        <span class="badge good">${esc(l.project||'—')}</span></div>`).join('')
    : '<div class="muted small">No lots yet.</div>';

  const or = await api('orders');
  const orders = $('#orders');
  if (orders && or.ok) orders.innerHTML = (or.json.orders||[]).length
    ? or.json.orders.map(o=>`<div class="item" style="cursor:default">
        <div class="lead"><strong>${esc(o.buyer)}</strong><span class="sub">${o.units} tCO₂e · ${esc(when(o.createdAt))}</span></div>
        <span class="badge ${o.retiredAt?'good':'ok'}">${o.retiredAt?'retired':'sold'}</span></div>`).join('')
    : '<div class="muted small">No orders yet.</div>';
}

$('#buy')?.addEventListener('click', async () => {
  const r = await api('buy', { method:'POST', body:{ buyer:$('#buyer').value.trim(), units:+$('#units').value } });
  const msg = $('#mk-msg');
  if (r.ok) { toast('Order placed.'); if (msg) msg.textContent = `Order ${r.json.order?.id} — ${r.json.order?.units} credits.`; loadMarket(); }
  else fail(r);
});
$('#check-serial')?.addEventListener('click', async () => {
  const v = $('#serial').value.trim();
  const r = await api(`serial/${encodeURIComponent(v)}`);
  const out = $('#serial-out');
  if (!out) return;
  if (r.ok) out.innerHTML = `<div class="result"><b>${esc(v)}</b> — ${esc(r.json.state||'—')} · project ${esc(r.json.project||'—')} · vintage ${esc(String(r.json.vintage||'—'))}</div>`;
  else out.innerHTML = `<div class="alert-box red">${esc(r.json.error||'Not found')}</div>`;
});

/* ══════════════════════════════════════════════
   MONEY
══════════════════════════════════════════════ */
async function loadMoney() {
  const rr = await api('reconcile');
  const box = $('#recon');
  if (box && rr.ok) {
    const d = rr.json;
    box.innerHTML = [
      ['Issued', d.issued], ['Sold', d.sold], ['Available', d.available],
      ['Buffer', d.buffer], ['Reversed', d.reversed],
    ].map(([k,v])=>`<div class="recon-row"><span>${esc(k)}</span><b>${v??'—'}</b></div>`).join('');
  }
}
async function loadFarmers() {
  const r = await api('farmers');
  const box = $('#farmers');
  if (!box || !r.ok) return;
  const list = r.json.farmers || [];
  box.innerHTML = list.length ? list.map(f=>`<div class="item" style="cursor:default">
    <div class="lead"><strong>${esc(f.key?.slice(0,14))}…</strong><span class="sub">${f.credits||0} credits · ${naira(f.pendingKobo||0)} pending</span></div>
    <span class="badge good">${f.credits||0} tCO₂e</span></div>`).join('') : '<div class="muted small">No farmers yet.</div>';
}

/* ══════════════════════════════════════════════
   AUDIT LOG
══════════════════════════════════════════════ */
async function renderLog() {
  const box = $('#loglist');
  const check = $('#logcheck');
  if (!box) return;
  const r = await fetch('api/ledger').then(r=>r.json()).catch(()=>null);
  if (!r) { if (check) check.textContent='Could not load ledger.'; return; }
  // Verify chain integrity in-browser
  let prev = null; let broken = false;
  for (const e of r.entries||[]) {
    if (prev && e.prev !== prev) { broken = true; break; }
    prev = e.hash;
  }
  if (check) check.innerHTML = broken
    ? '<div class="alert-box red">⚠ Chain integrity check FAILED — an entry has been modified.</div>'
    : `<div class="alert-box green">✓ Chain intact · ${(r.entries||[]).length} entries · head ${esc(r.head?.hash?.slice(0,12)||'—')}</div>`;
  box.innerHTML = (r.entries||[]).slice().reverse().map(e=>`
    <div class="item" style="cursor:default">
      <div class="lead"><strong>#${e.seq} · ${esc(e.root?.slice(0,12))}…</strong><span class="sub">${e.count} records · ${esc(when(e.ts))}</span></div>
      <span class="mono text-sm">${esc(e.hash?.slice(0,10))}…</span>
    </div>`).join('');
}

/* ══════════════════════════════════════════════
   CERTIFICATE DIALOG
══════════════════════════════════════════════ */
$('#cert-close')?.addEventListener('click', () => $('#cert')?.close());

/* ══════════════════════════════════════════════
   BOOT
══════════════════════════════════════════════ */
checkExistingSession();
