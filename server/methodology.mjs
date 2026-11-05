// Every number in this file is a DEMO ASSUMPTION. None is a registered methodology, a legal
// benefit-sharing rule, or a market price. Replace them before any real use.

export const CURRENCY = 'NGN';

export const METHODOLOGY = Object.freeze({
  id: 'DEMO-AGROFORESTRY-0',
  status: 'DEMO ASSUMPTIONS: not a registered methodology',
  // The registry measures verified tree-years (surviving trees in a monitoring period).
  // Converting that to tonnes of CO2e is methodology-specific; this factor is a placeholder.
  unit: 'verified tree-year',
  kgCO2ePerTreeYear: 20,
  density: { minPerHa: 20, maxPerHa: 1600 },   // plausibility band for trees per hectare
  minSample: 10,                                // survival sample: at least this many trees...
  minSampleShare: 0.1,                          // ...or this share of those planted, whichever is larger
  minQuality: 70,                               // GNSS quality score below this goes to manual review
  overlap: { review: 0.2, reject: 0.8 },        // share of a plot already registered by someone else
});

// Shares of each sale in basis points (10000 = 100%). DEMO split: Nigeria's benefit-sharing
// rules for voluntary projects were not published in the sources checked.
export const SPLIT_RULES = Object.freeze({ farmers: 6000, community: 2500, verifier: 500, platform: 1000 });

// Payout fraud controls.
export const PAYOUT_RULES = Object.freeze({
  firstPayoutCapKobo: 2_000_000,   // N20,000: a farmer's first payout is capped, the rest is held
  destinationCoolingHours: 72,     // after changing payout number, payouts are held this long
});

export const SERIAL_PREFIX = 'PL-NG';
