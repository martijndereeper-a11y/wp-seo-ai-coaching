/**
 * Pattern Detector
 *
 * Detects storytelling, sales technique, and behavioral patterns in AE speech.
 * Returns scored dimensions and highlight moments with timestamps.
 */

import type { TranscriptTurn } from './transcript-parser.ts';
import { SCRIPT_SECTIONS, MAX_SCRIPT_SCORE } from './script-sections.ts';

export interface PatternEvidence {
  timestampSeconds: number;
  timestampDisplay: string;
  excerpt: string;
  matchedKeyword: string;
}

export interface HighlightMoment {
  timestampSeconds: number;
  timestampDisplay: string;
  type: 'strength' | 'weakness' | 'coachable';
  category: string;
  description: string;
  guidance: string;
  excerpt: string;
  confidence: 'high' | 'medium' | 'low';
  // Rich context for coaching review
  context?: {
    before?: { speaker: string; text: string; timestamp: string };  // what was said before
    trigger: { speaker: string; text: string; timestamp: string };   // the moment itself
    after?: { speaker: string; text: string; timestamp: string };    // what happened next (AE reaction)
    shouldHaveDone?: string;  // specific alternative for THIS exact situation
  };
}

export interface PatternScores {
  // Storytelling
  marketContext: number;
  contentEngine: number;
  visibility: number;
  dataDriven: number;
  companyIntro: number;
  aiAngle: number;
  authority: number;
  socialProof: number;
  aspiration: number;
  vsAgency: number;
  compounding: number;
  // Sales technique
  activeListening: number;
  roiReframe: number;
  urgency: number;
  contract: number;
  personalStory: number;
  pricing: number;
  humor: number;
  theirBusiness: number;
  checkIn: number;
  opinionAsk: number;
  research: number;
  directness: number;
  priceAnchor: number;
  assumptiveClose: number;
  challenging: number;
}

export interface ProspectEngagement {
  buyingSignals: number;
  redFlags: number;
  engagementIndicators: number;
  score: 'engaged' | 'neutral' | 'disengaged';
  details: {
    buyingSignalTypes: string[];
    redFlagTypes: string[];
    engagementTypes: string[];
  };
}

export interface CallAnalysis {
  patterns: PatternScores;
  patternEvidence: Record<string, PatternEvidence[]>; // keyed by dimension name
  scriptAdherence: number; // 0-100
  sectionsHit: number[];
  sectionsMissed: number[];
  highlights: HighlightMoment[];
  talkRatio: number;
  questionCount: number;
  longestMonologue: number;
  aeWordCount: number;
  prospectQuestionCount: number;
  callVerdict: string[];
  prospectEngagement: ProspectEngagement;
}

const PATTERN_DEFS: Record<keyof PatternScores, RegExp> = {
  marketContext: /zoekgedrag|google|chatgpt|ai overviews|perplexity|zoekmarkt|seo.*verandert|online.*vindbaar/gi,
  contentEngine: /content|blog|artik|publicer|schrijven|tekst|pagina.*per.*maand/gi,
  visibility: /vindbaar|zichtbaar|gevonden.*worden|zoekresultat|ranking|positie|organisch/gi,
  dataDriven: /data|analys|meten|dashboard|rapportage|inzicht|tracking|monitor/gi,
  companyIntro: /wij zijn|we zijn|opgericht|kantoor|medewerkers|ons team|amsterdam|finland/gi,
  aiAngle: /\bai\b|ai.gedreven|kunstmatige|artificial/gi,
  authority: /expert|specialist|marktleider|bewezen|track.record|professionals/gi,
  socialProof: /\d+.*klanten|\d+.*bedrijven|2000|tweeduizend|duizend.*klant/gi,
  aspiration: /marktleider|groeien|schalen|volgende.*stap|ambitie|potentieel|mogelijkheid|kansen/gi,
  vsAgency: /bureau|agency|freelanc|extern.*inhuur|traditioneel/gi,
  compounding: /compound|stapel|sneeuwbal|snowball|exponenti|over.*tijd.*groei/gi,
  activeListening: /als.*ik.*het.*goed.*begrijp|dus.*je.*zegt|interessant|goed.*punt|snap.*ik|herkenbaar/gi,
  roiReframe: /investering|verdien.*terug|roi|terugverdien|waarde.*versus/gi,
  urgency: /snel|direct|meteen|zo snel mogelijk|nu.*het.*moment|wachten.*kost/gi,
  contract: /contract|onderteken|sign|overeenkomst|akkoord|bevestig/gi,
  personalStory: /wij hadden|ik had|bij ons|wij merkten|wij zagen|onze ervaring/gi,
  pricing: /prijs|pricing|budget|offerte|kosten|pakket|tarief|investering|€|\d+.*euro/gi,
  humor: /haha|grap|lach|grappig|leuk|funny/gi,
  theirBusiness: /jullie.*klant|jullie.*markt|jullie.*concurrent|jullie.*product|jullie.*dienst|jullie.*omzet|jullie.*groei/gi,
  checkIn: /gaat.*te snel|nog.*mee|duidelijk|alles.*helder|vragen.*tot.*nu|tot zover/gi,
  opinionAsk: /wat denk je|wat vind je|hoe klinkt|hoe.*kijk.*je|wat.*zegt.*gevoel|wat.*gaat.*door.*hoofd/gi,
  research: /ik.*zag.*op.*jullie|ik.*keek.*naar|ik.*heb.*gekeken|jullie.*website|jullie.*linkedin|jullie.*google/gi,
  directness: /wat wij doen|wat we doen|hoe het werkt|in een notendop|simpel gezegd|kort gezegd|even recht.*door|eerlijk|transparant/gi,
  priceAnchor: /bureau.*kost|normaal.*kost|gemiddeld|vergelijk|als.*je.*kijkt.*naar|wat.*je.*nu.*betaalt|bespaart/gi,
  assumptiveClose: /wanneer.*starten|welk.*pakket|als we.*beginnen|als we.*starten|ik stuur.*contract|volgende stap.*is/gi,
  challenging: /maar.*dan|waarom.*niet|wat.*houdt.*tegen|wat.*weerhoudt|als.*niet.*dan|stel.*dat/gi,
};

/** Get surrounding context for a turn */
function getContext(turns: TranscriptTurn[], turnIndex: number, triggerTurn: TranscriptTurn) {
  const before = turnIndex > 0 ? turns[turnIndex - 1] : undefined;
  const after = turnIndex < turns.length - 1 ? turns[turnIndex + 1] : undefined;
  return {
    before: before ? { speaker: before.speaker, text: before.text.slice(0, 200), timestamp: before.timestampDisplay } : undefined,
    trigger: { speaker: triggerTurn.speaker, text: triggerTurn.text.slice(0, 300), timestamp: triggerTurn.timestampDisplay },
    after: after ? { speaker: after.speaker, text: after.text.slice(0, 200), timestamp: after.timestampDisplay } : undefined,
  };
}

// Pre-compiled regex copies — avoids creating new RegExp on every call
const COMPILED_PATTERNS: Record<string, RegExp> = {};
for (const [key, regex] of Object.entries(PATTERN_DEFS)) {
  COMPILED_PATTERNS[key] = new RegExp(regex.source, regex.flags);
}

function countMatches(text: string, regex: RegExp): number {
  // Reset lastIndex for global regexes before matching
  regex.lastIndex = 0;
  const m = text.match(regex);
  return m ? m.length : 0;
}

export function analyzeCall(
  turns: TranscriptTurn[],
  recorderName: string,
  recordingUrl?: string,
): CallAnalysis {
  const firstName = recorderName.split(' ')[0];
  const aeTurns = turns.filter(t => t.speaker.includes(firstName));
  const prospectTurns = turns.filter(t => !t.speaker.includes(firstName));
  const aeText = aeTurns.map(t => t.text).join(' ').toLowerCase();
  const totalWords = turns.reduce((s, t) => s + t.wordCount, 0);
  const aeWords = aeTurns.reduce((s, t) => s + t.wordCount, 0);

  // Pattern scores + evidence tracking (using pre-compiled regexes)
  const patterns: PatternScores = {} as PatternScores;
  const patternEvidence: Record<string, PatternEvidence[]> = {};
  for (const [key, regex] of Object.entries(PATTERN_DEFS)) {
    (patterns as Record<string, number>)[key] = countMatches(aeText, regex);
    // Collect evidence: find actual turns where keywords matched (max 5 per dimension)
    const evidence: PatternEvidence[] = [];
    for (const turn of aeTurns) {
      if (evidence.length >= 5) break;
      regex.lastIndex = 0;
      const match = turn.text.toLowerCase().match(regex);
      if (match) {
        evidence.push({
          timestampSeconds: turn.timestampSeconds,
          timestampDisplay: turn.timestampDisplay,
          excerpt: turn.text.slice(0, 120),
          matchedKeyword: match[0],
        });
      }
    }
    patternEvidence[key] = evidence;
  }

  // Script adherence
  const sectionsHit: number[] = [];
  const sectionsMissed: number[] = [];
  let weightedScore = 0;
  for (const section of SCRIPT_SECTIONS) {
    const copy = new RegExp(section.keywords.source, section.keywords.flags);
    if (copy.test(aeText)) {
      sectionsHit.push(section.id);
      weightedScore += section.weight;
    } else {
      sectionsMissed.push(section.id);
    }
  }
  const scriptAdherence = Math.round(weightedScore / MAX_SCRIPT_SCORE * 100);

  // Highlights — find specific moments worth coaching on
  const highlights: HighlightMoment[] = [];

  // Good moments: what the AE did well
  // Guidance generators: receive the actual turn text + context for specific feedback
  type GuidanceFn = (excerpt: string, context?: ReturnType<typeof getContext>) => string;
  const goodPatterns: [string, RegExp, string, GuidanceFn][] = [
    ['ROI Reframe', /investering|verdien.*terug|roi|terugverdien/gi,
      'Reframes cost as investment',
      (excerpt) => `Good — you said: "${excerpt.slice(0, 80)}". Keep using "investering" instead of "kosten" and tie it to a timeline (e.g. "ROI from month 6+").`],
    ['Humor', /haha|grap|lach|grappig/gi,
      'Uses humor to build rapport',
      (excerpt, ctx) => {
        const reaction = ctx?.after?.text ? ` The prospect responded: "${ctx.after.text.slice(0, 60)}" — it landed.` : '';
        return `Humor drops the prospect's guard and builds trust.${reaction} Keep it natural — don't force it, but don't suppress it either.`;
      }],
    ['Check-in', /gaat.*te snel|nog.*mee|duidelijk|alles.*helder/gi,
      'Checks if prospect is following along',
      (excerpt, ctx) => {
        const reaction = ctx?.after?.text ? ` Prospect replied: "${ctx.after.text.slice(0, 60)}"` : '';
        return `Great pace control at "${excerpt.slice(0, 60)}".${reaction} These micro-moments prevent the prospect from zoning out during longer explanations.`;
      }],
    ['Assumptive Close', /wanneer.*starten|welk.*pakket|als we.*beginnen|volgende stap.*is/gi,
      'Uses assumptive close language',
      (excerpt) => `Strong close: "${excerpt.slice(0, 80)}". "Wanneer starten we" is much more effective than "wat vind je ervan?" Keep doing this at the end of every call.`],
    ['Opinion Ask', /wat denk je|wat vind je|hoe klinkt|hoe.*kijk.*je/gi,
      'Asks the prospect for their opinion',
      (excerpt, ctx) => {
        const reaction = ctx?.after?.text ? ` Prospect opened up: "${ctx.after.text.slice(0, 80)}"` : '';
        return `Good — "${excerpt.slice(0, 60)}" gives the prospect ownership and surfaces objections early.${reaction} Do this after every key section.`;
      }],
    ['Social Proof', /\d+.*klanten|\d+.*bedrijven|2000|tweeduizend/gi,
      'Uses concrete social proof numbers',
      (excerpt) => `You anchored with data: "${excerpt.slice(0, 80)}". Specific numbers are more convincing than vague claims. Keep doing this.`],
    ['Price Anchor', /bureau.*kost|normaal.*kost|vergelijk|wat.*je.*nu.*betaalt/gi,
      'Anchors price against a more expensive alternative',
      (excerpt) => `Good anchor: "${excerpt.slice(0, 80)}". Comparing to bureau costs before revealing your price makes it feel like a bargain. Use this every time before pricing.`],
    ['Their Business', /jullie.*klant|jullie.*markt|jullie.*concurrent/gi,
      'Focuses on the prospect\'s business context',
      (excerpt) => `You referenced their world: "${excerpt.slice(0, 80)}". Talking about their market, clients, and competitors shows you did your homework and builds trust.`],
  ];

  // Confidence mapping for strength categories
  const strengthConfidence: Record<string, 'high' | 'medium' | 'low'> = {
    'ROI Reframe': 'high', 'Humor': 'medium', 'Check-in': 'medium',
    'Assumptive Close': 'high', 'Opinion Ask': 'medium', 'Social Proof': 'high',
    'Price Anchor': 'high', 'Their Business': 'medium',
  };

  for (let ti = 0; ti < aeTurns.length; ti++) {
    const turn = aeTurns[ti];
    const tLow = turn.text.toLowerCase();
    for (const [category, regex, desc, guidanceFn] of goodPatterns) {
      // Single match call instead of test() + match()
      regex.lastIndex = 0;
      const allMatches = tLow.match(regex);
      if (allMatches) {
        let conf = strengthConfidence[category] || 'medium';
        if (allMatches.length >= 2 && conf === 'medium') conf = 'high';
        const turnIdx = turns.indexOf(turn);
        const ctx = getContext(turns, turnIdx, turn);
        highlights.push({
          timestampSeconds: turn.timestampSeconds,
          timestampDisplay: turn.timestampDisplay,
          type: 'strength',
          category, description: desc,
          guidance: guidanceFn(turn.text, ctx),
          excerpt: turn.text.slice(0, 200),
          confidence: conf,
          context: ctx,
        });
        break;
      }
    }
  }

  // ── Coachable moments with specific, contextual guidance ──

  // 1. Long monologues — but limit to worst 3 per call and vary guidance by WHAT they're talking about
  const monologues: { start: TranscriptTurn; words: number; topic: string; excerpt: string }[] = [];
  let consecutiveWords = 0;
  let monoStart: TranscriptTurn | null = null;
  let monoText = '';
  // Topic detection: scored approach — most keyword matches wins (no overlap issues)
  const TOPIC_PATTERNS: [string, RegExp][] = [
    ['product', /content|blog|artik|publicer|sitemap|pling|cluster|deurtje|pagina|publicatie/gi],
    ['market', /zoekgedrag|chatgpt|google|ai overviews|perplexity|zoekmarkt|seo.*verandert|markt.*shift/gi],
    ['pricing', /prijs|kosten|pakket|investering|€|euro|tarief|budget|offerte|bespaart/gi],
    ['company', /wij zijn|opgericht|finland|medewerkers|ons team|kantoor|amsterdam|klanten.*wereld/gi],
    ['competitors', /concurrent|bureau|agency|freelanc|extern.*inhuur|traditioneel|vergelijk.*met/gi],
  ];
  function detectMonologueTopic(text: string): string {
    const t = text.toLowerCase();
    let bestTopic = 'general';
    let bestScore = 0;
    for (const [topic, regex] of TOPIC_PATTERNS) {
      regex.lastIndex = 0;
      const matches = t.match(regex);
      const score = matches ? matches.length : 0;
      if (score > bestScore) { bestScore = score; bestTopic = topic; }
    }
    return bestScore >= 2 ? bestTopic : 'general'; // Require at least 2 matches to assign a topic
  }
  for (const turn of aeTurns) {
    consecutiveWords += turn.wordCount;
    monoText += ' ' + turn.text;
    if (!monoStart) monoStart = turn;
    if (turn.isQuestion || consecutiveWords > 100) {
      if (consecutiveWords > 100 && !turn.isQuestion && monoStart) {
        const topic = detectMonologueTopic(monoText);
        monologues.push({ start: monoStart, words: consecutiveWords, topic, excerpt: monoText.trim().slice(0, 120) });
      }
      consecutiveWords = 0;
      monoStart = null;
      monoText = '';
    }
  }
  // Only flag the worst 3 monologues, with topic-specific guidance
  const topicGuidance: Record<string, string> = {
    product: `You explained the product for ${'{W}'} words straight. The prospect can't absorb this much. Instead: explain ONE feature, then ask "Zou dit voor jullie relevant zijn?" before moving to the next.`,
    market: `${'{W}'} words about the market shift without checking in. The prospect already booked this call — they know the market matters. Shorten this to 30 seconds and ask: "Herken je dit in jullie markt?"`,
    pricing: `${'{W}'} words on pricing without pausing. When discussing price, LESS is more. State the number confidently, pause, and ask: "Hoe klinkt dat in verhouding tot wat jullie nu uitgeven?"`,
    company: `${'{W}'} words about WP SEO AI the company. Founders don't care about your org chart. Cut this to one sentence ("1700 klanten, gestart in Finland, nu 160 man") and move to THEIR situation.`,
    competitors: `${'{W}'} words comparing to alternatives. Don't sell against competitors — sell your unique value. Say it once and move on: "Een bureau kost €3-5K en jij doet het werk. Bij ons is het €625 en wij doen alles."`,
    general: `${'{W}'} words without a question. After 30 seconds of talking, pause and check: "Gaat dit te snel?" or "Is dit relevant voor jullie situatie?" The prospect needs space to process.`,
  };
  for (const m of monologues.sort((a, b) => b.words - a.words).slice(0, 3)) {
    const baseGuidance = (topicGuidance[m.topic] || topicGuidance.general).replace('{W}', String(m.words));
    highlights.push({
      timestampSeconds: m.start.timestampSeconds,
      timestampDisplay: m.start.timestampDisplay,
      type: 'coachable',
      category: 'Long Monologue',
      description: `${m.words} words on ${m.topic} without a question`,
      guidance: `Starting with: "${m.excerpt}..." — ${baseGuidance}`,
      excerpt: m.start.text.slice(0, 150) + '...',
      confidence: 'high',
    });
  }

  // 2. Missed opportunity: talking about "vindbaarheid" without making it concrete
  for (const turn of aeTurns) {
    const tLow = turn.text.toLowerCase();
    if (/vindbaar|zichtbaar/.test(tLow) && !/content|artik|blog|sitemap|deurtje|cluster/i.test(tLow)) {
      const vaguePart = turn.text.slice(0, 120);
      const turnIdx = turns.indexOf(turn);
      const ctx = getContext(turns, turnIdx, turn);
      const prospectContext = ctx.before?.text ? ` The prospect just said: "${ctx.before.text.slice(0, 80)}"` : '';
      highlights.push({
        timestampSeconds: turn.timestampSeconds,
        timestampDisplay: turn.timestampDisplay,
        type: 'coachable',
        category: 'Too Abstract',
        description: 'Uses vague "vindbaarheid" without making it concrete',
        guidance: `You said: "${vaguePart}".${prospectContext} Replace this with something specific they can picture: "we publiceren 20 artikelen per maand die elk een deurtje zijn naar je website." Abstract benefits don't stick — concrete mechanisms do.`,
        excerpt: turn.text.slice(0, 200),
        confidence: 'medium',
        context: ctx,
      });
    }
  }

  // 3. Missed opportunity: talking about AI without context
  let aiMentionsWithoutContext = 0;
  let aiExamples: string[] = [];
  for (const turn of aeTurns) {
    const tLow = turn.text.toLowerCase();
    if (/\bai\b|ai.gedreven/i.test(tLow) && !/zoekgedrag|chatgpt|google|perplexity|overviews|zoekmarkt/i.test(tLow)) {
      aiMentionsWithoutContext++;
      if (aiExamples.length < 2) aiExamples.push(turn.text.slice(0, 80));
      if (aiMentionsWithoutContext === 3) {
        highlights.push({
          timestampSeconds: turn.timestampSeconds,
          timestampDisplay: turn.timestampDisplay,
          type: 'coachable',
          category: 'AI Without Context',
          description: `Mentions AI ${aiMentionsWithoutContext}x without connecting it to market shift`,
          guidance: `You said things like: "${aiExamples[0]}"${aiExamples[1] ? ` and "${aiExamples[1]}"` : ''}. "AI" alone is a buzzword — connect it to why it matters for THEM: "17% van alle zoekopdrachten gaat nu via ChatGPT. Als jouw bedrijf daar niet in verschijnt, mis je die klanten." AI is the mechanism, market shift is the reason.`,
          excerpt: turn.text.slice(0, 200),
          confidence: 'medium',
        });
      }
    }
  }

  // 4. Pricing without anchoring first
  let mentionedPrice = false;
  let anchoredFirst = false;
  for (const turn of aeTurns) {
    const tLow = turn.text.toLowerCase();
    if (/bureau.*kost|normaal.*kost|vergelijk|wat.*betaal/i.test(tLow)) anchoredFirst = true;
    if (/€|euro.*per.*maand|pakket.*starter|pakket.*basic|pakket.*pro|vanaf.*625/i.test(tLow) && !mentionedPrice) {
      mentionedPrice = true;
      if (!anchoredFirst) {
        const turnIdx = turns.indexOf(turn);
        const ctx = getContext(turns, turnIdx, turn);
        const prospectAsked = ctx.before && !ctx.before.speaker.includes(firstName) ? ` after the prospect asked: "${ctx.before.text.slice(0, 80)}"` : '';
        highlights.push({
          timestampSeconds: turn.timestampSeconds,
          timestampDisplay: turn.timestampDisplay,
          type: 'coachable',
          category: 'Price Without Anchor',
          description: 'Mentions pricing before anchoring against alternatives',
          guidance: `You jumped to pricing ("${turn.text.slice(0, 80)}")${prospectAsked} without anchoring first. Before revealing your price, always compare: "Een bureau kost €3-5K per maand, en dan moet je zelf nog de tools kopen voor €400-500. Bij ons is het vanaf €625, en wij doen alles." The contrast makes your price feel like a deal.`,
          excerpt: turn.text.slice(0, 200),
          confidence: 'medium',
          context: ctx,
        });
      }
    }
  }

  // 5. Ending without a close
  const lastFiveAETurns = aeTurns.slice(-5);
  const closingText = lastFiveAETurns.map(t => t.text).join(' ').toLowerCase();
  if (!/contract|onderteken|starten|beginnen|wanneer|welk.*pakket|volgende stap|ik stuur/i.test(closingText) && aeTurns.length > 10) {
    const lastTurn = aeTurns[aeTurns.length - 1];
    if (lastTurn) {
      const lastProspect = prospectTurns[prospectTurns.length - 1];
      const secondLastAE = aeTurns.length > 1 ? aeTurns[aeTurns.length - 2] : undefined;
      highlights.push({
        timestampSeconds: lastTurn.timestampSeconds,
        timestampDisplay: lastTurn.timestampDisplay,
        type: 'coachable',
        category: 'No Close',
        description: 'Call ends without close language or next step',
        guidance: `The call ended without proposing a next step or asking for the business.`,
        excerpt: lastTurn.text.slice(0, 200),
        confidence: 'high',
        context: {
          before: secondLastAE ? { speaker: secondLastAE.speaker, text: secondLastAE.text.slice(0, 200), timestamp: secondLastAE.timestampDisplay } : undefined,
          trigger: { speaker: lastTurn.speaker, text: lastTurn.text.slice(0, 300), timestamp: lastTurn.timestampDisplay },
          after: lastProspect ? { speaker: lastProspect.speaker, text: lastProspect.text.slice(0, 200), timestamp: lastProspect.timestampDisplay } : undefined,
          shouldHaveDone: `Your last words were: "${lastTurn.text.slice(0, 100)}". Instead, end with one of: (1) "Ik stuur je vandaag een samenvatting en het contract — kun je het rustig bekijken." (2) "Zullen we donderdag 15 minuten inplannen om te beslissen of we links of rechts gaan?" (3) "Wat is er nodig om volgende week te starten?" Never end with "laat maar weten" or "denk er maar over na."`,
        },
      });
    }
  }

  // ── Koen's coaching rules (from Koen OS + AE Feedback docs) ──

  // 6. Softening words — erode authority (Koen: "eliminate doubt words")
  let softeningCount = 0;
  for (const turn of aeTurns) {
    const t = turn.text.toLowerCase();
    const softs = (t.match(/\bmisschien\b|\beigenlijk\b|\been beetje\b|\bzeg maar\b|\bvolgens mij\b|\been soort van\b|\bik geloof\b|\bik denk\b|\bgewoon\b|\beven\b/g) || []);
    softeningCount += softs.length;
    if (softs.length >= 3) {
      // Build a concrete rewrite suggestion from what they actually said
      const original = turn.text.slice(0, 120);
      const rewrite = original
        .replace(/\bmisschien\b/gi, '').replace(/\beigenlijk\b/gi, '').replace(/\been beetje\b/gi, '')
        .replace(/\bzeg maar\b/gi, '').replace(/\bvolgens mij\b/gi, '').replace(/\been soort van\b/gi, '')
        .replace(/\bik geloof\b/gi, '').replace(/\bik denk\b/gi, '').replace(/\bgewoon\b/gi, '')
        .replace(/\s{2,}/g, ' ').trim();
      highlights.push({
        timestampSeconds: turn.timestampSeconds, timestampDisplay: turn.timestampDisplay,
        type: 'coachable', category: 'Softening Words',
        description: `${softs.length} softening words in one turn (${softs.join(', ')})`,
        guidance: `You said: "${original}". That's ${softs.length} authority-eroding words (${softs.join(', ')}). Try instead: "${rewrite}". Koen's rule: eliminate "misschien", "eigenlijk", "een beetje", "zeg maar" — they make you sound unsure of your own product.`,
        excerpt: turn.text.slice(0, 200),
        confidence: 'high',
      });
    }
  }

  // 7. Accepting "ik moet erover nadenken" without converting to conditions
  for (const turn of prospectTurns) {
    const t = turn.text.toLowerCase();
    if (/nadenken|intern.*overleg|intern.*bespreken|even.*bespreken|met.*collega|met.*directie|erover.*nadenken/i.test(t)) {
      // Check if AE's next turn probes further
      const turnIdx = turns.indexOf(turn);
      const nextAETurn = turns.slice(turnIdx + 1).find(tt => tt.speaker.includes(firstName));
      if (nextAETurn) {
        const next = nextAETurn.text.toLowerCase();
        if (/geen probleem|begrijpelijk|neem de tijd|laat.*weten|meld.*je|snap ik|logisch/i.test(next) &&
            !/wat.*moet|wat.*nodig|welke.*vragen|wie.*beslist|wat.*houdt|wat.*weerhoudt/i.test(next)) {
          highlights.push({
            timestampSeconds: nextAETurn.timestampSeconds, timestampDisplay: nextAETurn.timestampDisplay,
            type: 'coachable', category: 'Accepted Think-It-Over',
            description: 'Accepted "ik moet erover nadenken" without probing',
            guidance: `Koen's rule: Never accept this. Convert doubt into conditions with a defined next step.`,
            excerpt: `Prospect: "${turn.text.slice(0,100)}" → AE: "${nextAETurn.text.slice(0,100)}"`,
            confidence: 'high',
            context: {
              before: { speaker: turn.speaker, text: turn.text.slice(0, 250), timestamp: turn.timestampDisplay },
              trigger: { speaker: nextAETurn.speaker, text: nextAETurn.text.slice(0, 300), timestamp: nextAETurn.timestampDisplay },
              shouldHaveDone: `The prospect said: "${turn.text.slice(0, 120)}". You responded: "${nextAETurn.text.slice(0, 120)}". This lets the deal go cold. Instead say: "Snap ik. Welke 2-3 vragen moeten jullie intern beantwoorden om Go of No-Go te zeggen? Laten we het volgende gesprek precies daarover hebben — dan weten we allebei waar we staan."`,
            },
          });
        }
      }
    }
  }

  // 8. Minimizing concerns — "dat is maar..." / "dat kost maar..."
  for (const turn of aeTurns) {
    const t = turn.text.toLowerCase();
    if (/dat is maar|kost maar|duurt maar|is maar|maar.*uur|maar.*minuut|heel eenvoudig|heel simpel|geen moeite/i.test(t)) {
      const turnIdx = turns.indexOf(turn);
      const ctx = getContext(turns, turnIdx, turn);
      const prospectConcern = ctx.before && !ctx.before.speaker.includes(firstName) ? `The prospect raised: "${ctx.before.text.slice(0, 100)}". ` : '';
      highlights.push({
        timestampSeconds: turn.timestampSeconds, timestampDisplay: turn.timestampDisplay,
        type: 'coachable', category: 'Minimizing Concern',
        description: 'Minimizes prospect concern instead of exploring it',
        guidance: `${prospectConcern}You responded: "${turn.text.slice(0, 100)}". This dismisses their concern. Instead explore it: "Welke projecten hebben nu prioriteit?" / "Wie zou dit intern oppakken?" Acknowledge first, then solve.`,
        excerpt: turn.text.slice(0, 200),
        confidence: 'medium',
        context: ctx,
      });
    }
  }

  // 9. No summary before pitch — jumping straight into explanation
  const firstAEBlock = aeTurns.slice(0, Math.min(15, Math.floor(aeTurns.length / 4)));
  const firstAEText = firstAEBlock.map(t => t.text).join(' ').toLowerCase();
  const hasSummary = /als ik.*het goed begrijp|samengevat|dus jullie|samen.*vat|klopt dat|begrijp ik goed/i.test(firstAEText);
  const hasPitchStart = /wat wij doen|ons platform|onze tool|wij zijn|laat me.*uitleggen|ik ga.*laten zien/i.test(firstAEText);
  if (hasPitchStart && !hasSummary && aeTurns.length > 15) {
    const pitchTurn = firstAEBlock.find(t => /wat wij doen|ons platform|onze tool|laat me.*uitleggen/i.test(t.text.toLowerCase()));
    if (pitchTurn) {
      highlights.push({
        timestampSeconds: pitchTurn.timestampSeconds, timestampDisplay: pitchTurn.timestampDisplay,
        type: 'coachable', category: 'No Summary Before Pitch',
        description: 'Jumps into pitch without first summarizing the prospect\'s situation',
        guidance: `Koen's rule: Always summarize before pitching. Say: "Dus als ik het goed begrijp: jullie willen groeien voorbij paid, maar worden nu niet organisch gevonden. Klopt dat?" Get agreement, THEN pitch. This creates tension and shows you listened.`,
        excerpt: pitchTurn.text.slice(0, 200),
        confidence: 'low',
      });
    }
  }

  // 10. Good: AE challenges the prospect's beliefs (strength)
  for (const turn of aeTurns) {
    const t = turn.text.toLowerCase();
    if (/mag ik.*challengen|mag ik.*even.*inhaken|darf ik|klopt dat.*echt|wat als.*niet|stel.*dat.*niet|ben je.*zeker/i.test(t)) {
      highlights.push({
        timestampSeconds: turn.timestampSeconds, timestampDisplay: turn.timestampDisplay,
        type: 'strength', category: 'Challenging Belief',
        description: 'Challenges the prospect\'s assumption instead of validating it',
        guidance: `Koen's rule: This is excellent. Challenging beliefs ("Klopt dat echt?" / "Wat als dat niet zo is?") is how you create the gap between their current state and where they could be. Keep doing this.`,
        excerpt: turn.text.slice(0, 200),
        confidence: 'high',
      });
    }
  }

  // 11. Good: Backs up claim with live search/proof
  for (const turn of aeTurns) {
    const t = turn.text.toLowerCase();
    if (/laten we.*even.*kijken|ik google.*even|zoeken we.*even|kijk.*hier|even.*live|even.*checken|search.*console/i.test(t)) {
      highlights.push({
        timestampSeconds: turn.timestampSeconds, timestampDisplay: turn.timestampDisplay,
        type: 'strength', category: 'Live Proof',
        description: 'Validates claims with live search instead of just stating them',
        guidance: `Koen's rule: Always verify live. Showing in Google/ChatGPT that the prospect is NOT being found creates much more urgency than saying "je wordt niet gevonden." Keep doing this.`,
        excerpt: turn.text.slice(0, 200),
        confidence: 'high',
      });
    }
  }

  // ── VP GTM-level detections ──

  // 12. Pricing discussed without ANY ROI reframe
  if (patterns.pricing > 0 && patterns.roiReframe === 0) {
    const priceTurn = aeTurns.find(t => /prijs|kosten|pakket|€|\d+.*euro|tarief/i.test(t.text.toLowerCase()));
    if (priceTurn) {
      highlights.push({
        timestampSeconds: priceTurn.timestampSeconds, timestampDisplay: priceTurn.timestampDisplay,
        type: 'coachable', category: 'Pricing Without ROI',
        description: 'Discussed pricing without framing it as an investment',
        guidance: `You talked about pricing ${patterns.pricing}x but never reframed it as an investment. Before ANY pricing: "Een bureau kost €3-5K. Dan heb je nog tools nodig voor €500. Bij ons is het vanaf €625, en wij doen alles. Dat is een investering die zich na 6 maanden terugverdient." Price without context is just a number — price with context is a bargain.`,
        excerpt: priceTurn.text.slice(0, 200),
        confidence: 'high',
      });
    }
  }

  // 13. Feature-speak instead of outcome-speak
  let featureCount = 0, outcomeCount = 0;
  for (const turn of aeTurns) {
    const t = turn.text.toLowerCase();
    if (/plugin|tool|platform|dashboard|functionalit|integratie|koppeling|wordpress|cms|feature|technologie/i.test(t)) featureCount++;
    if (/meer klanten|meer omzet|meer leads|meer bezoekers|groei|bespaar|tijd.*bespaar|geen.*zelf|wij doen.*alles|ontzorg/i.test(t)) outcomeCount++;
  }
  if (featureCount > 5 && outcomeCount < 2) {
    // Collect actual feature-speak examples
    const featureExamples: string[] = [];
    for (const t of aeTurns) {
      if (featureExamples.length >= 2) break;
      if (/plugin|tool|platform|dashboard|functionalit|integratie|koppeling/i.test(t.text.toLowerCase())) {
        featureExamples.push(t.text.slice(0, 80));
      }
    }
    const featureTurn = aeTurns.find(t => /plugin|tool|platform|dashboard|functionalit/i.test(t.text.toLowerCase()));
    if (featureTurn) {
      highlights.push({
        timestampSeconds: featureTurn.timestampSeconds, timestampDisplay: featureTurn.timestampDisplay,
        type: 'coachable', category: 'Feature-Speak',
        description: `${featureCount} feature mentions vs only ${outcomeCount} outcome mentions`,
        guidance: `You said things like: "${featureExamples[0] || ''}"${featureExamples[1] ? ` and "${featureExamples[1]}"` : ''}. That's ${featureCount} feature mentions vs only ${outcomeCount} outcomes. Founders don't buy a "WordPress plugin met AI" — they buy "meer klanten zonder er zelf tijd aan te besteden." Translate every feature: "Dat betekent voor jullie: [meer klanten / minder kosten / geen gedoe]."`,
        excerpt: featureTurn.text.slice(0, 200),
        confidence: 'medium',
      });
    }
  }

  // 14. Never talked about the prospect's business
  if (patterns.theirBusiness === 0 && aeTurns.length > 15) {
    const midTurn = aeTurns[Math.floor(aeTurns.length / 2)];
    if (midTurn) {
      highlights.push({
        timestampSeconds: midTurn.timestampSeconds, timestampDisplay: midTurn.timestampDisplay,
        type: 'coachable', category: 'No Prospect Focus',
        description: 'Never referenced the prospect\'s business, market, or customers',
        guidance: `The entire call was about YOU, not THEM. Use their name, their industry, their customers: "Jullie klanten zoeken op X, maar vinden jullie niet." Show you did your homework. If you can't name their top 3 customer types, you haven't done enough discovery.`,
        excerpt: midTurn.text.slice(0, 200),
        confidence: 'medium',
      });
    }
  }

  // 15. Product barely explained (<3 content mentions in 20+ min call)
  if (patterns.contentEngine < 3 && aeTurns.length > 20) {
    highlights.push({
      timestampSeconds: aeTurns[Math.floor(aeTurns.length * 0.6)]?.timestampSeconds || 0,
      timestampDisplay: aeTurns[Math.floor(aeTurns.length * 0.6)]?.timestampDisplay || '',
      type: 'coachable', category: 'Product Not Explained',
      description: `Only ${patterns.contentEngine} product mentions in the entire call`,
      guidance: `The prospect left this call without understanding what WP SEO AI actually does. They need to hear: "Wij publiceren 20-40 artikelen per maand op jullie website. Onzichtbaar testen we wat werkt. Wat scoort, krijg je te zien. Wat niet scoort, ruimen we op." If they can't explain it back to someone else, you haven't done your job.`,
      excerpt: '',
      confidence: 'medium',
    });
  }

  // 16. Dry monologue — high talk ratio + no humor
  if (patterns.humor === 0 && aeWords > 3000) {
    // Find the longest dry stretch to point to
    let longestDryStart = aeTurns[Math.floor(aeTurns.length / 3)];
    highlights.push({
      timestampSeconds: longestDryStart?.timestampSeconds || 0,
      timestampDisplay: longestDryStart?.timestampDisplay || '',
      type: 'coachable', category: 'Dry Delivery',
      description: `${Math.round(aeWords / 150)} minutes of talking with zero humor or lightness`,
      guidance: `You spoke ${aeWords} words across this call without a single light moment. Around ${longestDryStart?.timestampDisplay || 'mid-call'} would have been a natural place to break the tension. You don't need to be a comedian — just be human. Try: "Ik zeg altijd tegen klanten: als je na drie maanden niet blij bent, mag je me bellen om te klagen. Maar eerlijk, dat telefoontje heb ik nog nooit gehad."`,
      excerpt: longestDryStart?.text.slice(0, 200) || '',
      confidence: 'low',
    });
  }

  // 17. Prospect showing buying signals that AE missed
  const buySignals = prospectTurns.filter(t => /wanneer.*start|hoe lang.*duurt.*implementat|contract|onboarding|welk.*pakket|hoe snel|hoeveel.*kost/i.test(t.text.toLowerCase()));
  if (buySignals.length >= 1) {
    let missedCount = 0;
    for (const bs of buySignals) {
      const idx = turns.indexOf(bs);
      const nextAE = turns.slice(idx + 1, idx + 3).find(t => t.speaker.includes(firstName));
      const wasAdvanced = nextAE && /contract|starten|pakket|volgende stap|inplannen|afspreken|wanneer|welk/i.test(nextAE.text.toLowerCase());

      if (!wasAdvanced && nextAE && missedCount < 2) {
        // Detect what type of buying signal to give specific advance language
        const bsText = bs.text.toLowerCase();
        let advanceScript = '"Zullen we even kijken welk pakket past?"';
        if (/hoeveel.*kost|wat.*kost|prijs|tarief/i.test(bsText)) advanceScript = '"Goed dat je dat vraagt. [brief answer]. Zullen we even kijken welk pakket het beste past?"';
        else if (/wanneer|hoe snel|planning/i.test(bsText)) advanceScript = '"We kunnen volgende week starten. Zal ik het contract klaarzetten?"';
        else if (/hoe werkt|implementat|onboarding/i.test(bsText)) advanceScript = '"Ik leg het kort uit, en dan kijken we of het past. Welk pakket spreekt je het meest aan?"';
        highlights.push({
          timestampSeconds: bs.timestampSeconds, timestampDisplay: bs.timestampDisplay,
          type: 'coachable', category: 'Missed Buy Signal',
          description: 'Prospect showed buying interest but AE didn\'t advance',
          guidance: `The prospect asked: "${bs.text.slice(0, 100)}". You answered with "${nextAE.text.slice(0, 80)}" and kept pitching. When a prospect asks about pricing/timing/implementation, they're mentally buying. Answer briefly, then advance: ${advanceScript}`,
          excerpt: `Prospect: "${bs.text.slice(0, 150)}"`,
          confidence: 'high',
          context: {
            ...getContext(turns, idx, bs),
            after: nextAE ? { speaker: nextAE.speaker, text: nextAE.text.slice(0, 250), timestamp: nextAE.timestampDisplay } : undefined,
            shouldHaveDone: `The prospect said: "${bs.text.slice(0, 100)}". You responded with: "${nextAE?.text.slice(0, 100) || ''}". Instead, after answering their question, you should have immediately moved to: "Goed dat je dat vraagt. Laten we even kijken welk pakket het beste past en wanneer we kunnen starten."`,
          },
        });
        missedCount++;
      } else if (wasAdvanced && nextAE) {
        highlights.push({
          timestampSeconds: bs.timestampSeconds, timestampDisplay: bs.timestampDisplay,
          type: 'strength', category: 'Captured Buy Signal',
          description: 'Prospect showed interest and AE advanced the conversation',
          guidance: 'You recognized the buying signal and moved forward. This is exactly right.',
          excerpt: `Prospect: "${bs.text.slice(0, 100)}" → AE: "${nextAE.text.slice(0, 100)}"`,
          confidence: 'high',
          context: {
            ...getContext(turns, idx, bs),
            after: { speaker: nextAE.speaker, text: nextAE.text.slice(0, 250), timestamp: nextAE.timestampDisplay },
          },
        });
      }
    }
  }

  // Calculate longest monologue
  let longestMono = 0;
  let currentMono = 0;
  for (const turn of turns) {
    if (turn.speaker.includes(firstName)) {
      currentMono += turn.wordCount;
      longestMono = Math.max(longestMono, currentMono);
    } else {
      currentMono = 0;
    }
  }

  // ── Call-level verdict (summary of what went right/wrong) ──
  const callVerdict: string[] = [];
  if (patterns.contract === 0 && aeTurns.length > 10) callVerdict.push('Never attempted to close');
  if (patterns.roiReframe === 0 && patterns.pricing > 0) callVerdict.push('Pricing without ROI framing');
  if (patterns.theirBusiness === 0 && aeTurns.length > 15) callVerdict.push('Never referenced prospect business');
  if (patterns.contentEngine < 3 && aeTurns.length > 20) callVerdict.push('Product barely explained');
  if (featureCount > 5 && outcomeCount < 2) callVerdict.push('Feature-speak over outcomes');
  const talkRatioPct = totalWords > 0 ? Math.round(aeWords / totalWords * 100) : 0;
  if (talkRatioPct > 70) callVerdict.push('Dominated conversation (' + talkRatioPct + '% talk)');
  if (aeTurns.filter(t => t.isQuestion).length < 8 && aeTurns.length > 15) callVerdict.push('Insufficient discovery');

  // ── Prospect Engagement Scoring ──
  const prospectEngagement = detectProspectEngagement(turns, firstName);

  return {
    patterns,
    patternEvidence,
    scriptAdherence,
    sectionsHit,
    sectionsMissed,
    highlights: highlights.slice(0, 20), // cap at 20, focused
    talkRatio: totalWords > 0 ? Math.round(aeWords / totalWords * 100) : 0,
    questionCount: aeTurns.filter(t => t.isQuestion).length,
    longestMonologue: longestMono,
    aeWordCount: aeWords,
    prospectQuestionCount: prospectTurns.filter(t => t.isQuestion).length,
    callVerdict,
    prospectEngagement,
  };
}

/**
 * Detect prospect engagement level from transcript turns.
 * Counts buying signals, red flags, and engagement indicators.
 */
function detectProspectEngagement(
  turns: TranscriptTurn[],
  aeFirstName: string,
): ProspectEngagement {
  const prospectTurns = turns.filter(t => !t.speaker.includes(aeFirstName));
  const aeTurns = turns.filter(t => t.speaker.includes(aeFirstName));

  // ── Buying signals: prospect asks about pricing, timing, implementation, contract, onboarding ──
  const BUYING_SIGNAL_PATTERNS: [string, RegExp][] = [
    ['pricing question', /hoeveel.*kost|wat.*kost|prijs|tarief|budget|investering|€|euro/i],
    ['timing question', /wanneer.*start|hoe snel|hoe lang.*duurt|doorlooptijd|implementatie.*tijd|planning/i],
    ['implementation question', /hoe werkt.*implementat|onboarding|integratie|koppeling|technisch|installat/i],
    ['contract question', /contract|looptijd|opzegtermijn|overeenkomst|voorwaarden|commitment/i],
    ['onboarding question', /onboarding|opstarten|aan de slag|eerste stappen|hoe begin/i],
    ['next steps question', /volgende stap|hoe gaan we|wat.*is.*het.*proces|hoe.*verder/i],
  ];

  // Evidence: store actual prospect quotes for each signal type
  interface SignalEvidence { timestamp: string; speaker: string; quote: string; type: string; }

  let buyingSignals = 0;
  const buyingEvidence: SignalEvidence[] = [];
  for (const turn of prospectTurns) {
    const tLow = turn.text.toLowerCase();
    for (const [label, regex] of BUYING_SIGNAL_PATTERNS) {
      if (regex.test(tLow)) {
        buyingSignals++;
        if (buyingEvidence.length < 5) {
          buyingEvidence.push({ timestamp: turn.timestampDisplay, speaker: turn.speaker, quote: turn.text.slice(0, 150), type: label });
        }
        break;
      }
    }
  }

  // ── Red flags with evidence ──
  let redFlags = 0;
  const redFlagEvidence: SignalEvidence[] = [];

  // Short responses (<5 words)
  const shortResponses = prospectTurns.filter(t => t.wordCount < 5 && t.wordCount > 0);
  if (shortResponses.length > prospectTurns.length * 0.4 && prospectTurns.length > 3) {
    redFlags += Math.floor(shortResponses.length / 3);
    for (const t of shortResponses.slice(0, 3)) {
      if (redFlagEvidence.length < 5) redFlagEvidence.push({ timestamp: t.timestampDisplay, speaker: t.speaker, quote: t.text, type: 'short response' });
    }
  }

  // Doubt / delay language
  for (const turn of prospectTurns) {
    const tLow = turn.text.toLowerCase();
    if (/ik weet niet|weet ik niet|geen idee|misschien later|niet nu|later.*terugkomen|moet.*nadenken|lastig.*te zeggen/i.test(tLow)) {
      redFlags++;
      if (redFlagEvidence.length < 5) redFlagEvidence.push({ timestamp: turn.timestampDisplay, speaker: turn.speaker, quote: turn.text.slice(0, 150), type: 'doubt/delay' });
    }
  }

  // Silence detection
  let consecutiveAEWords = 0;
  let monoStartTurn: TranscriptTurn | null = null;
  for (const turn of turns) {
    if (turn.speaker.includes(aeFirstName)) {
      consecutiveAEWords += turn.wordCount;
      if (!monoStartTurn) monoStartTurn = turn;
    } else {
      if (consecutiveAEWords > 150 && monoStartTurn) {
        redFlags++;
        if (redFlagEvidence.length < 5) redFlagEvidence.push({ timestamp: monoStartTurn.timestampDisplay, speaker: 'AE', quote: `${consecutiveAEWords} words without prospect response`, type: 'AE monologue' });
      }
      consecutiveAEWords = 0;
      monoStartTurn = null;
    }
  }
  if (consecutiveAEWords > 150 && monoStartTurn) {
    redFlags++;
    if (redFlagEvidence.length < 5) redFlagEvidence.push({ timestamp: monoStartTurn.timestampDisplay, speaker: 'AE', quote: `${consecutiveAEWords} words without prospect response`, type: 'AE monologue' });
  }

  // ── Engagement indicators with evidence ──
  let engagementIndicators = 0;
  const engagementEvidence: SignalEvidence[] = [];

  // Long prospect responses (>30 words)
  const longResponses = prospectTurns.filter(t => t.wordCount > 30);
  engagementIndicators += longResponses.length;
  for (const t of longResponses.slice(0, 3)) {
    if (engagementEvidence.length < 5) engagementEvidence.push({ timestamp: t.timestampDisplay, speaker: t.speaker, quote: t.text.slice(0, 150), type: 'detailed answer' });
  }

  // Prospect questions
  const prospectQuestions = prospectTurns.filter(t => t.isQuestion);
  engagementIndicators += prospectQuestions.length;
  for (const t of prospectQuestions.slice(0, 3)) {
    if (engagementEvidence.length < 5) engagementEvidence.push({ timestamp: t.timestampDisplay, speaker: t.speaker, quote: t.text.slice(0, 150), type: 'prospect question' });
  }

  // Enthusiasm words
  for (const turn of prospectTurns) {
    const tLow = turn.text.toLowerCase();
    if (/interessant|goed|mooi|leuk|gaaf|top|super|geweldig|klinkt goed|klinkt interessant|dat wil ik|dat zoek ik|precies|helemaal|absoluut|zeker/i.test(tLow)) {
      engagementIndicators++;
      if (engagementEvidence.length < 5) engagementEvidence.push({ timestamp: turn.timestampDisplay, speaker: turn.speaker, quote: turn.text.slice(0, 120), type: 'enthusiasm' });
    }
  }

  // ── Score ──
  const positiveScore = buyingSignals * 2 + engagementIndicators;
  const negativeScore = redFlags * 2;
  const netScore = positiveScore - negativeScore;

  let score: 'engaged' | 'neutral' | 'disengaged';
  if (netScore >= 5) score = 'engaged';
  else if (netScore <= -3) score = 'disengaged';
  else score = 'neutral';

  return {
    buyingSignals,
    redFlags,
    engagementIndicators,
    score,
    details: {
      buyingSignalTypes: buyingEvidence.map(e => e.type).filter((v,i,a) => a.indexOf(v) === i),
      redFlagTypes: redFlagEvidence.map(e => e.type).filter((v,i,a) => a.indexOf(v) === i),
      engagementTypes: engagementEvidence.map(e => e.type).filter((v,i,a) => a.indexOf(v) === i),
    },
    evidence: {
      buying: buyingEvidence,
      redFlags: redFlagEvidence,
      engagement: engagementEvidence,
    },
  };
}
