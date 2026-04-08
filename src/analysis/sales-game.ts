/**
 * Sales Game Scorer
 *
 * Scores calls using the American Football game metaphor.
 * Detects deal advancement actions in transcripts:
 *
 *   A (15 pts) — First Down: Prospect confirms value, explains why they want to start
 *   B (5 pts)  — The Snap: Decision maker identified/present
 *   C (5 pts)  — Field Position: Budget or allocation confirmed
 *   D (5 pts)  — Game Clock: Hard decision date within ~1 week
 *   E (10 pts) — Hail Mary: Incentive traded for commitment (GNS)
 *   F (30 pts) — Touchdown: Deal closed
 *
 * Key rule: B, C, D only count if A (value confirmation) happened first.
 * E requires BOTH an incentive from AE AND commitment back from prospect.
 *
 * Pure function: no database calls, no async, just computation.
 */

import type { TranscriptTurn } from './transcript-parser.ts';

// ─── Interfaces ────────────────────────────────────────────────────────────

export interface GameAction {
  id: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  name: string;
  metaphor: string;
  points: number;
  earned: boolean;
  evidence: string;
  timestamp?: string;
  reason?: string;
}

export interface GameScore {
  totalPoints: number;
  maxPoints: number;
  actions: GameAction[];
  valueConfirmed: boolean;
  summary: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function isAE(turn: TranscriptTurn, recorderName: string): boolean {
  const firstName = recorderName.split(' ')[0].toLowerCase();
  return turn.speaker.toLowerCase().includes(firstName);
}

function isProspect(turn: TranscriptTurn, recorderName: string): boolean {
  return !isAE(turn, recorderName);
}

/**
 * Search ALL turns from a speaker for a pattern match.
 * Returns the first match found.
 */
function findTurn(
  turns: TranscriptTurn[],
  recorderName: string,
  speaker: 'ae' | 'prospect',
  pattern: RegExp,
  startFrom: number = 0,
): { index: number; turn: TranscriptTurn } | null {
  for (let i = startFrom; i < turns.length; i++) {
    const t = turns[i];
    const isSpeaker = speaker === 'ae' ? isAE(t, recorderName) : isProspect(t, recorderName);
    if (!isSpeaker) continue;
    pattern.lastIndex = 0;
    if (pattern.test(t.text)) return { index: i, turn: t };
  }
  return null;
}

/**
 * Search for a prospect response after a given index.
 * Can also check for response LENGTH as a signal (long positive = confirmation).
 */
function prospectRespondsAfter(
  turns: TranscriptTurn[],
  recorderName: string,
  afterIndex: number,
  pattern: RegExp,
  maxLookahead: number = 6,
): TranscriptTurn | null {
  const limit = Math.min(afterIndex + maxLookahead, turns.length);
  for (let i = afterIndex + 1; i < limit; i++) {
    if (!isProspect(turns[i], recorderName)) continue;
    pattern.lastIndex = 0;
    if (pattern.test(turns[i].text)) return turns[i];
  }
  return null;
}

/**
 * Find a prospect response that is "positively long" — a substantial positive
 * answer (>15 words) that doesn't contain doubt/objection language.
 * Used as a fallback for value confirmation when exact keywords aren't hit.
 */
function prospectGivesPositiveLongAnswer(
  turns: TranscriptTurn[],
  recorderName: string,
  afterIndex: number,
  maxLookahead: number = 6,
): TranscriptTurn | null {
  const DOUBT = /weet.*niet|twijfel|lastig|moeilijk|niet.*zeker|misschien.*niet|geen.*idee|moet.*nadenken|intern.*overleg|te.*duur|geen.*budget|geen.*tijd|nicht.*sicher|schwierig/i;
  const limit = Math.min(afterIndex + maxLookahead, turns.length);
  for (let i = afterIndex + 1; i < limit; i++) {
    const t = turns[i];
    if (!isProspect(t, recorderName)) continue;
    // Long response (>15 words) without doubt language = implicit positive
    if (t.wordCount > 15) {
      DOUBT.lastIndex = 0;
      if (!DOUBT.test(t.text)) return t;
    }
  }
  return null;
}

/**
 * Check if an AE turn is phrased as a question (contains ? or is short + ends questioning).
 * Filters out AE statements that happen to contain value-related keywords.
 */
function isQuestionTurn(turn: TranscriptTurn): boolean {
  if (turn.text.includes('?')) return true;
  // Short turns ending with rising intonation words
  if (turn.wordCount <= 20 && /toch$|of niet$|he$|hè$/i.test(turn.text.trim())) return true;
  return false;
}

// ─── A: Value Confirmation (15 pts) ────────────────────────────────────────
//
// AE asks if prospect is enthusiastic / wants to start → prospect confirms.
// The ask MUST be a question (contains ?), not a statement.
// Confirmation is broad: explicit keywords OR a long positive answer.

const VALUE_ASK = /enthousiast|wil.*je.*starten|zou.*je.*willen|wat.*vind.*je|hoe.*klinkt|zouden.*jullie|interesse|zin.*in|klinkt.*dat|spreekt.*je.*aan|overtuigd|past.*bij|zou.*dit.*iets|is.*dit.*iets|zie.*je.*dit|aanspreek|leuk.*vind|iets.*voor.*jullie|zouden.*jullie.*willen|hier.*mee.*aan.*de.*slag|matcht|aansluit/i;

const VALUE_CONFIRM = /ja|jazeker|zeker|absoluut|helemaal|klopt|inderdaad|precies|exact|goed.*verhaal|klinkt.*goed|klinkt.*logisch|klinkt.*interessant|spreekt.*aan|past.*bij|willen.*we|gaan.*we|willen.*beginnen|wil.*ik|ga.*ik|dat.*willen|nodig.*heb|zoeken.*wij|perfect|super|top|mooi|leuk|dat.*is.*het|dat.*is.*precies|mee.*eens|lijkt.*me.*goed|lijkt.*goed|kan.*niet.*wachten|overtuigd|enthousiast|positief|blij|logisch|dat.*snappen|begrijp.*ik|zie.*ik.*wel|is.*wat.*we|handiger|makkelijker|beter|scheelt|helpt|nuttig|waardevol|relevant/i;

function detectValueConfirmation(turns: TranscriptTurn[], recorderName: string): GameAction {
  const action: GameAction = {
    id: 'A', name: 'Value Confirmation', metaphor: 'The First Down',
    points: 15, earned: false, evidence: '',
  };

  // Search for AE value questions (must be question-like)
  // Try multiple passes — sometimes the first match is a statement, not a question
  let bestAsk: { index: number; turn: TranscriptTurn } | null = null;
  let searchFrom = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    const match = findTurn(turns, recorderName, 'ae', VALUE_ASK, searchFrom);
    if (!match) break;
    // Prefer turns that are actual questions
    if (isQuestionTurn(match.turn)) {
      bestAsk = match;
      break;
    }
    // Accept non-question turns only in second half of call (after pitch)
    if (!bestAsk && match.index > turns.length * 0.4) {
      bestAsk = match;
    }
    searchFrom = match.index + 1;
  }

  if (!bestAsk) {
    action.reason = 'Je hebt niet gevraagd of de prospect de waarde ziet of wil starten. Stel vragen als "Spreekt dit je aan?" of "Zou je hiermee willen starten?"';
    action.evidence = 'Geen value-vraag gevonden in het gesprek.';
    return action;
  }

  // Check 1: Explicit keyword match in prospect response
  const confirm = prospectRespondsAfter(turns, recorderName, bestAsk.index, VALUE_CONFIRM);
  if (confirm) {
    action.earned = true;
    action.evidence = `Prospect bevestigde: "${confirm.text.slice(0, 150)}"`;
    action.timestamp = confirm.timestampDisplay;
    return action;
  }

  // Check 2: Long positive response (>15 words, no doubt language)
  const longPositive = prospectGivesPositiveLongAnswer(turns, recorderName, bestAsk.index);
  if (longPositive) {
    action.earned = true;
    action.evidence = `Prospect gaf een uitgebreid positief antwoord: "${longPositive.text.slice(0, 150)}"`;
    action.timestamp = longPositive.timestampDisplay;
    return action;
  }

  action.reason = 'Je hebt de vraag gesteld, maar de prospect heeft de waarde niet expliciet bevestigd. Vraag door: "Kun je uitleggen waarom dit voor jullie interessant is?"';
  action.evidence = `AE vroeg: "${bestAsk.turn.text.slice(0, 120)}" maar prospect bevestigde niet.`;
  action.timestamp = bestAsk.turn.timestampDisplay;
  return action;
}

// ─── B: Decision Maker (5 pts) ─────────────────────────────────────────────
//
// AE surfaces who decides. Can be a direct question OR natural conversation
// where DM topic comes up. Broader patterns for both ask and confirm.

const DM_ASK = /wie.*beslist|wie.*beslissing|beslisser|decision.*maker|wie.*tekent|wie.*akkoord|wie.*moet.*meekijk|stakeholder|nog.*iemand.*nodig|wie.*betrokken|verantwoordelijk|ben.*jij.*degene|jij.*zelf.*beslissen|alleen.*jij|iemand.*anders.*nodig|goedkeuring|eigenaar|directeur|directie|management|team.*betrokken|afstemmen.*met|overleg.*met|toestemming|moet.*je.*nog/i;

const DM_CONFIRM = /ik.*beslis|ik.*besluit|dat.*ben.*ik|dat.*doe.*ik|ik.*teken|alleen.*nodig|ik.*mag.*beslissen|niemand.*anders|mijn.*beslissing|ik.*ga.*erover|ik.*heb.*mandaat|ik.*kan.*dat|hoef.*niemand|eigenaar|directeur.*ben.*ik|mijn.*bedrijf|mijn.*zaak|ik.*ben.*de.*baas|zelf.*weten|ik.*bepaal|nee.*alleen.*ik|nee.*dat.*hoeft.*niet|nee.*ik.*kan/i;

function detectDecisionMaker(turns: TranscriptTurn[], recorderName: string): GameAction {
  const action: GameAction = {
    id: 'B', name: 'Decision Maker', metaphor: 'The Snap',
    points: 5, earned: false, evidence: '',
  };

  // Check for AE asking about DM
  const aeAsk = findTurn(turns, recorderName, 'ae', DM_ASK);

  if (aeAsk) {
    // Check for explicit DM confirmation
    const confirm = prospectRespondsAfter(turns, recorderName, aeAsk.index, DM_CONFIRM, 8);
    if (confirm) {
      action.earned = true;
      action.evidence = `DM bevestigd: "${confirm.text.slice(0, 150)}"`;
      action.timestamp = confirm.timestampDisplay;
      return action;
    }
    action.reason = 'Je hebt naar de beslisser gevraagd maar geen duidelijke bevestiging gekregen. Push: "Ben jij degene die hierover beslist?"';
    action.evidence = `AE vroeg: "${aeAsk.turn.text.slice(0, 120)}" — geen bevestiging.`;
    action.timestamp = aeAsk.turn.timestampDisplay;
    return action;
  }

  // Fallback: prospect self-identifies as DM anywhere in the call
  const selfIdentify = findTurn(turns, recorderName, 'prospect', DM_CONFIRM);
  if (selfIdentify) {
    action.earned = true;
    action.evidence = `Prospect identificeerde zichzelf als DM: "${selfIdentify.turn.text.slice(0, 150)}"`;
    action.timestamp = selfIdentify.turn.timestampDisplay;
    return action;
  }

  action.reason = 'Decision maker niet besproken. Vraag: "Wie beslist hierover?" of "Ben jij degene die dit kan tekenen?"';
  action.evidence = 'Geen DM-gesprek gevonden.';
  return action;
}

// ─── C: Budget / Allocation (5 pts) ────────────────────────────────────────
//
// Budget topic surfaces — either AE asks or it comes up during pricing.
// Prospect indicates willingness to invest or discusses amounts.

const BUDGET_TOPIC = /budget|allocat|investering|beschikbaar|wat.*uitgeef|gereserveerd|hoeveel.*kost|financial|middelen|ruimte.*voor|wat.*betaal.*je.*nu|wat.*geef.*je.*uit|wat.*kost.*jullie|bureau.*kost|per.*maand|euro|€|prijskaartje|wat.*zijn.*de.*kosten|tarief/i;

const BUDGET_POSITIVE = /budget|beschikbaar|gereserveerd|investeren|ruimte.*voor|kunnen.*we|past.*binnen|geen.*probleem|dat.*lukt|is.*haalbaar|kan.*wel|is.*te.*doen|klinkt.*redelijk|euro.*per.*maand|betalen.*we.*nu|geven.*we.*uit|dat.*is.*prima|dat.*is.*goed|wat.*kost|zeg.*maar|kan.*ik.*doen|te.*overzien|schappelijk|meevalt|niet.*zo.*duur|best.*redelijk|verwacht/i;

function detectBudget(turns: TranscriptTurn[], recorderName: string): GameAction {
  const action: GameAction = {
    id: 'C', name: 'Budget / Allocatie', metaphor: 'Field Position',
    points: 5, earned: false, evidence: '',
  };

  // Check if budget topic comes up (from either side)
  const aeBudget = findTurn(turns, recorderName, 'ae', BUDGET_TOPIC);
  const prospectBudget = findTurn(turns, recorderName, 'prospect', BUDGET_TOPIC);

  if (!aeBudget && !prospectBudget) {
    action.reason = 'Budget niet besproken. Vraag: "Wat geef je nu uit aan SEO/content?" of "Is er budget beschikbaar?"';
    action.evidence = 'Geen budget-gesprek gevonden.';
    return action;
  }

  const startIndex = Math.min(
    aeBudget?.index ?? Infinity,
    prospectBudget?.index ?? Infinity,
  );

  // Check for positive budget response from prospect
  const confirm = prospectRespondsAfter(turns, recorderName, startIndex, BUDGET_POSITIVE, 10);
  if (confirm) {
    action.earned = true;
    action.evidence = `Budget besproken: "${confirm.text.slice(0, 150)}"`;
    action.timestamp = confirm.timestampDisplay;
    return action;
  }

  // Prospect bringing up budget/pricing themselves is also a positive signal
  if (prospectBudget && prospectBudget.turn.wordCount > 8) {
    action.earned = true;
    action.evidence = `Prospect bracht budget ter sprake: "${prospectBudget.turn.text.slice(0, 150)}"`;
    action.timestamp = prospectBudget.turn.timestampDisplay;
    return action;
  }

  action.reason = 'Budget werd besproken maar prospect gaf geen positief signaal. Vraag concreter: "Past dit binnen jullie budget?"';
  action.evidence = `Budget kwam ter sprake maar geen bevestiging.`;
  action.timestamp = (aeBudget || prospectBudget)?.turn.timestampDisplay;
  return action;
}

// ─── D: Timeline / Game Clock (5 pts) ──────────────────────────────────────
//
// Hard decision date within ~1 week. AE pushes for timing.

const TIMELINE_TOPIC = /wanneer|starten|besliss|duidelijk|timeline|tijdlijn|deadline|beslismoment|datum|volgende.*week|deze.*week|morgen|horen|tekenen|laten.*weten|terugkom|plannen|inplannen|agenda|moment|termijn/i;

const TIMELINE_TIGHT = /morgen|overmorgen|vandaag|deze.*week|maandag|dinsdag|woensdag|donderdag|vrijdag|begin.*volgende.*week|uiterlijk|komende.*dagen|voor.*het.*weekend|binnen.*een.*week|paar.*dagen|eind.*van.*de.*week|deze.*maandag|aankomende/i;

const TIMELINE_LOOSE = /volgende.*maand|na.*de.*zomer|over.*een.*paar.*weken|over.*twee.*weken|na.*de.*vakantie|eind.*van.*de.*maand|over.*een.*maand|paar.*weken|paar.*maanden|later|niet.*nu|nog.*even|op.*termijn/i;

function detectTimeline(turns: TranscriptTurn[], recorderName: string): GameAction {
  const action: GameAction = {
    id: 'D', name: 'Timeline', metaphor: 'The Game Clock',
    points: 5, earned: false, evidence: '',
  };

  // Find timeline topic from AE
  const aeTimeline = findTurn(turns, recorderName, 'ae', TIMELINE_TOPIC);
  if (!aeTimeline) {
    action.reason = 'Geen beslismoment besproken. Vraag: "Wanneer kunnen jullie hierover beslissen?" en push naar deze week.';
    action.evidence = 'Geen timeline-gesprek gevonden.';
    return action;
  }

  // Check for tight timeline (within ~1 week) from prospect
  const tightConfirm = prospectRespondsAfter(turns, recorderName, aeTimeline.index, TIMELINE_TIGHT, 10);
  if (tightConfirm) {
    action.earned = true;
    action.evidence = `Harde datum: "${tightConfirm.text.slice(0, 150)}"`;
    action.timestamp = tightConfirm.timestampDisplay;
    return action;
  }

  // Also check if AE states a tight timeline and prospect doesn't object
  const aeStatesTimeline = findTurn(turns, recorderName, 'ae', TIMELINE_TIGHT, aeTimeline.index);
  if (aeStatesTimeline) {
    // Check if prospect doesn't push back in the next few turns
    const pushback = prospectRespondsAfter(turns, recorderName, aeStatesTimeline.index, TIMELINE_LOOSE, 4);
    if (!pushback) {
      // Check for any prospect response (even short = implicit agreement)
      const anyResponse = prospectRespondsAfter(turns, recorderName, aeStatesTimeline.index, /./i, 4);
      if (anyResponse && !/nee|niet|moeilijk|lastig|kan.*niet/i.test(anyResponse.text)) {
        action.earned = true;
        action.evidence = `AE stelde tijdlijn voor: "${aeStatesTimeline.turn.text.slice(0, 100)}" — prospect stemde in.`;
        action.timestamp = aeStatesTimeline.turn.timestampDisplay;
        return action;
      }
    }
  }

  // Check for loose timeline (too far out = 0 points)
  const looseConfirm = prospectRespondsAfter(turns, recorderName, aeTimeline.index, TIMELINE_LOOSE, 10);
  if (looseConfirm) {
    action.reason = `Prospect noemde een beslismoment maar te ver weg: "${looseConfirm.text.slice(0, 100)}". Push: "Wat is er nodig om deze week te beslissen?"`;
    action.evidence = `Timeline te ver weg: "${looseConfirm.text.slice(0, 150)}"`;
    action.timestamp = looseConfirm.timestampDisplay;
    return action;
  }

  action.reason = 'Timeline besproken maar geen concreet moment afgesproken. Dring aan: "Kunnen we afspreken dat je uiterlijk vrijdag laat weten?"';
  action.evidence = `AE bracht timing ter sprake maar geen harde datum.`;
  action.timestamp = aeTimeline.turn.timestampDisplay;
  return action;
}

// ─── E: Good News Show / Hail Mary (10 pts) ────────────────────────────────
//
// AE offers incentive AND gets commitment back. Both sides of the trade.

const INCENTIVE_OFFER = /extra.*blog|extra.*artik|extra.*maand|extra.*pagina|korting|discount|setup.*fee|gratis|cadeau|bonus|erbij|er.*bovenop|speciale.*actie|als.*je.*nu|als.*jullie.*vandaag|alleen.*deze.*week|eenmalig|aanbieding|weggevertje|reducti|afprijz|onboarding.*gratis|opstartkosten|geen.*setup/i;

const COMMITMENT_BACK = /afgesproken|deal|akkoord|laten.*weten.*voor|beslissen.*voor|uiterlijk|tekenen.*voor|voor.*vrijdag|voor.*maandag|deze.*week|dan.*doen.*we|dan.*gaan.*we|dan.*starten|ik.*beloof|je.*hebt.*mijn.*woord|dat.*is.*goed|oké|oke|ok|prima|doe.*maar|top|klinkt.*goed|is.*goed|gaan.*we.*doen/i;

function detectGoodNewsShow(turns: TranscriptTurn[], recorderName: string): GameAction {
  const action: GameAction = {
    id: 'E', name: 'Good News Show', metaphor: 'The Hail Mary Pass',
    points: 10, earned: false, evidence: '',
  };

  const incentive = findTurn(turns, recorderName, 'ae', INCENTIVE_OFFER);
  if (!incentive) {
    action.reason = 'Geen incentive aangeboden. Bied altijd iets aan in ruil voor commitment: extra blogs, korting op setup fee, of een gratis maand. Vraag er iets voor terug!';
    action.evidence = 'Geen GNS (Good News Show) gevonden.';
    return action;
  }

  // Check for commitment back from prospect
  const commitment = prospectRespondsAfter(turns, recorderName, incentive.index, COMMITMENT_BACK, 10);
  if (commitment) {
    action.earned = true;
    action.evidence = `Incentive: "${incentive.turn.text.slice(0, 100)}" → Commitment: "${commitment.text.slice(0, 100)}"`;
    action.timestamp = incentive.turn.timestampDisplay;
    return action;
  }

  action.reason = `Je bood een incentive aan ("${incentive.turn.text.slice(0, 80)}"), maar kreeg geen commitment terug. GNS = ruil. Zeg: "Dit kan ik doen als jullie voor vrijdag laten weten."`;
  action.evidence = `Incentive zonder commitment: "${incentive.turn.text.slice(0, 150)}"`;
  action.timestamp = incentive.turn.timestampDisplay;
  return action;
}

// ─── F: Touchdown (30 pts) ─────────────────────────────────────────────────
//
// Only from outcome data. Lost deals = NEVER a touchdown.
// Unknown outcome: only if very strong close signals in transcript.

const STRONG_CLOSE = /getekend|ondertekend|deal.*rond|we.*gaan.*starten|stuur.*het.*contract|contract.*verstuurd|welkom.*bij|gefeliciteerd|we.*doen.*het|laten.*we.*beginnen|ik.*teken|waar.*moet.*ik.*tekenen|laten.*we.*starten|wanneer.*beginnen.*we|stuur.*maar.*op|laten.*we.*het.*doen/i;

function detectTouchdown(turns: TranscriptTurn[], recorderName: string, outcome: string): GameAction {
  const action: GameAction = {
    id: 'F', name: 'Touchdown', metaphor: 'TOUCHDOWN!',
    points: 30, earned: false, evidence: '',
  };

  // Won deals = automatic touchdown
  if (outcome === 'won') {
    action.earned = true;
    action.evidence = 'Deal geclosed!';
    const closeSignal = findTurn(turns, recorderName, 'prospect', STRONG_CLOSE);
    if (closeSignal) {
      action.evidence = `Deal closed: "${closeSignal.turn.text.slice(0, 150)}"`;
      action.timestamp = closeSignal.turn.timestampDisplay;
    }
    return action;
  }

  // Lost deals = NEVER a touchdown, regardless of what's in the transcript
  if (outcome === 'lost') {
    action.reason = 'Deal niet gewonnen. Analyseer wat er misgegaan is tussen value confirmation en het beslismoment.';
    action.evidence = 'Deal lost.';
    return action;
  }

  // Unknown outcome: only from very strong in-call close signals (strict)
  const signal = findTurn(turns, recorderName, 'prospect', STRONG_CLOSE);
  if (signal) {
    action.earned = true;
    action.evidence = `Close signal in call: "${signal.turn.text.slice(0, 150)}"`;
    action.timestamp = signal.turn.timestampDisplay;
    return action;
  }

  action.reason = 'Nog geen close. Werk toe naar een Touchdown via de stappen hierboven.';
  action.evidence = 'Nog geen close.';
  return action;
}

// ─── Main Scorer ───────────────────────────────────────────────────────────

export function scoreGame(
  turns: TranscriptTurn[],
  recorderName: string,
  outcome: string = 'unknown',
): GameScore {
  const actionA = detectValueConfirmation(turns, recorderName);
  const actionB = detectDecisionMaker(turns, recorderName);
  const actionC = detectBudget(turns, recorderName);
  const actionD = detectTimeline(turns, recorderName);
  const actionE = detectGoodNewsShow(turns, recorderName);
  const actionF = detectTouchdown(turns, recorderName, outcome);

  // Enforce sequence rule: B, C, D only count if A was earned
  const valueConfirmed = actionA.earned;
  if (!valueConfirmed) {
    for (const action of [actionB, actionC, actionD]) {
      if (action.earned) {
        action.earned = false;
        action.reason = `Geen punten: Value Confirmation (A) moet eerst behaald zijn. ${action.evidence}`;
        action.evidence = `Geblokkeerd: prospect heeft de waarde nog niet bevestigd. Eerst A scoren.`;
      }
    }
  }

  const actions = [actionA, actionB, actionC, actionD, actionE, actionF];
  const totalPoints = actions.reduce((sum, a) => sum + (a.earned ? a.points : 0), 0);

  const earnedNames = actions.filter(a => a.earned).map(a => a.metaphor);
  const missedNames = actions.filter(a => !a.earned).map(a => a.id);
  let summary: string;
  if (totalPoints === 70) {
    summary = 'Perfect game! Alle 6 acties gescoord — Touchdown!';
  } else if (totalPoints >= 40) {
    summary = `Sterke call (${totalPoints}/70). ${earnedNames.join(', ')}. Gemist: ${missedNames.join(', ')}.`;
  } else if (totalPoints >= 15) {
    summary = `Deal in beweging (${totalPoints}/70). ${earnedNames.length ? earnedNames.join(', ') + '.' : ''} Focus op: ${missedNames.join(', ')}.`;
  } else {
    summary = `Vroeg stadium (${totalPoints}/70). ${!valueConfirmed ? 'Begin met waarde bevestigen (A) — zonder First Down geen punten voor B/C/D.' : 'Focus op deal advancement.'}`;
  }

  return {
    totalPoints,
    maxPoints: 70,
    actions,
    valueConfirmed,
    summary,
  };
}
