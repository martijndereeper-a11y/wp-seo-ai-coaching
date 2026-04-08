/**
 * Meeting Classifier
 *
 * Determines whether a call is a "first" or "follow-up" meeting
 * using multiple signals, ranked by reliability:
 *
 *   1. Deal grouping — same deal_id/deal_name, ordered by date (strongest)
 *   2. Title patterns — "follow-up", "2e gesprek", "vervolg", etc.
 *   3. Transcript opening — references to previous conversation
 *   4. Company intro — heavy intro = first, skipped = follow-up
 *   5. Participant overlap — same prospect across multiple calls
 *
 * Each signal contributes to a confidence-weighted classification.
 */

import type { TranscriptTurn } from './transcript-parser.ts';

// ─── Types ─────────────────────────────────────────────────────────────────

export type MeetingType = 'first' | 'follow-up';

export interface MeetingClassification {
  type: MeetingType;
  confidence: 'high' | 'medium' | 'low';
  signals: ClassificationSignal[];
  dealSequence?: number;       // 1 = first, 2 = second, etc. (if deal grouping available)
}

export interface ClassificationSignal {
  source: string;
  indicates: MeetingType;
  weight: number;              // 0-10
  detail: string;
}

// ─── Title Patterns ────────────────────────────────────────────────────────

const FOLLOWUP_TITLE = /follow[\s-]?up|vervolg|2e?\s+(gesprek|call|meeting)|tweede|opvolg|check[\s-]?in|hernieuw|recap|terugkom|besluit|beslissing|contract|afrond|slot|offerte|voorstel|proposal|review|nabespreking/i;
const FIRST_TITLE = /intro|kennis\s*mak|eerste|1e?\s+(gesprek|call|meeting)|demo|presentatie|discovery|initial|exploratie/i;

// ─── Transcript Patterns ───────────────────────────────────────────────────

// Follow-up indicators in opening (first ~10 turns)
const FOLLOWUP_OPENING = /vorige keer|vorige call|vorige gesprek|vorige week|eerder besproken|zoals.*afgesproken|naar aanleiding|terugkom|opvolging|je had.*gezegd|je noemde|we hadden|we spraken|we zouden|beloofd|afgelopen keer|letztes mal|wie besprochen|letzte woche|as we discussed|last time|as agreed|previous call|following up/i;

// First-meeting indicators in opening
const FIRST_OPENING = /leuk.*kennis|fijn.*kennis|bedankt.*voor.*je.*tijd|vertel.*eens|wie.*zijn.*jullie|wat.*doen.*jullie|hoe.*ben.*je.*bij.*ons|waar.*heb.*je.*ons.*gevonden|kort.*voorstellen|even.*voorstellen|wie.*ben.*ik|schön.*dass|freut.*mich|nice.*to.*meet|tell.*me.*about/i;

// Company introduction pattern (from pattern-detector)
const COMPANY_INTRO = /wij zijn|we zijn|opgericht|kantoor|medewerkers|ons team|amsterdam|finland|mikael|onze oprichter/gi;

// ─── Classification Logic ──────────────────────────────────────────────────

/**
 * Classify a single call using title and transcript signals.
 * For deal-based grouping, use classifyWithDealContext instead.
 */
export function classifyMeeting(
  title: string,
  turns: TranscriptTurn[],
  recorderName: string,
): MeetingClassification {
  const signals: ClassificationSignal[] = [];

  // 1. Title analysis
  if (FOLLOWUP_TITLE.test(title || '')) {
    signals.push({
      source: 'title',
      indicates: 'follow-up',
      weight: 8,
      detail: `Title "${title}" matches follow-up pattern`,
    });
  } else if (FIRST_TITLE.test(title || '')) {
    signals.push({
      source: 'title',
      indicates: 'first',
      weight: 7,
      detail: `Title "${title}" matches first-meeting pattern`,
    });
  }

  // 2. Transcript opening (first ~10 turns)
  const openingTurns = turns.slice(0, Math.min(10, turns.length));
  const openingText = openingTurns.map(t => t.text).join(' ');

  if (FOLLOWUP_OPENING.test(openingText)) {
    const match = openingText.match(FOLLOWUP_OPENING);
    signals.push({
      source: 'transcript_opening',
      indicates: 'follow-up',
      weight: 9,
      detail: `Opening references previous contact: "${match?.[0]}"`,
    });
  }

  if (FIRST_OPENING.test(openingText)) {
    const match = openingText.match(FIRST_OPENING);
    signals.push({
      source: 'transcript_opening',
      indicates: 'first',
      weight: 7,
      detail: `Opening has first-meeting language: "${match?.[0]}"`,
    });
  }

  // 3. Company introduction depth (AE speech in first ~30% of call)
  const firstName = recorderName.split(' ')[0].toLowerCase();
  const earlyTurns = turns.slice(0, Math.ceil(turns.length * 0.3));
  const aeEarlyText = earlyTurns
    .filter(t => t.speaker.toLowerCase().includes(firstName))
    .map(t => t.text)
    .join(' ');

  COMPANY_INTRO.lastIndex = 0;
  const introHits = (aeEarlyText.match(COMPANY_INTRO) || []).length;

  if (introHits >= 3) {
    signals.push({
      source: 'company_intro',
      indicates: 'first',
      weight: 5,
      detail: `${introHits} company intro phrases in early call — typical first meeting`,
    });
  } else if (introHits === 0 && turns.length > 10) {
    signals.push({
      source: 'company_intro',
      indicates: 'follow-up',
      weight: 3,
      detail: 'No company introduction in early call — suggests follow-up',
    });
  }

  // 4. Discovery depth — first meetings have more questions in opening
  const aeEarlyQuestions = earlyTurns
    .filter(t => t.speaker.toLowerCase().includes(firstName) && t.isQuestion)
    .length;
  const totalEarlyTurns = earlyTurns.filter(t => t.speaker.toLowerCase().includes(firstName)).length;
  const earlyQuestionRatio = totalEarlyTurns > 0 ? aeEarlyQuestions / totalEarlyTurns : 0;

  if (earlyQuestionRatio > 0.4 && aeEarlyQuestions >= 3) {
    signals.push({
      source: 'discovery_depth',
      indicates: 'first',
      weight: 3,
      detail: `Heavy early discovery (${aeEarlyQuestions} questions in first 30%) — typical first meeting`,
    });
  }

  return resolveSignals(signals);
}

/**
 * Classify with deal context — uses deal grouping as the strongest signal.
 * Pass all recordings for the same deal_id/deal_name, sorted by created_at ASC.
 */
export function classifyWithDealContext(
  recordingId: string,
  title: string,
  turns: TranscriptTurn[],
  recorderName: string,
  dealRecordingIds: string[],  // All recording IDs for this deal, ordered by date ASC
): MeetingClassification {
  const signals: ClassificationSignal[] = [];

  // Deal sequence is the strongest signal
  if (dealRecordingIds.length > 0) {
    const position = dealRecordingIds.indexOf(recordingId);
    if (position === 0) {
      signals.push({
        source: 'deal_sequence',
        indicates: 'first',
        weight: 10,
        detail: `First recording in deal (1 of ${dealRecordingIds.length})`,
      });
    } else if (position > 0) {
      signals.push({
        source: 'deal_sequence',
        indicates: 'follow-up',
        weight: 10,
        detail: `Recording ${position + 1} of ${dealRecordingIds.length} in this deal`,
      });
    }
  }

  // Also run the standalone classifier for additional signals
  const standalone = classifyMeeting(title, turns, recorderName);
  signals.push(...standalone.signals);

  const result = resolveSignals(signals);

  // Add deal sequence number
  if (dealRecordingIds.length > 0) {
    result.dealSequence = dealRecordingIds.indexOf(recordingId) + 1;
  }

  return result;
}

// ─── Signal Resolution ─────────────────────────────────────────────────────

function resolveSignals(signals: ClassificationSignal[]): MeetingClassification {
  if (signals.length === 0) {
    return {
      type: 'first',
      confidence: 'low',
      signals: [{ source: 'default', indicates: 'first', weight: 1, detail: 'No signals detected — defaulting to first meeting' }],
    };
  }

  // Weighted vote
  let firstWeight = 0;
  let followUpWeight = 0;

  for (const s of signals) {
    if (s.indicates === 'first') firstWeight += s.weight;
    else followUpWeight += s.weight;
  }

  const type: MeetingType = followUpWeight > firstWeight ? 'follow-up' : 'first';
  const totalWeight = firstWeight + followUpWeight;
  const winningWeight = Math.max(firstWeight, followUpWeight);
  const margin = winningWeight - Math.min(firstWeight, followUpWeight);

  let confidence: 'high' | 'medium' | 'low';
  if (margin >= 8 || signals.some(s => s.source === 'deal_sequence')) {
    confidence = 'high';
  } else if (margin >= 4) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  return { type, confidence, signals };
}
