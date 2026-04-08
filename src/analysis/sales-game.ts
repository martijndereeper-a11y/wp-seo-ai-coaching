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
  evidence: string;             // Quote or explanation of why earned/not earned
  timestamp?: string;           // When in the call this was detected
  reason?: string;              // If not earned: why not
}

export interface GameScore {
  totalPoints: number;
  maxPoints: number;            // Always 70
  actions: GameAction[];
  valueConfirmed: boolean;      // Gate for B/C/D
  summary: string;              // One-line human-readable summary
}

// ─── Detection Helpers ─────────────────────────────────────────────────────

function isAE(turn: TranscriptTurn, recorderName: string): boolean {
  const firstName = recorderName.split(' ')[0].toLowerCase();
  return turn.speaker.toLowerCase().includes(firstName);
}

function isProspect(turn: TranscriptTurn, recorderName: string): boolean {
  return !isAE(turn, recorderName);
}

/** Find the first turn index where a pattern matches in a speaker's turns */
function findTurn(
  turns: TranscriptTurn[],
  recorderName: string,
  speaker: 'ae' | 'prospect',
  pattern: RegExp,
): { index: number; turn: TranscriptTurn } | null {
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const isSpeaker = speaker === 'ae' ? isAE(t, recorderName) : isProspect(t, recorderName);
    if (!isSpeaker) continue;
    pattern.lastIndex = 0;
    if (pattern.test(t.text)) return { index: i, turn: t };
  }
  return null;
}

/** Check if a prospect turn exists after a given index matching a pattern */
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

// ─── Action Detectors ──────────────────────────────────────────────────────

// A — Value Confirmation (15 pts)
// AE asks if prospect sees value / wants to start → prospect explains why
const VALUE_ASK = /enthousiast|wil.*je.*starten|zou.*je.*willen|wat.*vind.*je|hoe.*klinkt|zouden.*jullie|interesse|zin.*in|klinkt.*dat|spreekt.*aan|overtuigd|past.*bij/i;
const VALUE_CONFIRM = /ja.*graag|wil.*starten|klinkt.*goed|spreekt.*aan|zie.*de.*waarde|logisch|past.*bij|interessant|willen.*we|gaan.*we|zeker|absoluut|overtuigd|enthousiast|wil.*ik|willen.*beginnen|ga.*ik|helemaal|snap.*waarom|belangrijk.*voor|helpt.*ons|nodig.*heb|precies.*wat|zoeken.*wij|perfect/i;

function detectValueConfirmation(turns: TranscriptTurn[], recorderName: string): GameAction {
  const action: GameAction = {
    id: 'A', name: 'Value Confirmation', metaphor: 'The First Down',
    points: 15, earned: false, evidence: '',
  };

  // Find AE asking the value question
  const aeAsk = findTurn(turns, recorderName, 'ae', VALUE_ASK);
  if (!aeAsk) {
    action.reason = 'Je hebt niet gevraagd of de prospect de waarde ziet of wil starten. Stel vragen als "Spreekt dit je aan?" of "Zou je hiermee willen starten?"';
    action.evidence = 'Geen value-vraag gevonden in het gesprek.';
    return action;
  }

  // Find prospect confirming after the ask
  const confirm = prospectRespondsAfter(turns, recorderName, aeAsk.index, VALUE_CONFIRM);
  if (!confirm) {
    action.reason = 'Je hebt de vraag gesteld, maar de prospect heeft de waarde niet expliciet bevestigd. Vraag door: "Kun je uitleggen waarom dit voor jullie interessant is?"';
    action.evidence = `AE vroeg: "${aeAsk.turn.text.slice(0, 120)}" maar prospect bevestigde niet.`;
    action.timestamp = aeAsk.turn.timestampDisplay;
    return action;
  }

  action.earned = true;
  action.evidence = `Prospect bevestigde: "${confirm.text.slice(0, 150)}"`;
  action.timestamp = confirm.timestampDisplay;
  return action;
}

// B — Decision Maker (5 pts)
const DM_ASK = /wie.*beslist|wie.*beslissing|beslisser|decision.*maker|wie.*tekent|wie.*akkoord|wie.*moet.*meekijk|andere.*stakeholder|nog.*iemand.*nodig|wie.*betrokken.*bij.*besluit|verantwoordelijk.*voor/i;
const DM_CONFIRM = /ik.*beslis|ik.*besluit|dat.*ben.*ik|dat.*doe.*ik|ik.*teken|alleen.*nodig|ik.*mag.*beslissen|niemand.*anders|mijn.*beslissing|ik.*ga.*erover|ik.*heb.*mandaat/i;

function detectDecisionMaker(turns: TranscriptTurn[], recorderName: string): GameAction {
  const action: GameAction = {
    id: 'B', name: 'Decision Maker', metaphor: 'The Snap',
    points: 5, earned: false, evidence: '',
  };

  const aeAsk = findTurn(turns, recorderName, 'ae', DM_ASK);
  if (!aeAsk) {
    action.reason = 'Je hebt niet gevraagd wie de beslisser is. Vraag altijd: "Wie beslist hierover?" of "Zijn er nog andere stakeholders betrokken?"';
    action.evidence = 'Geen DM-vraag gevonden.';
    return action;
  }

  const confirm = prospectRespondsAfter(turns, recorderName, aeAsk.index, DM_CONFIRM);
  if (confirm) {
    action.earned = true;
    action.evidence = `DM bevestigd: "${confirm.text.slice(0, 150)}"`;
    action.timestamp = confirm.timestampDisplay;
  } else {
    // DM question asked but no clear confirmation — still half credit scenario,
    // but rules say no: must be confirmed
    action.reason = 'Je hebt naar de DM gevraagd, maar geen duidelijke bevestiging gekregen. Push door: "Ben jij degene die dit tekent?"';
    action.evidence = `AE vroeg: "${aeAsk.turn.text.slice(0, 120)}" — geen bevestiging.`;
    action.timestamp = aeAsk.turn.timestampDisplay;
  }

  return action;
}

// C — Budget (5 pts)
const BUDGET_ASK = /budget|allocat|investering|beschikbaar|wat.*uitgeeft|gereserveerd|hoeveel.*kost|financial|middelen|ruimte.*voor/i;
const BUDGET_CONFIRM = /budget|beschikbaar|gereserveerd|kijken.*naar|investeren|ruimte.*voor|kunnen.*we|past.*binnen|akkoord.*op|geen.*probleem|dat.*lukt|is.*haalbaar/i;

function detectBudget(turns: TranscriptTurn[], recorderName: string): GameAction {
  const action: GameAction = {
    id: 'C', name: 'Budget / Allocatie', metaphor: 'Field Position',
    points: 5, earned: false, evidence: '',
  };

  const aeAsk = findTurn(turns, recorderName, 'ae', BUDGET_ASK);
  if (!aeAsk) {
    action.reason = 'Budget niet besproken. Vraag: "Is er budget beschikbaar?" of "Wat geeft je nu uit aan SEO/content?"';
    action.evidence = 'Geen budget-vraag gevonden.';
    return action;
  }

  const confirm = prospectRespondsAfter(turns, recorderName, aeAsk.index, BUDGET_CONFIRM);
  if (confirm) {
    action.earned = true;
    action.evidence = `Budget bevestigd: "${confirm.text.slice(0, 150)}"`;
    action.timestamp = confirm.timestampDisplay;
  } else {
    action.reason = 'Je hebt naar budget gevraagd maar geen bevestiging gekregen. Vraag concreter: "Is dit een investering die past binnen jullie huidige budget?"';
    action.evidence = `AE vroeg: "${aeAsk.turn.text.slice(0, 120)}" — niet bevestigd.`;
    action.timestamp = aeAsk.turn.timestampDisplay;
  }

  return action;
}

// D — Timeline (5 pts) — hard date WITHIN 1 WEEK
const TIMELINE_ASK = /wanneer.*besliss|wanneer.*starten|wanneer.*duidelijk|timeline|tijdlijn|deadline|beslismoment|datum|wanneer.*weten|wanneer.*horen|wanneer.*tekenen|deze.*week|volgende.*week|morgen/i;
const TIMELINE_CONFIRM_TIGHT = /morgen|overmorgen|vandaag|deze.*week|maandag|dinsdag|woensdag|donderdag|vrijdag|begin.*volgende.*week|uiterlijk|komende.*dagen|voor.*het.*weekend|binnen.*een.*week/i;
const TIMELINE_CONFIRM_LOOSE = /volgende.*maand|na.*de.*zomer|over.*een.*paar.*weken|over.*twee.*weken|na.*de.*vakantie|eind.*van.*de.*maand|binnenkort|snel/i;

function detectTimeline(turns: TranscriptTurn[], recorderName: string): GameAction {
  const action: GameAction = {
    id: 'D', name: 'Timeline', metaphor: 'The Game Clock',
    points: 5, earned: false, evidence: '',
  };

  const aeAsk = findTurn(turns, recorderName, 'ae', TIMELINE_ASK);
  if (!aeAsk) {
    action.reason = 'Geen beslismoment afgesproken. Vraag altijd: "Wanneer kunnen jullie hierover beslissen?" en push naar een harde datum binnen een week.';
    action.evidence = 'Geen timeline-vraag gevonden.';
    return action;
  }

  // Check for tight timeline first (within ~1 week)
  const tightConfirm = prospectRespondsAfter(turns, recorderName, aeAsk.index, TIMELINE_CONFIRM_TIGHT);
  if (tightConfirm) {
    action.earned = true;
    action.evidence = `Harde datum binnen een week: "${tightConfirm.text.slice(0, 150)}"`;
    action.timestamp = tightConfirm.timestampDisplay;
    return action;
  }

  // Check for loose timeline (too far out = no points)
  const looseConfirm = prospectRespondsAfter(turns, recorderName, aeAsk.index, TIMELINE_CONFIRM_LOOSE);
  if (looseConfirm) {
    action.reason = `Prospect noemde een beslismoment maar te ver in de toekomst: "${looseConfirm.text.slice(0, 100)}". Push naar deze week: "Wat is er nodig om deze week een beslissing te nemen?"`;
    action.evidence = `Timeline te ver weg: "${looseConfirm.text.slice(0, 150)}"`;
    action.timestamp = looseConfirm.timestampDisplay;
    return action;
  }

  action.reason = 'Je hebt naar de timeline gevraagd maar geen concreet moment gekregen. Dring aan: "Kunnen we afspreken dat je uiterlijk vrijdag laat weten?"';
  action.evidence = `AE vroeg: "${aeAsk.turn.text.slice(0, 120)}" — geen harde datum.`;
  action.timestamp = aeAsk.turn.timestampDisplay;
  return action;
}

// E — Good News Show (10 pts)
// AE offers incentive AND prospect gives commitment back. Both sides must be present.
const INCENTIVE_OFFER = /extra.*blog|extra.*artik|extra.*maand|korting|discount|setup.*fee|gratis|cadeau|bonus|erbij|er.*bovenop|speciale.*actie|als.*je.*nu|als.*jullie.*vandaag|alleen.*deze.*week|eenmalig/i;
const COMMITMENT_BACK = /afgesproken|deal|akkoord|laten.*weten.*voor|beslissen.*voor|uiterlijk|tekenen.*voor|voor.*vrijdag|voor.*maandag|deze.*week|dan.*doen.*we|dan.*gaan.*we|dan.*starten|ik.*beloof|je.*hebt.*mijn.*woord/i;

function detectGoodNewsShow(turns: TranscriptTurn[], recorderName: string): GameAction {
  const action: GameAction = {
    id: 'E', name: 'Good News Show', metaphor: 'The Hail Mary Pass',
    points: 10, earned: false, evidence: '',
  };

  // Find AE offering an incentive
  const incentive = findTurn(turns, recorderName, 'ae', INCENTIVE_OFFER);
  if (!incentive) {
    action.reason = 'Geen incentive aangeboden. Bied altijd iets aan in ruil voor commitment: extra blogs, korting op setup fee, of een gratis maand. Maar vraag er dan wel iets voor terug!';
    action.evidence = 'Geen GNS (Good News Show) gevonden.';
    return action;
  }

  // Check if prospect gave commitment in return
  const commitment = prospectRespondsAfter(turns, recorderName, incentive.index, COMMITMENT_BACK, 8);
  if (!commitment) {
    action.reason = `Je bood een incentive aan ("${incentive.turn.text.slice(0, 80)}"), maar vroeg niet om commitment terug. GNS = ruil. Zeg: "Dit kan ik doen als jullie voor vrijdag laten weten."`;
    action.evidence = `Incentive zonder commitment terug: "${incentive.turn.text.slice(0, 150)}"`;
    action.timestamp = incentive.turn.timestampDisplay;
    return action;
  }

  action.earned = true;
  action.evidence = `Incentive: "${incentive.turn.text.slice(0, 100)}" → Commitment: "${commitment.text.slice(0, 100)}"`;
  action.timestamp = incentive.turn.timestampDisplay;
  return action;
}

// F — Touchdown (30 pts)
// Detected from outcome data, not transcript. But we also check for in-call close signals.
const CLOSE_SIGNALS = /getekend|ondertekend|deal.*rond|akkoord|we.*gaan.*starten|stuur.*maar|contract.*verstuurd|welkom.*bij|gefeliciteerd|we.*doen.*het|laten.*we.*beginnen|ik.*teken|waar.*moet.*ik.*tekenen/i;

function detectTouchdown(turns: TranscriptTurn[], recorderName: string, outcome: string): GameAction {
  const action: GameAction = {
    id: 'F', name: 'Touchdown', metaphor: 'TOUCHDOWN!',
    points: 30, earned: false, evidence: '',
  };

  if (outcome === 'won') {
    action.earned = true;
    action.evidence = 'Deal is closed!';
    // Try to find the close moment in transcript
    const closeSignal = findTurn(turns, recorderName, 'prospect', CLOSE_SIGNALS);
    if (closeSignal) {
      action.evidence = `Deal closed: "${closeSignal.turn.text.slice(0, 150)}"`;
      action.timestamp = closeSignal.turn.timestampDisplay;
    }
    return action;
  }

  // Check for in-call close signals even if outcome isn't 'won'
  const signal = findTurn(turns, recorderName, 'prospect', CLOSE_SIGNALS);
  if (signal) {
    action.earned = true;
    action.evidence = `Close signal: "${signal.turn.text.slice(0, 150)}"`;
    action.timestamp = signal.turn.timestampDisplay;
    return action;
  }

  action.reason = outcome === 'lost'
    ? 'Deal niet geclosed. Analyseer wat er tussen de waarde-bevestiging en het beslismoment is misgegaan.'
    : 'Nog geen close. Focus op de stappen hierboven om naar een Touchdown toe te werken.';
  action.evidence = outcome === 'lost' ? 'Deal lost.' : 'Nog geen close.';
  return action;
}

// ─── Main Scorer ───────────────────────────────────────────────────────────

export function scoreGame(
  turns: TranscriptTurn[],
  recorderName: string,
  outcome: string = 'unknown',
): GameScore {
  // Score each action
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

  // Generate summary
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
