/**
 * Excluded AEs — not shown in V1 dashboard, skipped in LLM backfill.
 *
 * Use for former AEs, leadership, or people whose calls shouldn't count
 * toward coaching metrics. Match is case-insensitive on `recorder_name`.
 *
 * Applied in:
 *   - run-analysis.ts fillLLMGaps (skips these AEs in LLM pre-compute)
 *   - run-analysis.ts refreshAEDeepAnalyses (skips deep analysis refresh)
 *   - api/routes/team.ts /v1/team (filters team list)
 *   - api/routes/team.ts /v1/ae/:name (returns 404 for excluded AEs)
 */

export const EXCLUDED_AES = new Set([
  'sam sökmen',
  'duco zitman',
  'pontus bäckman',
  'koen de groot',
  'martijn de reeper',
  'guido katwijk',
  'marc boels',
  'arshiya maskan',
  'pierre nuytten',
  'maartje kat',
  'thomas alkema',
  'sofia gettler',
]);

export function isExcludedAE(name: string | null | undefined): boolean {
  if (!name) return false;
  return EXCLUDED_AES.has(name.trim().toLowerCase());
}
