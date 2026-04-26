/**
 * Top performer profiling with residual close rate (controls for market).
 * Mirrors layer35_profiling/profiler.py.
 */

import { CallRow, FeatureMatrix } from './features.ts';
import { mean, olsWithIntercept } from './stats.ts';

export type AeProfile = {
  aeId: string;
  aeName: string;
  primaryMarket: string;
  totalCalls: number;
  wonCount: number;
  lostCount: number;
  closeRateRaw: number;
  expectedCloseRate: number;
  residual: number;
  residualRank: number;
  isTopPerformer: boolean;
  fingerprint: Record<string, number>; // behavior adoption rate
  pillarAvgs: Record<string, number>;
  strengths: string[]; // behaviors where this AE exceeds top-performer advantages
  gaps: string[]; // behaviors where this AE underperforms
};

export type ProfilingResult = {
  profiles: AeProfile[];
  topAeIds: Set<string>;
  differentials: Record<string, { topRate: number; avgRate: number; delta: number; classification: string }>;
};

// Classification of differences (ported from Python BEHAVIOR_CLASSIFICATION, adapted for our 26 patterns)
const BEHAVIOR_CLASSIFICATION: Record<string, string> = {
  priceAnchor: 'TRAINABLE',
  pricing: 'TRAINABLE',
  companyIntro: 'TRAINABLE',
  socialProof: 'TRAINABLE',
  contentEngine: 'STRUCTURAL',
  vsAgency: 'TRAINABLE',
  aiAngle: 'STRUCTURAL',
  marketContext: 'STRUCTURAL',
  opinionAsk: 'PRACTICE',
  theirBusiness: 'PRACTICE',
  activeListening: 'PRACTICE',
  checkIn: 'PRACTICE',
  challenging: 'PRACTICE',
  dataDriven: 'TRAINABLE',
  roiReframe: 'PRACTICE',
  assumptiveClose: 'PRACTICE',
  urgency: 'INNATE',
  directness: 'INNATE',
  humor: 'INNATE',
  authority: 'INNATE',
  aspiration: 'INNATE',
  research: 'TRAINABLE',
  visibility: 'STRUCTURAL',
  compounding: 'PRACTICE',
  personalStory: 'INNATE',
  contract: 'TRAINABLE',
};

export function profileAes(fm: FeatureMatrix, topPercentile = 0.8): ProfilingResult {
  const { rows, behaviorIds, pillarIds } = fm;

  // Group by AE
  const byAe = new Map<string, CallRow[]>();
  for (const r of rows) {
    const list = byAe.get(r.aeId) ?? [];
    list.push(r);
    byAe.set(r.aeId, list);
  }

  // Build market dummies for residual regression
  const markets = Array.from(new Set(rows.map(r => r.market))).sort();
  const marketCols = markets.slice(1); // drop first as reference

  const X: number[][] = rows.map(r => marketCols.map(m => r.market === m ? 1 : 0));
  const y = rows.map(r => r.outcome);

  const coef = olsWithIntercept(X, y);
  const predict = (row: CallRow) => {
    let p = coef[0];
    for (let j = 0; j < marketCols.length; j++) p += coef[j + 1] * (row.market === marketCols[j] ? 1 : 0);
    return p;
  };

  // Compute residuals at call level
  const residByCall = rows.map(r => r.outcome - predict(r));

  // AE stats
  const aeStats: { aeId: string; aeName: string; market: string; totalCalls: number; closeRate: number; residMean: number; won: number; lost: number }[] = [];
  for (const [aeId, calls] of byAe) {
    const won = calls.filter(c => c.outcome === 1).length;
    const lost = calls.length - won;
    const closeRate = won / calls.length;
    const residMean = mean(calls.map(c => c.outcome - predict(c)));
    const marketCounts: Record<string, number> = {};
    for (const c of calls) marketCounts[c.market] = (marketCounts[c.market] || 0) + 1;
    const primaryMarket = Object.entries(marketCounts).sort((a, b) => b[1] - a[1])[0][0];
    aeStats.push({ aeId, aeName: calls[0].aeName, market: primaryMarket, totalCalls: calls.length, closeRate, residMean, won, lost });
  }

  // Require at least 10 calls for profiling eligibility (matches call-engine's min_calls)
  const eligible = aeStats.filter(s => s.totalCalls >= 10);

  // Rank by residual
  eligible.sort((a, b) => b.residMean - a.residMean);
  const ranks = new Map<string, number>();
  eligible.forEach((s, i) => ranks.set(s.aeId, i + 1));

  // Threshold: top 20% of eligible AEs
  const topN = Math.max(1, Math.floor(eligible.length * (1 - topPercentile)));
  const topAeIds = new Set(eligible.slice(0, topN).map(s => s.aeId));

  // Behavior differentials: top performers vs rest
  const topCalls = rows.filter(r => topAeIds.has(r.aeId));
  const restCalls = rows.filter(r => !topAeIds.has(r.aeId));

  const differentials: ProfilingResult['differentials'] = {};
  for (const b of behaviorIds) {
    const topRate = topCalls.length ? mean(topCalls.map(r => r.patterns[b] || 0)) : 0;
    const avgRate = restCalls.length ? mean(restCalls.map(r => r.patterns[b] || 0)) : 0;
    differentials[b] = {
      topRate: round3(topRate),
      avgRate: round3(avgRate),
      delta: round3(topRate - avgRate),
      classification: BEHAVIOR_CLASSIFICATION[b] || 'PRACTICE',
    };
  }

  // Build per-AE profiles
  const topAdvantages = Object.entries(differentials).filter(([, d]) => d.delta > 0.08).sort((a, b) => b[1].delta - a[1].delta);

  const profiles: AeProfile[] = aeStats.map(s => {
    const calls = byAe.get(s.aeId)!;
    const fingerprint: Record<string, number> = {};
    for (const b of behaviorIds) fingerprint[b] = round3(mean(calls.map(c => c.patterns[b] || 0)));
    const pillarAvgs: Record<string, number> = {};
    for (const p of pillarIds) pillarAvgs[p] = round3(mean(calls.map(c => c.pillars[p] || 0)));

    const strengths = topAdvantages
      .filter(([b, d]) => fingerprint[b] >= d.topRate * 0.9)
      .map(([b]) => b)
      .slice(0, 10);
    const gaps = topAdvantages
      .filter(([b, d]) => fingerprint[b] < d.avgRate * 0.9)
      .map(([b]) => b)
      .slice(0, 10);

    return {
      aeId: s.aeId,
      aeName: s.aeName,
      primaryMarket: s.market,
      totalCalls: s.totalCalls,
      wonCount: s.won,
      lostCount: s.lost,
      closeRateRaw: round3(s.closeRate),
      expectedCloseRate: round3(s.closeRate - s.residMean),
      residual: round3(s.residMean),
      residualRank: ranks.get(s.aeId) ?? 9999,
      isTopPerformer: topAeIds.has(s.aeId),
      fingerprint,
      pillarAvgs,
      strengths,
      gaps,
    };
  });

  profiles.sort((a, b) => a.residualRank - b.residualRank);
  return { profiles, topAeIds, differentials };
}

function round3(x: number): number { return Math.round(x * 1000) / 1000; }
