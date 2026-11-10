// scripts/vercel-stage.mjs — stage exactly what Vercel's static layer serves.
//
// The repo root is a mixed bag (server code, local state, function entry) and
// only a whitelist is fit for the public web root, so this copies each static
// file into `outputDirectory` (public/) explicitly. The list is checked with
// existsSync rather than git ls-files: CLI deploys upload files without .git,
// and a build must not depend on repository plumbing being present.

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const OUT = join(ROOT, 'public');

const FILES = [
  // app shell + pages
  'index.html', 'site.css',
  'app.html', 'app.js', 'style.css', 'core.js',
  'console.html', 'console.js', 'console.css',
  'pitch-deck.html', 'pitch-deck.js',
  'explainer.html', 'explainer.js',
  'sw.js', 'sw-update.js',
  'manifest.webmanifest', 'icon.svg',
];

const EXTRA = [
  // decorative assets (tracked; never local-only material like working notes)
  'assets/leaf-pattern.svg',
  'assets/monstera/leaf-dark.png',
  'assets/monstera/leaf-mist.png',
  'assets/monstera/leaf.png',
  'assets/monstera/pattern-dark.jpg',
  'assets/monstera/pattern-mist.jpg',
  'assets/monstera/pattern.jpg',
  // vendored third-party clients
  'vendor/leaflet/LICENSE',
  'vendor/leaflet/leaflet-heat.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/leaflet.js',
  'vendor/neon-realtime-client.js',
];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let n = 0;
for (const rel of [...FILES, ...EXTRA]) {
  if (!existsSync(join(ROOT, rel))) throw new Error(`staging: missing file ${rel} — the deploy would eat a 404`);
  mkdirSync(join(OUT, rel, '..'), { recursive: true });
  cpSync(join(ROOT, rel), join(OUT, rel));
  n++;
}

console.log(`staged ${n} files into public/`);
