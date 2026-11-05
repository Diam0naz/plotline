// The carbon-unit registry: submission -> automatic checks -> signed verifier decision ->
// issuance with unique serials -> sale -> split -> payouts -> retirement -> reconciliation.
// Every state change is an event on a hash-chained log; state is rebuilt by replaying it.
// SIMULATED: issuance is not a registered carbon credit and payouts go to a sandbox.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { canonical, fingerprint, hashBody, verifySig } from '../core.js';
import { ChainLog, verifyEvents } from './chainlog.mjs';
import { runChecks } from './checks.mjs';
import { cleanFireEvidence } from './fire.mjs';
import {
  CURRENT_METHODOLOGY_ID, METHODOLOGY as M, PAYOUT_RULES as PR, SERIAL_PREFIX, SPLIT_RULES,
  methodologyById, publicMethodologies,
} from './methodology.mjs';
import { allocate, maskMsisdn, mockMobileMoney, normalizeMsisdn, splitKobo } from './payments.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const HOUR = 3600_000;
export const DEFAULT_PRICE_KOBO = 1_200_000; // N12,000 per tCO2e credit: demo price

const fail = (code, text) => ({ ok: false, error: code, message: text });
const serial = (n) => `${SERIAL_PREFIX}-${String(n).padStart(8, '0')}`;
const HEX64 = /^[0-9a-f]{64}$/;

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
    this.projects = new Map();
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
      case 'project_registered':
        this.projects.set(d.id, { ...d, registeredAt: e.ts });
        break;
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
        this.issuances.push({ ...d, next: d.saleableFrom ?? d.from, issuedAt: e.ts });
        this.subs.get(d.subId).issuanceId = d.id;
        this.nextSerial = d.to + 1;
        break;
      case 'reversed': {
        const iss = this.issuances.find((i) => i.id === d.issuanceId);
        if (iss) {
          iss.saleableTo = Math.max(iss.next - 1, (iss.saleableTo ?? iss.to) - d.units);
          iss.reversed = (iss.reversed ?? 0) + d.units;
          iss.cancellations = [...(iss.cancellations ?? []), { from: d.from, to: d.to, reason: d.reason, at: e.ts }];
        }
        break;
      }
      case 'authorized': {
        const iss = this.issuances.find((i) => i.id === d.issuanceId);
        if (iss) iss.authorization = { scope: d.scope, authority: d.authority, reference: d.reference, correspondingAdjustment: d.correspondingAdjustment, at: e.ts };
        break;
      }
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

  // ---------- 0. project registration: what the credits belong to ----------
  registerProject({
    name, proponent, boundaryHash = null, ecoregion = null, methodologyId, creditingStart, creditingEnd,
    additionality, landUsePrior, tenure, fpicRef = null, validationRef = null,
  }) {
    const method = methodologyById(methodologyId ?? CURRENT_METHODOLOGY_ID);
    if (!method) return fail('unknown_methodology', 'Unknown methodology version');
    const text = (v, lo, hi) => String(v ?? '').trim().slice(0, hi);
    const pname = text(name, 2, 80);
    const prop = text(proponent, 2, 80);
    if (pname.length < 2) return fail('bad_name', 'Give the project a name (2-80 characters)');
    if (prop.length < 2) return fail('bad_proponent', 'Name the project proponent (2-80 characters)');
    if (boundaryHash !== null && !HEX64.test(String(boundaryHash))) return fail('bad_boundary', 'boundaryHash must be 64 lowercase hex characters');
    const add = text(additionality, 20, 600);
    if (add.length < 20) return fail('additionality_required', 'Explain why the activity is additional (20-600 characters)');
    const prior = text(landUsePrior, 2, 200);
    if (prior.length < 2) return fail('land_use_required', 'Describe the land use before the activity');
    if (!['owned', 'customary', 'lease', 'community', 'public'].includes(tenure)) {
      return fail('bad_tenure', 'tenure must be owned, customary, lease, community or public');
    }
    const start = new Date(creditingStart);
    const end = new Date(creditingEnd);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      return fail('bad_crediting_period', 'creditingEnd must be a date after creditingStart');
    }
    if (text(validationRef, 2, 120).length < 2) return fail('validation_required', 'Record the validation reference');

    const id = `PRJ-${String(this.projects.size + 1).padStart(4, '0')}`;
    this.emit('project_registered', {
      id, name: pname, proponent: prop, boundaryHash: boundaryHash ?? null,
      ecoregion: text(ecoregion, 2, 80) || null,
      methodology: method.id, baselineId: method.baseline.id,
      creditingStart: start.toISOString(), creditingEnd: end.toISOString(),
      additionality: add, landUsePrior: prior, tenure,
      fpicRef: text(fpicRef, 2, 120) || null, validationRef: text(validationRef, 2, 120),
    });
    return { ok: true, project: this.projects.get(id) };
  }

  projectsList() {
    return [...this.projects.values()].map((p) => ({
      id: p.id, name: p.name, proponent: p.proponent, methodology: p.methodology, baselineId: p.baselineId,
      creditingStart: p.creditingStart, creditingEnd: p.creditingEnd, tenure: p.tenure,
      validationRef: p.validationRef, additionality: p.additionality, landUsePrior: p.landUsePrior,
      fpicRef: p.fpicRef, boundaryHash: p.boundaryHash, registeredAt: p.registeredAt,
    }));
  }

  // ---------- 1. a farmer's evidence arrives ----------
  async submit({ records, pub, msisdn, methodologyId, projectId = null }) {
    // A submission is checked against a named methodology version, and keeps it for issuance.
    const method = methodologyById(methodologyId ?? CURRENT_METHODOLOGY_ID);
    if (!method) return fail('unknown_methodology', 'Unknown methodology version');
    const project = projectId ? this.projects.get(projectId) : null;
    if (projectId && !project) return fail('unknown_project', 'No such project');
    if (project && project.methodology !== method.id) return fail('project_methodology_mismatch', 'The project was registered under a different methodology version');
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
    const checks = runChecks({ polygon, planting, survival, bodies, others, method });
    // Credits are tonnes, not trees: convert the verified activity and round down (conservative).
    const credits = Math.floor((checks.estAlive * method.kgCO2ePerTreeYear) / 1000);
    if (!checks.hard.length && credits < 1) {
      checks.hard.push({ code: 'below_one_tonne', text: 'This plot does not reach one tonne of CO2e under this methodology' });
    }

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
      units: credits, activityUnits: checks.estAlive, trees: planting.count, sample: survival.sampleSize, alive: survival.alive,
      methodology: method.id, methodologyVersion: method.version, baselineId: method.baseline.id,
      projectId: project?.id ?? null,
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
  async decide({ subId, verifierId, decision, note = '', ts, sig, fire }) {
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
    // Fire evidence is optional, normalised, and covered by the decision signature.
    const evidence = cleanFireEvidence(fire);
    if (evidence) body.fire = evidence;
    const hash = await hashBody(body);
    if (!(await verifySig(hash, sig, vkey))) return fail('bad_signature', 'Decision signature does not match the verifier key');

    this.emit('decided', { body, hash, sig });
    if (decision === 'approve') return { ok: true, status: 'approved', issuance: this.issue(s) };
    return { ok: true, status: 'rejected' };
  }

  // ---------- 3. issuance: unique serial range, once per approved submission ----------
  issue(s) {
    if (s.issuanceId || s.units < 1) return null;
    const method = methodologyById(s.methodology) ?? M;
    const from = this.nextSerial;
    const to = from + s.units - 1;
    // A buffer share is withheld from sale at issuance. It stays unissued-for-sale as cover for
    // reversal, rather than being sold and then clawed back.
    const bufferUnits = Math.max(0, Math.min(s.units - 1, Math.floor((s.units * method.bufferPct) / 100)));
    const saleableTo = to - bufferUnits;
    const id = `ISS-${String(this.issuances.length + 1).padStart(4, '0')}`;
    this.emit('issued', {
      id, subId: s.subId, fp: s.fp, plotKey: s.plotKey, farmName: s.farmName, units: s.units, from, to,
      saleableFrom: from, saleableTo,
      bufferUnits, bufferFrom: bufferUnits ? saleableTo + 1 : null, bufferTo: bufferUnits ? to : null,
      serialFrom: serial(from), serialTo: serial(to),
      methodology: method.id, methodologyVersion: method.version, baselineId: method.baseline.id,
      projectId: s.projectId ?? null, vintage: new Date(s.receivedAt).getUTCFullYear(),
      activityUnits: s.activityUnits ?? s.trees, kgCO2e: s.units * 1000,
    });
    return this.issuances[this.issuances.length - 1];
  }

  available() {
    return this.issuances.reduce((a, i) => a + Math.max(0, (i.saleableTo ?? i.to) - i.next + 1), 0);
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
      const free = Math.max(0, (iss.saleableTo ?? iss.to) - iss.next + 1);
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
  // ---------- 4b. reversals: cancel unsold serials after fire, clearing or a failed check ----------
  reverse({ issuanceId, units, reason, evidence = null }) {
    const iss = this.issuances.find((i) => i.id === issuanceId);
    if (!iss) return fail('unknown_issuance', 'No such issuance');
    const text = String(reason ?? '').trim();
    if (text.length < 5 || text.length > 300) return fail('bad_reason', 'Give a reason (5-300 characters)');
    // Total serial range in this issuance.
    const from = iss.from ?? 1;
    const to = iss.to ?? from;
    const total = to - from + 1;
    // Known quantities.
    const bufUnits = iss.bufferUnits ?? 0;
    const currentReversed = iss.reversed ?? 0;
    // Unsold outside the buffer = total - buffer already reversed so far.
    const unsoldOutside = total - bufUnits - currentReversed;
    // How many to reverse (default = all unsold).
    const requested = units === undefined ? unsoldOutside : units;
    const count = Math.max(1, Math.min(requested, unsoldOutside));
    // If the caller asked for more than available, return an error.
    if (count < requested) return fail('insufficient_unsold', `Only ${unsoldOutside} unsold units available (of ${total} total, ${bufUnits} in buffer)`);
    // Priority: first take from unsold outside buffer, then from buffer.
    const generalTake = Math.min(count, unsoldOutside);
    const bufTake = count - generalTake;
    // Compute serial ranges.
    // General unsold start at issuance.from and go for generalTake units.
    const gFrom = from;
    const gTo = from + generalTake - 1;
    // Buffer units start after the general unsold range.
    const bFrom = from + generalTake;
    const bTo = bFrom + bufTake - 1;
    // Overall reversed range spans from first taken to last taken.
    const rFrom = generalTake > 0 ? gFrom : bFrom;
    const rTo = generalTake > 0 && bufTake > 0 ? bTo : (generalTake > 0 ? gTo : bTo);
    this.emit('reversed', {
      issuanceId, units: count, reason: text, from: rFrom, to: rTo,
      serialFrom: serial(rFrom), serialTo: serial(rTo),
      evidence: evidence ? String(evidence).slice(0, 200) : null,
      usedBuffer: bufTake > 0,
    });
    return { ok: true, cancellation: { issuanceId, units: count, serialFrom: serial(rFrom), serialTo: serial(rTo), reason: text, usedBuffer: bufTake > 0 } };
  }

  // ---------- 4c. Article 6: who may claim these units, and are they adjusted? ----------
  authorizeIssuance({ issuanceId, scope, authority, reference, correspondingAdjustment = false }) {
    const iss = this.issuances.find((i) => i.id === issuanceId);
    if (!iss) return fail('unknown_issuance', 'No such issuance');
    if (!['domestic', 'international'].includes(scope)) return fail('bad_scope', 'Scope must be domestic or international');
    if (iss.authorization?.scope === 'international') return fail('already_authorized', 'This issuance is already authorised for international transfer');
    const auth = String(authority ?? '').trim();
    const ref = String(reference ?? '').trim();
    if (auth.length < 2 || auth.length > 80) return fail('bad_authority', 'Name the authority (2-80 characters)');
    if (ref.length < 2 || ref.length > 80) return fail('bad_reference', 'Give the authorisation reference (2-80 characters)');
    if (scope === 'international') {
      if (correspondingAdjustment !== true) return fail('adjustment_required', 'International transfer needs a corresponding adjustment');
      const claimed = [...this.orders.values()].some((o) => o.retired && o.lots.some((l) => l.issuanceId === issuanceId));
      if (claimed) return fail('already_claimed', 'Units from this issuance were already retired domestically');
    }
    this.emit('authorized', {
      issuanceId, scope, authority: auth, reference: ref, correspondingAdjustment: scope === 'international' && correspondingAdjustment === true,
    });
    return { ok: true, authorization: this.issuances.find((i) => i.id === issuanceId).authorization };
  }

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
    const issued = o.lots.map((l) => this.issuances.find((i) => i.id === l.issuanceId)).filter(Boolean);
    const method = methodologyById(issued[0]?.methodology) ?? M;
    return {
      title: 'Retirement certificate (SIMULATED: not a registered carbon credit)',
      orderId, retiredFor: o.retired.by, reason: o.retired.reason, retiredAt: o.retired.at,
      units: o.units, unit: method.unit, creditUnit: 'tCO2e', methodology: method.id, methodologyVersion: method.version,
      baselineId: method.baseline.id, tCO2e: o.units,
      projectIds: [...new Set(issued.map((i) => i.projectId).filter(Boolean))],
      vintages: [...new Set(issued.map((i) => i.vintage).filter(Boolean))],
      registry: { name: 'Plotline demo registry', serialPrefix: SERIAL_PREFIX, logHead: this.log.head() },
      claim: {
        type: 'voluntary offset retirement (demo)',
        statement: `The registry has retired ${o.units} serialised tCO2e credits on behalf of ${o.retired.by}. These serial numbers are cancelled and will not be sold again.`,
        limits: 'Demo registry only: the credits are simulated and are not recognised under any compliance or voluntary standard. No corresponding adjustment is claimed unless the certificate states one.',
      },
      serialFrom: o.serialFrom, serialTo: o.serialTo,
      lots: o.lots.map((l) => {
        const iss = this.issuances.find((i) => i.id === l.issuanceId);
        return {
          issuance: l.issuanceId, serialFrom: l.serialFrom, serialTo: l.serialTo, units: l.units,
          methodology: iss?.methodology ?? null, baselineId: iss?.baselineId ?? null,
          projectId: iss?.projectId ?? null, vintage: iss?.vintage ?? null,
          activityUnits: iss?.activityUnits ?? null,
          authorization: iss?.authorization ?? null,
        };
      }),
      article6: {
        international: o.lots.some((l) => this.issuances.find((i) => i.id === l.issuanceId)?.authorization?.scope === 'international'),
        correspondingAdjustment: o.lots.some((l) => this.issuances.find((i) => i.id === l.issuanceId)?.authorization?.correspondingAdjustment === true),
        authorities: [...new Set(issued.map((i) => i.authorization?.authority).filter(Boolean))],
      },
      logHead: this.log.head(),
    };
  }

  // ---------- 5. public verification: look up one serial or the retirement ledger ----------
  serialInfo(input) {
    const m = /^PL-NG-(\d{8})$/.exec(String(input ?? '').trim().toUpperCase());
    if (!m) return null;
    const n = Number(m[1]);
    const iss = this.issuances.find((i) => n >= i.from && n <= i.to);
    if (!iss) return null;
    const cancellation = (iss.cancellations ?? []).find((c) => n >= c.from && n <= c.to);
    const inBuffer = iss.bufferFrom != null && n >= iss.bufferFrom && n <= iss.bufferTo;
    let status = 'available';
    if (cancellation) status = 'cancelled';
    else if (inBuffer) status = 'buffer';
    else if (n < iss.next) status = 'sold';
    const order = status === 'sold'
      ? [...this.orders.values()].find((o) => o.lots.some((l) => l.issuanceId === iss.id && n >= l.from && n <= l.to))
      : null;
    return {
      serial: serial(n), status, creditUnit: 'tCO2e', kgCO2e: 1000,
      issuanceId: iss.id, projectId: iss.projectId ?? null, vintage: iss.vintage ?? null,
      methodology: iss.methodology ?? null, baselineId: iss.baselineId ?? null, farmName: iss.farmName,
      buffer: inBuffer, cancellation: cancellation ? { reason: cancellation.reason, at: cancellation.at } : null,
      sale: order ? { orderId: order.orderId, retired: order.retired ?? null } : null,
      authorization: iss.authorization ?? null,
    };
  }

  retirements() {
    return [...this.orders.values()].filter((o) => o.retired).map((o) => {
      const issued = o.lots.map((l) => this.issuances.find((i) => i.id === l.issuanceId)).filter(Boolean);
      return {
        orderId: o.orderId, buyer: o.buyer, units: o.units, tCO2e: o.units, retiredFor: o.retired.by,
        reason: o.retired.reason, retiredAt: o.retired.at, serialFrom: o.serialFrom, serialTo: o.serialTo,
        projectIds: [...new Set(issued.map((i) => i.projectId).filter(Boolean))],
        vintages: [...new Set(issued.map((i) => i.vintage).filter(Boolean))],
      };
    });
  }

  // ---------- views ----------
  publicOrder(o) {
    return { orderId: o.orderId, buyer: o.buyer, units: o.units, totalKobo: o.totalKobo, split: o.split, serialFrom: o.serialFrom, serialTo: o.serialTo, soldAt: o.soldAt, retired: o.retired };
  }

  publicSub(s) {
    return {
      subId: s.subId, status: s.status, farmName: s.farmName, farmerKey: s.fp, units: s.units, activityUnits: s.activityUnits ?? null, trees: s.trees,
      projectId: s.projectId ?? null,
      sample: s.sample, alive: s.alive, flags: s.checks.flags, hard: s.checks.hard, overlaps: s.checks.overlaps,
      areaHa: Math.round(s.checks.areaHa * 100) / 100, receivedAt: s.receivedAt, polygon: s.polygon,
      payoutTo: s.masked, issuanceId: s.issuanceId ?? null,
      methodology: s.methodology ?? null, methodologyVersion: s.methodologyVersion ?? null, baselineId: s.baselineId ?? null,
      decision: s.decision ? { by: s.decision.body.verifierId, decision: s.decision.body.decision, note: s.decision.body.note, ts: s.decision.body.ts, sig: s.decision.sig, fire: s.decision.body.fire ?? null } : null,
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
    const lots = this.issuances.map((i) => ({
      id: i.id, farmName: i.farmName, units: i.units, remaining: Math.max(0, (i.saleableTo ?? i.to) - i.next + 1),
      bufferUnits: i.bufferUnits ?? 0, reversedUnits: i.reversed ?? 0, projectId: i.projectId ?? null, vintage: i.vintage ?? null,
      serialFrom: i.serialFrom, serialTo: i.serialTo,
      methodology: i.methodology ?? M.id, methodologyVersion: i.methodologyVersion ?? null,
      authorization: i.authorization ?? null,
    }));
    return {
      priceKobo: this.priceKobo, available: this.available(),
      methodology: M.id, methodologyVersion: M.version, baselineId: M.baseline.id,
      status: M.status, creditUnit: 'tCO2e', unit: M.unit, kgCO2ePerCredit: 1000, kgCO2ePerTreeYear: M.kgCO2ePerTreeYear, bufferPct: M.bufferPct,
      methodologies: publicMethodologies(),
      lots, orders: [...this.orders.values()].map((o) => this.publicOrder(o)),
    };
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
    const buffered = this.issuances.reduce((a, i) => a + (i.bufferUnits ?? 0), 0);
    const reversed = this.issuances.reduce((a, i) => a + (i.reversed ?? 0), 0);
    const available = this.available();
    const serialsOk = this.issuances.every((x, i, arr) => (i === 0 ? x.from === 1 : x.from === arr[i - 1].to + 1));
    return {
      inKobo, paidToFarmersKobo: paid, heldKobo: held, communityKobo: community, verifierKobo: verifier, platformKobo: platform,
      balanced: inKobo === accounted,
      unitsIssued: issued, unitsSold: sold, unitsAvailable: available,
      unitsBuffered: buffered, unitsReversed: reversed,
      unitsBalanced: issued === sold + available + buffered + reversed,
      serialsContiguous: serialsOk,
    };
  }

  verifyLog() {
    return verifyEvents(this.log.entries);
  }
}

export { canonical };
