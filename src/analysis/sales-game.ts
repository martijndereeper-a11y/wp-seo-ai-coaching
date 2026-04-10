/**
 * Sales Game Scorer — Quarterback Sprint
 *
 * Velocity-first methodology: force a decision within 1 week.
 * Score by gaining grip on the process, not by being liked.
 *
 *   A (15 pts) — First Down: Prospect explains in own words WHY they need this
 *   B (5 pts)  — The Snap: Decision maker identified with mandate confirmation
 *   C (5 pts)  — Field Position: Budget or reallocation explicitly discussed
 *   D (5 pts)  — Game Clock: Hard decision date within ~1 week
 *   E (10 pts) — Hail Mary: Incentive traded for a fixed commitment date (GNS)
 *   F (10 pts) — Defensive Line: AE pushes urgency → prospect resists → AE handles it
 *
 * Key rules:
 * - B, C, D only count if A (value confirmation) happened first
 * - E requires BOTH an incentive AND a date-bound commitment back
 * - F requires a 3-step sequence: pressure → resistance → handling
 * - Only transcript evidence counts. "I felt it went well" = 0 points.
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

function isQuestionTurn(turn: TranscriptTurn): boolean {
  if (turn.text.includes('?')) return true;
  if (turn.wordCount <= 20 && /toch$|of niet$|he$|hè$/i.test(turn.text.trim())) return true;
  return false;
}

const DOUBT = /weet.*niet|twijfel|lastig|moeilijk|niet.*zeker|misschien.*niet|geen.*idee|moet.*nadenken|intern.*overleg|te.*duur|geen.*budget|geen.*tijd|nicht.*sicher|schwierig/i;

// ─── A: First Down — Value Confirmation (15 pts) ──────────────────────────
//
// Prospect must explain in THEIR OWN WORDS why they need this product.
// One-word agreement ("ja", "top") is politeness, not intrinsic motivation.
// We need a substantive response (>20 words) with reasoning language,
// OR explicit desire-to-act language.

const VALUE_ASK = /enthousiast|wil.*je.*starten|zou.*je.*willen|wat.*vind.*je|hoe.*klinkt|zouden.*jullie|interesse|zin.*in|klinkt.*dat|spreekt.*je.*aan|overtuigd|past.*bij|zou.*dit.*iets|is.*dit.*iets|zie.*je.*dit|aanspreek|leuk.*vind|iets.*voor.*jullie|zouden.*jullie.*willen|hier.*mee.*aan.*de.*slag|matcht|aansluit|waarom.*wil|wat.*spreekt.*je.*aan|kun.*je.*uitleggen/i;

// Prospect articulates a reason — desire + because/why language
const VALUE_WHY = /omdat|want|daarom|reden|nodig.*heb|zoeken.*wij|willen.*we.*graag|wil.*ik.*graag|missen.*we|probleem.*is|doel.*is|dat.*zou.*ons|dat.*helpt.*ons|hebben.*we.*last|kost.*ons.*nu|besparen|effici[eë]nt|groeien|we.*lopen.*vast|we.*komen.*niet|we.*missen|we.*hebben.*geen|we.*willen.*meer|dat.*is.*precies.*wat|dat.*is.*waar.*we|oploss|verbeter/i;

// Strong desire-to-act (not just agreement, but wanting to move)
const VALUE_DESIRE = /willen.*beginnen|willen.*starten|wil.*ik.*graag|ga.*ik.*graag|gaan.*we.*doen|willen.*we.*zeker|moeten.*we.*hebben|kunnen.*we.*niet.*zonder|is.*essentieel|is.*cruciaal|hebben.*we.*echt.*nodig|zo.*snel.*mogelijk|kan.*niet.*wachten|wanneer.*kunnen.*we.*starten|hoe.*snel.*kan/i;

function detectValueConfirmation(turns: TranscriptTurn[], recorderName: string): GameAction {
  const action: GameAction = {
    id: 'A', name: 'Value Confirmation', metaphor: 'The First Down',
    points: 15, earned: false, evidence: '',
  };

  // Find AE value question
  let bestAsk: { index: number; turn: TranscriptTurn } | null = null;
  let searchFrom = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    const match = findTurn(turns, recorderName, 'ae', VALUE_ASK, searchFrom);
    if (!match) break;
    if (isQuestionTurn(match.turn)) { bestAsk = match; break; }
    if (!bestAsk && match.index > turns.length * 0.4) bestAsk = match;
    searchFrom = match.index + 1;
  }

  if (!bestAsk) {
    action.reason = 'Je hebt niet gevraagd of de prospect de waarde ziet. Stel vragen als "Kun je uitleggen waarom dit voor jullie interessant is?" of "Wat spreekt je aan?"';
    action.evidence = 'Geen value-vraag gevonden in het gesprek.';
    return action;
  }

  // Check prospect responses after the ask (wider window of 8 turns)
  const limit = Math.min(bestAsk.index + 8, turns.length);
  for (let i = bestAsk.index + 1; i < limit; i++) {
    const t = turns[i];
    if (!isProspect(t, recorderName)) continue;

    // Path 1: Prospect uses desire-to-act language (any length)
    VALUE_DESIRE.lastIndex = 0;
    if (VALUE_DESIRE.test(t.text)) {
      action.earned = true;
      action.evidence = `Prospect wil actie: "${t.text.slice(0, 150)}"`;
      action.timestamp = t.timestampDisplay;
      return action;
    }

    // Path 2: Prospect gives a substantive answer (>20 words) with reasoning
    VALUE_WHY.lastIndex = 0;
    if (t.wordCount > 20 && VALUE_WHY.test(t.text)) {
      action.earned = true;
      action.evidence = `Prospect legt uit waarom: "${t.text.slice(0, 150)}"`;
      action.timestamp = t.timestampDisplay;
      return action;
    }

    // Path 3: Long substantive answer (>30 words) without doubt — they're
    // explaining something real even if they don't use explicit "because"
    if (t.wordCount > 30) {
      DOUBT.lastIndex = 0;
      if (!DOUBT.test(t.text)) {
        action.earned = true;
        action.evidence = `Prospect gaf uitgebreid positief antwoord: "${t.text.slice(0, 150)}"`;
        action.timestamp = t.timestampDisplay;
        return action;
      }
    }
  }

  action.reason = 'Je stelde de vraag, maar de prospect gaf geen inhoudelijk antwoord over waarom ze dit nodig hebben. Eén woord "ja" is niet genoeg — vraag door: "Kun je uitleggen wat dit voor jullie zou oplossen?"';
  action.evidence = `AE vroeg: "${bestAsk.turn.text.slice(0, 120)}" maar prospect gaf geen onderbouwing.`;
  action.timestamp = bestAsk.turn.timestampDisplay;
  return action;
}

// ─── B: The Snap — Decision Maker (5 pts) ─────────────────────────────────
//
// AE surfaces who decides. No DM = no game.
// Unchanged — this logic is solid.

const DM_ASK = /wie.*beslist|wie.*beslissing|beslisser|decision.*maker|wie.*tekent|wie.*akkoord|wie.*moet.*meekijk|stakeholder|nog.*iemand.*nodig|wie.*betrokken|verantwoordelijk|ben.*jij.*degene|jij.*zelf.*beslissen|alleen.*jij|iemand.*anders.*nodig|goedkeuring|eigenaar|directeur|directie|management|team.*betrokken|afstemmen.*met|overleg.*met|toestemming|moet.*je.*nog/i;

const DM_CONFIRM = /ik.*beslis|ik.*besluit|dat.*ben.*ik|dat.*doe.*ik|ik.*teken|alleen.*nodig|ik.*mag.*beslissen|niemand.*anders|mijn.*beslissing|ik.*ga.*erover|ik.*heb.*mandaat|ik.*kan.*dat|hoef.*niemand|eigenaar|directeur.*ben.*ik|mijn.*bedrijf|mijn.*zaak|ik.*ben.*de.*baas|zelf.*weten|ik.*bepaal|nee.*alleen.*ik|nee.*dat.*hoeft.*niet|nee.*ik.*kan/i;

function detectDecisionMaker(turns: TranscriptTurn[], recorderName: string): GameAction {
  const action: GameAction = {
    id: 'B', name: 'Decision Maker', metaphor: 'The Snap',
    points: 5, earned: false, evidence: '',
  };

  const aeAsk = findTurn(turns, recorderName, 'ae', DM_ASK);
  if (aeAsk) {
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

// ─── C: Field Position — Budget / Allocation (5 pts) ──────────────────────
//
// Explicit budget/reallocation conversation. Prospect must indicate willingness
// to invest or confirm amounts. "Wat kost het?" is a question, not confirmation.

const BUDGET_ASK = /budget|allocat|investering|beschikbaar|wat.*uitgeef|gereserveerd|hoeveel.*kost|middelen|ruimte.*voor|wat.*betaal.*je.*nu|wat.*geef.*je.*uit|wat.*kost.*jullie|bureau.*kost|wat.*zijn.*de.*kosten/i;

// Prospect signals willingness to invest — explicit, not just asking a question
const BUDGET_CONFIRM = /beschikbaar|gereserveerd|investeren|ruimte.*voor|past.*binnen|geen.*probleem|dat.*lukt|is.*haalbaar|kan.*wel|is.*te.*doen|betalen.*we.*nu|geven.*we.*uit|dat.*is.*prima|kan.*ik.*doen|te.*overzien|schappelijk|meevalt|niet.*zo.*duur|best.*redelijk|daar.*heb.*ik|daar.*hebben.*we|budget.*is|kost.*ons.*nu|we.*betalen.*nu|we.*geven.*uit|per.*maand.*uit|euro.*per.*maand|daar.*kan.*ik.*mee|dat.*is.*het.*waard|dat.*mag.*kosten/i;

function detectBudget(turns: TranscriptTurn[], recorderName: string): GameAction {
  const action: GameAction = {
    id: 'C', name: 'Budget / Allocatie', metaphor: 'Field Position',
    points: 5, earned: false, evidence: '',
  };

  // Check if budget topic comes up from AE side
  const aeBudget = findTurn(turns, recorderName, 'ae', BUDGET_ASK);
  if (!aeBudget) {
    action.reason = 'Budget niet besproken. Vraag: "Wat geef je nu uit aan SEO/content?" of "Is er budget beschikbaar?"';
    action.evidence = 'AE heeft budget/investering niet ter sprake gebracht.';
    return action;
  }

  // Check for explicit budget confirmation from prospect (wider window — budget
  // discussions can take a few exchanges)
  const confirm = prospectRespondsAfter(turns, recorderName, aeBudget.index, BUDGET_CONFIRM, 12);
  if (confirm) {
    action.earned = true;
    action.evidence = `Budget bevestigd: "${confirm.text.slice(0, 150)}"`;
    action.timestamp = confirm.timestampDisplay;
    return action;
  }

  // Prospect proactively mentions specific amounts/current spend (anywhere after
  // AE brings it up) — scan remaining turns
  for (let i = aeBudget.index + 1; i < turns.length; i++) {
    const t = turns[i];
    if (!isProspect(t, recorderName)) continue;
    // Mentions concrete money: numbers + euro/per maand/budget
    if (/\d/.test(t.text) && /euro|€|per.*maand|per.*jaar|budget|investeer|besteed|uitgeef|betaal/i.test(t.text)) {
      action.earned = true;
      action.evidence = `Prospect noemde bedragen: "${t.text.slice(0, 150)}"`;
      action.timestamp = t.timestampDisplay;
      return action;
    }
  }

  action.reason = 'Budget werd besproken maar prospect gaf geen duidelijk signaal over beschikbaarheid. Vraag concreter: "Wat geven jullie nu uit aan SEO?" of "Past dit binnen jullie budget?"';
  action.evidence = `AE bracht budget ter sprake maar geen bevestiging van prospect.`;
  action.timestamp = aeBudget.turn.timestampDisplay;
  return action;
}

// ─── D: Game Clock — Timeline (5 pts) ─────────────────────────────────────
//
// Strictest rule. Decision moment within ~1 week. 2+ weeks out = 0 points.
// Requires EXPLICIT date confirmation from prospect — "silence" or generic
// responses don't count. Momentum dies without a concrete deadline.

const TIMELINE_ASK = /wanneer.*beslis|wanneer.*laten.*weten|wanneer.*horen|wanneer.*starten|beslismoment|beslisdatum|datum|wanneer.*tekenen|deze.*week.*besliss|voor.*wanneer|deadline|tijdlijn|timeline|termijn|wanneer.*kunnen.*jullie|wanneer.*kan.*je/i;

const TIMELINE_TIGHT = /morgen|overmorgen|vandaag|deze.*week|maandag|dinsdag|woensdag|donderdag|vrijdag|begin.*volgende.*week|uiterlijk|komende.*dagen|voor.*het.*weekend|binnen.*een.*week|paar.*dagen|eind.*van.*de.*week|aankomende/i;

const TIMELINE_LOOSE = /volgende.*maand|na.*de.*zomer|over.*een.*paar.*weken|over.*twee.*weken|na.*de.*vakantie|eind.*van.*de.*maand|over.*een.*maand|paar.*weken|paar.*maanden|later|niet.*nu|nog.*even|op.*termijn/i;

function detectTimeline(turns: TranscriptTurn[], recorderName: string): GameAction {
  const action: GameAction = {
    id: 'D', name: 'Timeline', metaphor: 'The Game Clock',
    points: 5, earned: false, evidence: '',
  };

  // Find AE pushing for timeline
  const aeTimeline = findTurn(turns, recorderName, 'ae', TIMELINE_ASK);
  if (!aeTimeline) {
    action.reason = 'Geen beslismoment besproken. Vraag: "Wanneer kunnen jullie hierover beslissen?" en push naar deze week.';
    action.evidence = 'AE heeft niet naar een beslisdatum gevraagd.';
    return action;
  }

  // Only explicit tight timeline confirmation from PROSPECT counts
  const tightConfirm = prospectRespondsAfter(turns, recorderName, aeTimeline.index, TIMELINE_TIGHT, 10);
  if (tightConfirm) {
    action.earned = true;
    action.evidence = `Harde datum van prospect: "${tightConfirm.text.slice(0, 150)}"`;
    action.timestamp = tightConfirm.timestampDisplay;
    return action;
  }

  // Check for loose timeline (too far out = 0 points, but useful coaching feedback)
  const looseConfirm = prospectRespondsAfter(turns, recorderName, aeTimeline.index, TIMELINE_LOOSE, 10);
  if (looseConfirm) {
    action.reason = `Prospect noemde een datum maar te ver weg: "${looseConfirm.text.slice(0, 100)}". Push: "Wat is er nodig om deze week te beslissen?"`;
    action.evidence = `Timeline te ver weg: "${looseConfirm.text.slice(0, 150)}"`;
    action.timestamp = looseConfirm.timestampDisplay;
    return action;
  }

  action.reason = 'Timeline besproken maar prospect heeft geen concreet moment bevestigd. Dring aan: "Kunnen we afspreken dat je uiterlijk vrijdag laat weten?"';
  action.evidence = `AE vroeg naar timing maar prospect gaf geen harde datum.`;
  action.timestamp = aeTimeline.turn.timestampDisplay;
  return action;
}

// ─── E: Hail Mary — Good News Show (10 pts) ───────────────────────────────
//
// Psychological trade: AE gives incentive IN EXCHANGE FOR a fixed date.
// Generic "ok" or "top" without a date = not a trade. The commitment must
// include a specific date or concrete action with timing.

const INCENTIVE_OFFER = /extra.*blog|extra.*artik|extra.*maand|extra.*pagina|korting|discount|setup.*fee|gratis|cadeau|bonus|erbij|er.*bovenop|speciale.*actie|als.*je.*nu|als.*jullie.*vandaag|alleen.*deze.*week|eenmalig|aanbieding|weggevertje|reducti|afprijz|onboarding.*gratis|opstartkosten|geen.*setup/i;

// Commitment must include a DATE or concrete timing — not just "ok"
const DATED_COMMITMENT = /voor.*vrijdag|voor.*maandag|deze.*week|uiterlijk|laten.*weten.*voor|beslissen.*voor|tekenen.*voor|morgen|overmorgen|voor.*het.*weekend|komende.*dagen|dan.*doen.*we.*het|dan.*starten.*we|dan.*gaan.*we|afgesproken.*voor|dan.*teken|dan.*beslis/i;

function detectGoodNewsShow(turns: TranscriptTurn[], recorderName: string): GameAction {
  const action: GameAction = {
    id: 'E', name: 'Good News Show', metaphor: 'The Hail Mary Pass',
    points: 10, earned: false, evidence: '',
  };

  const incentive = findTurn(turns, recorderName, 'ae', INCENTIVE_OFFER);
  if (!incentive) {
    action.reason = 'Geen incentive aangeboden. Bied altijd iets aan in ruil voor een vaste datum: extra blogs, korting op setup, of een gratis maand. Maar vraag er een deadline voor terug!';
    action.evidence = 'Geen GNS (Good News Show) gevonden.';
    return action;
  }

  // Check for dated commitment back from prospect
  const commitment = prospectRespondsAfter(turns, recorderName, incentive.index, DATED_COMMITMENT, 10);
  if (commitment) {
    action.earned = true;
    action.evidence = `Incentive: "${incentive.turn.text.slice(0, 100)}" → Commitment met datum: "${commitment.text.slice(0, 100)}"`;
    action.timestamp = incentive.turn.timestampDisplay;
    return action;
  }

  // Also check if AE ties the incentive to a date and prospect agrees to that date
  const aeCondition = findTurn(turns, recorderName, 'ae', /als.*je.*voor|als.*jullie.*voor|als.*je.*deze.*week|als.*jullie.*deze.*week|op.*voorwaarde|in.*ruil.*voor/i, incentive.index);
  if (aeCondition) {
    const prospectAgrees = prospectRespondsAfter(turns, recorderName, aeCondition.index, DATED_COMMITMENT, 8);
    if (prospectAgrees) {
      action.earned = true;
      action.evidence = `AE stelde voorwaarde: "${aeCondition.turn.text.slice(0, 100)}" → Prospect akkoord: "${prospectAgrees.text.slice(0, 100)}"`;
      action.timestamp = aeCondition.turn.timestampDisplay;
      return action;
    }
  }

  action.reason = `Je bood een incentive aan ("${incentive.turn.text.slice(0, 80)}"), maar kreeg geen datum-gebonden commitment terug. GNS = ruil voor controle. Zeg: "Dit kan ik doen als jullie voor vrijdag laten weten."`;
  action.evidence = `Incentive zonder datum-commitment: "${incentive.turn.text.slice(0, 150)}"`;
  action.timestamp = incentive.turn.timestampDisplay;
  return action;
}

// ─── F: Defensive Line — Objection Handling Under Pressure (10 pts) ───────
//
// The test of resilience. Requires a 3-step sequence:
//   1. AE pushes urgency / tight timeline
//   2. Prospect resists or objects (pushback)
//   3. AE handles the pushback (doesn't fold, engages constructively)
//
// If the prospect says "ja" immediately without resistance — no points.
// We WANT to see resistance and how the AE tackles it.

const URGENCY_PUSH = /deze.*week|voor.*vrijdag|voor.*maandag|morgen|vandaag|uiterlijk|nu.*beslissen|snel.*beslissen|niet.*te.*lang.*wachten|momentum|nu.*starten|direct.*starten|meteen|zo.*snel.*mogelijk|wachten.*kost|hoe.*sneller|het.*liefst.*deze.*week|ik.*zou.*je.*aanraden.*om.*snel/i;

const PROSPECT_RESISTANCE = /moet.*nadenken|even.*overleggen|intern.*bespreken|te.*snel|rustig.*aan|geen.*haast|eerst.*nog|niet.*zo.*snel|volgende.*maand|na.*de.*vakantie|na.*de.*zomer|lastig|moeilijk|weet.*niet|twijfel|te.*vroeg|kan.*niet.*zo.*snel|partner.*overleg|collega.*overleg|bestuur.*overleg|druk.*nu|agenda.*vol|plannen.*eerst|eerst.*kijken|ik.*wil.*nog|vergelijk|andere.*partij|concurrent|even.*afwachten|dat.*lukt.*niet|niet.*deze.*week|moet.*er.*over.*slapen/i;

const AE_HANDLES = /begrijp|snap.*ik|logisch|wat.*zou.*ervoor.*nodig|wat.*als|stel.*dat|zou.*het.*helpen|wat.*zou.*helpen|kan.*ik.*iets.*doen|wat.*houdt.*je.*tegen|wat.*heb.*je.*nodig|als.*ik.*zou|laten.*we.*afspreken|concreet|specifiek|wanneer.*zou.*het.*wel|wat.*als.*we|dan.*stel.*ik.*voor|mijn.*voorstel|ik.*kan.*je.*helpen|wat.*maakt.*het.*lastig|leg.*eens.*uit|vertel.*me|hoe.*kan.*ik|wat.*is.*de.*blokkade|wie.*moet|wat.*moet.*er.*gebeuren/i;

function detectDefensiveLine(turns: TranscriptTurn[], recorderName: string): GameAction {
  const action: GameAction = {
    id: 'F', name: 'Defensive Line', metaphor: 'The Defensive Line',
    points: 10, earned: false, evidence: '',
  };

  // Step 1: Find AE pushing urgency
  let pushStart = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const aePush = findTurn(turns, recorderName, 'ae', URGENCY_PUSH, pushStart);
    if (!aePush) break;

    // Step 2: Prospect resists within 6 turns
    const resistance = prospectRespondsAfter(turns, recorderName, aePush.index, PROSPECT_RESISTANCE, 6);
    if (!resistance) {
      pushStart = aePush.index + 1;
      continue;
    }

    // Find the resistance turn index
    let resistanceIndex = aePush.index + 1;
    for (let i = aePush.index + 1; i < Math.min(aePush.index + 7, turns.length); i++) {
      if (turns[i] === resistance) { resistanceIndex = i; break; }
    }

    // Step 3: AE handles the pushback (within 4 turns after resistance)
    const handling = findTurn(turns, recorderName, 'ae', AE_HANDLES, resistanceIndex + 1);
    if (handling && handling.index <= resistanceIndex + 4) {
      action.earned = true;
      action.evidence = `Push: "${aePush.turn.text.slice(0, 80)}" → Weerstand: "${resistance.text.slice(0, 80)}" → Handling: "${handling.turn.text.slice(0, 80)}"`;
      action.timestamp = aePush.turn.timestampDisplay;
      return action;
    }

    // Found resistance but AE didn't handle it — coaching moment
    action.reason = `Je duwde op urgentie en de prospect gaf weerstand ("${resistance.text.slice(0, 80)}"), maar je ging er niet op in. Vraag door: "Wat zou ervoor nodig zijn om deze week te beslissen?"`;
    action.evidence = `Weerstand niet afgehandeld: "${resistance.text.slice(0, 120)}"`;
    action.timestamp = resistance.timestampDisplay;
    return action;
  }

  // No urgency push found at all
  const anyPush = findTurn(turns, recorderName, 'ae', URGENCY_PUSH);
  if (!anyPush) {
    action.reason = 'Geen urgentie gecreëerd. Push op een strakke deadline en wees niet bang voor weerstand — dáár zit de coaching value.';
    action.evidence = 'AE heeft niet op urgentie geduwd.';
    return action;
  }

  // AE pushed but prospect didn't resist — immediate agreement or silence
  action.reason = 'Je pushte op urgentie maar er kwam geen weerstand. Dat kan betekenen dat de prospect niet echt betrokken was, of dat de push niet sterk genoeg was.';
  action.evidence = `AE pushte: "${anyPush.turn.text.slice(0, 120)}" — geen weerstand van prospect.`;
  action.timestamp = anyPush.turn.timestampDisplay;
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
  const actionF = detectDefensiveLine(turns, recorderName);

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
  const maxPoints = 50;

  const earnedNames = actions.filter(a => a.earned).map(a => a.metaphor);
  const missedNames = actions.filter(a => !a.earned).map(a => a.id);
  let summary: string;
  if (totalPoints === maxPoints) {
    summary = 'Perfect game! Alle 6 acties gescoord.';
  } else if (totalPoints >= 30) {
    summary = `Sterke call (${totalPoints}/${maxPoints}). ${earnedNames.join(', ')}. Gemist: ${missedNames.join(', ')}.`;
  } else if (totalPoints >= 15) {
    summary = `Deal in beweging (${totalPoints}/${maxPoints}). ${earnedNames.length ? earnedNames.join(', ') + '.' : ''} Focus op: ${missedNames.join(', ')}.`;
  } else {
    summary = `Vroeg stadium (${totalPoints}/${maxPoints}). ${!valueConfirmed ? 'Begin met waarde bevestigen (A) — zonder First Down geen punten voor B/C/D.' : 'Focus op deal advancement.'}`;
  }

  return {
    totalPoints,
    maxPoints,
    actions,
    valueConfirmed,
    summary,
  };
}
