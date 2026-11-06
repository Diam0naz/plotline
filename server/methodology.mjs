// Every number in this file is a DEMO ASSUMPTION. None is a registered methodology, a legal
// benefit-sharing rule, or a market price. Replace them before any real use.
//
// Methodologies are versioned records, not a single constant: a submission records the version it
// was checked against, and issuance records the version and baseline it was credited under, so an
// old issuance stays reproducible after the rules change.

// ─────────────────────────────────────────────────────────────────────────────
// BIOMASS FACTOR — WHAT MUST REPLACE THE DEMO VALUE
// ─────────────────────────────────────────────────────────────────────────────
//
// The current `kgCO2ePerTreeYear: 18` is a placeholder. A real project MUST
// compute this from first principles for each species and ecoregion. The
// scaffold below documents the required steps; none of it runs yet.
//
// Step 1 — Above-ground biomass (AGB) via allometric equation.
//   The standard equation is from Chave et al. (2014), Equation 7 for tropical
//   moist forests:
//
//     AGB (kg) = 0.0673 × (ρ × D² × H) ^ 0.976
//
//   where:
//     ρ  = wood density (g/cm³) — look up by species in the Global Wood
//          Density Database (Zanne et al. 2009; doi:10.5061/dryad.234)
//     D  = diameter at breast height (cm), measured at 1.3 m
//     H  = total tree height (m), measured or estimated via height–diameter
//          models specific to the ecoregion
//
//   For smallholder agroforestry where H is hard to measure, the local
//   height–diameter relationship (e.g. Feldpausch et al. 2012) can substitute.
//
// Step 2 — Below-ground biomass (BGB).
//   IPCC 2006 Guidelines (Vol. 4, Table 4.4) give root:shoot ratios by forest
//   type. For tropical moist broadleaf forest the default is R = 0.37.
//
//     BGB (kg) = AGB × R
//
// Step 3 — Total tree biomass.
//
//     Total (kg dry matter) = AGB + BGB
//
// Step 4 — Carbon fraction.
//   IPCC default carbon fraction for all forest types: CF = 0.47 (dimensionless).
//
//     Carbon (kg C) = Total × CF
//
// Step 5 — CO₂ equivalent.
//
//     CO₂e (kg) = Carbon × (44/12)   // molecular weight ratio CO₂:C
//
// Step 6 — Annual increment.
//   Trees are measured at planting and at each monitoring period. The
//   increment in CO₂e per tree-year is:
//
//     kgCO2ePerTreeYear = (CO₂e_at_end - CO₂e_at_start) / years
//
//   This number varies by species, age, site quality and ecoregion and MUST be
//   re-measured at each monitoring period, not carried forward from prior years.
//
// Step 7 — Baseline.
//   A dynamic baseline requires matched unenrolled plots in the same ecoregion,
//   species mix, and planting age, measured at the same intervals. The net
//   additionality is:
//
//     net_kgCO2ePerTreeYear = kgCO2ePerTreeYear_enrolled
//                           - kgCO2ePerTreeYear_matched_baseline
//
// Step 8 — Uncertainty and conservativeness adjustment.
//   Apply a conservativeness deduction (typically 5-15 %) to account for
//   measurement uncertainty, per VCS VMD0055 or equivalent.
//
// IPCC references:
//   IPCC (2006). 2006 IPCC Guidelines for National GHG Inventories, Vol. 4
//   (Agriculture, Forestry and Other Land Use), Chapter 4.
//   https://www.ipcc-nggip.iges.or.jp/public/2006gl/vol4.html
//
// Chave et al. (2014). Improved allometric models to estimate the aboveground
//   biomass of tropical trees. Global Change Biology 20(10):3177–3190.
//   doi:10.1111/gcb.12629
//
// Zanne et al. (2009). Global wood density database. Dryad.
//   doi:10.5061/dryad.234
//
// ── SCAFFOLD (not yet wired to submissions) ────────────────────────────────
//
// export const IPCC_ROOT_SHOOT = Object.freeze({
//   'tropical_moist_broadleaf': 0.37,
//   'tropical_dry_broadleaf':   0.56,
//   'tropical_montane':         0.27,
//   'subtropical_moist':        0.37,
// });
//
// export const IPCC_CARBON_FRACTION = 0.47; // dimensionless, all forest types
// export const CO2_C_RATIO = 44 / 12;       // 3.6667
//
// /**
//  * Estimate aboveground biomass for one tree using the Chave et al. 2014
//  * pantropical allometric equation (Eq. 7).
//  *
//  * @param {number} woodDensity_g_cm3 - species wood density (g/cm³)
//  * @param {number} dbh_cm            - diameter at breast height (cm)
//  * @param {number} height_m          - total tree height (m)
//  * @returns {number} AGB in kg dry matter
//  */
// export function chaveAGB(woodDensity_g_cm3, dbh_cm, height_m) {
//   return 0.0673 * Math.pow(woodDensity_g_cm3 * dbh_cm ** 2 * height_m, 0.976);
// }
//
// /**
//  * Compute kg CO₂e sequestered by one tree from allometric inputs.
//  *
//  * @param {number} woodDensity_g_cm3
//  * @param {number} dbh_cm
//  * @param {number} height_m
//  * @param {string} forestType - key into IPCC_ROOT_SHOOT
//  * @returns {number} kg CO₂e
//  */
// export function treeCO2e(woodDensity_g_cm3, dbh_cm, height_m, forestType) {
//   const agb = chaveAGB(woodDensity_g_cm3, dbh_cm, height_m);
//   const r   = IPCC_ROOT_SHOOT[forestType] ?? IPCC_ROOT_SHOOT['tropical_moist_broadleaf'];
//   const bgb = agb * r;
//   return (agb + bgb) * IPCC_CARBON_FRACTION * CO2_C_RATIO;
// }
//
// To wire this in:
//   1. Collect DBH and height measurements in the survival record body.
//   2. Replace `kgCO2ePerTreeYear` in METHODOLOGIES with a per-submission call
//      to treeCO2e() using the measured species, DBH and height deltas.
//   3. Store the computed factor in the issuance event so it is reproducible.
// ─────────────────────────────────────────────────────────────────────────────

export const CURRENCY = 'NGN';

// A credit is one tonne of CO2e. Verified tree-years are the activity measurement; the methodology
// converts them to credits. One serial number always means one tonne.
const SHARED = {
  status: 'DEMO ASSUMPTIONS: not a registered methodology',
  unit: 'tCO2e credit',
  activityUnit: 'verified tree-year',
  creditUnit: 'tCO2e',
  kgCO2ePerCredit: 1000,
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
