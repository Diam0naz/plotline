// Every number in this file is a DEMO ASSUMPTION. None is a registered methodology, a legal
// benefit-sharing rule, or a market price. Replace them before any real use.
//
// Methodologies are versioned records, not a single constant: a submission records the version it
// was checked against, and issuance records the version and baseline it was credited under, so an
// old issuance stays reproducible after the rules change.

export const CURRENCY = 'NGN';

const SHARED = {
  status: 'DEMO ASSUMPTIONS: not a registered methodology',
  unit: 'verified tree-year',
  density: { minPerHa: 20, maxPerHa: 1600 },
  minSample: 10,
  minSampleShare: 0.1,
  minQuality: 70,
  overlap: { review: 0.2, reject: 0.8 },
};

export const METHODOLOGIES = Object.freeze({
  'DEMO-AGROFORESTRY-0': Object.freeze({
    ...SHARED,
    id: 'DEMO-AGROFORESTRY-0',
    version: 1,
    kgCO2ePerTreeYear: 20,
    bufferPct: 0,
    baseline: Object.freeze({
      id: 'baseline:none',
      description: 'No baseline. A fixed factor is applied directly to verified tree-years.',
      matchedPlots: 0,
      dynamic: false,
    }),
  }),
  'DEMO-AGROFORESTRY-1': Object.freeze({
    ...SHARED,
    id: 'DEMO-AGROFORESTRY-1',
    version: 2,
    // More conservative than v1: a buffer is withheld against reversal, and the factor is lower
    // because it is applied against a matched unenrolled baseline rather than a fixed assumption.
    kgCO2ePerTreeYear: 18,
    bufferPct: 10,
    baseline: Object.freeze({
      id: 'baseline:ng-agroforestry-demo-2026',
      description: 'Matched unenrolled plots in the same ecoregion, species mix and planting age. Demo data only.',
      matchedPlots: 10,
      dynamic: true,
    }),
  }),
});

export const CURRENT_METHODOLOGY_ID = 'DEMO-AGROFORESTRY-1';
export const METHODOLOGY = METHODOLOGIES[CURRENT_METHODOLOGY_ID];

export function methodologyById(id) {
  return typeof id === 'string' && Object.hasOwn(METHODOLOGIES, id) ? METHODOLOGIES[id] : null;
}

// What buyers and verifiers can see: identities and factors, not internals.
export function publicMethodologies() {
  return Object.values(METHODOLOGIES).map((m) => ({
    id: m.id,
    version: m.version,
    status: m.status,
    unit: m.unit,
    baselineId: m.baseline.id,
    baselineDescription: m.baseline.description,
    kgCO2ePerTreeYear: m.kgCO2ePerTreeYear,
    bufferPct: m.bufferPct,
    current: m.id === CURRENT_METHODOLOGY_ID,
  }));
}

// Shares of each sale in basis points (10000 = 100%). DEMO split: Nigeria's benefit-sharing
// rules for voluntary projects were not published in the sources checked.
export const SPLIT_RULES = Object.freeze({ farmers: 6000, community: 2500, verifier: 500, platform: 1000 });

// Payout fraud controls.
export const PAYOUT_RULES = Object.freeze({
  firstPayoutCapKobo: 2_000_000,   // N20,000: a farmer's first payout is capped, the rest is held
  destinationCoolingHours: 72,     // after changing payout number, payouts are held this long
});

export const SERIAL_PREFIX = 'PL-NG';
