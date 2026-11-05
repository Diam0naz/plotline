// Money helpers. All amounts are integer kobo so splits always add up exactly.
import { createHash } from 'node:crypto';

// Split `total` across weighted keys with the largest-remainder method, using BigInt so large
// sales cannot overflow. The parts always sum to exactly `total`.
export function allocate(total, weights) {
  for (const w of weights) {
    if (!Number.isInteger(w.weight) || w.weight < 0) throw new Error('weights must be non-negative integers');
  }
  if (!Number.isInteger(total) || total < 0) throw new Error('total must be a non-negative integer');
  const T = BigInt(total);
  const W = weights.map((w) => BigInt(w.weight));
  const S = W.reduce((a, b) => a + b, 0n);
  const out = new Map();
  if (T === 0n || S === 0n) {
    weights.forEach((w) => out.set(w.key, 0));
    return out;
  }
  const parts = weights.map((w, i) => ({ key: w.key, i, base: (T * W[i]) / S, rem: (T * W[i]) % S }));
  let left = T - parts.reduce((a, p) => a + p.base, 0n);
  [...parts]
    .sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1))
    .forEach((p) => { if (left > 0n) { p.base += 1n; left -= 1n; } });
  parts.forEach((p) => out.set(p.key, Number(p.base)));
  return out;
}

export function splitKobo(total, sharesBps) {
  const m = allocate(total, Object.entries(sharesBps).map(([key, weight]) => ({ key, weight })));
  return Object.fromEntries(m);
}

// Nigerian mobile numbers: 0 or +234 or 234, then 10 digits starting 7, 8 or 9.
export function normalizeMsisdn(input) {
  const s = String(input ?? '').replace(/[\s\-().]/g, '');
  const m = s.match(/^(?:\+?234|0)([789]\d{9})$/);
  return m ? '+234' + m[1] : null;
}

export const maskMsisdn = (n) => (n ? n.slice(0, 7) + '•••••' + n.slice(-2) : null);

// SANDBOX stand-in for a mobile-money provider. It is idempotent: the same key always gives the
// same reference. A real integration needs a licensed payment partner.
export function mockMobileMoney({ msisdn, amountKobo, key }) {
  if (!msisdn || !(amountKobo > 0)) return { provider: 'SANDBOX', ref: null, status: 'skipped' };
  const ref = 'MM-' + createHash('sha256').update(key).digest('hex').slice(0, 12).toUpperCase();
  return { provider: 'SANDBOX', ref, status: 'success' };
}

export const naira = (kobo) => (kobo / 100).toLocaleString('en-NG', { style: 'currency', currency: 'NGN' });
