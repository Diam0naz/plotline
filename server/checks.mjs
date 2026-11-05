// Automatic checks run on every submission before a human verifier sees it.
// "hard" problems reject the submission outright; "flags" send it to closer manual review.
import { overlapFraction, polygonAreaM2, m2ToHa } from '../core.js';
import { METHODOLOGY as DEFAULT_METHODOLOGY } from './methodology.mjs';

const isInt = (n) => Number.isInteger(n);

export function runChecks({ polygon, planting, survival, bodies, others = [], method = DEFAULT_METHODOLOGY }) {
  const hard = [];
  const flags = [];
  const overlaps = [];

  if (!isInt(planting.count) || planting.count < 1 || planting.count > 1_000_000) {
    hard.push({ code: 'invalid_planting_count', text: 'The planting count must be a whole number of trees' });
  }
  if (!isInt(survival.sampleSize) || survival.sampleSize < 1) {
    hard.push({ code: 'invalid_sample', text: 'The survival check must count at least one tree' });
  }
  if (!isInt(survival.alive) || survival.alive < 0 || survival.alive > survival.sampleSize) {
    hard.push({ code: 'invalid_alive', text: 'Alive trees cannot be more than the trees counted' });
  }
  const [, plantBody, survBody] = bodies;
  if (new Date(plantBody.ts) > new Date(survBody.ts)) {
    hard.push({ code: 'out_of_order', text: 'The survival check is dated before the planting' });
  }

  const areaHa = m2ToHa(polygonAreaM2(polygon));

  // Same land registered twice?
  for (const o of others) {
    if (!o.polygon) continue;
    const frac = Math.max(overlapFraction(polygon, o.polygon), overlapFraction(o.polygon, polygon));
    if (frac >= method.overlap.review) overlaps.push({ plotKey: o.plotKey, fraction: Math.round(frac * 100) / 100 });
    if (frac >= method.overlap.reject) {
      hard.push({ code: 'duplicate_plot', text: `This plot overlaps ${Math.round(frac * 100)}% with a plot already registered` });
    } else if (frac >= method.overlap.review) {
      flags.push({ code: 'plot_overlap', text: `This plot overlaps ${Math.round(frac * 100)}% with a plot already registered` });
    }
  }

  const minQ = Math.min(...bodies.map((b) => b.quality?.score ?? 0));
  if (minQ < method.minQuality) {
    flags.push({ code: 'low_gnss_quality', text: `Weakest GNSS quality score is ${minQ}/100 (review below ${method.minQuality})` });
  }
  if ([plantBody, survBody].some((b) => b.quality?.flags?.includes('outside_boundary'))) {
    flags.push({ code: 'fix_outside_plot', text: 'A planting or survival record was captured outside the plot boundary' });
  }

  if (isInt(planting.count) && planting.count >= 1 && areaHa > 0) {
    const perHa = planting.count / areaHa;
    if (perHa < method.density.minPerHa || perHa > method.density.maxPerHa) {
      flags.push({ code: 'implausible_density', text: `${Math.round(perHa)} trees per hectare is outside the usual ${method.density.minPerHa}-${method.density.maxPerHa} range` });
    }
  }
  if (isInt(survival.sampleSize) && isInt(planting.count)) {
    const needSample = Math.max(method.minSample, Math.ceil(method.minSampleShare * planting.count));
    if (survival.sampleSize < needSample) {
      flags.push({ code: 'small_sample', text: `Only ${survival.sampleSize} trees were counted; at least ${needSample} are expected for this planting` });
    }
  }
  if (isInt(survival.sampleSize) && survival.sampleSize >= 20 && survival.alive === survival.sampleSize) {
    flags.push({ code: 'survival_all_alive', text: 'Every counted tree is alive; a verifier should spot-check' });
  }

  const valid = hard.length === 0;
  const estAlive = valid ? Math.round((planting.count * survival.alive) / survival.sampleSize) : 0;
  return { hard, flags, overlaps, areaHa, estAlive, risk: flags.length ? 'review' : 'low' };
}
