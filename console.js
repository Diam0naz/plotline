import * as C from './core.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const naira = (k) => '₦' + (k / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 });
const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const KEY = 'plotline.verifier';

let tt;
function toast(m) {
  const t = $('#toast'); t.textContent = m; t.classList.add('show');
  clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 3500);
}

// The verifier's signing key lives only in this browser.
let V = null;
async function loadVerifier() {
  try { V = JSON.parse(localStorage.getItem(KEY)); } catch { V = null; }
  if (!V) {
    const keys = await C.generateKeys();
    V = { keys, fp: await C.fingerprint(keys.pub) };
    try { localStorage.setItem(KEY, JSON.stringify(V)); } catch { /* memory only */ }
  }
  $('#vinfo').innerHTML = `Verifier key <code>${esc(V.fp)}</code>. Decisions are signed with it and the registry keeps the signature.`;
}

const token = () => { try { return sessionStorage.getItem('plotline.op') || ''; } catch { return ''; } };
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('api/registry/' + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token() ? { authorization: 'Bearer ' + token() } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}
const fail = (r) => toast(r.json.message || r.json.error || `Request failed (${r.status})`);

// ---------- tabs ----------
$$('.ctabs button').forEach((b) => b.addEventListener('click', () => {
  $$('.ctabs button').forEach((x) => x.classList.toggle('on', x === b));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'p-' + b.dataset.p));
  if (b.dataset.p === 'verify' && map) setTimeout(() => map.invalidateSize(), 50);
  if (b.dataset.p === 'log') renderLog();
}));
$('#token').addEventListener('change', () => { try { sessionStorage.setItem('plotline.op', $('#token').value.trim()); } catch { /* ignore */ } loadAll(); });
$('#token').value = token();
$('#reload').addEventListener('click', loadAll);

$('#vreg').addEventListener('click', async () => {
  const r = await api('verifiers', { method: 'POST', body: { id: $('#vid').value.trim(), pub: V.keys.pub } });
  r.ok ? toast('Registered. This browser can now sign decisions.') : fail(r);
});

// ---------- verify ----------
let map, layer, subs = [], selected = null;
const fires = new Map(); // subId -> { loading, evidence }
function initMap() {
  if (typeof L === 'undefined') { $('#cmap').innerHTML = '<div class="nomap">Map library did not load.</div>'; return; }
  map = L.map('cmap').setView([9.9, 8.9], 13);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
  layer = L.layerGroup().addTo(map);
}
const colour = { pending: '#b4761e', approved: '#476633', rejected: '#a33a32' };
function drawMap() {
  if (!map) return;
  layer.clearLayers();
  const all = [];
  for (const s of subs) {
    const ll = s.polygon.map((p) => [p.lat, p.lon]);
    all.push(...ll);
    const sel = selected === s.subId;
    L.polygon(ll, { color: colour[s.status], weight: sel ? 4 : 2, fillOpacity: sel ? 0.35 : 0.15 }).bindTooltip(`${s.farmName || 'Plot'} (${s.status})`).addTo(layer)
      .on('click', () => select(s.subId));
  }
  if (all.length) map.fitBounds(all, { padding: [30, 30], maxZoom: 16 });
}
function renderQueue() {
  $('#queue').innerHTML = subs.length
    ? subs.map((s) => `<button class="item ${selected === s.subId ? 'sel' : ''}" data-id="${esc(s.subId)}"><span>${esc(s.farmName || 'Plot')} · ${s.units} tCO₂e<br><span class="sub">farmer ${esc(s.farmerKey)} · ${esc(when(s.receivedAt))}${s.flags.length || s.hard.length ? ' · ' + (s.flags.length + s.hard.length) + ' flag(s)' : ''}</span></span><span class="badge ${s.status === 'approved' ? 'good' : s.status === 'pending' ? 'ok' : 'bad'}">${s.status}</span></button>`).join('')
    : '<div class="muted">No submissions yet, or the operator token is missing.</div>';
  $$('#queue [data-id]').forEach((b) => b.addEventListener('click', () => select(b.dataset.id)));
}
function select(id) { selected = id; renderQueue(); drawMap(); renderDetail(); loadFire(); }

// ---------- fire check: live VIIRS detections near the plot ----------
function centroid(polygon) {
  const n = polygon.length || 1;
  return { lat: polygon.reduce((a, p) => a + p.lat, 0) / n, lon: polygon.reduce((a, p) => a + p.lon, 0) / n };
}
function fireHtml(s) {
  const entry = fires.get(s.subId);
  if (!entry) return '<div class="muted small">No fire check yet.</div>';
  if (entry.loading) return '<div class="muted small">Checking recent fires near this plot…</div>';
  const e = entry.evidence;
  if (!e || e.status !== 'ok') {
    return `<div class="muted small">Fire check unavailable${e?.error ? ' (' + esc(e.error) + ')' : ''}. You can still decide; the check is recorded as unavailable.</div>`;
  }
  if (!e.count) {
    return `<div class="ok-t">No VIIRS detections within ${e.radiusKm} km in the last ${e.days} days.</div>
      <div class="muted small">Checked ${esc(when(e.checkedAt))}. No detection is not proof that nothing burned.</div>`;
  }
  const near = e.nearestKm !== null && e.nearestKm <= 1;
  return `<div class="${near ? 'bad-t' : 'flag'}">${e.count} VIIRS detection${e.count === 1 ? '' : 's'} within ${e.radiusKm} km in the last ${e.days} days${e.nearestKm !== null ? `, nearest ${e.nearestKm} km` : ''}.</div>
    <div class="muted small">Latest ${esc(e.latestAcq || 'unknown')} · highest brightness ${e.maxBrightness ?? '—'} K · ${e.confidence?.high ?? 0} high-confidence. Inspect the plot before approving.</div>`;
}
function paintFire() {
  const s = subs.find((x) => x.subId === selected);
  const box = $('#fire-box');
  if (s && box) box.innerHTML = fireHtml(s);
}
async function loadFire(force = false) {
  const s = subs.find((x) => x.subId === selected);
  if (!s) return;
  const entry = fires.get(s.subId);
  if (!force && (entry?.evidence || entry?.loading)) return;
  fires.set(s.subId, { loading: true });
  paintFire();
  const c = centroid(s.polygon);
  const r = await api(`fires?lat=${c.lat.toFixed(6)}&lon=${c.lon.toFixed(6)}&radiusKm=5&days=30`);
  fires.set(s.subId, { loading: false, evidence: r.ok ? r.json : { status: 'unavailable', error: `http_${r.status}` } });
  paintFire();
}

function renderDetail() {
  const s = subs.find((x) => x.subId === selected);
  const el = $('#detail');
  if (!s) { el.innerHTML = '<div class="muted">Choose a submission to review.</div>'; return; }
  const issues = [...s.hard.map((x) => ({ ...x, hard: true })), ...s.flags]
    .map((x) => `<div class="${x.hard ? 'bad-t' : 'flag'}">${x.hard ? 'Rejected: ' : 'Review: '}${esc(x.text)}</div>`).join('') || '<div class="ok-t">No automatic flags</div>';
  const d = s.decision;
  el.innerHTML = `
    <h2>${esc(s.farmName || 'Plot')}</h2>
    <dl class="kv">
      <dt>Status</dt><dd>${esc(s.status)}${s.issuanceId ? ' · issued as ' + esc(s.issuanceId) : ''}</dd>
      <dt>Farmer key</dt><dd class="mono">${esc(s.farmerKey)}</dd>
      <dt>Area</dt><dd>${s.areaHa} ha</dd>
      <dt>Planted</dt><dd>${s.trees} trees</dd>
      <dt>Survival sample</dt><dd>${s.alive} alive of ${s.sample} counted</dd>
      <dt>Project</dt><dd class="mono">${esc(s.projectId || 'unregistered')}</dd>
      <dt>Verified activity</dt><dd>${s.activityUnits ?? '—'} tree-years</dd>
      <dt>Estimated credits</dt><dd><b>${s.units}</b> tCO₂e (rounded down)</dd>
      <dt>Methodology</dt><dd>${esc(s.methodology || '—')}${s.methodologyVersion ? ' (v' + s.methodologyVersion + ')' : ''}</dd>
      <dt>Baseline</dt><dd class="mono">${esc(s.baselineId || '—')}</dd>
      <dt>Payout to</dt><dd>${esc(s.payoutTo || 'none')}</dd>
      <dt>Submission</dt><dd class="mono">${esc(s.subId)}</dd>
    </dl>
    <h2 style="margin-top:12px">Automatic checks</h2>${issues}
    ${s.overlaps.length ? `<div class="flag">Overlaps with: ${s.overlaps.map((o) => esc(o.plotKey.split(':')[0]) + ' (' + Math.round(o.fraction * 100) + '%)').join(', ')}</div>` : ''}
    <h2 style="margin-top:12px">Fire check</h2>
    <div id="fire-box">${fireHtml(s)}</div>
    ${s.status === 'pending' ? '<button id="fire-recheck" class="quiet">Recheck recent fires</button>' : ''}
    ${s.status === 'pending' ? `
      <label style="margin-top:12px">Verifier note ${s.flags.length ? '(required to approve a flagged submission)' : '(optional)'}
        <textarea id="note" rows="3" maxlength="500" placeholder="What did you check? e.g. visited the plot, counted trees, compared with photo"></textarea>
      </label>
      <div class="row"><button id="approve" class="primary">Sign and approve</button><button id="reject" class="danger">Sign and reject</button></div>
      <p class="muted small">Your decision is signed with this browser's verifier key. A farmer cannot verify their own submission.</p>`
    : d ? `<h2 style="margin-top:12px">Signed decision</h2>
      <dl class="kv"><dt>By</dt><dd>${esc(d.by)}</dd><dt>Decision</dt><dd>${esc(d.decision)}</dd><dt>Note</dt><dd>${esc(d.note || 'none')}</dd><dt>Time</dt><dd>${esc(when(d.ts))}</dd><dt>Fire check</dt><dd>${d.fire ? esc(d.fire.status === 'ok' ? `${d.fire.count} detection(s), nearest ${d.fire.nearestKm ?? '—'} km, checked ${when(d.fire.checkedAt)}` : `unavailable (${d.fire.error || 'no result'})`) : 'not checked'}</dd><dt>Signature</dt><dd class="mono">${esc(d.sig)}</dd></dl>` : ''}`;
  $('#approve')?.addEventListener('click', () => decide(s, 'approve'));
  $('#reject')?.addEventListener('click', () => decide(s, 'reject'));
  $('#fire-recheck')?.addEventListener('click', () => loadFire(true));
}
async function decide(s, decision) {
  const body = { subId: s.subId, decision, note: ($('#note').value || '').trim().slice(0, 500), verifierId: $('#vid').value.trim(), ts: new Date().toISOString() };
  // What the verifier saw about fires is signed into the decision, so it cannot be added later.
  const ev = fires.get(s.subId)?.evidence;
  if (ev) body.fire = ev;
  const { sig } = await C.signBody(body, V.keys.priv);
  const r = await api('decide', { method: 'POST', body: { ...body, sig } });
  if (!r.ok) return fail(r);
  toast(decision === 'approve' ? `Approved. ${r.json.issuance ? r.json.issuance.units + ' tCO₂e credits issued (' + r.json.issuance.serialFrom + ' to ' + r.json.issuance.serialTo + ')' : ''}` : 'Rejected');
  loadAll();
}

// ---------- market ----------
async function renderMarket() {
  const r = await api('market');
  if (!r.ok) return;
  const m = r.json;
  $('#mk-sum').innerHTML = `Price <b>${naira(m.priceKobo)}</b> per tCO₂e credit (demo price) · <b>${m.available}</b> credits available · ${esc(m.methodology)}<br><span class="small">${esc(m.status)}; 1 credit = 1 tCO₂e. ${m.kgCO2ePerTreeYear} kg CO₂e per verified tree-year is a demo factor.</span>`;
  $('#lots').innerHTML = m.lots.length
    ? m.lots.map((l) => {
        const auth = l.authorization;
        const note = [
          l.bufferUnits ? l.bufferUnits + ' held in buffer' : null,
          l.reversedUnits ? l.reversedUnits + ' reversed' : null,
          l.projectId ? 'project ' + l.projectId : 'unregistered project',
          l.vintage ? 'vintage ' + l.vintage : null,
          auth ? (auth.scope === 'international' ? 'Article 6: international' : 'Article 6: domestic') + ' · ' + auth.reference : null,
        ].filter(Boolean).join(' · ');
        return `<div class="item"><span>${esc(l.id)} · ${esc(l.farmName || 'Plot')}<br><span class="sub mono">${esc(l.serialFrom)} → ${esc(l.serialTo)}</span>${note ? `<br><span class="sub">${esc(note)}</span>` : ''}</span>
          <span style="display:flex;gap:6px;align-items:center">${auth ? `<span class="badge ${auth.scope === 'international' ? 'ok' : 'good'}">${esc(auth.scope)}</span>` : ''}<span class="badge ${l.remaining ? 'good' : ''}">${l.remaining}/${l.units} left</span>${l.remaining && !auth ? `<button data-auth="${esc(l.id)}">Article 6</button>` : ''}</span></div>`;
      }).join('')
    : '<div class="muted">Nothing issued yet. A verifier must approve a submission first.</div>';
  $$('[data-auth]').forEach((b) => b.addEventListener('click', async () => {
    const authority = prompt('Authorising authority (e.g. NCCC):', 'NCCC');
    if (!authority) return;
    const reference = prompt('Authorisation reference:', 'NG-A6-');
    if (!reference) return;
    const scope = confirm('International transfer with a corresponding adjustment?\n\nCancel records a domestic claim instead.') ? 'international' : 'domestic';
    const rr = await api('authorize', { method: 'POST', body: { issuanceId: b.dataset.auth, scope, authority, reference, correspondingAdjustment: scope === 'international' } });
    rr.ok ? (toast('Authorisation recorded'), renderMarket()) : fail(rr);
  }));
  $('#orders').innerHTML = m.orders.length
    ? [...m.orders].reverse().map((o) => `<div class="item"><span>${esc(o.orderId)} · ${esc(o.buyer)} · ${o.units} tCO₂e · ${naira(o.totalKobo)}<br><span class="sub mono">${esc(o.serialFrom)} → ${esc(o.serialTo)}</span><br><span class="sub">Farmers ${naira(o.split.farmers)} · community ${naira(o.split.community)} · verifier ${naira(o.split.verifier)} · platform ${naira(o.split.platform)}</span></span>${o.retired ? `<button data-cert="${esc(o.orderId)}">Certificate</button>` : `<button data-retire="${esc(o.orderId)}">Retire</button>`}</div>`).join('')
    : '<div class="muted">No orders yet.</div>';
  $$('[data-retire]').forEach((b) => b.addEventListener('click', async () => {
    const who = prompt('Retire these credits on behalf of:', $('#buyer').value);
    if (!who) return;
    const rr = await api('retire', { method: 'POST', body: { orderId: b.dataset.retire, beneficiary: who, reason: 'Voluntary claim (demo)' } });
    rr.ok ? (toast('Retired. Units can no longer be sold or claimed again.'), showCert(rr.json.certificate), renderMarket()) : fail(rr);
  }));
  $$('[data-cert]').forEach((b) => b.addEventListener('click', async () => {
    const rr = await fetch('api/registry/certificate/' + b.dataset.cert);
    if (rr.ok) showCert(await rr.json());
  }));
}
function showCert(c) {
  $('#cert-body').innerHTML = `<h2>${esc(c.title)}</h2>
    <dl class="kv"><dt>Order</dt><dd>${esc(c.orderId)}</dd><dt>Retired for</dt><dd>${esc(c.retiredFor)}</dd><dt>Credits</dt><dd>${c.units} tCO₂e</dd><dt>Project</dt><dd class="mono">${esc(c.projectIds?.join(', ') || 'unregistered')}</dd><dt>Vintage</dt><dd>${esc(c.vintages?.join(', ') || '—')}</dd><dt>Claim</dt><dd>${esc(c.claim?.statement || '—')}<br><span class="small">${esc(c.claim?.limits || '')}</span></dd><dt>Serials</dt><dd class="mono">${esc(c.serialFrom)} → ${esc(c.serialTo)}</dd><dt>Retired</dt><dd>${esc(when(c.retiredAt))}</dd><dt>Methodology</dt><dd>${esc(c.methodology)}${c.methodologyVersion ? ' (v' + c.methodologyVersion + ')' : ''}</dd><dt>Baseline</dt><dd class="mono">${esc(c.baselineId || '—')}</dd><dt>Article 6</dt><dd>${c.article6?.international ? 'International transfer, corresponding adjustment applied' : 'No international transfer'}${c.article6?.authorities?.length ? ' · ' + esc(c.article6.authorities.join(', ')) : ''}</dd><dt>Log position</dt><dd class="mono">#${c.logHead.seq} ${esc(c.logHead.hash)}</dd></dl>`;
  $('#cert').showModal();
}
$('#cert-close').addEventListener('click', () => $('#cert').close());
$('#buy').addEventListener('click', async () => {
  const r = await api('order', { method: 'POST', body: { buyer: $('#buyer').value.trim(), units: Number($('#units').value), key: crypto.randomUUID() } });
  if (!r.ok) { fail(r); return; }
  $('#mk-msg').innerHTML = `<div class="result">Order ${esc(r.json.order.orderId)}: ${r.json.order.units} tCO₂e for ${naira(r.json.order.totalKobo)}. Payments were split and sent to the sandbox.</div>`;
  loadAll();
});
$('#check-serial').addEventListener('click', async () => {
  const serial = $('#serial').value.trim().toUpperCase();
  const box = $('#serial-out');
  if (!serial) { box.innerHTML = ''; return; }
  const r = await fetch('api/registry/serial/' + encodeURIComponent(serial));
  if (!r.ok) { box.innerHTML = '<div class="bad-t">Not issued by this registry. Check the serial.</div>'; return; }
  const d = await r.json();
  const tone = { available: 'good', sold: 'ok', buffer: 'ok', cancelled: 'bad' }[d.status] || '';
  box.innerHTML = `<div class="item"><span><b class="mono">${esc(d.serial)}</b> · 1 tCO₂e<br><span class="sub">Project ${esc(d.projectId || 'unregistered')} · vintage ${esc(d.vintage || '—')} · ${esc(d.methodology || '—')}</span>${d.sale ? `<span class="sub">Sold on ${esc(d.sale.orderId)}${d.sale.retired ? ' · retired for ' + esc(d.sale.retired.by) : ''}</span>` : ''}${d.cancellation ? `<span class="sub">Cancelled: ${esc(d.cancellation.reason)}</span>` : ''}${d.buffer ? '<span class="sub">Held in the buffer, not for sale.</span>' : ''}</span><span class="badge ${tone}">${esc(d.status)}</span></div>`;
});

// ---------- money ----------
async function renderMoney() {
  const r = await fetch('api/registry/reconcile').then((x) => x.json());
  const row = (k, v) => `<div class="recon-row"><span>${k}</span><b>${v}</b></div>`;
  $('#recon').innerHTML =
    row('Money received from buyers', naira(r.inKobo)) + row('Paid to farmers (sandbox)', naira(r.paidToFarmersKobo)) +
    row('Held for farmers', naira(r.heldKobo)) + row('Community pool', naira(r.communityKobo)) + row('Verifier fees', naira(r.verifierKobo)) +
    row('Platform', naira(r.platformKobo)) + row('Books balance', r.balanced ? '<span class="ok-t">PASS: in = out + held</span>' : '<span class="bad-t">FAIL</span>') +
    row('Credits issued (tCO₂e)', r.unitsIssued) + row('Sold / available / buffer / reversed', `${r.unitsSold} / ${r.unitsAvailable} / ${r.unitsBuffered} / ${r.unitsReversed}`) +
    row('Units balance', r.unitsBalanced ? '<span class="ok-t">PASS: issued = sold + available + buffer + reversed</span>' : '<span class="bad-t">FAIL</span>') +
    row('Serial numbers contiguous, none reused', r.serialsContiguous ? '<span class="ok-t">PASS</span>' : '<span class="bad-t">FAIL</span>');
  const keys = [...new Set(subs.map((s) => s.farmerKey))];
  const views = await Promise.all(keys.map((k) => fetch('api/registry/farmer/' + k).then((x) => x.json())));
  $('#farmers').innerHTML = views.length
    ? views.map((v) => `<div class="item"><span><span class="mono">${esc(v.farmerKey)}</span> · ${esc(v.payoutTo || 'no number')}<br><span class="sub">Paid ${naira(v.paidKobo)} · held ${naira(v.heldKobo)}${v.cooldownUntil ? ' · number cooling until ' + esc(when(v.cooldownUntil)) : ''}</span>${v.payouts.filter((p) => p.status === 'held').map((p) => `<div class="flag">${naira(p.amountKobo)} held: ${esc(p.reason)}</div>`).join('')}</span>${v.heldKobo ? `<button data-release="${esc(v.farmerKey)}">Release held</button>` : ''}</div>`).join('')
    : '<div class="muted">No farmers yet.</div>';
  $$('[data-release]').forEach((b) => b.addEventListener('click', async () => {
    const rr = await api('release', { method: 'POST', body: { fp: b.dataset.release } });
    rr.ok ? (toast(`Released ${naira(rr.json.released)}`), loadAll()) : fail(rr);
  }));
}

// ---------- public log, checked here ----------
async function renderLog() {
  const log = await fetch('api/registry/log').then((x) => x.json());
  const mine = await C.verifyChainAsync(log.entries);
  $('#logcheck').innerHTML = `${mine.ok ? '<span class="ok-t">PASS</span> Every entry links to the one before it and every hash recomputes here' : `<span class="bad-t">FAIL</span> ${esc(mine.reason)} at entry ${mine.at}`}<br>
    <span class="muted small">${log.entries.length} entries · head <span class="mono">${esc(log.head.hash)}</span><br>Publish this head somewhere public (a tweet, a Solana memo) and no one can quietly rewrite history behind it.</span>`;
  $('#loglist').innerHTML = [...log.entries].reverse().slice(0, 80).map((e) => `<div class="item"><span>#${e.seq} · ${esc(e.type)}<br><span class="sub mono">${esc(e.hash.slice(0, 24))}…</span></span><span class="sub">${esc(when(e.ts))}</span></div>`).join('') || '<div class="muted">The log is empty.</div>';
}

async function loadAll() {
  const r = await api('submissions');
  subs = r.ok ? r.json.submissions : [];
  if (!r.ok && r.status === 401) toast('Enter the operator token to see submissions');
  if (selected && !subs.find((s) => s.subId === selected)) selected = null;
  renderQueue(); drawMap(); renderDetail();
  await renderMarket(); await renderMoney();
  if ($('#p-log').classList.contains('active')) renderLog();
}

(async () => { await loadVerifier(); initMap(); await loadAll(); })().catch((e) => { console.error(e); toast('Console problem: ' + e.message); });
