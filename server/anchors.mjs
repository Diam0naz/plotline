// anchors.mjs — a record of when the ledger head was published to an external,
// operator-uneditable surface (a Solana memo), and the public check that the
// current ledger still contains every head that was anchored there.
//
// WHY: the ledger (ledger.mjs) is hash-chained, so it is tamper-EVIDENT: altering
// any past entry breaks every entry after it. But while the operator holds the only
// copy, they could in principle rebuild a different chain. Publishing the head hash
// somewhere they cannot edit — and REMEMBERING what was published — turns that into
// tamper-PROOF: anyone can confirm the live chain still carries the exact head that
// was anchored at that sequence. If it does not, the history was rewound.
//
// A receipt is a plain append record (no chaining needed): its integrity comes from
// the head hash it references, which already commits to the whole chain prefix.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * @typedef {Object} AnchorReceipt
 * @property {number} seq      - ledger sequence of the anchored head
 * @property {string} hash     - ledger head hash that was anchored
 * @property {'dry_run'|'live'} mode
 * @property {string} ts       - ISO timestamp the head was anchored
 * @property {string} [memo]   - the memo string published
 * @property {string|null} [signature] - Solana transaction signature (live only)
 * @property {string|null} [explorer]  - explorer URL for the transaction (live only)
 */

export class AnchorReceipts {
  constructor(file) {
    this.file = file;
    this.entries = [];
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      this.entries = readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
    }
  }

  /** Append one receipt and return it. */
  record(receipt) {
    const e = {
      seq: receipt.seq,
      hash: receipt.hash,
      mode: receipt.mode === 'live' ? 'live' : 'dry_run',
      ts: receipt.ts || new Date().toISOString(),
      memo: receipt.memo ?? null,
      signature: receipt.signature ?? null,
      explorer: receipt.explorer ?? null,
    };
    appendFileSync(this.file, JSON.stringify(e) + '\n');
    this.entries.push(e);
    return e;
  }

  list(limit = 100) {
    return this.entries.slice(-Math.max(0, limit));
  }

  last() {
    return this.entries[this.entries.length - 1] || null;
  }

  /** The most recent receipt that was actually submitted on-chain (not a dry run). */
  lastLive() {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].mode === 'live') return this.entries[i];
    }
    return null;
  }
}

/**
 * Check that every anchored head is still present, unchanged, in the live chain.
 *
 * @param {Array<{seq:number, hash:string}>} entries - the ledger entries (index i = seq i+1)
 * @param {AnchorReceipt[]} receipts
 * @returns {{ intact: boolean, checks: Array<object> }}
 */
export function verifyAnchors(entries, receipts) {
  const checks = receipts.map((r) => {
    const current = entries[r.seq - 1]?.hash ?? null;
    const present = current === r.hash;
    return {
      seq: r.seq,
      hash: r.hash,
      mode: r.mode,
      ts: r.ts,
      signature: r.signature ?? null,
      explorer: r.explorer ?? null,
      present,
      // When a previously-anchored head is missing or different, say what the
      // chain now holds at that sequence so the discrepancy is inspectable.
      currentHashAtSeq: current,
    };
  });
  return { intact: checks.every((c) => c.present), checks };
}
