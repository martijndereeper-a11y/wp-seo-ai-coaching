/**
 * Report generators — 5 markdown reports mirroring call-engine layer5_output.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { FeatureMatrix, CallRow } from './features.ts';
import type { CausalEstimate, QualityAssociation } from './causal.ts';
import type { AeProfile, ProfilingResult } from './profiler.ts';
import { fmtPct, mean } from './stats.ts';

const BEHAVIOR_LABELS: Record<string, string> = {
  humor: 'Humor / rapport',
  aiAngle: 'AI / GEO angle',
  checkIn: 'Check-in with prospect',
  pricing: 'Pricing discussion',
  urgency: 'Urgency creation',
  contract: 'Contract / commitment language',
  research: 'Pre-call research referenced',
  vsAgency: 'vs-agency positioning',
  authority: 'Authority / expertise frame',
  aspiration: 'Aspirational framing',
  dataDriven: 'Data-driven pitch',
  directness: 'Direct / assertive language',
  opinionAsk: 'Ask for opinion',
  roiReframe: 'ROI reframe',
  visibility: 'Search visibility education',
  challenging: 'Challenging prospect thinking',
  compounding: 'Compounding value framing',
  priceAnchor: 'Price anchor (marketing spend)',
  socialProof: 'Social proof / case studies',
  companyIntro: 'Company introduction',
  contentEngine: 'Content-engine demo',
  marketContext: 'Market-context framing',
  personalStory: 'Personal story',
  theirBusiness: 'Discovery of their business',
  activeListening: 'Active listening cues',
  assumptiveClose: 'Assumptive close',
};

function label(b: string): string { return BEHAVIOR_LABELS[b] ?? b; }

function ensureDir(path: string) { mkdirSync(dirname(path), { recursive: true }); }

function write(path: string, content: string) {
  ensureDir(path);
  writeFileSync(path, content);
}

function formatCi(lo: number, hi: number): string {
  return `[${fmtPct(lo)}, ${fmtPct(hi)}]`;
}

// ─── 1. Winning Script Components ─────────────────────────────────────────────

export function writeScriptReport(outDir: string, fm: FeatureMatrix, estimates: CausalEstimate[]): string {
  const overall = estimates.filter(e => e.method === 'within_ae');
  const winning = overall.filter(e => e.classification === 'winning');
  const harmful = overall.filter(e => e.classification === 'harmful');
  const neutral = overall.filter(e => e.classification === 'neutral');

  const lines: string[] = [];
  lines.push('# Winning Script Components');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Analysis Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push(`| Total calls (won+lost, first meetings) | ${fm.rows.length} |`);
  lines.push(`| Won | ${fm.rows.filter(r => r.outcome === 1).length} |`);
  lines.push(`| Lost | ${fm.rows.filter(r => r.outcome === 0).length} |`);
  lines.push(`| Overall close rate | ${(mean(fm.rows.map(r => r.outcome)) * 100).toFixed(1)}% |`);
  lines.push(`| Distinct AEs | ${new Set(fm.rows.map(r => r.aeId)).size} |`);
  lines.push(`| Behaviors tested | ${fm.behaviorIds.length} |`);
  lines.push(`| Estimates (overall) | ${overall.length} (${winning.length} winning · ${harmful.length} harmful · ${neutral.length} neutral) |`);
  lines.push(`| Method | Within-AE Frisch-Waugh-Lovell demeaning |`);
  lines.push(`| CI | Non-parametric bootstrap 95% |`);
  lines.push('');

  lines.push('## Winning Components (CI lower bound > 0)');
  lines.push('');
  if (winning.length === 0) {
    lines.push('_No behaviors reached statistical significance for positive effect across all markets._');
    lines.push('');
    lines.push('This likely reflects that most behaviors have second-order effects that depend on context (market, prospect size, meeting flow), not independent main effects.');
  } else {
    lines.push('| Behavior | Effect | 95% CI | Base→Treated | n (T/C) | AEs | p |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const e of winning) {
      lines.push(`| **${label(e.treatment)}** | ${fmtPct(e.effect)} | ${formatCi(e.ciLower, e.ciUpper)} | ${(e.baseRate * 100).toFixed(0)}% → ${(e.treatedRate * 100).toFixed(0)}% | ${e.nTreated}/${e.nControl} | ${e.nAes} | ${e.pValue ?? 'n/a'} |`);
    }
  }
  lines.push('');

  lines.push('## Harmful Behaviors (CI upper bound < 0)');
  lines.push('');
  if (harmful.length === 0) {
    lines.push('_No behaviors showed a statistically significant negative effect._');
  } else {
    lines.push('| Behavior | Effect | 95% CI | Base→Treated | n (T/C) | AEs | p |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const e of harmful) {
      lines.push(`| **${label(e.treatment)}** | ${fmtPct(e.effect)} | ${formatCi(e.ciLower, e.ciUpper)} | ${(e.baseRate * 100).toFixed(0)}% → ${(e.treatedRate * 100).toFixed(0)}% | ${e.nTreated}/${e.nControl} | ${e.nAes} | ${e.pValue ?? 'n/a'} |`);
    }
  }
  lines.push('');

  lines.push('## No Detectable Effect (CI spans zero)');
  lines.push('');
  if (neutral.length === 0) {
    lines.push('_All behaviors had detectable directional effects._');
  } else {
    lines.push('| Behavior | Effect | 95% CI | n (T/C) |');
    lines.push('|---|---|---|---|');
    for (const e of neutral) {
      lines.push(`| ${label(e.treatment)} | ${fmtPct(e.effect)} | ${formatCi(e.ciLower, e.ciUpper)} | ${e.nTreated}/${e.nControl} |`);
    }
  }
  lines.push('');

  lines.push('## Methodology');
  lines.push('');
  lines.push('Within-AE analysis uses Frisch–Waugh–Lovell demeaning: both treatment and outcome are demeaned by the AE\'s own mean before OLS. This removes all time-invariant AE characteristics (experience, territory, personality) from the estimate. Each AE must have ≥10 won/lost calls and ≥15%/≤85% treatment variation to be included — an AE who always or never uses a behavior provides no within-AE variation.');
  lines.push('');
  lines.push('Confidence intervals are 95% percentile bootstrap over 500 resamples of the demeaned pairs. p-values are two-sided from normal approximation to the t-statistic (valid for our sample sizes).');
  lines.push('');

  const path = join(outDir, 'winning_script_report.md');
  write(path, lines.join('\n'));
  return path;
}

// ─── 2. Market Breakdown ─────────────────────────────────────────────────────

export function writeMarketReport(outDir: string, fm: FeatureMatrix, estimates: CausalEstimate[]): string {
  const lines: string[] = [];
  lines.push('# Market Breakdown (NL vs DE vs EN)');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  const markets = ['NL', 'DE', 'EN', 'OTHER'] as const;
  lines.push('## Call volume and close rate by market');
  lines.push('');
  lines.push('| Market | Calls | Won | Lost | Close rate | Median quality |');
  lines.push('|---|---|---|---|---|---|');
  for (const m of markets) {
    const rs = fm.rows.filter(r => r.market === m);
    if (rs.length === 0) continue;
    const won = rs.filter(r => r.outcome === 1).length;
    const sorted = rs.map(r => r.callQuality).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    lines.push(`| ${m} | ${rs.length} | ${won} | ${rs.length - won} | ${(won / rs.length * 100).toFixed(1)}% | ${median} |`);
  }
  lines.push('');

  for (const m of ['NL', 'DE'] as const) {
    const mkEst = estimates.filter(e => e.context.startsWith(m)).filter(e => e.classification !== 'neutral').sort((a, b) => b.effect - a.effect);
    lines.push(`## ${m} — Behaviors with significant effect (within-AE)`);
    lines.push('');
    if (mkEst.length === 0) {
      lines.push(`_No behaviors reached significance in the ${m} market._`);
    } else {
      lines.push('| Behavior | Effect | CI | n (T/C) | AEs |');
      lines.push('|---|---|---|---|---|');
      for (const e of mkEst) {
        const tag = e.classification === 'winning' ? '✅' : '⛔️';
        lines.push(`| ${tag} ${label(e.treatment)} | ${fmtPct(e.effect)} | ${formatCi(e.ciLower, e.ciUpper)} | ${e.nTreated}/${e.nControl} | ${e.nAes} |`);
      }
    }
    lines.push('');
  }

  // Behavior adoption differential across markets
  lines.push('## Behavior adoption rates across markets');
  lines.push('');
  lines.push('| Behavior | NL adoption | DE adoption | EN adoption |');
  lines.push('|---|---|---|---|');
  const nlRows = fm.rows.filter(r => r.market === 'NL');
  const deRows = fm.rows.filter(r => r.market === 'DE');
  const enRows = fm.rows.filter(r => r.market === 'EN');
  for (const b of fm.behaviorIds) {
    const nl = nlRows.length ? mean(nlRows.map(r => r.patterns[b] || 0)) : 0;
    const de = deRows.length ? mean(deRows.map(r => r.patterns[b] || 0)) : 0;
    const en = enRows.length ? mean(enRows.map(r => r.patterns[b] || 0)) : 0;
    lines.push(`| ${label(b)} | ${(nl * 100).toFixed(0)}% | ${(de * 100).toFixed(0)}% | ${(en * 100).toFixed(0)}% |`);
  }
  lines.push('');

  const path = join(outDir, 'market_report.md');
  write(path, lines.join('\n'));
  return path;
}

// ─── 3. AE Coaching ──────────────────────────────────────────────────────────

export function writeAeCoachingReport(outDir: string, fm: FeatureMatrix, profiling: ProfilingResult, estimates: CausalEstimate[]): string {
  const lines: string[] = [];
  lines.push('# Per-AE Coaching Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('AEs ranked by **residual close rate** — actual outcome minus what their market mix predicts. An AE with a high residual closes more than their market alone would predict.');
  lines.push('');

  lines.push('## Top performers (top 20% by residual)');
  lines.push('');
  lines.push('| Rank | AE | Market | Calls | Won/Lost | Raw close | Residual |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const p of profiling.profiles.filter(p => p.isTopPerformer)) {
    lines.push(`| #${p.residualRank} | **${p.aeName}** | ${p.primaryMarket} | ${p.totalCalls} | ${p.wonCount}/${p.lostCount} | ${(p.closeRateRaw * 100).toFixed(0)}% | ${fmtPct(p.residual)} |`);
  }
  lines.push('');

  // Key behaviors top performers do more
  const winningFromCausal = new Set(estimates.filter(e => e.method === 'within_ae' && e.classification === 'winning').map(e => e.treatment));
  const differentials = Object.entries(profiling.differentials).sort((a, b) => b[1].delta - a[1].delta);

  lines.push('## What top performers do differently (behavior adoption)');
  lines.push('');
  lines.push('Behaviors where the top 20% of AEs (residual-ranked) use them more than the rest. The **Classification** column shows whether this is trainable (workshop), practice (coaching cycles), structural (script/process change), or innate (personality).');
  lines.push('');
  lines.push('| Behavior | Top adoption | Rest adoption | Δ | Causal evidence | Classification |');
  lines.push('|---|---|---|---|---|---|');
  for (const [b, d] of differentials.slice(0, 15)) {
    const causal = winningFromCausal.has(b) ? '✅ winning' : '—';
    const delta = d.delta > 0 ? `+${(d.delta * 100).toFixed(0)}%` : `${(d.delta * 100).toFixed(0)}%`;
    lines.push(`| ${label(b)} | ${(d.topRate * 100).toFixed(0)}% | ${(d.avgRate * 100).toFixed(0)}% | ${delta} | ${causal} | ${d.classification} |`);
  }
  lines.push('');

  lines.push('## Individual AE coaching cards');
  lines.push('');
  for (const p of profiling.profiles) {
    lines.push(`### ${p.aeName} (${p.primaryMarket}) — rank #${p.residualRank}`);
    lines.push('');
    lines.push(`- Calls: **${p.totalCalls}** (${p.wonCount} won / ${p.lostCount} lost)`);
    lines.push(`- Close rate: **${(p.closeRateRaw * 100).toFixed(0)}%** (expected for market mix: ${(p.expectedCloseRate * 100).toFixed(0)}%)`);
    lines.push(`- Residual: **${fmtPct(p.residual)}**${p.isTopPerformer ? ' · **Top performer**' : ''}`);
    const pillarLine = Object.entries(p.pillarAvgs).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(' · ');
    lines.push(`- Pillars: ${pillarLine}`);
    if (p.strengths.length) lines.push(`- **Strengths:** ${p.strengths.map(label).join(', ')}`);
    if (p.gaps.length) lines.push(`- **Gaps (vs top performers):** ${p.gaps.map(label).join(', ')}`);
    lines.push('');
  }

  const path = join(outDir, 'ae_coaching_report.md');
  write(path, lines.join('\n'));
  return path;
}

// ─── 4. Validated Deviations ──────────────────────────────────────────────────

export function writeDeviationReport(outDir: string, fm: FeatureMatrix, estimates: CausalEstimate[], profiling: ProfilingResult): string {
  const lines: string[] = [];
  lines.push('# Validated Deviations');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('A *deviation* is a behavior that is NOT in the core script but appears significantly more in top performers or has a positive within-AE causal effect. These are candidates for promotion into the script.');
  lines.push('');

  const coreScript = new Set(['companyIntro', 'research', 'visibility', 'pricing', 'priceAnchor', 'contentEngine']);
  const topDiffs = Object.entries(profiling.differentials).filter(([b, d]) => d.delta > 0.08 && !coreScript.has(b)).sort((a, b) => b[1].delta - a[1].delta);
  const causalSet = new Set(estimates.filter(e => e.method === 'within_ae' && e.classification === 'winning').map(e => e.treatment));

  lines.push('## Candidate deviations to promote');
  lines.push('');
  lines.push('| Behavior | Top adoption | Rest adoption | Δ | Significant causal effect? |');
  lines.push('|---|---|---|---|---|');
  for (const [b, d] of topDiffs) {
    const flag = causalSet.has(b) ? '✅ yes' : '—';
    lines.push(`| ${label(b)} | ${(d.topRate * 100).toFixed(0)}% | ${(d.avgRate * 100).toFixed(0)}% | +${(d.delta * 100).toFixed(0)}% | ${flag} |`);
  }
  lines.push('');
  lines.push('Deviations flagged with ✅ are **promotable**: causal evidence + top-performer adoption both agree. Deviations without ✅ are worth a coaching experiment.');
  lines.push('');

  // Anti-patterns: top performers do this LESS
  const antiPatterns = Object.entries(profiling.differentials).filter(([, d]) => d.delta < -0.08).sort((a, b) => a[1].delta - b[1].delta);
  lines.push('## Anti-patterns (top performers do LESS of these)');
  lines.push('');
  if (antiPatterns.length === 0) {
    lines.push('_No significant anti-patterns._');
  } else {
    lines.push('| Behavior | Top adoption | Rest adoption | Δ |');
    lines.push('|---|---|---|---|');
    for (const [b, d] of antiPatterns) {
      lines.push(`| ${label(b)} | ${(d.topRate * 100).toFixed(0)}% | ${(d.avgRate * 100).toFixed(0)}% | ${(d.delta * 100).toFixed(0)}% |`);
    }
  }
  lines.push('');

  const path = join(outDir, 'deviation_report.md');
  write(path, lines.join('\n'));
  return path;
}

// ─── 5. Executive Summary ─────────────────────────────────────────────────────

export function writeExecutiveSummary(outDir: string, fm: FeatureMatrix, estimates: CausalEstimate[], profiling: ProfilingResult, quality: QualityAssociation[]): string {
  const lines: string[] = [];
  lines.push('# Call Engine — Executive Summary');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  const won = fm.rows.filter(r => r.outcome === 1).length;
  const overall = estimates.filter(e => e.method === 'within_ae');
  const winning = overall.filter(e => e.classification === 'winning');
  const harmful = overall.filter(e => e.classification === 'harmful');

  // Calibration check: AE win rates that look inflated
  const aeWinRates = profiling.profiles.map(p => p.closeRateRaw);
  const medianWinRate = aeWinRates.length ? aeWinRates.slice().sort((a, b) => a - b)[Math.floor(aeWinRates.length / 2)] : 0;
  const over85 = profiling.profiles.filter(p => p.closeRateRaw > 0.85 && p.totalCalls >= 20).length;

  lines.push('## Dataset');
  lines.push('');
  lines.push(`- **${fm.rows.length}** first-meeting calls with won/lost outcome`);
  lines.push(`- **${won}** won · **${fm.rows.length - won}** lost · **${(won / fm.rows.length * 100).toFixed(1)}%** overall close rate`);
  lines.push(`- **${new Set(fm.rows.map(r => r.market)).size}** markets, **${new Set(fm.rows.map(r => r.aeId)).size}** AEs`);
  lines.push(`- **${profiling.profiles.length}** AEs eligible for profiling (≥10 calls)`);
  lines.push('');

  const isInflated = over85 >= 3 || medianWinRate > 0.6;
  if (isInflated) {
    lines.push('## ⚠️ Outcome calibration warning');
    lines.push('');
    lines.push(`Median AE close rate is **${(medianWinRate * 100).toFixed(0)}%** with **${over85}** AEs above 85% on ≥20 calls. This pattern usually indicates outcome-label inflation — first-meeting → closed-won in B2B SaaS sits well under 50%. Effect sizes below are scaled to whatever the "won" label currently means; recommend re-tagging from HubSpot deal stage before acting on coaching priorities.`);
    lines.push('');
  } else {
    lines.push('## ✅ Outcome calibration');
    lines.push('');
    lines.push(`Median AE close rate is **${(medianWinRate * 100).toFixed(0)}%** with **${over85}** AEs above 85% on ≥20 calls. Distribution looks consistent with closed-won deal labels rather than "positive next step" tags — effect sizes can be read at face value.`);
    lines.push('');
  }

  lines.push('## Top findings');
  lines.push('');
  if (winning.length === 0) {
    lines.push('No behaviors hit the 95% CI positive threshold overall. This is consistent with the calibration warning above (right-censored outcomes compress effect sizes).');
  } else {
    lines.push('Top 5 behaviors with positive within-AE causal effect on close rate:');
    lines.push('');
    for (const e of winning.slice(0, 5)) {
      lines.push(`- **${label(e.treatment)}** — ${fmtPct(e.effect)} ${formatCi(e.ciLower, e.ciUpper)} · ${e.nAes} AEs · p=${e.pValue ?? 'n/a'}`);
    }
  }
  lines.push('');

  if (harmful.length > 0) {
    lines.push('Behaviors with negative causal effect:');
    lines.push('');
    for (const e of harmful.slice(0, 5)) {
      lines.push(`- **${label(e.treatment)}** — ${fmtPct(e.effect)} ${formatCi(e.ciLower, e.ciUpper)} · ${e.nAes} AEs`);
    }
    lines.push('');
  }

  lines.push('## Call quality associations (descriptive, not causal)');
  lines.push('');
  lines.push('Mean call_quality_score when behavior is present vs absent. Useful when outcome labels are noisy.');
  lines.push('');
  lines.push('| Behavior | Used in | With behavior | Without | Δ quality |');
  lines.push('|---|---|---|---|---|');
  for (const q of quality.slice(0, 10)) {
    lines.push(`| ${label(q.behavior)} | ${(q.rateUsed * 100).toFixed(0)}% | ${q.qualityWith.toFixed(1)} | ${q.qualityWithout.toFixed(1)} | ${q.delta > 0 ? '+' : ''}${q.delta.toFixed(1)} |`);
  }
  lines.push('');

  lines.push('## Top 5 AEs (residual rank)');
  lines.push('');
  for (const p of profiling.profiles.slice(0, 5)) {
    lines.push(`- **${p.aeName}** (${p.primaryMarket}) — ${p.totalCalls} calls · raw ${(p.closeRateRaw * 100).toFixed(0)}% · residual ${fmtPct(p.residual)}`);
  }
  lines.push('');

  lines.push('## Ready-to-ship coaching patterns');
  lines.push('');
  const shipReady = Object.entries(profiling.differentials)
    .filter(([b, d]) => d.delta > 0.1)
    .sort((a, b) => b[1].delta - a[1].delta)
    .slice(0, 5);
  if (shipReady.length === 0) {
    lines.push('_No patterns cross the Δ+10% top-vs-rest threshold._');
  } else {
    for (const [b, d] of shipReady) {
      lines.push(`- **${label(b)}**: top performers use this in ${(d.topRate * 100).toFixed(0)}% of calls vs ${(d.avgRate * 100).toFixed(0)}% for the rest (+${(d.delta * 100).toFixed(0)}%). Classification: ${d.classification}.`);
    }
  }
  lines.push('');

  const path = join(outDir, 'executive_summary.md');
  write(path, lines.join('\n'));
  return path;
}
