// Generic append-only, hash-chained event log stored as JSON lines.
// Each entry commits to the previous one, so editing or removing any past entry is detectable.
// The registry rebuilds all of its state by replaying this log.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonical, CHAIN_ZERO } from '../core.js';

export const ZERO = CHAIN_ZERO;
const sha = (s) => createHash('sha256').update(s).digest('hex');

export const eventHash = (e) => sha(canonical({ seq: e.seq, ts: e.ts, type: e.type, data: e.data, prev: e.prev }));

export function verifyEvents(entries) {
  let prev = ZERO;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.seq !== i + 1) return { ok: false, at: e.seq, reason: 'sequence gap' };
    if (e.prev !== prev) return { ok: false, at: e.seq, reason: 'previous-hash mismatch' };
    if (eventHash(e) !== e.hash) return { ok: false, at: e.seq, reason: 'entry was altered' };
    prev = e.hash;
  }
  return { ok: true, length: entries.length, head: prev };
}

export class ChainLog {
  constructor(file) {
    this.file = file;
    this.entries = [];
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      this.entries = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
      const v = verifyEvents(this.entries);
      // Refuse to run on a damaged log rather than quietly continuing from it.
      if (!v.ok) throw new Error(`Registry log failed verification at entry ${v.at}: ${v.reason}`);
    }
  }

  head() {
    const last = this.entries[this.entries.length - 1];
    return last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: ZERO };
  }

  append(type, data, now = new Date()) {
    const h = this.head();
    // Round-trip through JSON so undefined values cannot make the hash differ after a reload.
    const e = { seq: h.seq + 1, ts: now.toISOString(), type, data: JSON.parse(JSON.stringify(data)), prev: h.hash };
    e.hash = eventHash(e);
    appendFileSync(this.file, JSON.stringify(e) + '\n');
    this.entries.push(e);
    return e;
  }

  list(from = 1, limit = 1000) {
    const start = Math.max(0, from - 1);
    return this.entries.slice(start, start + limit);
  }
}
