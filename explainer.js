// Plotline explainer engine — drives scene timing, the always-on captions and
// the per-scene anims of explainer.html. External file: the site CSP is
// script-src 'self', inline scripts are blocked (learned on pitch-deck).
'use strict';

const SCENES = [
  { dur: 25, caps: [
    [1, 7, 'Imagine a farmer who plants eight hundred trees.'],
    [7, 14, "She waters them, protects them, and keeps them alive through the dry season."],
    [14, 21, 'And when someone asks her to prove it, she has nothing. No record anyone will trust. No way to be paid for what she did.'],
    [21, 25, 'This is Plotline — and this is how it works, from the first tree to the final payment.'],
  ] },
  { dur: 35, caps: [
    [0, 8, 'Trees store carbon, and Nigeria is building a carbon market around that fact.'],
    [8, 15, 'But most of the planting is done by smallholder farmers, and proving their work is hard.'],
    [15, 22, 'Audits are costly. Paperwork is slow. Many tracking tools charge for every record.'],
    [22, 29, 'So proof can cost more than the payment it unlocks — and the farmers who do the work are left out.'],
    [29, 35, 'Buyers have the opposite problem: they cannot easily tell a real claim from a fake one.'],
  ] },
  { dur: 40, caps: [
    [0, 8, 'Amina starts by walking the edge of her plot with her phone.'],
    [8, 16, 'The app drops a point at each corner, and measures the area and the perimeter.'],
    [16, 24, "It works with no signal at all — it runs in the phone's browser and stores everything on the device."],
    [24, 32, 'Each point also gets a quality score, so a weak GPS reading is flagged instead of trusted.'],
    [32, 40, 'Amina is illustrative — a stand-in for thousands of real smallholders.'],
  ] },
  { dur: 35, caps: [
    [0, 8, 'At planting, she records how many trees went in the ground.'],
    [8, 16, 'Later she walks the plot, counts a sample of the trees, and records how many are alive.'],
    [16, 22, 'In this example: seventy out of eighty.'],
    [22, 35, 'The registry uses that sample to estimate how many of her eight hundred trees survived.'],
  ] },
  { dur: 35, caps: [
    [0, 10, 'Every record is signed with a key that lives on her phone — nobody can later claim she said something she did not.'],
    [10, 18, 'The records are grouped, and only a short fingerprint goes to a public log.'],
    [18, 27, 'Her data stays with her; the log can prove a record existed, unchanged, without revealing what is in it.'],
    [27, 35, 'There is no fee, and no crypto wallet to set up.'],
  ] },
  { dur: 40, caps: [
    [0, 8, 'When she submits, the registry re-checks every signature and runs automatic tests.'],
    [8, 18, 'Does this plot overlap one that is already registered? Is the tree count plausible for the area? Was the GPS reading weak?'],
    [18, 22, 'Doubtful cases are flagged.'],
    [22, 33, 'Then an independent verifier reviews the evidence, writes a note for anything flagged, and signs the approval or rejection.'],
    [33, 40, 'That signature is stored — and a farmer can never verify her own submission.'],
  ] },
  { dur: 30, caps: [
    [0, 8, 'Approval issues units with unique serial numbers, so the same tree-year can never be counted twice.'],
    [8, 18, 'A buyer purchases units, and the money splits by published rules: farmers, a community pool, the verifier, and the platform.'],
    [18, 25, 'Amina is paid straight to her mobile-money number, under strict fraud rules: one payout number per farmer, a hold after any change, and a cap on the first payout.'],
    [25, 30, 'In this prototype, payments are simulated in a sandbox.'],
  ] },
  { dur: 30, caps: [
    [0, 7, 'Here is why a buyer, a regulator or a funder can trust it without trusting me.'],
    [7, 14, 'Every change in the registry is an entry on a log, and each entry depends on the one before it.'],
    [14, 23, 'Anyone can download that log and check it in their own browser. Change one past entry and the chain breaks at exactly that point.'],
    [23, 30, 'The books must also balance to the kobo: money in equals money paid, held and shared.'],
  ] },
  { dur: 20, caps: [
    [0, 8, 'Nigeria is setting up a carbon market office, verification requirements, and a carbon tax pilot in 2029.'],
    [8, 14, 'All of that needs trusted evidence from the ground — and smallholders are where much of that ground is.'],
    [14, 18, 'Plotline makes their work provable: free for the farmer, cheap for the verifier, auditable for the buyer.'],
    [18, 20, 'Next: photo checks with a specialised vision model, and satellite vegetation data.'],
  ] },
  { dur: 10, caps: [
    [0, 10, 'Farmers already do the work. Plotline makes it count.'],
  ] },
];

// Progress-driven per-scene effects: fn(p) with p = 0..1 between `at` and
// `at+for`. Progress-driven (not wall-clock) so pause/jump/fast-forward all stay in sync.
const FX = {
  2: [
    { at: 8, for: 4, fn: (p) => {
      document.getElementById('area-val').textContent = (0.561 * p).toFixed(2);
      document.getElementById('peri-val').textContent = Math.round(352 * p);
    } },
  ],
  6: [
    { at: 8, for: 0, fn: () => document.querySelectorAll('.bar > i[data-go]').forEach((b) => b.classList.add('go')) },
  ],
};

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const speed = Math.max(0.5, Number(params.get('speed')) || 1);
const TOTAL = SCENES.reduce((a, s) => a + s.dur, 0);

const scenes = [...document.querySelectorAll('.scene')];
let i = 0, tScene = 0, playing = true, lastTs = null, everStarted = false;

// build chapter buttons + dots
const chaptersBox = $('chapters'), dotsBox = $('dots');
SCENES.forEach((_, n) => {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = n + 1; b.addEventListener('click', () => goto(n));
  chaptersBox.append(b);
  const d = document.createElement('i');
  d.addEventListener('click', () => goto(n));
  dotsBox.append(d);
});

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function setCaption(time) {
  const cap = $('cap');
  const line = SCENES[i].caps.find(([a, b]) => time >= a && time < b);
  const text = line ? line[2] : '';
  if (cap.textContent !== text) cap.textContent = text || '\u00a0';
}

function refreshChrome() {
  const before = SCENES.slice(0, i).reduce((a, s) => a + s.dur, 0);
  $('progress').style.width = (100 * (before + tScene) / TOTAL) + '%';
  $('clock').textContent = `${fmt(before + tScene)} / ${fmt(TOTAL)}`;
  [...chaptersBox.children].forEach((b, n) => b.classList.toggle('on', n === i));
  [...dotsBox.children].forEach((d, n) => d.classList.toggle('on', n === i));
}

function runFx() {
  (FX[i] || []).forEach((fx, k) => {
    const key = `${i}:${k}`;
    if (fxDone.has(key)) return;
    if (tScene >= fx.at) {
      fxDone.add(key);
      if (fx.for > 0 && tScene < fx.at + fx.for) return void fxPend.set(key, fx); // animating
      fx.fn(fx.for > 0 ? 1 : 0);
    }
  });
  // drive resolving fx animations from scene time
  fxPend.forEach((fx, key) => {
    const p = Math.min(1, Math.max(0, (tScene - fx.at) / fx.for));
    fx.fn(p);
    if (p >= 1) { fx.fn(1); fxPend.delete(key); }
  });
}
const fxDone = new Set(), fxPend = new Map();

function enter(n, keepT = 0) {
  i = Math.max(0, Math.min(SCENES.length - 1, n));
  tScene = Math.min(keepT, SCENES[i].dur);
  fxDone.clear(); fxPend.clear();
  scenes.forEach((s, k) => {
    const on = k === i;
    if (on && !s.classList.contains('on')) { void s.offsetWidth; } // reflow so CSS animations replay
    s.classList.toggle('on', on);
  });
  setCaption(tScene);
  refreshChrome();
}

function goto(n, t = 0) { enter(n, t); }

let dimTimer = null;
function wakeHud() {
  $('controls').classList.remove('dimmed');
  $('chapters').classList.remove('dimmed');
  clearTimeout(dimTimer);
  dimTimer = setTimeout(() => {
    if (clean) document.querySelector('.chapters').classList.add('dimmed');
    $('controls').classList.add('dimmed');
    $('chapters').classList.add('dimmed');
  }, 2600);
}

const clean = params.get('clean') === '1';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>';
function togglePlay() {
  playing = !playing;
  const b = $('b-play');
  b.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

function loop(ts) {
  if (lastTs === null) lastTs = ts;
  const dt = Math.min(0.1, (ts - lastTs) / 1000) * speed; // guard a big tab-switch gap
  lastTs = ts;
  if (playing) {
    tScene += dt;
    setCaption(tScene);
    runFx();
    refreshChrome();
    if (tScene >= SCENES[i].dur) {
      if (i < SCENES.length - 1) enter(i + 1);
      else { playing = false; $('b-play').innerHTML = ICON_PLAY; $('b-play').setAttribute('aria-label', 'Play'); }
    }
  }
  requestAnimationFrame(loop);
}

addEventListener('keydown', (e) => {
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  if (e.key === 'ArrowRight') goto(i + 1);
  if (e.key === 'ArrowLeft') goto(i - 1);
  if (e.key === 'f') document.documentElement.requestFullscreen?.();
  if (e.key === 'c') { document.querySelector('.chapters').classList.add('dimmed'); $('controls').classList.add('dimmed'); }
});

$('b-play').addEventListener('click', togglePlay);
$('b-prev').addEventListener('click', () => goto(i - 1));
$('b-next').addEventListener('click', () => goto(i + 1));
$('b-fs').addEventListener('click', () => document.documentElement.requestFullscreen?.());
document.addEventListener('mousemove', () => { if (everStarted) wakeHud(); });

window.PL = {
  idx: () => i,
  t: () => tScene,
  goto,
  paused: () => !playing,
  toggle: togglePlay,
};

start(); function start() {
  const from = Math.max(1, Number(params.get('scene')) || 1);
  enter(from - 1, Number(params.get('t')) || 0);
  everStarted = true;
  wakeHud();
  requestAnimationFrame(loop);
}
