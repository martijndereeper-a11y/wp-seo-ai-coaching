/**
 * Smart Review — Rule-based call analysis engine
 *
 * Generates Koen-style call reviews WITHOUT an LLM.
 * Uses conversation flow analysis, conviction tracking,
 * multi-turn sequence detection, and rich templates.
 *
 * Pure function: no database calls, no async, just computation.
 */

import type { TranscriptTurn } from './transcript-parser.ts';
import type { CallAnalysis } from './pattern-detector.ts';
import { SCRIPT_SECTIONS } from './script-sections.ts';

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface CallPhase {
  name: string;
  timeRange: string;
  aeTalkRatio: number;
  aeQuestions: number;
  prospectQuestions: number;
  prospectLongAnswers: number;
  prospectShortAnswers: number;
  engagement: 'high' | 'neutral' | 'low';
  control: string;
}

export interface ConvictionPoint {
  timestamp: string;
  score: number;
}

export interface ObjectionExchange {
  prospectTimestamp: string;
  prospectSaid: string;
  aeTimestamp: string;
  aeSaid: string;
  handling: 'acknowledged' | 'minimized' | 'talked over' | 'explored' | 'ignored';
  shouldHaveDone: string;
}

export interface BuyingSignalExchange {
  prospectTimestamp: string;
  prospectSaid: string;
  signalType: string;
  aeTimestamp: string;
  aeSaid: string;
  didAdvance: boolean;
  shouldHaveDone: string;
}

export interface ScriptPhaseReview {
  id: number;
  name: string;
  covered: boolean;
  timestamp?: string;
  duration?: string;
  detail: string;
  quality: 'good' | 'ok' | 'weak' | 'skipped';
}

export interface SmartReview {
  summary: string;
  phases: CallPhase[];
  convictionArc: ConvictionPoint[];
  convictionTrend: string;
  peakMoment: string;
  objections: ObjectionExchange[];
  buyingSignals: BuyingSignalExchange[];
  scriptReview: ScriptPhaseReview[];
  criticalMoment: {
    timestamp: string;
    category: string;
    whatHappened: string;
    aeReaction: string;
    shouldHaveDone: string;
  } | null;
  oneThingToChange: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function isAE(turn: TranscriptTurn, recorderName: string): boolean {
  const firstName = recorderName.split(' ')[0].toLowerCase();
  return turn.speaker.toLowerCase().includes(firstName);
}

function isProspect(turn: TranscriptTurn, recorderName: string): boolean {
  return !isAE(turn, recorderName);
}

// ─── 1. Call Phases ──────────────────────────────────────────────────────────

const PHASE_NAMES = ['Opening', 'Discovery', 'Demo/Value', 'Pricing/Close'];

function buildPhases(turns: TranscriptTurn[], recorderName: string): CallPhase[] {
  if (turns.length === 0) return [];

  const chunkSize = Math.max(1, Math.ceil(turns.length / 4));
  const phases: CallPhase[] = [];

  for (let p = 0; p < 4; p++) {
    const start = p * chunkSize;
    const end = Math.min(start + chunkSize, turns.length);
    const chunk = turns.slice(start, end);
    if (chunk.length === 0) continue;

    let aeWords = 0;
    let totalWords = 0;
    let aeQuestions = 0;
    let prospectQuestions = 0;
    let prospectLong = 0;
    let prospectShort = 0;

    for (const t of chunk) {
      totalWords += t.wordCount;
      if (isAE(t, recorderName)) {
        aeWords += t.wordCount;
        if (t.isQuestion) aeQuestions++;
      } else {
        if (t.isQuestion) prospectQuestions++;
        if (t.wordCount > 25) prospectLong++;
        if (t.wordCount < 5) prospectShort++;
      }
    }

    const aeTalkRatio = totalWords > 0 ? Math.round((aeWords / totalWords) * 100) : 0;
    const totalProspectAnswers = prospectLong + prospectShort;

    let engagement: 'high' | 'neutral' | 'low';
    if (totalProspectAnswers > 0 && prospectShort / totalProspectAnswers > 0.6) {
      engagement = 'low';
    } else if (prospectLong > prospectShort && prospectQuestions > 0) {
      engagement = 'high';
    } else {
      engagement = 'neutral';
    }

    let control: string;
    if (aeTalkRatio > 70) control = 'AE dominated';
    else if (aeTalkRatio < 40) control = 'Prospect led';
    else control = 'Balanced';

    const startTime = formatTimestamp(chunk[0].timestampSeconds);
    const endTime = formatTimestamp(chunk[chunk.length - 1].timestampSeconds);

    phases.push({
      name: PHASE_NAMES[p] || `Phase ${p + 1}`,
      timeRange: `${startTime} — ${endTime}`,
      aeTalkRatio,
      aeQuestions,
      prospectQuestions,
      prospectLongAnswers: prospectLong,
      prospectShortAnswers: prospectShort,
      engagement,
      control,
    });
  }

  return phases;
}

// ─── 2. Conviction Arc ──────────────────────────────────────────────────────

const ENTHUSIASM_WORDS = /interessant|goed|mooi|leuk|top|precies|absoluut/gi;
const DOUBT_WORDS = /weet niet|misschien|nadenken|lastig|intern/gi;

function buildConvictionArc(
  turns: TranscriptTurn[],
  recorderName: string,
): { arc: ConvictionPoint[]; trend: string; peakMoment: string } {
  const prospectTurns = turns.filter(t => isProspect(t, recorderName));
  if (prospectTurns.length < 5) {
    return { arc: [], trend: 'sustained', peakMoment: '00:00' };
  }

  const arc: ConvictionPoint[] = [];
  let peakScore = -Infinity;
  let peakTs = '00:00';

  for (let i = 0; i <= prospectTurns.length - 5; i++) {
    const window = prospectTurns.slice(i, i + 5);
    const avgWords = window.reduce((s, t) => s + t.wordCount, 0) / 5;
    const questions = window.filter(t => t.isQuestion).length;
    const combinedText = window.map(t => t.text).join(' ');
    const enthusiasmHits = (combinedText.match(ENTHUSIASM_WORDS) || []).length;
    const doubtHits = (combinedText.match(DOUBT_WORDS) || []).length;

    const score = Math.max(0, Math.round(avgWords / 5 + questions * 2 + enthusiasmHits * 3 - doubtHits * 4));

    const ts = window[Math.floor(window.length / 2)].timestampDisplay;
    arc.push({ timestamp: ts, score });

    if (score > peakScore) {
      peakScore = score;
      peakTs = ts;
    }
  }

  // Determine trend
  const endScore = arc.length > 0 ? arc[arc.length - 1].score : 0;
  let trend: string;
  if (peakScore <= 0) {
    trend = 'declined';
  } else if (endScore > peakScore) {
    trend = 'rose';
  } else if (endScore >= peakScore * 0.8) {
    trend = 'sustained';
  } else if (endScore >= peakScore * 0.5) {
    trend = 'declined';
  } else {
    trend = 'dropped';
  }

  return { arc, trend, peakMoment: peakTs };
}

// ─── 3. Objection Detection ─────────────────────────────────────────────────

interface ObjectionMatch {
  type: string;
  pattern: RegExp;
  shouldHaveDone: string;
}

const OBJECTION_PATTERNS: ObjectionMatch[] = [
  {
    type: 'cost',
    pattern: /te duur|kost veel|budget|te hoog|veel geld/i,
    shouldHaveDone: "Ask: 'Wat zou voor jou een redelijke investering zijn als je zeker wist dat het werkte?' Then anchor against bureau costs.",
  },
  {
    type: 'timing',
    pattern: /niet nu|later|nadenken|intern overleg|na de zomer/i,
    shouldHaveDone: "Ask: 'Wat verandert er over X weken dat we nu niet weten?' Convert vague timing to concrete conditions.",
  },
  {
    type: 'skepticism',
    pattern: /al geprobeerd|werkt niet|twijfel|sceptisch|weet niet of/i,
    shouldHaveDone: "Ask: 'Wat heb je precies geprobeerd en waarom werkte het niet?' Show how this is fundamentally different.",
  },
  {
    type: 'internal',
    pattern: /concurrent|andere partij|al iemand|bureau/i,
    shouldHaveDone: "Ask: 'Welke vragen gaat die persoon stellen? Zal ik er even bij zijn?' Offer to join the internal conversation.",
  },
  {
    type: 'capacity',
    pattern: /geen tijd|te druk|geen mensen|wie doet dat/i,
    shouldHaveDone: "Emphasize that WP SEO AI does everything — 'Wij doen alles. Jullie hoeven alleen goed te keuren.' Remove capacity as a blocker.",
  },
];

function detectObjections(
  turns: TranscriptTurn[],
  recorderName: string,
): ObjectionExchange[] {
  const results: ObjectionExchange[] = [];

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (!isProspect(t, recorderName)) continue;

    for (const obj of OBJECTION_PATTERNS) {
      if (!obj.pattern.test(t.text)) continue;

      // Find the next 1-2 AE turns as response
      const aeTurns: TranscriptTurn[] = [];
      for (let j = i + 1; j < Math.min(i + 4, turns.length); j++) {
        if (isAE(turns[j], recorderName)) {
          aeTurns.push(turns[j]);
          if (aeTurns.length >= 2) break;
        }
      }

      if (aeTurns.length === 0) continue;

      const aeResponse = aeTurns.map(a => a.text).join(' ');
      const aeTimestamp = aeTurns[0].timestampDisplay;

      // Classify handling
      let handling: ObjectionExchange['handling'];
      if (aeResponse.includes('?') && aeResponse.length < 200) {
        handling = 'explored';
      } else if (/snap ik|begrijp ik|klopt|herkenbaar|logisch/i.test(aeResponse)) {
        handling = 'acknowledged';
      } else if (/maar dat is maar|heel eenvoudig|maakt niet uit|valt mee/i.test(aeResponse)) {
        handling = 'minimized';
      } else if (aeResponse.split(/\s+/).length > 50 && !aeResponse.includes('?')) {
        handling = 'talked over';
      } else {
        // Check if AE changed topic entirely (no keywords from the objection type)
        const objectText = t.text.toLowerCase();
        const responseText = aeResponse.toLowerCase();
        const sharedWords = objectText.split(/\s+/).filter(w => w.length > 3 && responseText.includes(w));
        handling = sharedWords.length < 2 ? 'ignored' : 'acknowledged';
      }

      results.push({
        prospectTimestamp: t.timestampDisplay,
        prospectSaid: t.text.slice(0, 200),
        aeTimestamp,
        aeSaid: aeResponse.slice(0, 300),
        handling,
        shouldHaveDone: obj.shouldHaveDone,
      });

      break; // One objection type per turn
    }

    if (results.length >= 5) break;
  }

  return results;
}

// ─── 4. Buying Signal Detection ──────────────────────────────────────────────

interface SignalMatch {
  type: string;
  pattern: RegExp;
}

const BUYING_SIGNAL_PATTERNS: SignalMatch[] = [
  { type: 'pricing', pattern: /hoeveel kost|wat kost|prijs|tarief|budget|investering/i },
  { type: 'timing', pattern: /wanneer starten|hoe snel|planning|implementatie/i },
  { type: 'implementation', pattern: /hoe werkt|onboarding|koppeling|technisch|wordpress/i },
  { type: 'comparison', pattern: /verschil met|versus|anders dan/i },
  { type: 'commitment', pattern: /als we|wanneer we|stel dat we/i },
];

const ADVANCE_PATTERNS = /pakket|starten|contract|volgende stap|wanneer|welk|inplannen/i;

function detectBuyingSignals(
  turns: TranscriptTurn[],
  recorderName: string,
): BuyingSignalExchange[] {
  const results: BuyingSignalExchange[] = [];

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (!isProspect(t, recorderName)) continue;

    for (const sig of BUYING_SIGNAL_PATTERNS) {
      if (!sig.pattern.test(t.text)) continue;

      // Find next AE turn
      let aeResponse: TranscriptTurn | null = null;
      for (let j = i + 1; j < Math.min(i + 4, turns.length); j++) {
        if (isAE(turns[j], recorderName)) {
          aeResponse = turns[j];
          break;
        }
      }

      if (!aeResponse) continue;

      const didAdvance = ADVANCE_PATTERNS.test(aeResponse.text);
      const signalLabel = sig.type.charAt(0).toUpperCase() + sig.type.slice(1);

      results.push({
        prospectTimestamp: t.timestampDisplay,
        prospectSaid: t.text.slice(0, 200),
        signalType: signalLabel,
        aeTimestamp: aeResponse.timestampDisplay,
        aeSaid: aeResponse.text.slice(0, 300),
        didAdvance,
        shouldHaveDone: `The prospect asked about ${sig.type}. This means they're mentally evaluating. Answer briefly, then advance: 'Goed dat je dat vraagt. [brief answer]. Zullen we even kijken welk pakket het beste past?'`,
      });

      break; // One signal type per turn
    }

    if (results.length >= 5) break;
  }

  return results;
}

// ─── 5. Script Phase Review ─────────────────────────────────────────────────

const SKIPPED_PRESCRIPTIONS: Record<number, string> = {
  1: "Tell the Mikael story — 'Onze oprichter zag dat SEO alleen werkte voor grote bedrijven. Dus bouwde hij een interne tool. Die tool is WP SEO AI.' Takes 30 seconds, builds credibility.",
  2: "Show the market is shifting — '17% van alle zoekopdrachten gaat nu via ChatGPT. 92% is long-tail. De vraag is niet of dit relevant is, maar of jullie daarin worden meegenomen.'",
  3: "Bridge from AI to SEO — 'AI Search bouwt voort op SEO-fundamenten. De basis moet kloppen.'",
  4: "Ask what they use now — 'Welke tools gebruiken jullie nu voor SEO?' Creates the gap between DIY and managed.",
  5: "Drop the stat — '96,55% van alle content krijgt nooit één bezoeker.' Let it sink in.",
  6: "Make them feel it — '3-4 uur per artikel, van onderzoek tot publicatie. En dan scoort 9 van de 10 niet.'",
  7: "Show the sitemap flow live on their website. This is the #1 aha-moment. Don't skip it.",
  8: "Explain the quality gate — 'Je krijgt een pling als een artikel scoort. Pas na jouw goedkeuring gaat het live.'",
  9: "Explain topic clusters — 'Elk artikel is een deurtje naar je website. Samen bouwen ze autoriteit.'",
  10: "Use the metaphor — 'In 1999 kon je met een simpele website groot worden. Dat window is er nu weer. Eerste movers winnen.'",
  11: "Set expectations — 'Dit is een sneeuwbal. Eerste 3 maanden: fundament. Maand 6-9: versnelling. Na 12 maanden: 60% groei.'",
  12: "Anchor before revealing — 'Een bureau kost €3-5K. Bij ons vanaf €625, en wij doen alles.' Frame as investment, not cost.",
};

function buildScriptReview(
  turns: TranscriptTurn[],
  recorderName: string,
): ScriptPhaseReview[] {
  const aeTurns = turns.filter(t => isAE(t, recorderName));
  const reviews: ScriptPhaseReview[] = [];

  for (const section of SCRIPT_SECTIONS) {
    let firstMatch: TranscriptTurn | null = null;
    let firstMatchIndex = -1;

    // Search AE turns for keyword match
    for (let i = 0; i < aeTurns.length; i++) {
      if (section.keywords.test(aeTurns[i].text)) {
        firstMatch = aeTurns[i];
        firstMatchIndex = i;
        break;
      }
      // Reset lastIndex for global regexps
      section.keywords.lastIndex = 0;
    }
    // Reset lastIndex after loop
    section.keywords.lastIndex = 0;

    if (firstMatch) {
      // Estimate duration: time until next section match or +2 minutes
      let endTime = firstMatch.timestampSeconds + 120;
      if (firstMatchIndex + 1 < aeTurns.length) {
        endTime = aeTurns[Math.min(firstMatchIndex + 5, aeTurns.length - 1)].timestampSeconds;
      }
      const durationSecs = Math.max(0, endTime - firstMatch.timestampSeconds);
      const durationMin = Math.floor(durationSecs / 60);
      const durationSec = durationSecs % 60;

      // Check quality: did prospect react? Find the next prospect turn
      const matchInAllTurns = turns.indexOf(firstMatch);
      let quality: ScriptPhaseReview['quality'] = 'ok';
      if (matchInAllTurns >= 0) {
        for (let j = matchInAllTurns + 1; j < Math.min(matchInAllTurns + 4, turns.length); j++) {
          if (isProspect(turns[j], recorderName)) {
            if (turns[j].wordCount > 20) quality = 'good';
            else if (turns[j].wordCount < 5) quality = 'weak';
            break;
          }
        }
      }

      reviews.push({
        id: section.id,
        name: section.name,
        covered: true,
        timestamp: firstMatch.timestampDisplay,
        duration: `${durationMin}m${String(durationSec).padStart(2, '0')}s`,
        detail: firstMatch.text.slice(0, 200),
        quality,
      });
    } else {
      reviews.push({
        id: section.id,
        name: section.name,
        covered: false,
        detail: SKIPPED_PRESCRIPTIONS[section.id] || `Section "${section.name}" was not covered.`,
        quality: 'skipped',
      });
    }
  }

  return reviews;
}

// ─── 6. Critical Moment ─────────────────────────────────────────────────────

const CRITICAL_PRIORITY: string[] = [
  'Missed Buy Signal',
  'Accepted Think-It-Over',
  'No Close',
  'Pricing Without ROI',
  'No Summary Before Pitch',
  'Long Monologue',
];

function findCriticalMoment(
  analysis: CallAnalysis,
): SmartReview['criticalMoment'] {
  if (!analysis.highlights || analysis.highlights.length === 0) return null;

  // Sort highlights by priority
  let best = analysis.highlights[0];
  let bestPriority = CRITICAL_PRIORITY.length + 1;

  for (const h of analysis.highlights) {
    const idx = CRITICAL_PRIORITY.findIndex(
      p => h.category.toLowerCase().includes(p.toLowerCase()),
    );
    const priority = idx >= 0 ? idx : CRITICAL_PRIORITY.length;
    if (priority < bestPriority) {
      bestPriority = priority;
      best = h;
    }
  }

  return {
    timestamp: best.timestampDisplay,
    category: best.category,
    whatHappened: best.description,
    aeReaction: best.context?.after?.text || best.excerpt || 'No specific reaction captured.',
    shouldHaveDone: best.context?.shouldHaveDone || best.guidance,
  };
}

// ─── 7. One Thing To Change ─────────────────────────────────────────────────

function pickOneThingToChange(
  analysis: CallAnalysis,
  phases: CallPhase[],
): string {
  const { patterns, talkRatio, questionCount } = analysis;

  if (talkRatio > 70) {
    return `Talk less. At ${talkRatio}%, you're lecturing. The prospect needs space to think out loud. Aim for 55%. Every minute you talk past 55% is a minute the prospect disengages.`;
  }

  const hasClose = patterns.assumptiveClose > 0 || patterns.contract > 0;
  if (!hasClose) {
    return "Close every call. Practice: 'Wat is er nodig om volgende week te starten?' You don't need permission to close — the prospect expects it.";
  }

  if (questionCount < 12) {
    return `Ask more questions before pitching. You asked ${questionCount} — top performers ask 22+. Prepare 5 discovery questions about their current situation before every call.`;
  }

  if (patterns.contentEngine < 3) {
    return "Explain the product more clearly. The prospect needs to understand what they're buying — walk through the content engine, sitemap demo, and pling flow.";
  }

  if (patterns.roiReframe === 0 && patterns.pricing > 0) {
    return "Frame price as investment before revealing numbers. Say: 'Een bureau kost €3-5K per maand. Bij ons vanaf €625.' Without the anchor, any price feels high.";
  }

  // Check for prospect disengagement
  const lastPhase = phases.length > 0 ? phases[phases.length - 1] : null;
  if (lastPhase && lastPhase.engagement === 'low') {
    return "The prospect checked out toward the end. Check in more often: 'Is dit relevant voor jullie situatie?' If you sense silence, pause and ask — don't pitch harder.";
  }

  return "Convert interest into action. Every call should end with a clear next step: a package selection, a follow-up meeting, or a contract send. Don't let 'interessant' be the final word.";
}

// ─── 8. Summary ─────────────────────────────────────────────────────────────

function buildSummary(
  turns: TranscriptTurn[],
  recorderName: string,
  analysis: CallAnalysis,
  callDurationSeconds: number,
  phases: CallPhase[],
  convictionTrend: string,
  objections: ObjectionExchange[],
  buyingSignals: BuyingSignalExchange[],
): string {
  const durationMin = Math.round(callDurationSeconds / 60);

  // Who controlled
  const overallAERatio = analysis.talkRatio;
  let controlDesc: string;
  if (overallAERatio > 70) controlDesc = `The AE dominated at ${overallAERatio}% talk time`;
  else if (overallAERatio > 60) controlDesc = `The AE talked more than ideal at ${overallAERatio}%`;
  else if (overallAERatio < 40) controlDesc = 'The prospect led most of the conversation';
  else controlDesc = `Talk balance was reasonable at ${overallAERatio}%`;

  // Discovery quality
  let discoveryDesc: string;
  if (analysis.questionCount >= 20) discoveryDesc = `Strong discovery with ${analysis.questionCount} questions`;
  else if (analysis.questionCount >= 12) discoveryDesc = `Adequate discovery (${analysis.questionCount} questions)`;
  else discoveryDesc = `Shallow discovery — only ${analysis.questionCount} questions asked`;

  // Prospect engagement
  let engagementDesc: string;
  if (convictionTrend === 'rose') engagementDesc = 'Prospect engagement grew throughout';
  else if (convictionTrend === 'sustained') engagementDesc = 'Prospect stayed engaged';
  else if (convictionTrend === 'declined') engagementDesc = 'Prospect engagement faded toward the end';
  else engagementDesc = 'Prospect disengaged midway and never recovered';

  // How it ended
  let endDesc: string;
  const hasClose = analysis.patterns.assumptiveClose > 0 || analysis.patterns.contract > 0;
  if (hasClose && buyingSignals.length > 0) {
    endDesc = 'Call ended with a close attempt and buying signals were present.';
  } else if (hasClose) {
    endDesc = 'Close was attempted.';
  } else if (objections.length > 0) {
    endDesc = `Call ended with ${objections.length} unresolved objection(s) and no close.`;
  } else {
    endDesc = 'No clear close was attempted.';
  }

  return `${durationMin}-minute call. ${controlDesc}. ${discoveryDesc}. ${engagementDesc}. ${endDesc}`;
}

// ─── Main Export ─────────────────────────────────────────────────────────────

export function generateSmartReview(
  turns: TranscriptTurn[],
  recorderName: string,
  analysis: CallAnalysis,
  callDurationSeconds: number,
): SmartReview {
  const phases = buildPhases(turns, recorderName);
  const { arc, trend, peakMoment } = buildConvictionArc(turns, recorderName);
  const objections = detectObjections(turns, recorderName);
  const buyingSignals = detectBuyingSignals(turns, recorderName);
  const scriptReview = buildScriptReview(turns, recorderName);
  const criticalMoment = findCriticalMoment(analysis);
  const oneThingToChange = pickOneThingToChange(analysis, phases);
  const summary = buildSummary(
    turns,
    recorderName,
    analysis,
    callDurationSeconds,
    phases,
    trend,
    objections,
    buyingSignals,
  );

  return {
    summary,
    phases,
    convictionArc: arc,
    convictionTrend: trend,
    peakMoment,
    objections,
    buyingSignals,
    scriptReview,
    criticalMoment,
    oneThingToChange,
  };
}
