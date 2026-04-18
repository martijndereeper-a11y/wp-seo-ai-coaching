/**
 * Coaching data window.
 *
 * The V1 coaching dashboard and LLM backfill only consider calls within this
 * rolling window. Rationale:
 *   - Coaching is about recent behavior; stale patterns don't help reps improve.
 *   - AE deep analyses use most-recent-first anyway.
 *   - Cost scales linearly with call volume — a tight window keeps ongoing
 *     ops ~$15/month vs ~$40+ for unlimited.
 *
 * Exceptions (the window does NOT apply):
 *   - Paste-link endpoint: a lead can still surface any specific old call on demand.
 *   - Classic dashboard endpoints: untouched so historical views still work.
 *
 * Change this one constant to widen/tighten the window everywhere.
 */
export const COACHING_WINDOW_DAYS = 60;

/** Returns an ISO timestamp representing the cutoff (now - COACHING_WINDOW_DAYS). */
export function coachingWindowCutoff(): string {
  return new Date(Date.now() - COACHING_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
}
