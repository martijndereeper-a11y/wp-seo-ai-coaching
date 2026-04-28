/**
 * Per-behavior coaching content for the admin /admin behavior-detail panel.
 *
 * For each behavior we store:
 *   definition       — what it actually is + which regex tokens we look for
 *   whyItMatters     — short prose, ties to causal evidence
 *   examplePhrases   — NL / DE / EN sample lines an AE can say
 *   commonMisses     — concrete failure modes we see across the dataset
 *   coachingDrill    — one practical coaching exercise tied to the behavior
 *   classification   — TRAINABLE | PRACTICE | INNATE | STRUCTURAL
 */

export type BehaviorCoaching = {
  key: string;
  label: string;
  classification: 'TRAINABLE' | 'PRACTICE' | 'INNATE' | 'STRUCTURAL';
  definition: string;
  whyItMatters: string;
  examplePhrases: { nl: string[]; de: string[]; en: string[] };
  commonMisses: string[];
  coachingDrill: string;
};

export const BEHAVIOR_COACHING: Record<string, BehaviorCoaching> = {
  contract: {
    key: 'contract',
    label: 'Contract / commitment language',
    classification: 'TRAINABLE',
    definition: 'The AE uses commitment-implying language toward the end of the call — words like "contract", "sign", "agreement", or "akkoord" that frame the next step as a transaction, not a meeting.',
    whyItMatters: 'Strongest single causal signal in the dataset: +11.8% close rate, 95% CI [+8.5%, +15.1%], p<0.001 across 21 AEs. Removing the verbal hedge between "interested" and "buying" turns a positive call into a forward-moving deal.',
    examplePhrases: {
      nl: [
        '"Ik stuur je vandaag het contract — kijk het rustig door en laat me morgen weten of het past."',
        '"We kunnen volgende week starten. Zal ik het contract klaarzetten?"',
        '"Tekenen we vandaag of donderdag?"',
      ],
      de: [
        '"Ich schicke Ihnen heute den Vertrag — schauen Sie ihn in Ruhe durch und sagen Sie mir morgen Bescheid."',
        '"Wir können nächste Woche starten. Soll ich den Vertrag vorbereiten?"',
        '"Unterzeichnen wir heute oder Donnerstag?"',
      ],
      en: [
        '"I\'ll send the contract over today — review it and let me know tomorrow."',
        '"We can start next week. Should I get the contract ready?"',
        '"Are we signing today or Thursday?"',
      ],
    },
    commonMisses: [
      'Ending with "laat maar weten" / "let me know" — open loop, no deadline.',
      'Saying "I\'ll send a proposal" instead of "I\'ll send the contract" — proposals invite review; contracts invite signature.',
      'Asking the prospect to come back to you instead of booking the next concrete touchpoint in the call itself.',
    ],
    coachingDrill: 'Role-play: AE has 90 seconds to close every meeting. Coach plays prospect saying "this looks interesting, let me think." AE must respond with a contract-language line (not "let me know") and book the signing call. Repeat 5x with different prospect objections.',
  },

  assumptiveClose: {
    key: 'assumptiveClose',
    label: 'Assumptive close',
    classification: 'PRACTICE',
    definition: 'Language that presumes the deal is happening — "when would you start", "which package fits", "I\'ll send the contract Thursday" — instead of asking permission to continue.',
    whyItMatters: 'Causal effect +6.5% close rate, 95% CI [+3.5%, +10.2%], p=0.001 across 17 AEs. Reframes the conversation from "should we?" to "how will we?", forcing the prospect to either commit or surface their real objection.',
    examplePhrases: {
      nl: [
        '"Welk pakket past het beste — Pro of Premium?"',
        '"Wanneer zouden jullie willen starten — deze maand of begin volgende?"',
        '"Wie wordt jullie main contact tijdens onboarding?"',
      ],
      de: [
        '"Welches Paket passt am besten — Pro oder Premium?"',
        '"Wann möchten Sie starten — diesen Monat oder Anfang nächsten?"',
        '"Wer wird Ihr Hauptansprechpartner während des Onboardings?"',
      ],
      en: [
        '"Which package fits best — Pro or Premium?"',
        '"When would you start — this month or early next?"',
        '"Who\'ll be your main contact during onboarding?"',
      ],
    },
    commonMisses: [
      'Using "if" language ("if we work together") — keeps the prospect in evaluation mode.',
      'Asking "do you want to..." instead of "which..." or "when..." — gives a yes/no escape hatch.',
      'Adding qualifiers ("just hypothetically...") — undermines the assumption.',
    ],
    coachingDrill: 'Listen to 3 of the AE\'s recent lost calls. Find every "if" / "do you want to" / "would you like to" statement. Rewrite each as an assumptive-close ("when", "which", "who"). Have the AE practice the rewritten lines aloud. Then book a real call where they have to use 5+ assumptive lines — count them on review.',
  },

  roiReframe: {
    key: 'roiReframe',
    label: 'ROI reframe',
    classification: 'PRACTICE',
    definition: 'The AE explicitly reframes price as investment with a payback timeline — "investering" / "Investition" / "pay back", "roi", "verdien terug". Removes the cost objection before the prospect raises it.',
    whyItMatters: 'Causal effect +3.5% close rate (NL: +4.1%) across 23 AEs. Top performers use this 22pp more than the rest — second-widest top-rest gap of any behavior. The price stays the same; only the framing changes.',
    examplePhrases: {
      nl: [
        '"Het is geen kost, het is een investering — gemiddeld verdien je het binnen 6 maanden terug via extra verkeer."',
        '"Vergelijk het met een bureau van €4K/maand. Bij ons is het vanaf €625, en wij doen alles."',
        '"Voor €625/maand bouw je een organische zoekmachine die elke maand sterker wordt — een bureau stop je geld in en als je stopt, stopt het."',
      ],
      de: [
        '"Es sind keine Kosten, es ist eine Investition — im Durchschnitt amortisiert sie sich in 6 Monaten."',
        '"Vergleichen Sie es mit einer Agentur für 4K€/Monat. Bei uns sind es ab 625€, und wir machen alles."',
        '"Für 625€/Monat bauen Sie eine organische Suchmaschine, die jeden Monat stärker wird."',
      ],
      en: [
        '"This isn\'t a cost, it\'s an investment — payback is around 6 months on average."',
        '"Compare it to a €4K/month agency. We start at €625, and we do everything."',
        '"For €625/month you\'re building a search engine that compounds — an agency you keep paying or it stops working."',
      ],
    },
    commonMisses: [
      'Saying "kosten" / "Kosten" / "cost" instead of "investering" / "Investition" / "investment" — the word choice itself anchors the prospect\'s mental category.',
      'Quoting the price without anchoring against the alternative (agency, in-house hire) — unanchored prices feel expensive.',
      'Skipping the payback horizon — "6 months" / "by month 4" / "first year" makes the math feel concrete.',
    ],
    coachingDrill: '60-second drill: AE pitches the price in 60 seconds, must use "investering" or equivalent at least twice, must include an agency cost comparison, must include a payback horizon. Coach times them and rejects the take if any of the three is missing.',
  },

  compounding: {
    key: 'compounding',
    label: 'Compounding value framing',
    classification: 'PRACTICE',
    definition: 'The AE explains that value compounds over time — "snowball", "stapelt", "exponentiell", "over time", "every month it gets stronger". Justifies a longer commitment by making the long view feel inevitable.',
    whyItMatters: 'Top performers use this 18pp more than the rest. While not statistically significant in causal terms (p=0.16), it\'s strongly correlated with closing because it pre-handles the cancellation objection — the prospect intuits that stopping early throws away the compounding.',
    examplePhrases: {
      nl: [
        '"In maand 1 zie je nog weinig. In maand 6 zie je verkeer. In maand 12 stapelen die maandelijkse rankings — elke nieuwe pagina vergroot de oude."',
        '"Het is een sneeuwbal. Hoe langer je rolt, hoe groter het wordt. Daarom rekenen wij met 12 maanden minimum."',
        '"Wat je vandaag bouwt, levert volgend jaar nog steeds verkeer op."',
      ],
      de: [
        '"In Monat 1 sehen Sie wenig. In Monat 6 Traffic. In Monat 12 stapeln sich die monatlichen Rankings."',
        '"Es ist ein Schneeball. Je länger Sie rollen, desto größer wird er."',
        '"Was Sie heute bauen, bringt nächstes Jahr immer noch Traffic."',
      ],
      en: [
        '"Month 1 you see little. Month 6, traffic. Month 12, the monthly rankings stack — each new page lifts the old ones."',
        '"It\'s a snowball — the longer it rolls, the bigger it gets. That\'s why we work in 12-month minimum cycles."',
        '"What you build today is still earning traffic next year."',
      ],
    },
    commonMisses: [
      'Talking only about month-1 impact — frames the deal as short-term and invites comparison to ad spend.',
      'Saying "results take time" without explaining WHY they compound — sounds like an excuse, not an architectural truth.',
      'Skipping the long-horizon picture entirely — leaves the prospect mentally pricing one month at a time.',
    ],
    coachingDrill: 'AE writes a 30-second compounding pitch in their own voice. Coach reviews against three criteria: (1) explicit timeline (months 1, 6, 12), (2) a metaphor (snowball, sneeuwbal, etc.), (3) ties to commitment length. AE delivers it on next 5 calls; review which calls had it vs not, compare close rates.',
  },

  humor: {
    key: 'humor',
    label: 'Humor / rapport',
    classification: 'INNATE',
    definition: 'Light language and laughter that drops the prospect\'s guard — "haha", "grappig", "Witz", jokes that land. Detected by laughter tokens and humor markers in AE turns.',
    whyItMatters: 'Top performers use this 18pp more (87% vs 68%). Within-AE causal effect not significant overall, but humor strongly predicts trust and the prospect\'s willingness to disclose budget/authority/timeline honestly later in the call.',
    examplePhrases: {
      nl: [
        'Self-deprecating: "Ja, dat klinkt verdacht veel als sales-praatjes — laat me je laten zien wat ik bedoel."',
        'Light callback: "Toen je net zei [X], dacht ik direct aan onze klant in Utrecht die exact dezelfde paniek had."',
        'Acknowledged tension: "Ik ga je nu de prijs noemen — adem rustig in [pause]."',
      ],
      de: [
        'Self-deprecating: "Ja, klingt verdächtig nach Verkaufsgerede — lassen Sie mich zeigen, was ich meine."',
        'Light callback: "Als Sie [X] gesagt haben, musste ich an unseren Kunden in Hamburg denken, der genau die gleiche Panik hatte."',
      ],
      en: [
        'Self-deprecating: "I know that sounds suspiciously like a sales pitch — let me show you what I mean."',
        'Light callback: "When you said [X] earlier, I thought of our client in Utrecht who had that exact panic."',
      ],
    },
    commonMisses: [
      'Trying to be funny without setup — forced humor lands worse than no humor.',
      'Suppressing genuine reactions to the prospect\'s jokes — AE laughs once and snaps back to formal mode; prospect senses it.',
      'Defaulting to sterile professional tone the entire call — no warmth, no rapport, just script.',
    ],
    coachingDrill: 'Hard one to coach directly because it\'s INNATE. Best lever: assign humor as observation, not generation. AE listens to 3 of their recent calls flagged "low humor" and identifies 3 moments where they could have been warmer. Pair them with a humor-strong AE for shadow calls. Some AEs won\'t move on this — that\'s fine; it\'s not the highest-leverage path for everyone.',
  },

  opinionAsk: {
    key: 'opinionAsk',
    label: 'Ask for opinion',
    classification: 'PRACTICE',
    definition: 'AE explicitly asks the prospect for their reaction or read — "wat denk je", "hoe klinkt dat", "what do you think". Stops the AE\'s monologue and forces a temperature check.',
    whyItMatters: '+12.6% causal effect on close rate in the inflated-outcome run; effect attenuated to non-significant under the cleaned outcomes but the win/lost differential remains: present in 91% of NL won calls vs 76% of NL lost calls.',
    examplePhrases: {
      nl: [
        '"Hoe klinkt dat in vergelijking met wat jullie nu doen?"',
        '"Wat gaat er nu door je hoofd?"',
        '"Wat zou jou nog aarzelen na wat je net hebt gehoord?"',
      ],
      de: [
        '"Wie klingt das im Vergleich zu dem, was Sie jetzt machen?"',
        '"Was geht Ihnen gerade durch den Kopf?"',
      ],
      en: [
        '"How does that sound compared to what you\'re doing now?"',
        '"What\'s going through your mind right now?"',
      ],
    },
    commonMisses: [
      'Asking yes/no questions — "make sense?" — gives no real signal.',
      'Asking opinion AFTER pitching for 4+ minutes — too late; prospect has already disengaged.',
      'Not pausing after asking — AE keeps talking, robs the prospect of space to answer.',
    ],
    coachingDrill: 'After every major pitch block (pricing, demo, value framing), AE must pause and ask one open opinion question — and silence-count to 5. Track frequency on next 10 calls; aim for 3+ opinion-asks per call.',
  },

  theirBusiness: {
    key: 'theirBusiness',
    label: 'Discovery of their business',
    classification: 'PRACTICE',
    definition: 'AE asks about the prospect\'s customers, market, competitors, products, revenue, or growth — discovery questions specifically about THEM, not about marketing in general.',
    whyItMatters: 'Top performers ask 87% (NL); rest 87%. Gap is small overall but the LACK of business discovery is the strongest predictor of "low call quality" (under 40 score). It\'s table stakes — without it, nothing else lands.',
    examplePhrases: {
      nl: [
        '"Wie zijn jullie ideale klanten? Hoe zien die eruit?"',
        '"Wat is voor jullie een goede klant — qua omzet, qua type?"',
        '"Wat zijn jullie 2-3 grootste concurrenten en wat doen die wel/niet?"',
      ],
      de: [
        '"Wer sind Ihre idealen Kunden?"',
        '"Was sind Ihre 2-3 größten Wettbewerber?"',
      ],
      en: [
        '"Who are your ideal customers — what do they look like?"',
        '"Who are your 2-3 biggest competitors and what do they do well/poorly?"',
      ],
    },
    commonMisses: [
      'Spending discovery time on "what\'s your current SEO setup" — that\'s about US, not them.',
      'Skipping the customer/market questions and going straight to demo.',
      'Asking surface questions ("what do you do?") instead of probing ("how do these customers find you today?").',
    ],
    coachingDrill: 'AE prepares 5 business-discovery questions BEFORE every call. Coach reviews the list 5 minutes before. After call, AE marks which ones they actually asked. Goal: 4 of 5 asked per call.',
  },

  priceAnchor: {
    key: 'priceAnchor',
    label: 'Price anchor (marketing spend)',
    classification: 'TRAINABLE',
    definition: 'Before stating WP SEO AI\'s price, the AE anchors against the prospect\'s current spend — agency cost, ad budget, or what similar companies pay. Makes the WP SEO AI price feel small.',
    whyItMatters: 'Top performers anchor 83% of calls vs 65% for the rest (+18pp). Causal effect inferred via the ROI reframe link — same mechanism, applied at the moment the price is mentioned.',
    examplePhrases: {
      nl: [
        '"Een SEO-bureau kost al snel €4-5K per maand. En dan moet je daar nog tools voor inkopen, gemiddeld €500. Bij ons is het vanaf €625, en wij doen alles."',
        '"Wat betalen jullie nu aan Google Ads? [pause] Bij ons komt daar een organische motor onder, en de kosten daarvan zijn een fractie."',
        '"Een interne SEO-specialist kost €70K per jaar. Bij ons is het €7,500."',
      ],
      de: [
        '"Eine SEO-Agentur kostet schnell 4-5K€ pro Monat. Bei uns sind es ab 625€."',
        '"Was bezahlen Sie jetzt für Google Ads? Bei uns kommt darunter eine organische Maschine."',
      ],
      en: [
        '"An SEO agency easily costs €4-5K per month. We start at €625, and we do everything."',
        '"What are you paying for Google Ads now? Beneath that, we add an organic engine for a fraction."',
      ],
    },
    commonMisses: [
      'Stating the price first, then anchoring — order matters, anchor MUST come before.',
      'Anchoring against an unrealistic comparison (€10K agency when prospect would never hire one).',
      'Skipping the anchor on small accounts — assumes they don\'t care about price; they always do.',
    ],
    coachingDrill: 'AE writes 3 anchor lines tailored to NL/DE/EN markets. Coach reviews. AE practices delivering them in <15s each. Track on next 10 calls: anchor before price, yes/no.',
  },

  socialProof: {
    key: 'socialProof',
    label: 'Social proof / case studies',
    classification: 'TRAINABLE',
    definition: 'AE references customer counts or specific clients — "we hebben 2,490 klanten", "one of our customers in [industry]", "tweeduizend bedrijven". Borrows authority by association.',
    whyItMatters: 'Causal effect +7.7% (in older inflated-outcomes run; attenuated under cleaned but still positive). Top performers reference proof 87% (NL) — strongly tied to overcoming "have I heard of you?" hesitation, especially for SMB prospects.',
    examplePhrases: {
      nl: [
        '"We hebben inmiddels meer dan 2,490 klanten in 88 verschillende industrieën."',
        '"Een klant van ons in [vergelijkbare industrie] zat in exact hetzelfde — laat me je vertellen wat er gebeurd is."',
        '"De 200 grootste WordPress-sites in Nederland gebruiken inmiddels onze tool."',
      ],
      de: [
        '"Wir haben mittlerweile über 2,490 Kunden in 88 verschiedenen Branchen."',
        '"Ein Kunde von uns in [Branche] war in genau der gleichen Situation."',
      ],
      en: [
        '"We have over 2,490 customers across 88 industries."',
        '"A customer of ours in [similar industry] was in the same place — let me tell you what happened."',
      ],
    },
    commonMisses: [
      'Generic proof ("many customers") without numbers or industry — feels hollow.',
      'Naming a customer the prospect doesn\'t know — proof needs to land in the prospect\'s reference frame.',
      'Saving social proof for the end — should land within the first 10 minutes when credibility is being established.',
    ],
    coachingDrill: 'AE memorizes the industry catalog\'s top 10 industries by customer count. On every call, identifies the prospect\'s industry from the discovery, then drops in: "[X count] customers in your space." Track: did they do it within first 15 minutes?',
  },

  challenging: {
    key: 'challenging',
    label: 'Challenging prospect thinking',
    classification: 'PRACTICE',
    definition: 'AE pushes back on the prospect\'s assumptions — "but then", "why not", "what\'s holding you back". Tests the prospect\'s reasoning instead of accepting their framing.',
    whyItMatters: 'Top performers challenge 93% of NL calls vs 84% rest. Strongly correlated with the AE running the meeting (vs the prospect running it). Challenging is the difference between a sales conversation and a polite Q&A.',
    examplePhrases: {
      nl: [
        '"Stel dat je dit niet doet — wat gebeurt er over 12 maanden met je organische verkeer?"',
        '"Waarom heb je het tot nu toe niet aangepakt?"',
        '"Maar als je weet dat je concurrent dit al doet, wat houdt je tegen?"',
      ],
      de: [
        '"Angenommen, Sie tun das nicht — was passiert in 12 Monaten?"',
        '"Warum haben Sie es bisher nicht angegangen?"',
      ],
      en: [
        '"Suppose you don\'t do this — what happens in 12 months?"',
        '"Why hasn\'t this been tackled before?"',
        '"If your competitor is already doing this, what\'s actually holding you back?"',
      ],
    },
    commonMisses: [
      'Challenging too early — prospect needs warming up first; cold challenges feel hostile.',
      'Challenging without follow-through — asks "what stops you" then doesn\'t address the answer.',
      'Avoiding it entirely to seem agreeable — costs the close because the AE never tested for real objection.',
    ],
    coachingDrill: 'On next 5 calls, AE must ask at least 2 cost-of-inaction questions ("what happens if you don\'t...") and 1 commitment-blocker question ("what would stop us from starting?"). Mark the timestamp on each.',
  },

  research: {
    key: 'research',
    label: 'Pre-call research referenced',
    classification: 'TRAINABLE',
    definition: 'AE references something specific they saw on the prospect\'s website, LinkedIn, Google, or recent news — "I saw on your site...", "ik zag op LinkedIn...". Demonstrates effort and earns the right to ask deeper questions.',
    whyItMatters: '+10.1% causal in earlier run; correlated with higher initial trust and shorter discovery time. Skipping it is the #1 reason discovery feels generic to the prospect.',
    examplePhrases: {
      nl: [
        '"Ik zag op jullie website dat jullie net een nieuwe productlijn hebben gelanceerd — vertel daar eens over."',
        '"Ik keek even op jullie LinkedIn en zag dat jullie 50 medewerkers hebben — hoe is dat verdeeld over commercie en operations?"',
      ],
      de: [
        '"Ich habe auf Ihrer Website gesehen, dass Sie eine neue Produktlinie gestartet haben."',
        '"Ich habe auf Ihrem LinkedIn gesehen..."',
      ],
      en: [
        '"I saw on your website that you just launched a new product line — tell me about that."',
        '"I checked your LinkedIn and saw you have 50 staff..."',
      ],
    },
    commonMisses: [
      'Generic openers ("how\'s your day?") instead of researched ones.',
      'Mentioning research too late ("oh by the way I saw...") — should be first 60 seconds.',
      'Researching the wrong things — focusing on irrelevant trivia instead of business signals.',
    ],
    coachingDrill: 'AE has a 5-minute pre-call research template (website hero, recent LinkedIn post, top 3 Google results for company name). Must reference 2 of the 3 in opening 2 minutes. Track adoption.',
  },
};

/** Default fallback for behaviors without rich coaching content. */
export function getCoaching(key: string, label: string, classification: string): BehaviorCoaching {
  if (BEHAVIOR_COACHING[key]) return BEHAVIOR_COACHING[key];
  return {
    key,
    label,
    classification: (classification as any) || 'PRACTICE',
    definition: `Behavior detected by language patterns in the AE's turns. See pattern-detector.ts for the full regex.`,
    whyItMatters: 'No detailed coaching content authored yet for this behavior. Refer to the causal effect + adoption-rate gap above to judge priority.',
    examplePhrases: { nl: [], de: [], en: [] },
    commonMisses: [],
    coachingDrill: 'Coaching drill not yet authored. Compare exemplar wins vs anti-exemplar losses below to extract patterns by ear.',
  };
}
