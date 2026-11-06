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

// ─────────────────────────────────────────────────────────────────────────────
// MOBILE-MONEY PROVIDER INTERFACE
// ─────────────────────────────────────────────────────────────────────────────
//
// To integrate a real Nigerian mobile-money provider (e.g. Flutterwave, Paystack
// Transfer, or a direct MNO USSD/API):
//
//  1. Implement the `MobileMoneyProvider` interface below.
//  2. Set the MOBILE_MONEY_PROVIDER environment variable to the provider name.
//  3. Supply credentials via environment variables (never hard-coded).
//  4. Replace the `sandboxProvider` export with `resolveProvider()`.
//
// The interface contract:
//   • `disburse` must be idempotent: the same `key` must always return the same
//     `ref` without charging twice (implement via idempotency key on the API).
//   • `status` values: 'success' | 'pending' | 'failed' | 'skipped'.
//   • `ref` is the provider transaction reference for reconciliation.
//   • All amounts are integer kobo (100 kobo = ₦1).
//
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} DisburseResult
 * @property {string} provider  - provider name, e.g. 'FLUTTERWAVE'
 * @property {string|null} ref  - provider transaction reference
 * @property {'success'|'pending'|'failed'|'skipped'} status
 * @property {string|null} [message] - human-readable error or note
 */

/**
 * @typedef {Object} MobileMoneyProvider
 * @property {string} name
 * @property {function({msisdn: string, amountKobo: number, key: string, currency?: string}): Promise<DisburseResult>} disburse
 */

// ── Sandbox provider (current default) ────────────────────────────────────
// Idempotent: the same key always gives the same reference.
// Replace this with a real provider for production.

/** @type {MobileMoneyProvider} */
const sandboxProvider = {
  name: 'SANDBOX',
  async disburse({ msisdn, amountKobo, key }) {
    if (!msisdn || !(amountKobo > 0)) {
      return { provider: 'SANDBOX', ref: null, status: 'skipped', message: 'missing msisdn or zero amount' };
    }
    const ref = 'MM-' + createHash('sha256').update(key).digest('hex').slice(0, 12).toUpperCase();
    return { provider: 'SANDBOX', ref, status: 'success' };
  },
};

// ── Flutterwave adapter skeleton ───────────────────────────────────────────
// Uncomment and fill in when you have a Flutterwave Transfer API key.
// Docs: https://developer.flutterwave.com/reference/transfers
//
// import { createHash } from 'node:crypto';
//
// /** @type {MobileMoneyProvider} */
// export const flutterwaveProvider = {
//   name: 'FLUTTERWAVE',
//   async disburse({ msisdn, amountKobo, key, currency = 'NGN' }) {
//     if (!msisdn || !(amountKobo > 0)) {
//       return { provider: 'FLUTTERWAVE', ref: null, status: 'skipped' };
//     }
//     const amount = amountKobo / 100; // Flutterwave works in naira, not kobo
//     const res = await fetch('https://api.flutterwave.com/v3/transfers', {
//       method: 'POST',
//       headers: {
//         'Authorization': `Bearer ${process.env.FLW_SECRET_KEY}`,
//         'Content-Type': 'application/json',
//       },
//       body: JSON.stringify({
//         account_bank: 'MPS',           // mobile money — check FLW docs for bank code
//         account_number: msisdn,        // MSISDN in E.164 format
//         amount,
//         narration: 'Plotline agroforestry payout',
//         currency,
//         reference: key,               // idempotency key: same key = same transfer
//         callback_url: process.env.FLW_CALLBACK_URL ?? null,
//       }),
//     });
//     if (!res.ok) {
//       const err = await res.json().catch(() => ({}));
//       return { provider: 'FLUTTERWAVE', ref: null, status: 'failed', message: err?.message ?? `http_${res.status}` };
//     }
//     const json = await res.json();
//     return {
//       provider: 'FLUTTERWAVE',
//       ref: String(json?.data?.id ?? ''),
//       status: json?.status === 'success' ? 'success' : 'pending',
//     };
//   },
// };

// ── Paystack Transfer adapter skeleton ────────────────────────────────────
// Uncomment and fill in when you have a Paystack Transfer-enabled secret key.
// Docs: https://paystack.com/docs/transfers/single-transfers/
//
// /** @type {MobileMoneyProvider} */
// export const paystackProvider = {
//   name: 'PAYSTACK',
//   async disburse({ msisdn, amountKobo, key }) {
//     if (!msisdn || !(amountKobo > 0)) {
//       return { provider: 'PAYSTACK', ref: null, status: 'skipped' };
//     }
//     // Step 1: create or retrieve a transfer recipient for the MSISDN.
//     // Step 2: initiate a transfer with the idempotency key.
//     // Both steps must be idempotent. Reference: the Paystack Transfers API.
//     // (skeleton not expanded here — follow the Paystack docs)
//     throw new Error('Paystack provider not yet implemented');
//   },
// };

// ── Active provider ────────────────────────────────────────────────────────
// Swap `sandboxProvider` for `flutterwaveProvider` or `paystackProvider` when
// you are ready to go live.

/** @type {MobileMoneyProvider} */
export const mobileMoneyProvider = sandboxProvider;

/**
 * Disburse a payment.  Drop-in replacement for the old mockMobileMoney().
 * Returns a plain DisburseResult (never throws).
 *
 * @param {{ msisdn: string, amountKobo: number, key: string }} opts
 * @returns {Promise<DisburseResult>}
 */
export async function disbursePayout({ msisdn, amountKobo, key }) {
  try {
    return await mobileMoneyProvider.disburse({ msisdn, amountKobo, key });
  } catch (err) {
    return { provider: mobileMoneyProvider.name, ref: null, status: 'failed', message: String(err?.message ?? 'unknown error').slice(0, 120) };
  }
}

// Back-compat alias so existing callers don't break immediately.
// Remove once all call sites use disbursePayout().
export function mockMobileMoney({ msisdn, amountKobo, key }) {
  if (!msisdn || !(amountKobo > 0)) return { provider: 'SANDBOX', ref: null, status: 'skipped' };
  const ref = 'MM-' + createHash('sha256').update(key).digest('hex').slice(0, 12).toUpperCase();
  return { provider: 'SANDBOX', ref, status: 'success' };
}

export const naira = (kobo) => (kobo / 100).toLocaleString('en-NG', { style: 'currency', currency: 'NGN' });
