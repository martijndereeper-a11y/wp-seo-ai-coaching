/**
 * SPICED Classifier — LLM-based discovery-quality tracking
 *
 * SPICED framework (Winning by Design), applied to WP SEO AI first meetings:
 *   S = Situation        — prospect's current state captured (setup, tools, team, traffic baseline)
 *   P = Pain             — prospect articulates a concrete problem in their own words
 *   I = Impact           — pain tied to a business consequence, ideally quantified (€, leads, time)
 *   C = Critical Event   — a dated compelling event that forces a decision on a timeline
 *   D = Decision         — decision process/criteria mapped (who decides, how, agreed next step)
 *
 * Why LLM, not regex:
 *   SPICED lives in paraphrase and dialect — the same as VBAT. AEs only trust a
 *   verdict they can verify, so every verdict returns a verbatim quote with a
 *   timestamp so the AE can jump to that moment and confirm it themselves.
 *
 * Methodology tie-in:
 *   Each element is a binary behavior (spiced.situation … spiced.decision). Those
 *   binaries are injected into the call-engine feature matrix (see
 *   call-engine/features.ts), so the within-AE causal engine reports which SPICED
 *   elements actually move close rate — same rigor as any other behavior.
 *
 * Output is cached per call in ae_call_analysis.spiced_classification.
 */

import type { TranscriptTurn } from './transcript-parser.ts';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Anthropic SDK lazy-loaded (29MB cold start)
let _Anthropic: any = null;
async function getAnthropic() {
  if (!_Anthropic) {
    const mod = await import('@anthropic-ai/sdk');
    _Anthropic = mod.default || mod;
  }
  return _Anthropic;
}

function loadApiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const envPath = join(homedir(), '.config', 'document-hub', '.env');
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (t.startsWith('ANTHROPIC_API_KEY=')) {
        return t.slice('ANTHROPIC_API_KEY='.length).replace(/^["']|["']$/g, '');
      }
    }
  }
  return '';
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type SPICEDKey = 'S' | 'P' | 'I' | 'C' | 'D';

export interface SPICEDVerdict {
  confirmed: boolean;
  evidence: string;          // direct quote from the transcript (prospect or AE)
  speaker: 'prospect' | 'ae' | 'none';
  timestamp: string;          // MM:SS — empty if confirmed=false and no attempt made
  reasoning: string;          // one-line explanation of the verdict
  confidence: 'high' | 'medium' | 'low';
}

export interface SPICEDClassification {
  S: SPICEDVerdict;
  P: SPICEDVerdict;
  I: SPICEDVerdict;
  C: SPICEDVerdict;
  D: SPICEDVerdict;
  hitCount: number;           // out of 5
  generatedAt: string;
  model: string;
}

// Stable behavior ids consumed by the call-engine feature matrix.
export const SPICED_BEHAVIOR_IDS: Record<SPICEDKey, string> = {
  S: 'spiced.situation',
  P: 'spiced.pain',
  I: 'spiced.impact',
  C: 'spiced.critical_event',
  D: 'spiced.decision',
};

// ─── Prompt assembly ────────────────────────────────────────────────────────

function buildTranscriptForPrompt(turns: TranscriptTurn[], recorderName: string): string {
  const firstName = recorderName.split(' ')[0].toLowerCase();
  const lines: string[] = [];
  for (const t of turns) {
    const isAE = t.speaker.toLowerCase().includes(firstName);
    const role = isAE ? 'AE' : 'PROSPECT';
    lines.push(`[${t.timestampDisplay}] ${role} (${t.speaker}): ${t.text}`);
  }
  return lines.join('\n');
}

const LANG_NAME: Record<string, string> = { nl: 'Dutch', de: 'German', en: 'English' };
const LANG_DEFAULT_ISO = 'en';

function resolveLanguage(iso?: string | null): { iso: string; name: string } {
  const k = (iso || LANG_DEFAULT_ISO).toLowerCase();
  const name = LANG_NAME[k] || LANG_NAME[LANG_DEFAULT_ISO];
  return { iso: LANG_NAME[k] ? k : LANG_DEFAULT_ISO, name };
}

function buildSystemPrompt(language: string): string {
  const { name: langLabel } = resolveLanguage(language);
  return `You are a sales discovery analyst for WP SEO AI, an AI-native SEO/GEO managed service selling to Dutch and German SMB founders and marketing managers. You evaluate first-meeting sales calls against the SPICED discovery framework.

You return verdicts as structured JSON via the classify_call tool. Every verdict must cite a direct quote from the transcript (prospect's or AE's exact words) with its timestamp, so the AE can verify the verdict themselves.

## The five elements

**S — Situation captured**
The prospect's CURRENT STATE is established on the record: their current SEO/marketing approach, the tools they use, who handles it, and/or their traffic/lead baseline. Not just the AE asking — the prospect must actually describe their situation. One-word answers do not count.
Evidence must be from the PROSPECT describing their current state.

**P — Pain surfaced**
The prospect articulates a concrete PROBLEM in their own words (e.g. low organic traffic, wasted ad spend, no inbound leads, losing visibility to AI search, content that never ranks). The AE naming a pain the prospect never confirms does NOT count — the prospect must own it.
Evidence must be from the PROSPECT.

**I — Impact established**
The pain is tied to a BUSINESS CONSEQUENCE, ideally quantified: revenue lost, leads missed, hours wasted, € spent, or the upside of fixing it. A vague "it's not great" is NOT impact. Look for a number, a scale, or a concrete business consequence ("we lose deals to competitors who rank", "we spend €X/month on ads because organic doesn't work").
Evidence can be prospect or AE, but the consequence must be specific.

**C — Critical Event identified**
A DATED compelling event that forces a decision on a timeline exists: a launch, budget cycle, campaign, seasonal peak, contract ending, competitor move, or a self-imposed deadline WITH a reason. "Ergens dit jaar" / "someday" is NOT a critical event. Must have both a timeframe and a reason it matters.
Evidence should show the event and its timing.

**D — Decision process mapped**
The DECISION PROCESS is understood: who decides, what the criteria are, what steps remain, AND a concrete agreed next step. Simply asking "wat vind je ervan?" is not enough. Look for the decision path being surfaced and a next step both sides committed to.
Evidence should show the process or the agreed next step.

## Rules

- ALWAYS return all five elements — S, P, I, C, D — in a single classify_call. Never omit one. If an element was not addressed in the call, still return it with confirmed=false. A response missing any of the five is invalid.
- Only transcript evidence counts. Never invent or paraphrase — use verbatim quotes.
- Each verdict must include: confirmed (bool), evidence (verbatim quote, max 150 chars), speaker, timestamp (MM:SS), reasoning (one line), confidence (high/medium/low).
- If an element was never addressed at all, set confirmed=false, evidence="", speaker="none", timestamp="", and reasoning should say the AE never surfaced it.
- Confidence calibration: "high" = clear, unambiguous. "medium" = present but imperfect (e.g., pain mentioned but not owned strongly). "low" = borderline, could go either way.
- Be strict. False positives destroy AE trust. When in doubt, mark NOT confirmed and explain why.

## Language

The transcript is in ${langLabel}. Write the "reasoning" field in ${langLabel}. The "evidence" field is a verbatim quote from the transcript and must remain in the original language exactly as spoken. Other fields (speaker, timestamp, confidence) are technical enums and stay as-is.`;
}

function verdictSchema(description: string) {
  return {
    type: 'object',
    description,
    properties: {
      confirmed: { type: 'boolean' },
      evidence: { type: 'string', description: 'Verbatim quote (max 150 chars), empty if confirmed=false and never attempted' },
      speaker: { type: 'string', enum: ['prospect', 'ae', 'none'] },
      timestamp: { type: 'string', description: 'MM:SS or empty' },
      reasoning: { type: 'string', description: 'One-line explanation' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
    required: ['confirmed', 'evidence', 'speaker', 'timestamp', 'reasoning', 'confidence'],
  };
}

// Anthropic tool schema for structured output
const CLASSIFY_TOOL = {
  name: 'classify_call',
  description: 'Return SPICED discovery classification for a sales call',
  input_schema: {
    type: 'object',
    properties: {
      S: verdictSchema('Situation captured'),
      P: verdictSchema('Pain surfaced'),
      I: verdictSchema('Impact established'),
      C: verdictSchema('Critical Event identified'),
      D: verdictSchema('Decision process mapped'),
    },
    required: ['S', 'P', 'I', 'C', 'D'],
  },
};

// ─── Main classifier ────────────────────────────────────────────────────────

/**
 * Default model for SPICED classification.
 *
 * Sonnet, not Haiku. This tool forces a single call filling 5 nested verdict
 * objects (30 required fields). Haiku intermittently completes the tool call
 * with only the first element (S) populated — ~30% of calls even after 3
 * retries — silently defaulting P/I/C/D to "not confirmed" and corrupting every
 * downstream adoption/causal number. Sonnet fills the full schema reliably.
 * Correctness beats the ~5x Haiku cost saving on a metric people coach against.
 */
export const SPICED_DEFAULT_MODEL = 'claude-sonnet-5';

export async function classifySPICED(
  turns: TranscriptTurn[],
  recorderName: string,
  callTitle: string,
  durationSeconds: number,
  language: string = LANG_DEFAULT_ISO,
  model: string = SPICED_DEFAULT_MODEL,
): Promise<SPICEDClassification | null> {
  const apiKey = loadApiKey();
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set — skipping SPICED classification');
    return null;
  }
  if (turns.length === 0) return null;

  const AnthropicClass = await getAnthropic();
  const client = new AnthropicClass({ apiKey });

  // Cap only as a safety valve for pathological transcripts. The old 25k cap
  // truncated ~90% of real calls mid-way — and Impact / Critical Event / Decision
  // are closing-phase moves, so cutting the end systematically marked them absent.
  // Median call is ~50k chars (~13k tokens); Haiku has 200k context, so keep the
  // whole call. 120k chars (~30k tokens) covers every real call with headroom.
  const TRANSCRIPT_CHAR_CAP = 120000;
  const fullTranscript = buildTranscriptForPrompt(turns, recorderName);
  const transcript = fullTranscript.length > TRANSCRIPT_CHAR_CAP
    ? fullTranscript.slice(0, TRANSCRIPT_CHAR_CAP) + '\n[... transcript truncated ...]'
    : fullTranscript;

  const userMessage = `Call: ${callTitle}
AE: ${recorderName}
Duration: ${Math.round(durationSeconds / 60)} minutes

Transcript:
${transcript}

Classify this call on all five SPICED elements (S/P/I/C/D). Cite direct quotes and timestamps. Be strict — false positives destroy AE trust.`;

  const ALL: SPICEDKey[] = ['S', 'P', 'I', 'C', 'D'];

  // Haiku intermittently returns only the first element(s) of the 5-object tool
  // schema (stop_reason=tool_use, but P/I/C/D simply absent). That silently
  // defaulted them to "not confirmed" and corrupted every downstream number.
  // Retry until all five come back; never store a partial result.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 4096,
        // Pure structured extraction — no reasoning needed. Sonnet 5 runs adaptive
        // thinking by default when omitted, which would consume the 4096 budget and
        // risk re-truncating the tool output. Disable it: cheaper, faster, safer.
        thinking: { type: 'disabled' },
        // Cache the static system prompt — keyed by language so each cohort hits the cache.
        system: [{ type: 'text', text: buildSystemPrompt(language), cache_control: { type: 'ephemeral' } }],
        tools: [CLASSIFY_TOOL],
        tool_choice: { type: 'tool', name: 'classify_call' },
        messages: [{ role: 'user', content: userMessage }],
      });

      const toolUse = response.content.find((b: any) => b.type === 'tool_use');
      if (!toolUse || !toolUse.input) {
        console.error('SPICED classifier: no tool_use block returned');
        continue;
      }

      const input = toolUse.input as Record<string, SPICEDVerdict>;
      const missing = ALL.filter(k => !input[k] || typeof input[k] !== 'object');
      if (response.stop_reason === 'max_tokens' || missing.length > 0) {
        console.error(`SPICED classifier: incomplete output (stop_reason=${response.stop_reason}, missing=${missing.join(',') || 'none'}) — retry ${attempt + 1}/3`);
        continue;
      }

      const verdicts = {
        S: normalizeVerdict(input.S),
        P: normalizeVerdict(input.P),
        I: normalizeVerdict(input.I),
        C: normalizeVerdict(input.C),
        D: normalizeVerdict(input.D),
      };
      const hitCount = ALL.filter(k => verdicts[k].confirmed).length;

      return { ...verdicts, hitCount, generatedAt: new Date().toISOString(), model };
    } catch (err: any) {
      console.error(`SPICED classifier error (attempt ${attempt + 1}/3):`, err?.message || err);
    }
  }

  console.error('SPICED classifier: gave up after 3 incomplete attempts');
  return null;
}

function normalizeVerdict(raw: any): SPICEDVerdict {
  if (!raw || typeof raw !== 'object') {
    return { confirmed: false, evidence: '', speaker: 'none', timestamp: '', reasoning: 'No verdict returned', confidence: 'low' };
  }
  return {
    confirmed: Boolean(raw.confirmed),
    evidence: String(raw.evidence || '').slice(0, 200),
    speaker: ['prospect', 'ae', 'none'].includes(raw.speaker) ? raw.speaker : 'none',
    timestamp: String(raw.timestamp || ''),
    reasoning: String(raw.reasoning || '').slice(0, 300),
    confidence: ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'medium',
  };
}
