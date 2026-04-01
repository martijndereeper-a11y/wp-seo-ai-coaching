/**
 * Koen's 5 Coaching Pillars
 *
 * Replaces generic quality scores with diagnostic pillar ratings.
 * Each call and each AE gets scored on 5 pillars that map to
 * Koen's coaching framework.
 */

import type { TranscriptTurn } from './transcript-parser.ts';

export interface PillarScore {
  name: string;
  score: number;      // 0-100
  level: 'strong' | 'developing' | 'needs work';
  evidence: string;   // one-line explanation
}

export interface PillarScores {
  control: PillarScore;
  discovery: PillarScore;
  gapCreation: PillarScore;
  objectionHandling: PillarScore;
  advancement: PillarScore;
}

/**
 * Score a call on Koen's 5 pillars.
 * Uses existing analysis data — no LLM needed.
 */
export function scoreCallPillars(
  talkRatio: number,
  questionCount: number,
  patterns: Record<string, number>,
  highlights: { type: string; category: string }[],
  callVerdict: string[],
  scriptSectionsHit: number[],
  prospectEngagement: { buyingSignals?: number; redFlags?: number; engagementIndicators?: number; score?: string } | null,
  smartReview?: { phases?: { control: string; engagement: string }[]; objections?: { handling: string }[]; buyingSignals?: { didAdvance: boolean }[] },
): PillarScores {

  const vd = Array.isArray(callVerdict) ? callVerdict : [];
  const hl = highlights || [];
  const p = patterns || {};
  const pe = prospectEngagement || {};
  const sr = smartReview || {};

  // ── 1. CONTROL: Does the AE lead the conversation? ──
  // Good: 45-60% talk ratio, check-ins, agenda setting, redirecting
  // Bad: >70% (monologuing) or <30% (passive)
  let controlScore = 50;
  // Talk ratio sweet spot: 45-55% is ideal
  const talkDiff = Math.abs(talkRatio - 50);
  controlScore += Math.max(0, 25 - talkDiff); // up to +25 for perfect ratio
  // Check-ins show pace control
  controlScore += Math.min(15, (p.checkIn || 0) * 5);
  // Excessive monologues hurt control
  const monologues = hl.filter(h => h.category === 'Long Monologue').length;
  controlScore -= monologues * 5;
  // If prospect led most phases (from smart review)
  if (sr.phases) {
    const prospectLed = sr.phases.filter(ph => ph.control === 'Prospect led').length;
    controlScore -= prospectLed * 8;
  }
  controlScore = Math.max(0, Math.min(100, controlScore));

  // ── 2. DISCOVERY: Do they understand the prospect? ──
  // Good: 18+ questions, hypothesis-led, prospect gives long answers
  // Bad: <10 questions, jumped straight to pitch
  let discoveryScore = 0;
  // Question count (target: 22, minimum: 12)
  discoveryScore += Math.min(40, Math.round((questionCount / 22) * 40));
  // Open discovery questions
  discoveryScore += Math.min(10, (p.openDiscovery || 0) * 5);
  // Talked about their business
  discoveryScore += Math.min(15, (p.theirBusiness || 0) * 5);
  // Active listening
  discoveryScore += Math.min(15, (p.activeListening || 0) * 5);
  // Research shown
  discoveryScore += Math.min(10, (p.research || 0) * 5);
  // Penalty: no summary before pitch
  if (hl.some(h => h.category === 'No Summary Before Pitch')) discoveryScore -= 10;
  // Penalty: insufficient discovery verdict
  if (vd.includes('Insufficient discovery')) discoveryScore -= 15;
  discoveryScore = Math.max(0, Math.min(100, discoveryScore));

  // ── 3. GAP CREATION: Does the prospect see the problem? ──
  // Good: live proof, 96.55% stat, sitemap demo, prospect engagement rises
  // Bad: abstract "vindbaarheid", no concrete proof
  let gapScore = 0;
  // Key script sections that create the gap
  const gapSections = new Set(scriptSectionsHit || []);
  if (gapSections.has(2)) gapScore += 15;  // AI Search shift
  if (gapSections.has(5)) gapScore += 15;  // 96.55% stat
  if (gapSections.has(6)) gapScore += 10;  // Manual pain
  if (gapSections.has(7)) gapScore += 20;  // Sitemap demo
  if (gapSections.has(8)) gapScore += 10;  // Pling flow
  if (gapSections.has(9)) gapScore += 10;  // Topic clusters
  // Live proof shown
  if (hl.some(h => h.category === 'Live Proof')) gapScore += 15;
  // Market context set
  gapScore += Math.min(10, (p.marketContext || 0) * 2);
  // Penalty: too abstract
  const tooAbstract = hl.filter(h => h.category === 'Too Abstract').length;
  gapScore -= tooAbstract * 10;
  gapScore = Math.max(0, Math.min(100, gapScore));

  // ── 4. OBJECTION HANDLING: Do they resolve concerns? ──
  // Good: explored, acknowledged, stacked objections
  // Bad: minimized, talked over, ignored, accepted think-it-over
  let objScore = 50; // start neutral
  if (sr.objections && sr.objections.length > 0) {
    const explored = sr.objections.filter(o => o.handling === 'explored' || o.handling === 'acknowledged').length;
    const bad = sr.objections.filter(o => o.handling === 'minimized' || o.handling === 'talked over' || o.handling === 'ignored').length;
    const ratio = sr.objections.length > 0 ? explored / sr.objections.length : 0.5;
    objScore = Math.round(ratio * 80) + 10; // 10-90 range based on handling quality
    objScore -= bad * 5;
  }
  // Penalty: minimizing concerns
  if (hl.some(h => h.category === 'Minimizing Concern')) objScore -= 10;
  // Penalty: accepted think-it-over without probing
  if (hl.some(h => h.category === 'Accepted Think-It-Over')) objScore -= 15;
  // Bonus: challenging beliefs
  if (hl.some(h => h.category === 'Challenging Belief')) objScore += 10;
  // ROI reframing (handles price objection)
  objScore += Math.min(10, (p.roiReframe || 0) * 5);
  objScore = Math.max(0, Math.min(100, objScore));

  // ── 5. ADVANCEMENT: Does every call end with a next step? ──
  // Good: close language, assumptive close, next step defined, urgency
  // Bad: no close, "laat maar weten", missed buying signals
  let advScore = 0;
  // Close language used
  advScore += Math.min(25, (p.contract || 0) * 10);
  // Assumptive close
  advScore += Math.min(20, (p.assumptiveClose || 0) * 10);
  // Urgency created
  advScore += Math.min(15, (p.urgency || 0) * 5);
  // Price anchoring
  advScore += Math.min(10, (p.priceAnchor || 0) * 5);
  // Buying signals captured
  if (sr.buyingSignals) {
    const advanced = sr.buyingSignals.filter(bs => bs.didAdvance).length;
    advScore += Math.min(15, advanced * 5);
    const missed = sr.buyingSignals.filter(bs => !bs.didAdvance).length;
    advScore -= missed * 5;
  }
  // Captured buy signal highlight
  if (hl.some(h => h.category === 'Captured Buy Signal')) advScore += 10;
  // Penalties
  if (vd.includes('Never attempted to close')) advScore -= 20;
  if (hl.some(h => h.category === 'No Close')) advScore -= 15;
  if (hl.some(h => h.category === 'Missed Buy Signal')) advScore -= 10;
  if (hl.some(h => h.category === 'Price Without Anchor')) advScore -= 5;
  if (vd.includes('Pricing without ROI framing')) advScore -= 10;
  advScore = Math.max(0, Math.min(100, advScore));

  // Convert to levels
  function toLevel(score: number): 'strong' | 'developing' | 'needs work' {
    if (score >= 65) return 'strong';
    if (score >= 40) return 'developing';
    return 'needs work';
  }

  function toEvidence(pillar: string, score: number, details: string[]): string {
    const relevant = details.filter(Boolean).slice(0, 2);
    return relevant.join('. ') || (score >= 65 ? 'Performing well' : score >= 40 ? 'Room for improvement' : 'Needs focused coaching');
  }

  return {
    control: {
      name: 'Control',
      score: controlScore,
      level: toLevel(controlScore),
      evidence: toEvidence('control', controlScore, [
        talkRatio > 65 ? `Talk ratio ${talkRatio}% — dominating conversation` : talkRatio < 35 ? `Talk ratio ${talkRatio}% — too passive` : `Talk ratio ${talkRatio}% — balanced`,
        monologues > 2 ? `${monologues} long monologues` : '',
        (p.checkIn || 0) >= 2 ? `${p.checkIn} check-ins — good pace control` : '',
      ]),
    },
    discovery: {
      name: 'Discovery',
      score: discoveryScore,
      level: toLevel(discoveryScore),
      evidence: toEvidence('discovery', discoveryScore, [
        questionCount >= 20 ? `${questionCount} questions — strong discovery` : questionCount >= 12 ? `${questionCount} questions — adequate` : `Only ${questionCount} questions — needs more depth`,
        (p.theirBusiness || 0) > 0 ? 'Referenced prospect business' : 'Never talked about prospect business',
        (p.research || 0) > 0 ? 'Showed preparation' : '',
      ]),
    },
    gapCreation: {
      name: 'Gap Creation',
      score: gapScore,
      level: toLevel(gapScore),
      evidence: toEvidence('gap', gapScore, [
        gapSections.has(7) ? 'Sitemap demo shown' : 'Sitemap demo skipped',
        gapSections.has(5) ? 'Used 96.55% stat' : '',
        hl.some(h => h.category === 'Live Proof') ? 'Showed live proof' : 'No live proof',
        tooAbstract > 0 ? `${tooAbstract}x used vague "vindbaarheid"` : '',
      ]),
    },
    objectionHandling: {
      name: 'Objection Handling',
      score: objScore,
      level: toLevel(objScore),
      evidence: toEvidence('objections', objScore, [
        hl.some(h => h.category === 'Accepted Think-It-Over') ? 'Accepted "need to think" without probing' : '',
        hl.some(h => h.category === 'Minimizing Concern') ? 'Minimized prospect concerns' : '',
        hl.some(h => h.category === 'Challenging Belief') ? 'Challenged prospect assumptions' : '',
        (p.roiReframe || 0) > 0 ? `ROI reframed ${p.roiReframe}x` : 'No ROI reframing',
      ]),
    },
    advancement: {
      name: 'Advancement',
      score: advScore,
      level: toLevel(advScore),
      evidence: toEvidence('advancement', advScore, [
        (p.contract || 0) > 0 ? 'Used close language' : 'No close language',
        hl.some(h => h.category === 'No Close') ? 'Call ended without next step' : '',
        hl.some(h => h.category === 'Captured Buy Signal') ? 'Captured buying signal' : '',
        hl.some(h => h.category === 'Missed Buy Signal') ? 'Missed buying signal' : '',
        (p.urgency || 0) > 0 ? `Created urgency ${p.urgency}x` : 'No urgency created',
      ]),
    },
  };
}

/**
 * Aggregate pillar scores across multiple calls for an AE profile.
 */
export function aggregatePillars(pillarsList: PillarScores[]): PillarScores {
  if (pillarsList.length === 0) {
    const empty: PillarScore = { name: '', score: 0, level: 'needs work', evidence: 'No data' };
    return { control: { ...empty, name: 'Control' }, discovery: { ...empty, name: 'Discovery' }, gapCreation: { ...empty, name: 'Gap Creation' }, objectionHandling: { ...empty, name: 'Objection Handling' }, advancement: { ...empty, name: 'Advancement' } };
  }

  function avgPillar(key: keyof PillarScores): PillarScore {
    const scores = pillarsList.map(p => p[key].score);
    const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    const level = avg >= 65 ? 'strong' : avg >= 40 ? 'developing' : 'needs work';
    // Find most common evidence
    const name = pillarsList[0][key].name;
    return { name, score: avg, level: level as any, evidence: `Average score: ${avg} across ${pillarsList.length} calls` };
  }

  return {
    control: avgPillar('control'),
    discovery: avgPillar('discovery'),
    gapCreation: avgPillar('gapCreation'),
    objectionHandling: avgPillar('objectionHandling'),
    advancement: avgPillar('advancement'),
  };
}
