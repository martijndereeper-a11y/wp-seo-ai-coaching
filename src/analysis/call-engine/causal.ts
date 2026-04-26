/**
 * Run within-AE causal analysis for each binarized behavior.
 * Mirrors layer4_causal orchestration.
 */

import { CallRow, FeatureMatrix } from './features.ts';
import { withinAe, type WithinAeResult } from './stats.ts';

export type CausalEstimate = {
  treatment: string;
  method: 'within_ae' | 'within_ae_by_market';
  context: string;
  effect: number;
  ciLower: number;
  ciUpper: number;
  pValue: number | null;
  nTreated: number;
  nControl: number;
  nAes: number;
  baseRate: number;
  treatedRate: number;
  classification: 'winning' | 'harmful' | 'neutral';
};

function classify(r: WithinAeResult): CausalEstimate['classification'] {
  if (r.ciLower > 0 && r.beta > 0) return 'winning';
  if (r.ciUpper < 0 && r.beta < 0) return 'harmful';
  return 'neutral';
}

export function runCausalAnalysis(fm: FeatureMatrix, minCallsPerAe = 10, minVar = 0.15): CausalEstimate[] {
  const { rows, behaviorIds } = fm;
  const estimates: CausalEstimate[] = [];

  // Overall within-AE per behavior
  for (const b of behaviorIds) {
    const input = rows.map(r => ({ aeId: r.aeId, t: r.patterns[b] || 0, y: r.outcome }));
    const result = withinAe(input, minCallsPerAe, minVar);
    if (!result) continue;
    estimates.push({
      treatment: b,
      method: 'within_ae',
      context: `all_markets (n_aes=${result.nAes})`,
      effect: result.beta,
      ciLower: result.ciLower,
      ciUpper: result.ciUpper,
      pValue: result.pValue,
      nTreated: result.nTreated,
      nControl: result.nControl,
      nAes: result.nAes,
      baseRate: result.baseRate,
      treatedRate: result.treatedRate,
      classification: classify(result),
    });
  }

  // Per-market within-AE (NL and DE have enough volume)
  for (const market of ['NL', 'DE'] as const) {
    const marketRows = rows.filter(r => r.market === market);
    if (marketRows.length < 100) continue;

    for (const b of behaviorIds) {
      const input = marketRows.map(r => ({ aeId: r.aeId, t: r.patterns[b] || 0, y: r.outcome }));
      const result = withinAe(input, minCallsPerAe, minVar);
      if (!result) continue;
      estimates.push({
        treatment: b,
        method: 'within_ae_by_market',
        context: `${market} (n_aes=${result.nAes})`,
        effect: result.beta,
        ciLower: result.ciLower,
        ciUpper: result.ciUpper,
        pValue: result.pValue,
        nTreated: result.nTreated,
        nControl: result.nControl,
        nAes: result.nAes,
        baseRate: result.baseRate,
        treatedRate: result.treatedRate,
        classification: classify(result),
      });
    }
  }

  // Sort by effect size desc
  estimates.sort((a, b) => b.effect - a.effect);
  return estimates;
}

/**
 * Descriptive call-quality associations: for each behavior, mean call_quality for t=1 vs t=0.
 * Provides a second lens alongside win/loss outcome (useful when outcomes are noisy).
 */
export type QualityAssociation = {
  behavior: string;
  rateUsed: number;
  qualityWith: number;
  qualityWithout: number;
  delta: number;
};

export function runQualityAssociations(fm: FeatureMatrix): QualityAssociation[] {
  const { rows, behaviorIds } = fm;
  const out: QualityAssociation[] = [];
  for (const b of behaviorIds) {
    const withIt = rows.filter(r => (r.patterns[b] || 0) >= 1);
    const without = rows.filter(r => (r.patterns[b] || 0) < 1);
    if (withIt.length < 30 || without.length < 30) continue;
    const qWith = avg(withIt.map(r => r.callQuality));
    const qWithout = avg(without.map(r => r.callQuality));
    out.push({
      behavior: b,
      rateUsed: round3(withIt.length / rows.length),
      qualityWith: round1(qWith),
      qualityWithout: round1(qWithout),
      delta: round1(qWith - qWithout),
    });
  }
  out.sort((a, b) => b.delta - a.delta);
  return out;
}

function avg(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function round1(x: number): number { return Math.round(x * 10) / 10; }
function round3(x: number): number { return Math.round(x * 1000) / 1000; }
