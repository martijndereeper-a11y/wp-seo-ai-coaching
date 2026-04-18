/**
 * VBAT Classifier — LLM-based qualification tracking
 *
 * Marc's VBAT framework:
 *   V = Value       — prospect articulates in their own words why they need this
 *   B = Budget      — explicit discussion of spend / willingness to invest
 *   A = Authority   — decision-maker identified with confirmed mandate
 *   T = Timeline    — concrete decision date committed to
 *
 * Expert-level extensions (from the Sales Game):
 *   E = Good News Show     — incentive traded for a dated commitment
 *   F = Defensive Line     — urgency push → prospect resistance → AE handles it
 *
 * Why LLM, not regex:
 *   The regex version in sales-game.ts is brittle — it misses paraphrases,
 *   dialect, and context. For adoption, AEs need verdicts they can trust and
 *   verify against the transcript. Every verdict returns a direct quote with
 *   timestamp so the AE can jump to that moment and confirm it themselves.
 *
 * Output is cached per call in ae_call_analysis.vbat_classification.
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

export type VBATKey = 'V' | 'B' | 'A' | 'T' | 'E' | 'F';

export interface VBATVerdict {
  confirmed: boolean;
  evidence: string;          // direct quote from the transcript (prospect or AE)
  speaker: 'prospect' | 'ae' | 'none';
  timestamp: string;          // MM:SS — empty if confirmed=false and no attempt made
  reasoning: string;          // one-line explanation of the verdict
  confidence: 'high' | 'medium' | 'low';
}

export interface VBATClassification {
  V: VBATVerdict;
  B: VBATVerdict;
  A: VBATVerdict;
  T: VBATVerdict;
  E: VBATVerdict;
  F: VBATVerdict;
  hitCount: number;           // out of 4 (V/B/A/T only — E/F are expert-level)
  generatedAt: string;
  model: string;
}

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

const SYSTEM_PROMPT = `You are a sales qualification analyst for WP SEO AI, an AI-native SEO/GEO platform selling to Dutch SMB founders. You evaluate sales calls against Marc's VBAT qualification framework plus two expert-level actions from the Sales Game playbook.

You return verdicts as structured JSON via the classify_call tool. Every verdict must cite a direct quote from the transcript (prospect's or AE's exact words) with its timestamp, so the AE can verify the verdict themselves.

## The six dimensions

**V — Value Confirmed**
The prospect articulates in THEIR OWN WORDS why they need this product. Not one-word agreement ("ja", "top"). They must either:
(a) explain a concrete reason ("omdat we...", "want we...", "we lopen vast op..."), OR
(b) express desire to act ("willen we graag starten", "dit hebben we echt nodig"), OR
(c) give a substantive (>30 words) positive answer that references the product's value.
Evidence must be from the PROSPECT.

**B — Budget Discussed**
Explicit budget conversation took place. Either:
(a) AE asked about budget/current spend/investment capacity AND prospect gave a concrete response (amount, "past binnen budget", "kunnen we doen"), OR
(b) prospect proactively mentioned specific amounts or current spend on similar solutions.
A prospect asking "wat kost het?" is NOT budget confirmation — that's a question, not a signal of willingness.
Evidence must show the exchange — prefer the prospect's response.

**A — Authority Confirmed**
The decision-maker is identified with mandate. Either:
(a) AE asked who decides AND prospect confirmed themselves ("ik beslis", "dat ben ik", "ik ben eigenaar"), OR
(b) prospect self-identified as the decision-maker unprompted.
"Ik moet even met mijn compagnon overleggen" = NOT confirmed — this is a committee signal.
Evidence must be from the PROSPECT.

**T — Timeline Set**
A concrete decision date within roughly one week was committed to by the PROSPECT. Vague timeframes ("over een paar weken", "na de zomer", "we laten weten") = NOT confirmed. Must be specific ("deze week", "voor vrijdag", "maandag", exact date).
Evidence must be the prospect committing to the date.

**E — Good News Show (expert-level)**
The AE offered an incentive (extra blog, discount, free setup, bonus) AND received a dated commitment back. Both elements are required:
(1) AE offers something concrete
(2) Prospect commits to a specific date in exchange
If AE gave away value without getting a date in return → NOT confirmed.

**F — Defensive Line (expert-level)**
Three-step sequence: (1) AE pushes urgency on a tight timeline, (2) prospect resists ("moet nadenken", "te snel", "niet deze week"), (3) AE handles the resistance constructively (probes, offers options, doesn't cave). If prospect agreed immediately → NOT tested. If AE folded after pushback → NOT confirmed.

## Rules

- Only transcript evidence counts. Never invent or paraphrase — use verbatim quotes.
- Each verdict must include: confirmed (bool), evidence (verbatim quote, max 150 chars), speaker, timestamp (MM:SS), reasoning (one line), confidence (high/medium/low).
- If a dimension was never addressed at all, set confirmed=false, evidence="", speaker="none", timestamp="", and reasoning should say the AE never attempted it.
- Confidence calibration: "high" = clear, unambiguous. "medium" = present but imperfect (e.g., value referenced but not enthusiastically). "low" = borderline, could go either way.
- Be strict. False positives destroy AE trust. When in doubt, mark NOT confirmed and explain why.
- Respond in Dutch for the "reasoning" field when the call is in Dutch; otherwise match the call's language.`;

// Anthropic tool schema for structured output
const CLASSIFY_TOOL = {
  name: 'classify_call',
  description: 'Return VBAT + expert-level classification for a sales call',
  input_schema: {
    type: 'object',
    properties: {
      V: verdictSchema('Value confirmed'),
      B: verdictSchema('Budget discussed'),
      A: verdictSchema('Authority confirmed'),
      T: verdictSchema('Timeline set'),
      E: verdictSchema('Good News Show — incentive traded for dated commitment'),
      F: verdictSchema('Defensive Line — urgency → resistance → handling'),
    },
    required: ['V', 'B', 'A', 'T', 'E', 'F'],
  },
};

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

// ─── Main classifier ────────────────────────────────────────────────────────

/**
 * Default model for VBAT classification.
 *
 * Haiku 4.5 is the right fit: VBAT is structured extraction (pick a verdict,
 * cite a verbatim quote, give a reason). The Sonnet-vs-Haiku delta on this task
 * is negligible, and Haiku is ~3x cheaper on input + output, which matters when
 * we run this on thousands of historical calls.
 */
export const VBAT_DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

export async function classifyVBAT(
  turns: TranscriptTurn[],
  recorderName: string,
  callTitle: string,
  durationSeconds: number,
  model: string = VBAT_DEFAULT_MODEL,
): Promise<VBATClassification | null> {
  const apiKey = loadApiKey();
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set — skipping VBAT classification');
    return null;
  }
  if (turns.length === 0) return null;

  const AnthropicClass = await getAnthropic();
  const client = new AnthropicClass({ apiKey });

  // Trim transcript to ~25k chars to leave room for prompt + reasoning
  const fullTranscript = buildTranscriptForPrompt(turns, recorderName);
  const transcript = fullTranscript.length > 25000
    ? fullTranscript.slice(0, 25000) + '\n[... transcript truncated ...]'
    : fullTranscript;

  const userMessage = `Call: ${callTitle}
AE: ${recorderName}
Duration: ${Math.round(durationSeconds / 60)} minutes

Transcript:
${transcript}

Classify this call on all six dimensions (V/B/A/T/E/F). Cite direct quotes and timestamps. Be strict — false positives destroy AE trust.`;

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 2000,
      // Cache the static system prompt (~2k tokens of framework definition) — reused on every call.
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: [CLASSIFY_TOOL],
      tool_choice: { type: 'tool', name: 'classify_call' },
      messages: [{ role: 'user', content: userMessage }],
    });

    const toolUse = response.content.find((b: any) => b.type === 'tool_use');
    if (!toolUse || !toolUse.input) {
      console.error('VBAT classifier: no tool_use block returned');
      return null;
    }

    const input = toolUse.input as Record<string, VBATVerdict>;
    const verdicts = {
      V: normalizeVerdict(input.V),
      B: normalizeVerdict(input.B),
      A: normalizeVerdict(input.A),
      T: normalizeVerdict(input.T),
      E: normalizeVerdict(input.E),
      F: normalizeVerdict(input.F),
    };

    const hitCount = ['V', 'B', 'A', 'T'].filter(k => verdicts[k as VBATKey].confirmed).length;

    return {
      ...verdicts,
      hitCount,
      generatedAt: new Date().toISOString(),
      model,
    };
  } catch (err: any) {
    console.error('VBAT classifier error:', err?.message || err);
    return null;
  }
}

function normalizeVerdict(raw: any): VBATVerdict {
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
