// The carbon-unit registry: submission -> automatic checks -> signed verifier decision ->
// issuance with unique serials -> sale -> split -> payouts -> retirement -> reconciliation.
// Every state change is an event on a hash-chained log; state is rebuilt by replaying it.
// SIMULATED: issuance is not a registered carbon credit and payouts go to a sandbox.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { canonical, fingerprint, hashBody, verifySig } from '../core.js';
import { ChainLog, verifyEvents } from './chainlog.mjs';
import { runChecks } from './checks.mjs';
import { METHODOLOGY as M, PAYOUT_RULES as PR, SERIAL_PREFIX, SPLIT_RULES } from './methodology.mjs';
import { allocate, maskMsisdn, mockMobileMoney, normalizeMsisdn, splitKobo } from './payments.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const HOUR = 3600_000;
export const DEFAULT_PRICE_KOBO = 30_000; // N300 per verified tree-year: demo price

const fail = (code, text) => ({ ok: false, error: code, message: text });
const serial = (n) => `${SERIAL_PREFIX}-${String(n).padStart(8, '0')}`;

export class Registry {
  constructor({ file, privateFile = null, verifiers = {}, now = () => new Date(), priceKobo = DEFAULT_PRICE_KOBO }) {
    this.log = new ChainLog(file);
    // Phone numbers never go on the public log: only a salted hash and a masked form do.
    this.privateFile = privateFile;
    this.priv = privateFile && existsSync(privateFile)
      ? JSON.parse(readFileSync(privateFile, 'utf8'))
      : { salt: randomBytes(16).toString('hex'), numbers: {} };
    if (privateFile && !existsSync(privateFile)) writeFileSync(privateFile, JSON.stringify(this.priv), { mode: 0o600 });
    this.verifiers = verifiers; // id -> public JWK
    this.now = now;
    this.priceKobo = priceKobo;
    this.reset();
    for (const e of this.log.entries) this.apply(e);
  }

  msisdnKey(num) { return sha(this.priv.salt + num); }
  numberOf(key) { return key ? this.priv.numbers[key] ?? null : null; }
  keepNumber(key, num) {
    if (this.priv.numbers[key]) return;
    this.priv.numbers[key] = num;
    if (this.privateFile) writeFileSync(this.privateFile, JSON.stringify(this.priv), { mode: 0o600 });
  }

  reset() {
    this.subs = new Map();
    this.farmers = new Map();
    this.msisdnOwner = new Map();
    this.issuances = [];
    this.orders = new Map();
    this.orderKeys = new Map();
    this.payouts = [];
    this.pools = { community: 0, verifier: 0, platform: 0 };
    this.nextSerial = 1;
  }

  // ---------- replay: the only place state changes ----------
  apply(e) {
    const d = e.data;
    switch (e.type) {
      case 'submitted': {
        this.subs.set(d.subId, { ...d, status: 'pending', receivedAt: e.ts, seq: e.seq });
        let f = this.farmers.get(d.fp);
        if (!f) { f = { fp: d.fp, pub: d.pub, msisdnKey: null, masked: null, cooldownUntil: null, paid: 0 }; this.farmers.set(d.fp, f); }
        if (d.msisdnKey && d.msisdnKey !== f.msisdnKey) {
          if (f.msisdnKey) {
            f.cooldownUntil = new Date(new Date(e.ts).getTime() + PR.destinationCoolingHours * HOUR).toISOString();
            this.msisdnOwner.delete(f.msisdnKey);
          }
          f.msisdnKey = d.msisdnKey;
          f.masked = d.masked;
          this.msisdnOwner.set(d.msisdnKey, d.fp);
        }
        break;
      }
      case 'rejected':
        this.subs.set(d.subId, { ...d, status: 'rejected', receivedAt: e.ts, seq: e.seq });
        break;
      case 'decided': {
        const s = this.subs.get(d.body.subId);
        s.status = d.body.decision === 'approve' ? 'approved' : 'rejected';
        s.decision = d;
        break;
      }
      case 'issued':
        this.issuances.push({ ...d, next: d.from, issuedAt: e.ts });
        this.subs.get(d.subId).issuanceId = d.id;
        this.nextSerial = d.to + 1;
        break;
      case 'sold': {
        for (const l of d.lots) {
          const iss = this.issuances.find((x) => x.id === l.issuanceId);
          iss.next = l.to + 1;
        }
        this.orders.set(d.orderId, { ...d, soldAt: e.ts, retired: null });
        if (d.key) this.orderKeys.set(d.key, d.orderId);
        this.pools.community += d.split.community;
        this.pools.verifier += d.split.verifier;
        this.pools.platform += d.split.platform;
        break;
      }
      case 'payout':
        this.payouts.push({ ...d, at: e.ts });
        if (d.status === 'paid') this.farmers.get(d.fp).paid += d.amountKobo;
        break;
      case 'released': {
        const p = this.payouts.find((x) => x.id === d.payoutId);
        p.status = 'paid'; p.ref = d.ref; p.releasedAt = e.ts;
        this.farmers.get(p.fp).paid += p.amountKobo;
        break;
      }
      case 'retired':
        this.orders.get(d.orderId).retired = { by: d.beneficiary, reason: d.reason, at: e.ts };
        break;
      default:
        throw new Error('unknown event type ' + e.type);
    }
  }

  emit(type, data) {
    const e = this.log.append(type, data, this.now());
    this.apply(e);
    return e;
  }

  // ---------- 1. a farmer's evidence arrives ----------
  async submit({ records, pub, msisdn }) {
    if (!Array.isArray(records) || records.length !== 3 || !pub || typeof pub !== 'object') {
      return fail('bad_shape', 'Send the farm, planting and survival records with your public key');
    }
    const fp = await fingerprint(pub);
    const kinds = ['farm', 'planting', 'survival'];
    for (let i = 0; i < 3; i++) {
      const r = records[i];
      if (!r?.body || r.body.kind !== kinds[i]) return fail('wrong_order', `Record ${i + 1} must be "${kinds[i]}"`);
      if ((await hashBody(r.body)) !== r.hash) return fail('bad_hash', `Record ${i + 1} does not match its hash`);
      if (!(await verifySig(r.hash, r.sig, pub))) return fail('bad_signature', `Record ${i + 1} was not signed by this key`);
      if (r.body.signer !== fp) return fail('wrong_signer', `Record ${i + 1} names a different signer`);
      if (r.body.farmId !== records[0].body.farmId) return fail('mixed_farms', 'All three records must be for the same farm');
    }
    const bodies = records.map((r) => r.body);
    const polygon = bodies[0].data?.polygon;
    const okPoly = Array.isArray(polygon) && polygon.length >= 3 && polygon.length <= 500 &&
      polygon.every((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180);
    if (!okPoly) return fail('bad_polygon', 'The farm record needs a boundary of at least 3 points');

    const subId = sha(records.map((r) => r.hash).join('|'));
    const existing = this.subs.get(subId);
    if (existing) return { ok: true, duplicate: true, subId, status: existing.status };

    const plotKey = `${fp}:${bodies[0].farmId}`;
    const others = [...this.subs.values()]
      .filter((s) => s.status !== 'rejected' && s.plotKey !== plotKey && s.polygon)
      .map((s) => ({ plotKey: s.plotKey, polygon: s.polygon }));
    const planting = bodies[1].data ?? {};
    const survival = bodies[2].data ?? {};
    const checks = runChecks({ polygon, planting, survival, bodies, others });

    const num = normalizeMsisdn(msisdn);
    const nkey = num && this.msisdnKey(num);
    const owner = nkey && this.msisdnOwner.get(nkey);
    if (owner && owner !== fp) {
      checks.hard.push({ code: 'number_in_use', text: 'This payout number is already linked to a different farmer key' });
    }
    if (!num) checks.flags.push({ code: 'no_valid_number', text: 'No valid payout number: payouts will be held' });

    const base = {
      subId, fp, pub, plotKey, farmId: bodies[0].farmId, farmName: bodies[0].data?.name ?? null, polygon,
      recordHashes: records.map((r) => r.hash), msisdnKey: nkey || null, masked: num ? maskMsisdn(num) : null, checks,
      units: checks.estAlive, trees: planting.count, sample: survival.sampleSize, alive: survival.alive,
    };
    if (checks.hard.length) {
      this.emit('rejected', { ...base, reason: checks.hard });
      return { ok: true, subId, status: 'rejected', checks };
    }
    if (nkey) this.keepNumber(nkey, num);
    this.emit('submitted', base);
    return { ok: true, subId, status: 'pending', checks };
  }

  // ---------- 2. an independent verifier decides, and signs ----------
  async decide({ subId, verifierId, decision, note = '', ts, sig }) {
    const s = this.subs.get(subId);
    const vkey = this.verifiers[verifierId];
    if (!s) return fail('unknown_submission', 'No such submission');
    if (!vkey) return fail('unknown_verifier', 'This verifier is not on the registry\'s approved list');
    if (s.status !== 'pending') return fail('already_decided', `Submission is already ${s.status}`);
    if (!['approve', 'reject'].includes(decision)) return fail('bad_decision', 'Decision must be approve or reject');
    if ((await fingerprint(vkey)) === s.fp) return fail('self_verification', 'A farmer cannot verify their own submission');
    if (decision === 'approve' && s.checks.flags.length && String(note).trim().length < 5) {
      return fail('note_required', 'This submission was flagged: write a note explaining why you approve it');
    }
    const body = { subId, decision, note: String(note).slice(0, 500), verifierId, ts };
    const hash = await hashBody(body);
    if (!(await verifySig(hash, sig, vkey))) return fail('bad_signature', 'Decision signature does not match the verifier key');

    this.emit('decided', { body, hash, sig });
    if (decision === 'approve') return { ok: true, status: 'approved', issuance: this.issue(s) };
    return { ok: true, status: 'rejected' };
  }

  // ---------- 3. issuance: unique serial range, once per approved submission ----------
  issue(s) {
    if (s.issuanceId || s.units < 1) return null;
    const from = this.nextSerial;
    const to = from + s.units - 1;
    const id = `ISS-${String(this.issuances.length + 1).padStart(4, '0')}`;
    this.emit('issued', {
      id, subId: s.subId, fp: s.fp, plotKey: s.plotKey, farmName: s.farmName, units: s.units, from, to,
      serialFrom: serial(from), serialTo: serial(to), methodology: M.id, kgCO2e: s.units * M.kgCO2ePerTreeYear,
    });
    return this.issuances[this.issuances.length - 1];
  }

  available() {
    return this.issuances.reduce((a, i) => a + (i.to - i.next + 1), 0);
  }

  // ---------- 4. a buyer buys; money is split and paid ----------
  placeOrder({ buyer, units, key }) {
    if (key && this.orderKeys.has(key)) return { ok: true, duplicate: true, order: this.publicOrder(this.orders.get(this.orderKeys.get(key))) };
    const name = String(buyer ?? '').trim();
    if (name.length < 2 || name.length > 80) return fail('bad_buyer', 'Buyer name must be 2-80 characters');
    if (!Number.isInteger(units) || units < 1) return fail('bad_units', 'Units must be a whole number of at least 1');
    if (units > this.available()) return fail('not_enough_units', `Only ${this.available()} units are available`);

    // first in, first out across issued lots, so serials are never reused
    const lots = [];
    let need = units;
    for (const iss of this.issuances) {
      if (need === 0) break;
      const free = iss.to - iss.next + 1;
      if (free < 1) continue;
      const take = Math.min(free, need);
      lots.push({ issuanceId: iss.id, fp: iss.fp, from: iss.next, to: iss.next + take - 1, units: take });
      need -= take;
    }
    const totalKobo = units * this.priceKobo;
    const split = splitKobo(totalKobo, SPLIT_RULES);
    const perFarmer = new Map();
    for (const l of lots) perFarmer.set(l.fp, (perFarmer.get(l.fp) ?? 0) + l.units);
    const shares = allocate(split.farmers, [...perFarmer].map(([k, w]) => ({ key: k, weight: w })));
    const orderId = `ORD-${String(this.orders.size + 1).padStart(4, '0')}`;
    this.emit('sold', {
      orderId, key: key ?? null, buyer: name, units, priceKobo: this.priceKobo, totalKobo, split,
      serialFrom: serial(lots[0].from), serialTo: serial(lots[lots.length - 1].to),
      lots: lots.map((l) => ({ ...l, serialFrom: serial(l.from), serialTo: serial(l.to) })),
    });

    [...shares].forEach(([fp, amountKobo], i) => this.pay({ orderId, fp, amountKobo, seq: i }));
    return { ok: true, order: this.publicOrder(this.orders.get(orderId)) };
  }

  // payout fraud rules decide whether money moves now or is held
  pay({ orderId, fp, amountKobo, seq }) {
    const f = this.farmers.get(fp);
    const now = this.now();
    const id = `PAY-${String(this.payouts.length + 1).padStart(4, '0')}`;
    const idem = `${orderId}:${fp}:${seq}`;
    let pay = amountKobo, hold = 0, reason = null;
    const number = this.numberOf(f.msisdnKey);
    if (!f.msisdnKey) { pay = 0; hold = amountKobo; reason = 'no_valid_number'; }
    else if (!number) { pay = 0; hold = amountKobo; reason = 'destination_unavailable'; }
    else if (f.cooldownUntil && new Date(f.cooldownUntil) > now) { pay = 0; hold = amountKobo; reason = 'new_number_cooling_off'; }
    else if (f.paid === 0 && amountKobo > PR.firstPayoutCapKobo) { pay = PR.firstPayoutCapKobo; hold = amountKobo - pay; reason = 'first_payout_cap'; }

    if (pay > 0) {
      const mm = mockMobileMoney({ msisdn: number, amountKobo: pay, key: idem });
      this.emit('payout', { id, orderId, fp, amountKobo: pay, status: 'paid', reason: null, ref: mm.ref, provider: mm.provider, idem, to: f.masked });
    }
    if (hold > 0) {
      const hid = pay > 0 ? `PAY-${String(this.payouts.length + 1).padStart(4, '0')}` : id;
      this.emit('payout', { id: hid, orderId, fp, amountKobo: hold, status: 'held', reason, ref: null, provider: 'SANDBOX', idem: idem + ':held', to: f.masked });
    }
  }

  // an operator releases held money once the reason no longer applies
  releaseHeld(fp) {
    const f = this.farmers.get(fp);
    if (!f) return fail('unknown_farmer', 'No such farmer');
    if (!f.msisdnKey) return fail('no_number', 'Farmer has no valid payout number');
    if (f.cooldownUntil && new Date(f.cooldownUntil) > this.now()) return fail('cooling', `Number changed recently; wait until ${f.cooldownUntil}`);
    let released = 0, count = 0;
    for (const p of this.payouts.filter((x) => x.fp === fp && x.status === 'held')) {
      if (!this.numberOf(f.msisdnKey)) return fail('no_number', 'Payout number is not available');
      const mm = mockMobileMoney({ msisdn: this.numberOf(f.msisdnKey), amountKobo: p.amountKobo, key: p.idem });
      this.emit('released', { payoutId: p.id, ref: mm.ref });
      released += p.amountKobo; count++;
    }
    return { ok: true, released, count };
  }

  // ---------- 5. retirement: the buyer claims the units so they cannot be sold or claimed again ----------
  retire({ orderId, beneficiary, reason = '' }) {
    const o = this.orders.get(orderId);
    if (!o) return fail('unknown_order', 'No such order');
    if (o.retired) return fail('already_retired', 'These units are already retired');
    const who = String(beneficiary ?? '').trim();
    if (who.length < 2 || who.length > 80) return fail('bad_beneficiary', 'Name who the retirement is for (2-80 characters)');
    this.emit('retired', { orderId, beneficiary: who, reason: String(reason).slice(0, 200) });
    return { ok: true, certificate: this.certificate(orderId) };
  }

  certificate(orderId) {
    const o = this.orders.get(orderId);
    if (!o?.retired) return null;
    return {
      title: 'Retirement certificate (SIMULATED: not a registered carbon credit)',
      orderId, retiredFor: o.retired.by, reason: o.retired.reason, retiredAt: o.retired.at,
      units: o.units, unit: M.unit, methodology: M.id, tCO2eDemo: (o.units * M.kgCO2ePerTreeYear) / 1000,
      serialFrom: o.serialFrom, serialTo: o.serialTo,
      lots: o.lots.map((l) => ({ issuance: l.issuanceId, serialFrom: l.serialFrom, serialTo: l.serialTo, units: l.units })),
      logHead: this.log.head(),
    };
  }

  // ---------- views ----------
  publicOrder(o) {
    return { orderId: o.orderId, buyer: o.buyer, units: o.units, totalKobo: o.totalKobo, split: o.split, serialFrom: o.serialFrom, serialTo: o.serialTo, soldAt: o.soldAt, retired: o.retired };
  }

  publicSub(s) {
    return {
      subId: s.subId, status: s.status, farmName: s.farmName, farmerKey: s.fp, units: s.units, trees: s.trees,
      sample: s.sample, alive: s.alive, flags: s.checks.flags, hard: s.checks.hard, overlaps: s.checks.overlaps,
      areaHa: Math.round(s.checks.areaHa * 100) / 100, receivedAt: s.receivedAt, polygon: s.polygon,
      payoutTo: s.masked, issuanceId: s.issuanceId ?? null,
      decision: s.decision ? { by: s.decision.body.verifierId, decision: s.decision.body.decision, note: s.decision.body.note, ts: s.decision.body.ts, sig: s.decision.sig } : null,
    };
  }

  farmerView(fp) {
    const subs = [...this.subs.values()].filter((s) => s.fp === fp).map((s) => this.publicSub(s));
    const pays = this.payouts.filter((p) => p.fp === fp);
    const f = this.farmers.get(fp);
    return {
      farmerKey: fp, payoutTo: f ? f.masked : null, cooldownUntil: f?.cooldownUntil ?? null,
      submissions: subs,
      paidKobo: pays.filter((p) => p.status === 'paid').reduce((a, p) => a + p.amountKobo, 0),
      heldKobo: pays.filter((p) => p.status === 'held').reduce((a, p) => a + p.amountKobo, 0),
      payouts: pays.map(({ id, orderId, amountKobo, status, reason, ref, to }) => ({ id, orderId, amountKobo, status, reason, ref, to })),
    };
  }

  market() {
    const lots = this.issuances.map((i) => ({ id: i.id, farmName: i.farmName, units: i.units, remaining: i.to - i.next + 1, serialFrom: i.serialFrom, serialTo: i.serialTo }));
    return { priceKobo: this.priceKobo, available: this.available(), methodology: M.id, status: M.status, kgCO2ePerUnit: M.kgCO2ePerTreeYear, lots, orders: [...this.orders.values()].map((o) => this.publicOrder(o)) };
  }

  // money in must equal money out + money held + pool balances
  reconcile() {
    const inKobo = [...this.orders.values()].reduce((a, o) => a + o.totalKobo, 0);
    const paid = this.payouts.filter((p) => p.status === 'paid').reduce((a, p) => a + p.amountKobo, 0);
    const held = this.payouts.filter((p) => p.status === 'held').reduce((a, p) => a + p.amountKobo, 0);
    const { community, verifier, platform } = this.pools;
    const accounted = paid + held + community + verifier + platform;
    const issued = this.issuances.reduce((a, i) => a + i.units, 0);
    const sold = this.issuances.reduce((a, i) => a + (i.next - i.from), 0);
    const serialsOk = this.issuances.every((x, i, arr) => (i === 0 ? x.from === 1 : x.from === arr[i - 1].to + 1));
    return {
      inKobo, paidToFarmersKobo: paid, heldKobo: held, communityKobo: community, verifierKobo: verifier, platformKobo: platform,
      balanced: inKobo === accounted, unitsIssued: issued, unitsSold: sold, unitsAvailable: issued - sold, serialsContiguous: serialsOk,
    };
  }

  verifyLog() {
    return verifyEvents(this.log.entries);
  }
}

export { canonical };
