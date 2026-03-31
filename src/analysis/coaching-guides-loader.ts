/**
 * Coaching Guides Loader
 *
 * Reads all documents from the coaching-guides/ folder and parses them
 * into structured rules that the pattern detector can use.
 *
 * Supported formats: .md, .txt, .pdf
 * Each file can contain freeform text. The loader extracts actionable
 * rules by looking for patterns like:
 *   - Bullet points starting with "Do:" / "Don't:" / "Always:" / "Never:"
 *   - Sections with headers (## Discovery, ## Pricing, etc.)
 *   - Any line that reads like a directive
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUIDES_DIR = join(__dirname, '..', '..', 'coaching-guides');

export interface CoachingRule {
  source: string;       // filename it came from
  category: string;     // e.g. "discovery", "pricing", "closing", "general"
  directive: string;    // the actual rule text
  type: 'do' | 'dont';  // positive or negative instruction
}

export interface CoachingGuides {
  rules: CoachingRule[];
  rawTexts: { filename: string; content: string }[];
}

/** Categorize a rule based on keywords in the text */
function categorize(text: string): string {
  const t = text.toLowerCase();
  if (/discovery|vraag|vragen|ontdek|luister|qualify/i.test(t)) return 'discovery';
  if (/prijs|pricing|kosten|investering|budget|tarief|pakket/i.test(t)) return 'pricing';
  if (/clos|sluit|contract|onderteken|volgende stap|next step|akkoord/i.test(t)) return 'closing';
  if (/objection|bezwaar|tegenwerp|weerstand|maar.*dan/i.test(t)) return 'objections';
  if (/demo|sitemap|pling|scherm|laten zien/i.test(t)) return 'demo';
  if (/script|verhaal|story|intro|opening/i.test(t)) return 'storytelling';
  if (/follow.?up|opvolg|na.*gesprek|email|nastuur/i.test(t)) return 'follow-up';
  return 'general';
}

/** Extract rules from a text document */
function extractRules(content: string, filename: string): CoachingRule[] {
  const rules: CoachingRule[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.length < 10) continue;

    // Match directive patterns
    const doMatch = trimmed.match(/^[-*•]\s*(do|always|wel|altijd|zorg|maak|gebruik|vraag|start|eindig|noem|vertel|toon|laat)\s*:?\s*(.+)/i);
    const dontMatch = trimmed.match(/^[-*•]\s*(don'?t|never|niet|nooit|vermijd|stop|geen)\s*:?\s*(.+)/i);

    if (doMatch) {
      rules.push({ source: filename, category: categorize(doMatch[2]), directive: doMatch[2], type: 'do' });
    } else if (dontMatch) {
      rules.push({ source: filename, category: categorize(dontMatch[2]), directive: dontMatch[2], type: 'dont' });
    }

    // Also match lines that start with "Do:" or "Don't:" or "Tip:" or "Regel:"
    const labelMatch = trimmed.match(/^(Do|Don'?t|Tip|Regel|Rule|Always|Never|Wel|Niet|Altijd|Nooit)\s*:\s*(.+)/i);
    if (labelMatch) {
      const isDont = /don'?t|never|niet|nooit/i.test(labelMatch[1]);
      rules.push({ source: filename, category: categorize(labelMatch[2]), directive: labelMatch[2], type: isDont ? 'dont' : 'do' });
    }
  }

  return rules;
}

/** Load all coaching guides from the coaching-guides/ folder */
export function loadCoachingGuides(): CoachingGuides {
  if (!existsSync(GUIDES_DIR)) {
    return { rules: [], rawTexts: [] };
  }

  const files = readdirSync(GUIDES_DIR).filter(f => {
    const ext = extname(f).toLowerCase();
    return ['.md', '.txt'].includes(ext); // PDF support can be added later
  });

  const rules: CoachingRule[] = [];
  const rawTexts: { filename: string; content: string }[] = [];

  for (const file of files) {
    if (file === 'README.md') continue;
    const content = readFileSync(join(GUIDES_DIR, file), 'utf-8');
    rawTexts.push({ filename: file, content });
    rules.push(...extractRules(content, file));
  }

  return { rules, rawTexts };
}

/** Match coaching rules against detected patterns in a call */
export function matchRulesToCall(
  rules: CoachingRule[],
  aeText: string,
): { matched: CoachingRule[]; violated: CoachingRule[] } {
  const matched: CoachingRule[] = [];
  const violated: CoachingRule[] = [];
  const t = aeText.toLowerCase();

  for (const rule of rules) {
    // Extract key terms from the directive (first 3 significant words)
    const words = rule.directive.toLowerCase()
      .replace(/[^a-zà-ÿ\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 3)
      .slice(0, 3);

    if (words.length === 0) continue;

    const found = words.some(w => t.includes(w));

    if (rule.type === 'do' && found) matched.push(rule);
    if (rule.type === 'do' && !found) violated.push(rule);
    if (rule.type === 'dont' && found) violated.push(rule);
    if (rule.type === 'dont' && !found) matched.push(rule);
  }

  return { matched, violated };
}
