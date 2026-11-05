// Append-only, hash-chained ledger of batch roots.
//
// Each entry commits to the one before it (prev = previous entry's hash), so changing or removing any
// past entry breaks every entry after it. Anyone holding an old copy of the ledger head can prove the
// history was not rewritten. For permanence beyond this server, publish the head hash somewhere public
// (a blockchain memo, a newspaper, a social post): that is the step that makes it truly immutable.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonical } from '../core.js';

export const ZERO = '0'.repeat(64);
const sha = (s) => createHash('sha256').update(s).digest('hex');

export function entryHash(e) {
  return sha(canonical({ seq: e.seq, ts: e.ts, root: e.root, count: e.count, prev: e.prev }));
}

export function verifyChain(entries) {
  let prev = ZERO;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.seq !== i + 1) return { ok: false, at: e.seq, reason: 'sequence gap' };
    if (e.prev !== prev) return { ok: false, at: e.seq, reason: 'previous-hash mismatch' };
    if (entryHash(e) !== e.hash) return { ok: false, at: e.seq, reason: 'entry was altered' };
    prev = e.hash;
  }
  return { ok: true, length: entries.length, head: prev };
}

export class Ledger {
  constructor(file) {
    this.file = file;
    this.entries = [];
    this.byRoot = new Map();
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
      this.entries = lines.map((l) => JSON.parse(l));
      const v = verifyChain(this.entries);
      // Refuse to run on a damaged ledger rather than quietly continuing from it.
      if (!v.ok) throw new Error(`Ledger failed verification at entry ${v.at}: ${v.reason}`);
      for (const e of this.entries) this.byRoot.set(e.root, e);
    }
  }

  head() {
    const last = this.entries[this.entries.length - 1];
    return last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: ZERO };
  }

  find(root) {
    return this.byRoot.get(root) || null;
  }

  // Publishing the same root twice returns the original entry, so retries are safe.
  add(root, count, now = new Date()) {
    const existing = this.find(root);
    if (existing) return { entry: existing, created: false };
    const h = this.head();
    const e = { seq: h.seq + 1, ts: now.toISOString(), root, count, prev: h.hash };
    e.hash = entryHash(e);
    appendFileSync(this.file, JSON.stringify(e) + '\n');
    this.entries.push(e);
    this.byRoot.set(root, e);
    return { entry: e, created: true };
  }

  list(from = 1, limit = 500) {
    return this.entries.slice(Math.max(0, from - 1), Math.max(0, from - 1) + limit);
  }
}
