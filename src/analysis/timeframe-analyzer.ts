/**
 * Timeframe Analyzer
 *
 * Slices call transcripts into arbitrary time windows and computes
 * per-window metrics, patterns, and engagement. Supports comparison
 * across calls (won vs lost, AE vs AE) for the same time window.
 *
 * Pure function: no database calls, no async, just computation.
 */

import type { TranscriptTurn, SpeakerStats } from './transcript-parser.ts';
import type { PatternScores } from './pattern-detector.ts';

// ─── Interfaces ────────────────────────────────────────────────────────────

export interface TimeWindow {
  startSeconds: number;
  endSeconds: number;
  label: string;
}

export interface TimeframeMetrics {
  talkRatio: number;                // AE talk percentage (0-100)
  questionCount: number;            // AE questions
  prospectQuestionCount: number;
  wordsPerMinute: number;           // Overall pace
  turnCount: number;                // Total turns in window
  aeTurnCount: number;
  prospectTurnCount: number;
  avgTurnLength: number;            // Avg words per turn (all speakers)
  aeAvgTurnLength: number;
  prospectAvgTurnLength: number;
  longestMonologue: number;         // Consecutive words by one speaker
  controlShifts: number;            // Speaker changes
  totalWords: number;
  aeWords: number;
  prospectWords: number;
  durationSeconds: number;          // Actual duration of this window
}

export interface TimeframeEngagement {
  prospectLongAnswers: number;      // >25 words
  prospectShortAnswers: number;     // <5 words
  prospectAvgLength: number;        // Avg prospect turn length
  level: 'high' | 'neutral' | 'low';
}

export interface TimeframePatterns {
  scores: Partial<PatternScores>;
  topDimensions: string[];          // Top 5 pattern dimensions active in window
}

export interface TimeframeAnalysis {
  window: TimeWindow;
  metrics: TimeframeMetrics;
  engagement: TimeframeEngagement;
  patterns: TimeframePatterns;
  turnSample: Array<{              // First/last few turns for context
    timestamp: string;
    speaker: string;
    text: string;
    isQuestion: boolean;
  }>;
}

export interface TimeframeComparison {
  label: string;
  window: TimeWindow;
  groups: Array<{
    name: string;                   // e.g. "Won", "Lost", or AE name
    callCount: number;
    avgMetrics: TimeframeMetrics;
    avgEngagement: TimeframeEngagement;
    avgPatterns: Partial<PatternScores>;
  }>;
  deltas: Record<string, number>;   // Key metric differences (group[0] - group[1])
  insights: string[];               // Auto-generated insights
}

// ─── Pattern regex (subset of pattern-detector, inlined to avoid coupling) ──

const TIMEFRAME_PATTERNS: Record<string, RegExp> = {
  marketContext: /zoekgedrag|google|chatgpt|ai overviews|perplexity|zoekmarkt|seo.*verandert|online.*vindbaar/gi,
  contentEngine: /content|blog|artik|publicer|schrijven|tekst|pagina.*per.*maand/gi,
  visibility: /vindbaar|zichtbaar|gevonden.*worden|zoekresultat|ranking|positie|organisch/gi,
  dataDriven: /data|analys|meten|dashboard|rapportage|inzicht|tracking|monitor/gi,
  aiAngle: /\bai\b|ai.gedreven|kunstmatige|artificial/gi,
  socialProof: /\d+.*klanten|\d+.*bedrijven|2000|tweeduizend|duizend.*klant/gi,
  activeListening: /als.*ik.*het.*goed.*begrijp|dus.*je.*zegt|interessant|goed.*punt|snap.*ik|herkenbaar/gi,
  roiReframe: /investering|verdien.*terug|roi|terugverdien|waarde.*versus/gi,
  urgency: /snel|direct|meteen|zo snel mogelijk|nu.*het.*moment|wachten.*kost/gi,
  contract: /contract|onderteken|sign|overeenkomst|akkoord|bevestig/gi,
  pricing: /prijs|pricing|budget|offerte|kosten|pakket|tarief|investering|€|\d+.*euro/gi,
  theirBusiness: /jullie.*klant|jullie.*markt|jullie.*concurrent|jullie.*product|jullie.*dienst|jullie.*omzet|jullie.*groei/gi,
  checkIn: /gaat.*te snel|nog.*mee|duidelijk|alles.*helder|vragen.*tot.*nu|tot zover/gi,
  opinionAsk: /wat denk je|wat vind je|hoe klinkt|hoe.*kijk.*je|wat.*zegt.*gevoel/gi,
  research: /ik.*zag.*op.*jullie|ik.*keek.*naar|ik.*heb.*gekeken|jullie.*website|jullie.*linkedin/gi,
  priceAnchor: /bureau.*kost|normaal.*kost|vergelijk|als.*je.*kijkt.*naar|wat.*je.*nu.*betaalt|bespaart/gi,
  assumptiveClose: /wanneer.*starten|welk.*pakket|als we.*beginnen|als we.*starten|ik stuur.*contract|volgende stap.*is/gi,
  challenging: /maar.*dan|waarom.*niet|wat.*houdt.*tegen|wat.*weerhoudt|als.*niet.*dan|stel.*dat/gi,
};

// ─── Preset Windows ────────────────────────────────────────────────────────

export const PRESET_WINDOWS: Record<string, (durationSeconds: number) => TimeWindow> = {
  'full':     (d) => ({ startSeconds: 0, endSeconds: d, label: 'Full Call' }),
  'opening':  (d) => ({ startSeconds: 0, endSeconds: Math.min(300, d), label: 'Opening (0:00–5:00)' }),
  'discovery': (d) => ({ startSeconds: 300, endSeconds: Math.min(900, d), label: 'Discovery (5:00–15:00)' }),
  'mid':      (d) => ({ startSeconds: Math.floor(d * 0.25), endSeconds: Math.floor(d * 0.75), label: 'Middle 50%' }),
  'close':    (d) => ({ startSeconds: Math.max(0, d - 300), endSeconds: d, label: `Close (last 5 min)` }),
  'first-half':  (d) => ({ startSeconds: 0, endSeconds: Math.floor(d / 2), label: 'First Half' }),
  'second-half': (d) => ({ startSeconds: Math.floor(d / 2), endSeconds: d, label: 'Second Half' }),
  'q1':  (d) => ({ startSeconds: 0, endSeconds: Math.floor(d * 0.25), label: 'Q1 (0–25%)' }),
  'q2':  (d) => ({ startSeconds: Math.floor(d * 0.25), endSeconds: Math.floor(d * 0.5), label: 'Q2 (25–50%)' }),
  'q3':  (d) => ({ startSeconds: Math.floor(d * 0.5), endSeconds: Math.floor(d * 0.75), label: 'Q3 (50–75%)' }),
  'q4':  (d) => ({ startSeconds: Math.floor(d * 0.75), endSeconds: d, label: 'Q4 (75–100%)' }),
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function isAE(turn: TranscriptTurn, recorderName: string): boolean {
  const firstName = recorderName.split(' ')[0].toLowerCase();
  return turn.speaker.toLowerCase().includes(firstName);
}

function countMatches(text: string, regex: RegExp): number {
  regex.lastIndex = 0;
  const m = text.match(regex);
  return m ? m.length : 0;
}

function sliceTurns(turns: TranscriptTurn[], window: TimeWindow): TranscriptTurn[] {
  return turns.filter(t =>
    t.timestampSeconds >= window.startSeconds && t.timestampSeconds < window.endSeconds
  );
}

// ─── Core Analysis ─────────────────────────────────────────────────────────

function computeMetrics(
  windowTurns: TranscriptTurn[],
  recorderName: string,
  window: TimeWindow,
): TimeframeMetrics {
  if (windowTurns.length === 0) {
    return {
      talkRatio: 0, questionCount: 0, prospectQuestionCount: 0,
      wordsPerMinute: 0, turnCount: 0, aeTurnCount: 0, prospectTurnCount: 0,
      avgTurnLength: 0, aeAvgTurnLength: 0, prospectAvgTurnLength: 0,
      longestMonologue: 0, controlShifts: 0,
      totalWords: 0, aeWords: 0, prospectWords: 0,
      durationSeconds: 0,
    };
  }

  let aeWords = 0;
  let prospectWords = 0;
  let aeQuestions = 0;
  let prospectQuestions = 0;
  let aeTurns = 0;
  let prospectTurns = 0;

  for (const t of windowTurns) {
    if (isAE(t, recorderName)) {
      aeWords += t.wordCount;
      aeTurns++;
      if (t.isQuestion) aeQuestions++;
    } else {
      prospectWords += t.wordCount;
      prospectTurns++;
      if (t.isQuestion) prospectQuestions++;
    }
  }

  const totalWords = aeWords + prospectWords;

  // Longest monologue
  let longestMono = 0;
  let currentMono = 0;
  let prevSpeaker = '';
  let controlShifts = 0;

  for (const t of windowTurns) {
    if (t.speaker !== prevSpeaker) {
      if (prevSpeaker) controlShifts++;
      longestMono = Math.max(longestMono, currentMono);
      currentMono = t.wordCount;
      prevSpeaker = t.speaker;
    } else {
      currentMono += t.wordCount;
    }
  }
  longestMono = Math.max(longestMono, currentMono);

  // Duration: use actual turn timestamps, clamped to the window
  const actualStart = Math.max(windowTurns[0].timestampSeconds, window.startSeconds);
  const actualEnd = Math.min(
    windowTurns[windowTurns.length - 1].timestampSeconds,
    window.endSeconds,
  );
  const durationSeconds = Math.max(1, actualEnd - actualStart);
  const durationMinutes = durationSeconds / 60;

  return {
    talkRatio: totalWords > 0 ? Math.round((aeWords / totalWords) * 100) : 0,
    questionCount: aeQuestions,
    prospectQuestionCount: prospectQuestions,
    wordsPerMinute: Math.round(totalWords / durationMinutes),
    turnCount: windowTurns.length,
    aeTurnCount: aeTurns,
    prospectTurnCount: prospectTurns,
    avgTurnLength: windowTurns.length > 0 ? Math.round(totalWords / windowTurns.length) : 0,
    aeAvgTurnLength: aeTurns > 0 ? Math.round(aeWords / aeTurns) : 0,
    prospectAvgTurnLength: prospectTurns > 0 ? Math.round(prospectWords / prospectTurns) : 0,
    longestMonologue: longestMono,
    controlShifts,
    totalWords,
    aeWords,
    prospectWords,
    durationSeconds,
  };
}

function computeEngagement(
  windowTurns: TranscriptTurn[],
  recorderName: string,
): TimeframeEngagement {
  let longAnswers = 0;
  let shortAnswers = 0;
  let totalWords = 0;
  let count = 0;

  for (const t of windowTurns) {
    if (isAE(t, recorderName)) continue;
    count++;
    totalWords += t.wordCount;
    if (t.wordCount > 25) longAnswers++;
    if (t.wordCount < 5) shortAnswers++;
  }

  const totalAnswers = longAnswers + shortAnswers;
  let level: 'high' | 'neutral' | 'low';
  if (totalAnswers > 0 && shortAnswers / totalAnswers > 0.6) {
    level = 'low';
  } else if (longAnswers > shortAnswers && count > 0) {
    level = 'high';
  } else {
    level = 'neutral';
  }

  return {
    prospectLongAnswers: longAnswers,
    prospectShortAnswers: shortAnswers,
    prospectAvgLength: count > 0 ? Math.round(totalWords / count) : 0,
    level,
  };
}

function computePatterns(
  windowTurns: TranscriptTurn[],
  recorderName: string,
): TimeframePatterns {
  const aeText = windowTurns
    .filter(t => isAE(t, recorderName))
    .map(t => t.text)
    .join(' ')
    .toLowerCase();

  const scores: Partial<PatternScores> = {};
  const entries: Array<[string, number]> = [];

  for (const [key, regex] of Object.entries(TIMEFRAME_PATTERNS)) {
    const count = countMatches(aeText, regex);
    if (count > 0) {
      (scores as Record<string, number>)[key] = count;
      entries.push([key, count]);
    }
  }

  entries.sort((a, b) => b[1] - a[1]);
  const topDimensions = entries.slice(0, 5).map(e => e[0]);

  return { scores, topDimensions };
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Analyze a specific time window within a call transcript.
 */
export function analyzeTimeframe(
  turns: TranscriptTurn[],
  recorderName: string,
  window: TimeWindow,
): TimeframeAnalysis {
  const windowTurns = sliceTurns(turns, window);

  const metrics = computeMetrics(windowTurns, recorderName, window);
  const engagement = computeEngagement(windowTurns, recorderName);
  const patterns = computePatterns(windowTurns, recorderName);

  // Sample turns: first 3 + last 3 (for context)
  const sampleTurns = [
    ...windowTurns.slice(0, 3),
    ...windowTurns.slice(-3),
  ];
  const uniqueSample = Array.from(new Map(sampleTurns.map(t => [t.timestampSeconds, t])).values());

  return {
    window,
    metrics,
    engagement,
    patterns,
    turnSample: uniqueSample.map(t => ({
      timestamp: t.timestampDisplay,
      speaker: t.speaker,
      text: t.text.slice(0, 200),
      isQuestion: t.isQuestion,
    })),
  };
}

/**
 * Analyze all preset windows for a single call.
 * Returns a full-call "heatmap" of how metrics shift over time.
 */
export function analyzeAllWindows(
  turns: TranscriptTurn[],
  recorderName: string,
  durationSeconds: number,
  windowType: 'quarters' | 'halves' | 'presets' = 'quarters',
): TimeframeAnalysis[] {
  const windows: TimeWindow[] = [];

  if (windowType === 'quarters') {
    windows.push(
      PRESET_WINDOWS['q1'](durationSeconds),
      PRESET_WINDOWS['q2'](durationSeconds),
      PRESET_WINDOWS['q3'](durationSeconds),
      PRESET_WINDOWS['q4'](durationSeconds),
    );
  } else if (windowType === 'halves') {
    windows.push(
      PRESET_WINDOWS['first-half'](durationSeconds),
      PRESET_WINDOWS['second-half'](durationSeconds),
    );
  } else {
    windows.push(
      PRESET_WINDOWS['opening'](durationSeconds),
      PRESET_WINDOWS['discovery'](durationSeconds),
      PRESET_WINDOWS['mid'](durationSeconds),
      PRESET_WINDOWS['close'](durationSeconds),
    );
  }

  return windows.map(w => analyzeTimeframe(turns, recorderName, w));
}

/**
 * Analyze custom equal-sized windows across a call.
 * E.g., windowSizeMinutes=5 on a 30-min call = 6 windows.
 */
export function analyzeByInterval(
  turns: TranscriptTurn[],
  recorderName: string,
  durationSeconds: number,
  windowSizeMinutes: number,
): TimeframeAnalysis[] {
  const windowSize = windowSizeMinutes * 60;
  const results: TimeframeAnalysis[] = [];

  for (let start = 0; start < durationSeconds; start += windowSize) {
    const end = Math.min(start + windowSize, durationSeconds);
    const startMin = Math.floor(start / 60);
    const endMin = Math.floor(end / 60);
    const window: TimeWindow = {
      startSeconds: start,
      endSeconds: end,
      label: `${startMin}:00–${endMin}:00`,
    };
    results.push(analyzeTimeframe(turns, recorderName, window));
  }

  return results;
}

// ─── Cross-Call Comparison ─────────────────────────────────────────────────

interface CallInput {
  turns: TranscriptTurn[];
  recorderName: string;
  durationSeconds: number;
  group: string;           // e.g. "won", "lost", or AE name
}

function averageMetrics(analyses: TimeframeAnalysis[]): TimeframeMetrics {
  if (analyses.length === 0) {
    return {
      talkRatio: 0, questionCount: 0, prospectQuestionCount: 0,
      wordsPerMinute: 0, turnCount: 0, aeTurnCount: 0, prospectTurnCount: 0,
      avgTurnLength: 0, aeAvgTurnLength: 0, prospectAvgTurnLength: 0,
      longestMonologue: 0, controlShifts: 0,
      totalWords: 0, aeWords: 0, prospectWords: 0,
      durationSeconds: 0,
    };
  }

  const n = analyses.length;
  const sum = (fn: (a: TimeframeAnalysis) => number) =>
    Math.round(analyses.reduce((s, a) => s + fn(a), 0) / n);

  return {
    talkRatio: sum(a => a.metrics.talkRatio),
    questionCount: sum(a => a.metrics.questionCount),
    prospectQuestionCount: sum(a => a.metrics.prospectQuestionCount),
    wordsPerMinute: sum(a => a.metrics.wordsPerMinute),
    turnCount: sum(a => a.metrics.turnCount),
    aeTurnCount: sum(a => a.metrics.aeTurnCount),
    prospectTurnCount: sum(a => a.metrics.prospectTurnCount),
    avgTurnLength: sum(a => a.metrics.avgTurnLength),
    aeAvgTurnLength: sum(a => a.metrics.aeAvgTurnLength),
    prospectAvgTurnLength: sum(a => a.metrics.prospectAvgTurnLength),
    longestMonologue: sum(a => a.metrics.longestMonologue),
    controlShifts: sum(a => a.metrics.controlShifts),
    totalWords: sum(a => a.metrics.totalWords),
    aeWords: sum(a => a.metrics.aeWords),
    prospectWords: sum(a => a.metrics.prospectWords),
    durationSeconds: sum(a => a.metrics.durationSeconds),
  };
}

function averageEngagement(analyses: TimeframeAnalysis[]): TimeframeEngagement {
  if (analyses.length === 0) {
    return { prospectLongAnswers: 0, prospectShortAnswers: 0, prospectAvgLength: 0, level: 'neutral' };
  }

  const n = analyses.length;
  const avgLong = Math.round(analyses.reduce((s, a) => s + a.engagement.prospectLongAnswers, 0) / n);
  const avgShort = Math.round(analyses.reduce((s, a) => s + a.engagement.prospectShortAnswers, 0) / n);
  const avgLen = Math.round(analyses.reduce((s, a) => s + a.engagement.prospectAvgLength, 0) / n);

  const levels = analyses.map(a => a.engagement.level);
  const highCount = levels.filter(l => l === 'high').length;
  const lowCount = levels.filter(l => l === 'low').length;
  let level: 'high' | 'neutral' | 'low';
  if (highCount > n / 2) level = 'high';
  else if (lowCount > n / 2) level = 'low';
  else level = 'neutral';

  return { prospectLongAnswers: avgLong, prospectShortAnswers: avgShort, prospectAvgLength: avgLen, level };
}

function averagePatterns(analyses: TimeframeAnalysis[]): Partial<PatternScores> {
  if (analyses.length === 0) return {};

  const n = analyses.length;
  const sums: Record<string, number> = {};

  for (const a of analyses) {
    for (const [key, val] of Object.entries(a.patterns.scores)) {
      sums[key] = (sums[key] || 0) + (val as number);
    }
  }

  const avg: Record<string, number> = {};
  for (const [key, val] of Object.entries(sums)) {
    avg[key] = Math.round((val / n) * 10) / 10;
  }

  return avg as Partial<PatternScores>;
}

/**
 * Compare the same time window across grouped calls.
 * E.g., compare "opening 5 min" of won calls vs lost calls.
 */
export function compareTimeframes(
  calls: CallInput[],
  window: TimeWindow | string,
): TimeframeComparison {
  // Group calls
  const groups = new Map<string, CallInput[]>();
  for (const call of calls) {
    const existing = groups.get(call.group) || [];
    existing.push(call);
    groups.set(call.group, existing);
  }

  // Analyze each call's window
  const groupResults: TimeframeComparison['groups'] = [];
  const resolvedWindows: TimeWindow[] = [];

  for (const [groupName, groupCalls] of Array.from(groups.entries())) {
    const analyses: TimeframeAnalysis[] = [];

    for (const call of groupCalls) {
      let w: TimeWindow;
      if (typeof window === 'string') {
        const preset = PRESET_WINDOWS[window];
        if (!preset) throw new Error(`Unknown preset window: ${window}`);
        w = preset(call.durationSeconds);
      } else {
        w = window;
      }
      resolvedWindows.push(w);
      analyses.push(analyzeTimeframe(call.turns, call.recorderName, w));
    }

    groupResults.push({
      name: groupName,
      callCount: groupCalls.length,
      avgMetrics: averageMetrics(analyses),
      avgEngagement: averageEngagement(analyses),
      avgPatterns: averagePatterns(analyses),
    });
  }

  // Compute deltas (first group minus second group)
  const deltas: Record<string, number> = {};
  if (groupResults.length >= 2) {
    const a = groupResults[0].avgMetrics;
    const b = groupResults[1].avgMetrics;
    deltas['talkRatio'] = a.talkRatio - b.talkRatio;
    deltas['questionCount'] = a.questionCount - b.questionCount;
    deltas['prospectQuestionCount'] = a.prospectQuestionCount - b.prospectQuestionCount;
    deltas['wordsPerMinute'] = a.wordsPerMinute - b.wordsPerMinute;
    deltas['longestMonologue'] = a.longestMonologue - b.longestMonologue;
    deltas['controlShifts'] = a.controlShifts - b.controlShifts;
    deltas['prospectAvgLength'] = groupResults[0].avgEngagement.prospectAvgLength - groupResults[1].avgEngagement.prospectAvgLength;
  }

  // Generate insights
  const insights = generateInsights(groupResults, deltas);

  // Resolve the display window
  const displayWindow = resolvedWindows[0] || (typeof window === 'string'
    ? { startSeconds: 0, endSeconds: 300, label: window }
    : window);

  return {
    label: `${groupResults.map(g => g.name).join(' vs ')} — ${displayWindow.label}`,
    window: displayWindow,
    groups: groupResults,
    deltas,
    insights,
  };
}

function generateInsights(
  groups: TimeframeComparison['groups'],
  deltas: Record<string, number>,
): string[] {
  if (groups.length < 2) return [];

  const insights: string[] = [];
  const [a, b] = groups;

  // Talk ratio difference
  if (Math.abs(deltas['talkRatio']) > 8) {
    const talker = deltas['talkRatio'] > 0 ? a.name : b.name;
    const listener = deltas['talkRatio'] > 0 ? b.name : a.name;
    insights.push(
      `${talker} calls have ${Math.abs(deltas['talkRatio'])}% higher AE talk ratio than ${listener} in this window — AE talked more in ${talker.toLowerCase()} calls.`
    );
  }

  // Question count difference
  if (Math.abs(deltas['questionCount']) > 2) {
    const more = deltas['questionCount'] > 0 ? a.name : b.name;
    insights.push(
      `${more} calls average ${Math.abs(deltas['questionCount'])} more AE questions in this window.`
    );
  }

  // Prospect engagement
  if (Math.abs(deltas['prospectAvgLength']) > 8) {
    const more = deltas['prospectAvgLength'] > 0 ? a.name : b.name;
    insights.push(
      `Prospects give longer answers (avg +${Math.abs(deltas['prospectAvgLength'])} words/turn) in ${more.toLowerCase()} calls during this phase.`
    );
  }

  // Monologue difference
  if (Math.abs(deltas['longestMonologue']) > 30) {
    const longer = deltas['longestMonologue'] > 0 ? a.name : b.name;
    insights.push(
      `${longer} calls have longer AE monologues (+${Math.abs(deltas['longestMonologue'])} words) in this window — potential over-pitching.`
    );
  }

  // Control shifts
  if (Math.abs(deltas['controlShifts']) > 3) {
    const more = deltas['controlShifts'] > 0 ? a.name : b.name;
    insights.push(
      `${more} calls have more back-and-forth (${Math.abs(deltas['controlShifts'])} more speaker switches) — more conversational.`
    );
  }

  // Pattern differences
  const aPatterns = a.avgPatterns as Record<string, number>;
  const bPatterns = b.avgPatterns as Record<string, number>;
  const allKeys = Array.from(new Set([...Object.keys(aPatterns), ...Object.keys(bPatterns)]));
  const patternDiffs: Array<[string, number]> = [];

  for (const key of allKeys) {
    const diff = (aPatterns[key] || 0) - (bPatterns[key] || 0);
    if (Math.abs(diff) > 1) patternDiffs.push([key, diff]);
  }

  patternDiffs.sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]));
  for (const [key, diff] of patternDiffs.slice(0, 3)) {
    const more = diff > 0 ? a.name : b.name;
    const label = key.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
    insights.push(
      `${more} calls show more "${label}" pattern usage in this window.`
    );
  }

  return insights;
}
