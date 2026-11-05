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
function initMap() {
  if (typeof L === 'undefined') { $('#cmap').innerHTML = '<div class="nomap">Map library did not load.</div>'; return; }
  map = L.map('cmap').setView([9.9, 8.9], 13);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
  layer = L.layerGroup().addTo(map);
}
const colour = { pending: '#f5a524', approved: '#34d399', rejected: '#f87171' };
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
    ? subs.map((s) => `<button class="item ${selected === s.subId ? 'sel' : ''}" data-id="${esc(s.subId)}"><span>${esc(s.farmName || 'Plot')} · ${s.units} tree-years<br><span class="sub">farmer ${esc(s.farmerKey)} · ${esc(when(s.receivedAt))}${s.flags.length || s.hard.length ? ' · ' + (s.flags.length + s.hard.length) + ' flag(s)' : ''}</span></span><span class="badge ${s.status === 'approved' ? 'good' : s.status === 'pending' ? 'ok' : 'bad'}">${s.status}</span></button>`).join('')
    : '<div class="muted">No submissions yet, or the operator token is missing.</div>';
  $$('#queue [data-id]').forEach((b) => b.addEventListener('click', () => select(b.dataset.id)));
}
function select(id) { selected = id; renderQueue(); drawMap(); renderDetail(); }

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
      <dt>Estimated verified</dt><dd><b>${s.units}</b> tree-years</dd>
      <dt>Payout to</dt><dd>${esc(s.payoutTo || 'none')}</dd>
      <dt>Submission</dt><dd class="mono">${esc(s.subId)}</dd>
    </dl>
    <h2 style="margin-top:12px">Automatic checks</h2>${issues}
    ${s.overlaps.length ? `<div class="flag">Overlaps with: ${s.overlaps.map((o) => esc(o.plotKey.split(':')[0]) + ' (' + Math.round(o.fraction * 100) + '%)').join(', ')}</div>` : ''}
    ${s.status === 'pending' ? `
      <label style="margin-top:12px">Verifier note ${s.flags.length ? '(required to approve a flagged submission)' : '(optional)'}
        <textarea id="note" rows="3" maxlength="500" placeholder="What did you check? e.g. visited the plot, counted trees, compared with photo"></textarea>
      </label>
      <div class="row"><button id="approve" class="primary">Sign and approve</button><button id="reject" class="danger">Sign and reject</button></div>
      <p class="muted small">Your decision is signed with this browser's verifier key. A farmer cannot verify their own submission.</p>`
    : d ? `<h2 style="margin-top:12px">Signed decision</h2>
      <dl class="kv"><dt>By</dt><dd>${esc(d.by)}</dd><dt>Decision</dt><dd>${esc(d.decision)}</dd><dt>Note</dt><dd>${esc(d.note || 'none')}</dd><dt>Time</dt><dd>${esc(when(d.ts))}</dd><dt>Signature</dt><dd class="mono">${esc(d.sig)}</dd></dl>` : ''}`;
  $('#approve')?.addEventListener('click', () => decide(s, 'approve'));
  $('#reject')?.addEventListener('click', () => decide(s, 'reject'));
}
async function decide(s, decision) {
  const body = { subId: s.subId, decision, note: ($('#note').value || '').trim().slice(0, 500), verifierId: $('#vid').value.trim(), ts: new Date().toISOString() };
  const { sig } = await C.signBody(body, V.keys.priv);
  const r = await api('decide', { method: 'POST', body: { ...body, sig } });
  if (!r.ok) return fail(r);
  toast(decision === 'approve' ? `Approved. ${r.json.issuance ? r.json.issuance.units + ' units issued (' + r.json.issuance.serialFrom + ' to ' + r.json.issuance.serialTo + ')' : ''}` : 'Rejected');
  loadAll();
}

// ---------- market ----------
async function renderMarket() {
  const r = await api('market');
  if (!r.ok) return;
  const m = r.json;
  $('#mk-sum').innerHTML = `Price <b>${naira(m.priceKobo)}</b> per verified tree-year (demo price) · <b>${m.available}</b> units available · ${esc(m.methodology)}<br><span class="small">${esc(m.status)}; ${m.kgCO2ePerUnit} kg CO₂e per unit is a placeholder.</span>`;
  $('#lots').innerHTML = m.lots.length
    ? m.lots.map((l) => `<div class="item"><span>${esc(l.id)} · ${esc(l.farmName || 'Plot')}<br><span class="sub mono">${esc(l.serialFrom)} → ${esc(l.serialTo)}</span></span><span class="badge ${l.remaining ? 'good' : ''}">${l.remaining}/${l.units} left</span></div>`).join('')
    : '<div class="muted">Nothing issued yet. A verifier must approve a submission first.</div>';
  $('#orders').innerHTML = m.orders.length
    ? [...m.orders].reverse().map((o) => `<div class="item"><span>${esc(o.orderId)} · ${esc(o.buyer)} · ${o.units} units · ${naira(o.totalKobo)}<br><span class="sub mono">${esc(o.serialFrom)} → ${esc(o.serialTo)}</span><br><span class="sub">Farmers ${naira(o.split.farmers)} · community ${naira(o.split.community)} · verifier ${naira(o.split.verifier)} · platform ${naira(o.split.platform)}</span></span>${o.retired ? `<button data-cert="${esc(o.orderId)}">Certificate</button>` : `<button data-retire="${esc(o.orderId)}">Retire</button>`}</div>`).join('')
    : '<div class="muted">No orders yet.</div>';
  $$('[data-retire]').forEach((b) => b.addEventListener('click', async () => {
    const who = prompt('Retire these units on behalf of:', $('#buyer').value);
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
    <dl class="kv"><dt>Order</dt><dd>${esc(c.orderId)}</dd><dt>Retired for</dt><dd>${esc(c.retiredFor)}</dd><dt>Units</dt><dd>${c.units} ${esc(c.unit)}</dd><dt>Demo tCO₂e</dt><dd>${c.tCO2eDemo} (placeholder factor)</dd><dt>Serials</dt><dd class="mono">${esc(c.serialFrom)} → ${esc(c.serialTo)}</dd><dt>Retired</dt><dd>${esc(when(c.retiredAt))}</dd><dt>Methodology</dt><dd>${esc(c.methodology)}</dd><dt>Log position</dt><dd class="mono">#${c.logHead.seq} ${esc(c.logHead.hash)}</dd></dl>`;
  $('#cert').showModal();
}
$('#cert-close').addEventListener('click', () => $('#cert').close());
$('#buy').addEventListener('click', async () => {
  const r = await api('order', { method: 'POST', body: { buyer: $('#buyer').value.trim(), units: Number($('#units').value), key: crypto.randomUUID() } });
  if (!r.ok) { fail(r); return; }
  $('#mk-msg').innerHTML = `<div class="result">Order ${esc(r.json.order.orderId)}: ${r.json.order.units} units for ${naira(r.json.order.totalKobo)}. Payments were split and sent to the sandbox.</div>`;
  loadAll();
});

// ---------- money ----------
async function renderMoney() {
  const r = await fetch('api/registry/reconcile').then((x) => x.json());
  const row = (k, v) => `<div class="recon-row"><span>${k}</span><b>${v}</b></div>`;
  $('#recon').innerHTML =
    row('Money received from buyers', naira(r.inKobo)) + row('Paid to farmers (sandbox)', naira(r.paidToFarmersKobo)) +
    row('Held for farmers', naira(r.heldKobo)) + row('Community pool', naira(r.communityKobo)) + row('Verifier fees', naira(r.verifierKobo)) +
    row('Platform', naira(r.platformKobo)) + row('Books balance', r.balanced ? '<span class="ok-t">PASS: in = out + held</span>' : '<span class="bad-t">FAIL</span>') +
    row('Units issued / sold / available', `${r.unitsIssued} / ${r.unitsSold} / ${r.unitsAvailable}`) + row('Serial numbers contiguous, none reused', r.serialsContiguous ? '<span class="ok-t">PASS</span>' : '<span class="bad-t">FAIL</span>');
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
