/**
 * Narrative Coach — LLM-powered deep call analysis
 *
 * Takes flagged moments from the pattern detector + full transcript context
 * and generates Koen-style narrative coaching reviews using Claude API.
 *
 * Two modes:
 *   1. analyzeCallNarrative() — full call review (objections, buying signals, coaching)
 *   2. analyzeCallQuick() — focused on top 3 moments only (faster, cheaper)
 */

// Anthropic SDK is lazy-loaded to avoid 29MB cold start on Vercel
let _Anthropic: any = null;
async function getAnthropic() {
  if (!_Anthropic) {
    const mod = await import('@anthropic-ai/sdk');
    _Anthropic = mod.default || mod;
  }
  return _Anthropic;
}
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function loadApiKey(): string {
  // Check env first
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;

  // Check .env file
  const envPath = join(homedir(), '.config', 'document-hub', '.env');
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('ANTHROPIC_API_KEY=')) {
        return trimmed.slice('ANTHROPIC_API_KEY='.length).replace(/^["']|["']$/g, '');
      }
    }
  }
  return '';
}

// Load Koen's coaching rules
function loadCoachingContext(): string {
  const rulesPath = join(process.cwd(), 'coaching-guides', 'koen-rules.md');
  if (existsSync(rulesPath)) {
    return readFileSync(rulesPath, 'utf-8');
  }
  return '';
}

export interface NarrativeReview {
  summary: string;
  objectionsAnalysis: string;
  buyingSignalsAnalysis: string;
  coachingMoments: string;
  overallVerdict: string;
  generatedAt: string;
}

// System prompt for AE-level deep analysis — static across AEs, cached.
function buildAEDeepSystemPrompt(): string {
  const coachingRules = loadCoachingContext();
  return `You are a sales coaching analyst conducting comprehensive performance reviews of AEs at WP SEO AI, an AI-native SEO/GEO platform in the Netherlands selling to SMB founders.

## Coaching framework (from Koen, Commercial Director):
${coachingRules.slice(0, 2000)}

## Output format

Write a comprehensive coaching review for the AE. This is for their lead to use in 1:1s and performance reviews. Be specific — reference actual calls by name, quote actual objection/buying signal exchanges, and identify PATTERNS across calls, not just individual moments.

Write in English. Use ### headers exactly as shown below.

### 1. OVERVIEW (3-4 sentences)
Who is this AE? What is their overall level? What is the one-line summary of where they are?

### 2. CALL CONTROL & CONVERSATION MANAGEMENT
Do they lead conversations or follow? Do they set agendas? When do they lose control? Reference specific calls. Is this consistent or does it vary?

### 3. DISCOVERY & GAP CREATION
Do they create the gap (prospect realizes they have a problem)? Do they use live proof (Google/ChatGPT search)? Do they ask enough questions? Are they hypothesis-led or open-ended? Show the pattern across calls.

### 4. OBJECTION HANDLING PATTERNS
How do they typically handle objections? Quote actual exchanges from the call data. Do they explore, acknowledge, minimize, or talk over? Is there a consistent pattern? What objection types are they weakest on?

### 5. CLOSING BEHAVIOR
Do they close? Do they create urgency? Do they define next steps? What happens at the end of their calls? Quote specific closing (or non-closing) moments.

### 6. SCRIPT & NARRATIVE EXECUTION
Which parts of the pitch do they consistently nail? Which do they consistently skip? Is their narrative clear and founder-friendly or feature-heavy?

### 7. COACHING PLAN (most important section)
The TOP 3 things this AE should work on, in priority order. For each:
- What is the problem (with evidence from calls)?
- What should they do differently (specific, actionable)?
- How to practice it (concrete exercise or habit)?
- How to measure progress?

Be brutally honest but constructive. This is a coaching document, not a report card.`;
}

// System prompt for per-call narrative — static across all calls, cached.
function buildCallNarrativeSystemPrompt(): string {
  const coachingRules = loadCoachingContext();
  return `You are a sales coaching analyst reviewing sales calls for WP SEO AI, an AI-native SEO/GEO platform in the Netherlands.

## Your coaching framework (from Koen, Commercial Director):
${coachingRules.slice(0, 3000)}

## Output format

Analyze each call in depth. Write in English. Be specific — use exact timestamps (MM:SS format) and direct quotes from the transcript.

Provide your analysis in these 5 sections, using ### headers exactly as shown:

### 1. CALL SUMMARY (3-4 sentences)
What happened in this call? Who was on it? What was discussed? What was the outcome?

### 2. WHERE DID THE PROSPECT SHOW DOUBTS OR OBJECTIONS?
For each objection moment:
- Exact timestamp and direct quote from prospect
- What the AE actually said in response (exact quote)
- What the AE should have done instead (specific scripted alternative)
- Why this matters commercially

### 3. WHERE DID THE PROSPECT GIVE BUYING SIGNALS?
For each buying signal:
- Exact timestamp and direct quote
- Why this is a buying signal (what does it reveal about mindset?)
- What the AE actually did with it
- What the AE should have done (prevent happy ears — validate, dig, find out WHY)
- The specific words the AE should have said

### 4. KEY COACHING MOMENTS
The 3 most impactful moments where the AE's behavior directly influenced the outcome. For each:
- What happened (with quotes)
- The AE's reaction
- What should have happened instead
- The business impact of this gap

### 5. OVERALL VERDICT
2-3 sentences: What is the single biggest thing this AE should work on based on this call? Be direct and specific, not generic.

Be brutally honest but constructive. Use specific quotes and timestamps throughout. Never be vague.`;
}

export async function analyzeCallNarrative(
  transcriptText: string,
  aeName: string,
  callTitle: string,
  callDuration: number,
  flaggedMoments: { type: string; category: string; timestamp: string; excerpt: string; guidance: string }[],
): Promise<NarrativeReview | null> {
  const apiKey = loadApiKey();
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set — skipping narrative analysis');
    return null;
  }

  const AnthropicClass = await getAnthropic();
  const client = new AnthropicClass({ apiKey });
  const trimmedTranscript = transcriptText.slice(0, 30000);
  const flaggedSummary = flaggedMoments.map(m =>
    `[${m.timestamp}] ${m.type.toUpperCase()}: ${m.category} — ${m.excerpt.slice(0, 100)}`
  ).join('\n');

  const userMessage = `AE: ${aeName}
Call: ${callTitle}
Duration: ${callDuration} minutes

## Pre-flagged moments by our detection engine:
${flaggedSummary}

## Full transcript:
${trimmedTranscript}`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2500,
      system: [{ type: 'text', text: buildCallNarrativeSystemPrompt(), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => (block as { type: 'text'; text: string }).text)
      .join('\n');

    // Parse sections
    const sections = {
      summary: extractSection(text, '1. CALL SUMMARY', '2.'),
      objectionsAnalysis: extractSection(text, '2. WHERE DID THE PROSPECT SHOW DOUBTS', '3.'),
      buyingSignalsAnalysis: extractSection(text, '3. WHERE DID THE PROSPECT GIVE BUYING SIGNALS', '4.'),
      coachingMoments: extractSection(text, '4. KEY COACHING MOMENTS', '5.'),
      overallVerdict: extractSection(text, '5. OVERALL VERDICT', null),
      generatedAt: new Date().toISOString(),
    };

    return sections;
  } catch (err: any) {
    console.error('Claude API error:', err.message);
    return null;
  }
}

// ─── AE-level deep analysis (across all calls) ──────────────────────────────

export interface AEDeepAnalysis {
  overview: string;
  callControl: string;
  discoveryAndGapCreation: string;
  objectionPatterns: string;
  closingBehavior: string;
  scriptExecution: string;
  coachingPlan: string;
  generatedAt: string;
}

export async function analyzeAEDeep(
  aeName: string,
  callSummaries: {
    title: string;
    date: string;
    duration: number;
    talkRatio: number;
    questionCount: number;
    scriptAdherence: number;
    quality: number;
    outcome: string;
    summary: string;
    oneThingToChange: string;
    objections: { prospectSaid: string; aeSaid: string; handling: string }[];
    buyingSignals: { prospectSaid: string; aeSaid: string; didAdvance: boolean }[];
    callVerdict: string[];
    scriptMissed: string[];
  }[],
  profileData: {
    totalCalls: number;
    avgTalkRatio: number;
    avgQuestions: number;
    avgScriptAdherence: number;
    avgQuality: number;
    strengths: string[];
    weaknesses: string[];
  },
  teamBenchmarks: {
    avgTalkRatio: number;
    avgQuestions: number;
    avgQuality: number;
  },
): Promise<AEDeepAnalysis | null> {
  const apiKey = loadApiKey();
  if (!apiKey) return null;

  const AnthropicClass = await getAnthropic();
  const client = new AnthropicClass({ apiKey });

  // Build a condensed view of all calls
  const callData = callSummaries.slice(0, 30).map((c, i) => {
    const objStr = c.objections.slice(0, 2).map(o => `Prospect: "${o.prospectSaid.slice(0,80)}" → AE: "${o.aeSaid.slice(0,80)}" [${o.handling}]`).join('\n    ');
    const bsStr = c.buyingSignals.slice(0, 2).map(b => `Prospect: "${b.prospectSaid.slice(0,80)}" → AE: "${b.aeSaid.slice(0,80)}" [${b.didAdvance ? 'ADVANCED' : 'MISSED'}]`).join('\n    ');
    return `Call ${i+1}: "${c.title}" (${c.date}, ${c.duration}min, ${c.outcome || 'unknown'})
  Talk: ${c.talkRatio}% | Qs: ${c.questionCount} | Script: ${c.scriptAdherence}% | Quality: ${c.quality}
  Summary: ${c.summary.slice(0, 200)}
  Verdict: ${c.callVerdict.join(', ') || 'OK'}
  Script missed: ${c.scriptMissed.join(', ') || 'None'}
  One thing: ${c.oneThingToChange.slice(0, 150)}
  ${objStr ? 'Objections:\n    ' + objStr : ''}
  ${bsStr ? 'Buying signals:\n    ' + bsStr : ''}`;
  }).join('\n\n');

  const userMessage = `## AE: ${aeName}
## Profile:
- ${profileData.totalCalls} calls analyzed
- Avg talk ratio: ${profileData.avgTalkRatio}% (team avg: ${teamBenchmarks.avgTalkRatio}%)
- Avg questions: ${profileData.avgQuestions}/call (team avg: ${teamBenchmarks.avgQuestions})
- Avg script adherence: ${profileData.avgScriptAdherence}%
- Avg call quality: ${profileData.avgQuality} (team avg: ${teamBenchmarks.avgQuality})
- Strengths: ${profileData.strengths.join(', ') || 'None identified'}
- Weaknesses: ${profileData.weaknesses.join(', ') || 'None identified'}

## Call data (most recent ${callSummaries.length} calls):
${callData}`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 6000,
      system: [{ type: 'text', text: buildAEDeepSystemPrompt(), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => (block as { type: 'text'; text: string }).text)
      .join('\n');

    return {
      overview: extractSection(text, '1. OVERVIEW', '2.'),
      callControl: extractSection(text, '2. CALL CONTROL', '3.'),
      discoveryAndGapCreation: extractSection(text, '3. DISCOVERY', '4.'),
      objectionPatterns: extractSection(text, '4. OBJECTION HANDLING', '5.'),
      closingBehavior: extractSection(text, '5. CLOSING', '6.'),
      scriptExecution: extractSection(text, '6. SCRIPT', '7.'),
      coachingPlan: extractSection(text, '7. COACHING PLAN', null),
      generatedAt: new Date().toISOString(),
    };
  } catch (err: any) {
    console.error('Claude API error:', err.message);
    return null;
  }
}

// ─── Streaming variants (yield text chunks as Claude generates) ──────────────

export async function* streamCallNarrative(
  transcriptText: string,
  aeName: string,
  callTitle: string,
  callDuration: number,
  flaggedMoments: { type: string; category: string; timestamp: string; excerpt: string; guidance: string }[],
): AsyncGenerator<string, void, unknown> {
  const apiKey = loadApiKey();
  if (!apiKey) { yield 'ERROR: ANTHROPIC_API_KEY not set'; return; }

  const AnthropicClass = await getAnthropic();
  const client = new AnthropicClass({ apiKey });
  const trimmedTranscript = transcriptText.slice(0, 30000);
  const flaggedSummary = flaggedMoments.map(m =>
    `[${m.timestamp}] ${m.type.toUpperCase()}: ${m.category} — ${m.excerpt.slice(0, 100)}`
  ).join('\n');

  const userMessage = `AE: ${aeName}
Call: ${callTitle}
Duration: ${callDuration} minutes

## Pre-flagged moments by our detection engine:
${flaggedSummary}

## Full transcript:
${trimmedTranscript}`;

  try {
    const stream = await client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 2500,
      system: [{ type: 'text', text: buildCallNarrativeSystemPrompt(), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMessage }],
    });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        yield event.delta.text;
      }
    }
  } catch (err: any) {
    yield `\n[ERROR: ${err?.message || 'unknown'}]`;
  }
}

export async function* streamAEDeep(
  aeName: string,
  callSummaries: any[],
  profileData: any,
  teamBenchmarks: any,
): AsyncGenerator<string, void, unknown> {
  const apiKey = loadApiKey();
  if (!apiKey) { yield 'ERROR: ANTHROPIC_API_KEY not set'; return; }

  const AnthropicClass = await getAnthropic();
  const client = new AnthropicClass({ apiKey });

  const callData = callSummaries.slice(0, 30).map((c: any, i: number) => {
    const objStr = c.objections.slice(0, 2).map((o: any) => `Prospect: "${o.prospectSaid.slice(0,80)}" → AE: "${o.aeSaid.slice(0,80)}" [${o.handling}]`).join('\n    ');
    const bsStr = c.buyingSignals.slice(0, 2).map((b: any) => `Prospect: "${b.prospectSaid.slice(0,80)}" → AE: "${b.aeSaid.slice(0,80)}" [${b.didAdvance ? 'ADVANCED' : 'MISSED'}]`).join('\n    ');
    return `Call ${i+1}: "${c.title}" (${c.date}, ${c.duration}min, ${c.outcome || 'unknown'})
  Talk: ${c.talkRatio}% | Qs: ${c.questionCount} | Script: ${c.scriptAdherence}% | Quality: ${c.quality}
  Summary: ${c.summary.slice(0, 200)}
  Verdict: ${c.callVerdict.join(', ') || 'OK'}
  One thing: ${c.oneThingToChange.slice(0, 150)}
  ${objStr ? 'Objections:\n    ' + objStr : ''}
  ${bsStr ? 'Buying signals:\n    ' + bsStr : ''}`;
  }).join('\n\n');

  const userMessage = `## AE: ${aeName}
## Profile:
- ${profileData.totalCalls} calls analyzed
- Avg talk ratio: ${profileData.avgTalkRatio}% (team avg: ${teamBenchmarks.avgTalkRatio}%)
- Avg questions: ${profileData.avgQuestions}/call (team avg: ${teamBenchmarks.avgQuestions})
- Avg script adherence: ${profileData.avgScriptAdherence}%
- Avg call quality: ${profileData.avgQuality} (team avg: ${teamBenchmarks.avgQuality})
- Strengths: ${profileData.strengths.join(', ') || 'None'}
- Weaknesses: ${profileData.weaknesses.join(', ') || 'None'}

## Call data (most recent ${callSummaries.length} calls):
${callData}`;

  try {
    const stream = await client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 6000,
      system: [{ type: 'text', text: buildAEDeepSystemPrompt(), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMessage }],
    });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        yield event.delta.text;
      }
    }
  } catch (err: any) {
    yield `\n[ERROR: ${err?.message || 'unknown'}]`;
  }
}

function extractSection(text: string, startMarker: string, endMarker: string | null): string {
  const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) return '';

  let content: string;
  if (endMarker) {
    const endIdx = text.indexOf('### ' + endMarker, startIdx + startMarker.length);
    content = endIdx === -1
      ? text.slice(startIdx + startMarker.length)
      : text.slice(startIdx + startMarker.length, endIdx);
  } else {
    content = text.slice(startIdx + startMarker.length);
  }

  return content.replace(/^[#\s]*/, '').trim();
}
