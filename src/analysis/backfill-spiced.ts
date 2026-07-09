/**
 * One-off SPICED backfill for the causal-analysis population.
 *
 * The routine gap-fill in run-analysis.ts is windowed to the last
 * COACHING_WINDOW_DAYS (cost control). But the call-engine feature matrix uses
 * ALL won/lost first meetings — which skew older than that window, because deals
 * take time to reach a won/lost outcome. Result: SPICED never gets computed for
 * the calls the causal engine actually analyzes.
 *
 * This script classifies SPICED for every won/lost first-meeting call that
 * doesn't have it yet, ignoring the coaching window. Run once after adding the
 * SPICED classifier; the routine gap-fill keeps recent calls current thereafter.
 *
 * Usage:
 *   npx tsx src/analysis/backfill-spiced.ts            # all missing
 *   npx tsx src/analysis/backfill-spiced.ts --limit 50 # cap for a test run
 */

import { createSupabaseClient } from '../database/supabase-client.ts';
import { parseTranscript } from './transcript-parser.ts';
import { classifySPICED } from './spiced-classifier.ts';
import { isExcludedAE } from '../config/excluded-aes.ts';

const supabase = createSupabaseClient();

const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg >= 0 ? parseInt(process.argv[limitArg + 1], 10) || Infinity : Infinity;
// --force re-classifies calls that already have a verdict (e.g. after a prompt or
// truncation-cap change makes prior verdicts stale).
const FORCE = process.argv.includes('--force');
const MIN_DURATION_SECONDS = 600;
const CONCURRENCY = 3;
const PAGE_SIZE = 1000;

async function main() {
  console.log('SPICED backfill — won/lost first meetings, no coaching-window limit\n');

  // Page all won/lost first-meeting calls (lightweight cols)
  const rows: any[] = [];
  let from = 0;
  while (true) {
    let q = supabase
      .from('ae_call_analysis')
      .select('recording_id, recorder_name, title, duration_seconds, spiced_classification, meeting_type, outcome')
      .in('outcome', ['won', 'lost'])
      .gte('duration_seconds', MIN_DURATION_SECONDS)
      .or('meeting_type.eq.first,meeting_type.is.null')
      .order('created_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    const { data: page, error } = await q;
    if (error) { console.error(`Fetch error at offset ${from}:`, error.message); break; }
    if (!page || page.length === 0) break;
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  // A row is "done" only if it has a complete Sonnet-generated verdict. Under
  // --force, re-run anything not yet done (so repeated runs converge and don't
  // redo already-fixed rows). Without --force, only fill empty verdicts.
  const isDone = (r: any) => {
    const s = r.spiced_classification;
    if (!s || typeof s !== 'object' || !(s.model || '').includes('sonnet')) return false;
    return ['S', 'P', 'I', 'C', 'D'].every(k => s[k] && typeof s[k] === 'object');
  };
  const eligible = rows
    .filter(r => !isExcludedAE(r.recorder_name))
    .filter(r => FORCE ? !isDone(r) : (!r.spiced_classification || Object.keys(r.spiced_classification as object).length === 0));

  const jobList = eligible.slice(0, LIMIT).map(r => r.recording_id);
  const rowsById = new Map(eligible.map(r => [r.recording_id, r]));

  console.log(`  ${rows.length} won/lost first meetings ≥${MIN_DURATION_SECONDS / 60}min`);
  console.log(`  ${eligible.length} missing SPICED${jobList.length < eligible.length ? ` (capped to ${jobList.length})` : ''}\n`);
  if (jobList.length === 0) { console.log('Nothing to backfill.'); return; }

  let filled = 0, skipped = 0, errors = 0, consecutiveErrors = 0, bailedOut = false, done = 0;
  const BAILOUT = 20;

  async function worker(id: string) {
    if (bailedOut) return;
    const row = rowsById.get(id);
    if (!row) return;
    try {
      // Transcript fetch can transiently time out under concurrency (big text
      // column). Retry before treating it as genuinely missing — otherwise a
      // timeout gets miscounted as "no transcript" and the call is skipped.
      let rec: any = null;
      for (let a = 0; a < 3; a++) {
        const res = await supabase.from('recordings').select('transcript_text, transcript_lang').eq('id', id).single();
        if (res.data?.transcript_text) { rec = res.data; break; }
        if (!res.error) break; // genuine empty (no error) → stop retrying
      }
      if (!rec?.transcript_text) { skipped++; return; }

      const parsed = parseTranscript(rec.transcript_text, row.recorder_name);
      const callLang = (rec.transcript_lang || 'en').toLowerCase();
      const result = await classifySPICED(
        parsed.turns, row.recorder_name, row.title || 'Untitled', row.duration_seconds || 0, callLang,
      );

      if (!result) {
        errors++;
        consecutiveErrors++;
        if (consecutiveErrors >= BAILOUT) {
          bailedOut = true;
          console.error(`\n  ❌ ${BAILOUT} consecutive failures — bailing. Check ANTHROPIC_API_KEY / credit. (${filled} filled)`);
        }
        return;
      }

      await supabase.from('ae_call_analysis').update({ spiced_classification: result }).eq('recording_id', id);
      filled++;
      consecutiveErrors = 0;
    } catch (err: any) {
      errors++;
      console.error(`  ${id}: ${err?.message || err}`);
    } finally {
      done++;
      if (done % 25 === 0 || done === jobList.length) {
        process.stdout.write(`\r  Progress: ${done}/${jobList.length} (filled: ${filled}, skipped: ${skipped}, errors: ${errors})`);
      }
    }
  }

  // Simple fixed-size pool
  let cursor = 0;
  async function runner() {
    while (cursor < jobList.length && !bailedOut) {
      const id = jobList[cursor++];
      await worker(id);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => runner()));

  console.log(`\n\nBackfill complete — filled: ${filled}, skipped (no transcript): ${skipped}, errors: ${errors}`);
  console.log('Now regenerate reports: npx tsx src/analysis/call-engine/run.ts');
}

main().catch(err => { console.error(err); process.exit(1); });
