// scripts/vercel-stage.mjs — stage exactly what Vercel's static layer serves.
//
// The repo root is a mixed bag (server code, local state, function entry) and
// only a whitelist is fit for the public web root. This copies each tracked
// static file into `outputDirectory` (public/) — tracked-file enumeration via
// git ls-files keeps local-only material (the working notes in assets/) out of
// the deploy even when staging happens on a machine with uncommitted files.
// Shipped deliberately because nothing here is incidental.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const OUT = join(ROOT, 'public');

const FILES = [
  'index.html', 'site.css',
  'app.html', 'app.js', 'style.css', 'core.js',
  'console.html', 'console.js', 'console.css',
  'pitch-deck.html',
  'sw.js', 'sw-update.js',
  'manifest.webmanifest', 'icon.svg',
];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const tracked = (dir) => execFileSync('git', ['-C', ROOT, 'ls-files', dir], { encoding: 'utf8' })
  .split('\n').filter(Boolean);

mkdirSync(join(OUT, 'assets'), { recursive: true });
for (const rel of tracked('assets')) cpSync(join(ROOT, rel), join(OUT, rel));

mkdirSync(join(OUT, 'vendor'), { recursive: true });
for (const rel of tracked('vendor')) {
  mkdirSync(join(OUT, rel, '..'), { recursive: true });
  cpSync(join(ROOT, rel), join(OUT, rel));
}

for (const f of FILES) {
  mkdirSync(join(OUT, f, '..'), { recursive: true });
  cpSync(join(ROOT, f), join(OUT, f));
}

console.log(`staged ${FILES.length} files + tracked assets/ + tracked vendor/ into public/`);
