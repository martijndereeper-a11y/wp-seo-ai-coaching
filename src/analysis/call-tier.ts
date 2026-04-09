/**
 * Call Tier Classifier
 *
 * Auto-classifies calls into three tiers based on effort signals:
 *   A — Kanshebber: ICP call, full effort, real opportunity
 *   B — Full effort: Complete call but low-chance prospect
 *   C — Troep: Short/incomplete, AE deliberately didn't go all-in
 *
 * AEs can override the auto-classification via the dashboard.
 */

export type CallTier = 'A' | 'B' | 'C';

export interface TierClassification {
  tier: CallTier;
  label: string;
  auto: boolean;             // true = auto-classified, false = manually overridden
  signals: string[];         // Why this tier was assigned
}

interface CallData {
  duration_seconds?: number;
  script_adherence?: number;
  question_count?: number;
  talk_ratio?: number;
  call_quality_score?: number;
  game_score?: { totalPoints?: number };
  outcome?: string;
  meeting_type?: string;
}

const TIER_LABELS: Record<CallTier, string> = {
  A: 'Kanshebber',
  B: 'Full effort',
  C: 'Troep',
};

/**
 * Auto-classify a call into a tier based on objective signals.
 * Uses duration, script coverage, question count, and game score.
 */
export function classifyCallTier(call: CallData): TierClassification {
  const dur = call.duration_seconds || 0;
  const durMin = dur / 60;
  const script = call.script_adherence || 0;
  const questions = call.question_count || 0;
  const quality = call.call_quality_score || 0;
  const gameScore = call.game_score?.totalPoints ?? 0;
  const signals: string[] = [];

  // ── C: Troep — short, incomplete, or zero-effort ──
  // Any ONE strong signal is enough
  if (durMin < 8) {
    signals.push(`Duur: ${Math.round(durMin)}min (<8min)`);
    return { tier: 'C', label: TIER_LABELS.C, auto: true, signals };
  }
  if (durMin < 12 && questions < 4) {
    signals.push(`Kort gesprek (${Math.round(durMin)}min) met weinig vragen (${questions})`);
    return { tier: 'C', label: TIER_LABELS.C, auto: true, signals };
  }
  if (script < 10 && questions < 5 && durMin < 15) {
    signals.push(`Minimaal script (${script}%), weinig vragen (${questions}), kort (${Math.round(durMin)}min)`);
    return { tier: 'C', label: TIER_LABELS.C, auto: true, signals };
  }

  // ── A: Kanshebber — high effort AND deal advancement signals ──
  // Need multiple strong signals to qualify
  let aSignals: string[] = [];

  if (durMin >= 20) aSignals.push(`Duur: ${Math.round(durMin)}min (>20min)`);
  if (script >= 30) aSignals.push(`Script: ${script}% (>30%)`);
  if (questions >= 10) aSignals.push(`Vragen: ${questions} (>10)`);
  if (gameScore >= 15) aSignals.push(`Game: ${gameScore}/70 (>15)`);
  if (quality >= 45) aSignals.push(`Quality: ${quality} (>45)`);
  if (call.outcome === 'won') aSignals.push('Outcome: won');

  // Need at least 3 strong signals for A
  if (aSignals.length >= 3) {
    return { tier: 'A', label: TIER_LABELS.A, auto: true, signals: aSignals };
  }

  // ── B: Full effort — decent call but not a top opportunity ──
  let bSignals: string[] = [];
  if (durMin >= 15) bSignals.push(`Duur: ${Math.round(durMin)}min`);
  if (script >= 15 || questions >= 6) bSignals.push(`Script ${script}%, ${questions} vragen`);
  if (quality >= 25) bSignals.push(`Quality: ${quality}`);

  if (bSignals.length >= 1) {
    return { tier: 'B', label: TIER_LABELS.B, auto: true, signals: bSignals };
  }

  // Default: C if nothing else matches
  signals.push('Geen sterke signalen gevonden');
  return { tier: 'C', label: TIER_LABELS.C, auto: true, signals };
}
