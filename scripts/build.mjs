// scripts/build.mjs — the honest "build" for a no-build app.
// There is no bundler to run: this validates that everything that would ship is
// well-formed (syntax, JSON, referenced assets), so a deploy fails here rather than
// on a farmer's phone. Exits non-zero on the first problem class it finds.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
let fail = 0;
const err = (msg) => { console.error(`✗ ${msg}`); fail = 1; };
const ok = (msg) => console.log(`✓ ${msg}`);

// 1. Every module and browser script must parse.
for (const f of [
  'server/server.mjs', 'server/registry.mjs', 'server/auth.mjs', 'server/ledger.mjs',
  'server/chainlog.mjs', 'server/cache.mjs', 'server/checks.mjs', 'server/fire.mjs',
  'server/ndvi.mjs', 'server/anchor-publish.mjs', 'server/methodology.mjs', 'server/payments.mjs',
  'server/pgstore.mjs', 'server/neonauth.mjs', 'server/realtime.mjs',
  'server/testkit.mjs', 'core.js', 'app.js', 'console.js', 'sw.js',
]) {
  try { execFileSync(process.execPath, ['--check', join(ROOT, f)], { stdio: 'pipe' }); }
  catch (e) { err(`${f}: ${String(e.stderr).slice(0, 200)}`); continue; }
  ok(`syntax ${f}`);
}

// 2. JSON assets parse.
for (const f of ['package.json', 'manifest.webmanifest']) {
  try { JSON.parse(readFileSync(join(ROOT, f), 'utf8')); ok(`json ${f}`); }
  catch (e) { err(`${f}: ${e.message}`); }
}

// 3. Every HTML file references only assets that exist (local href/src/script).
for (const f of ['index.html', 'app.html', 'console.html']) {
  const html = readFileSync(join(ROOT, f), 'utf8');
  const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1])
    .filter((u) => !/^(https?:|data:|#|mailto:)/.test(u));
  for (const ref of refs) {
    const path = ref.split('?')[0].replace(/^\//, '') + (ref.split('?')[0].endsWith('/') ? 'index.html' : '');
    try { readFileSync(join(ROOT, path)); }
    catch { err(`${f}: missing asset ${ref}`); continue; }
  }
  ok(`assets ${f} (${refs.length} references)`);
}

// 4. The service worker precache list must name only files that exist.
try {
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const names = [...sw.matchAll(/'([^']+\.(?:html|css|js|svg|json|webmanifest))'/g)].map((m) => m[1]);
  for (const n of names) {
    try { readFileSync(join(ROOT, n)); }
    catch { err(`sw.js precache lists missing file ${n}`); }
  }
  if (names.length) ok(`sw.js precache (${names.length} files verified)`);
  else ok('sw.js precache: list delegated');
} catch (e) { err(`sw.js: ${e.message}`); }

if (fail) { console.error('\nbuild failed'); process.exit(1); }
console.log('\nbuild passed');
