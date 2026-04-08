/**
 * Batch Analysis Runner
 *
 * Analyzes all recordings in Supabase and stores results in ae_call_analysis
 * and ae_coaching_profiles tables.
 *
 * Usage:
 *   npm run analyze              # analyze new recordings only
 *   npm run analyze -- --full    # re-analyze everything
 */

import { createSupabaseClient } from '../database/supabase-client.ts';
import { parseTranscript, identifyAE, getProspectStats } from './transcript-parser.ts';
import { analyzeCall } from './pattern-detector.ts';
import { SCRIPT_SECTIONS } from './script-sections.ts';
import { loadCoachingGuides, matchRulesToCall } from './coaching-guides-loader.ts';
import { scoreCallPillars } from './coaching-pillars.ts';
import { generateSmartReview, type SmartReviewBenchmarks } from './smart-review.ts';
import { scoreGame } from './sales-game.ts';
import { classifyWithDealContext, classifyMeeting, type MeetingClassification } from './meeting-classifier.ts';

const supabase = createSupabaseClient();
const isFullMode = process.argv.includes('--full');

// ─── Ensure tables exist ─────────────────────────────────────────────────────

async function ensureTables() {
  // Create ae_call_analysis table
  const { error: e1 } = await supabase.rpc('exec_sql', {
    sql: `
      CREATE TABLE IF NOT EXISTS ae_call_analysis (
        id TEXT PRIMARY KEY,
        recording_id TEXT NOT NULL,
        recorder_name TEXT NOT NULL,
        outcome TEXT NOT NULL,
        title TEXT,
        deal_name TEXT,
        created_at TIMESTAMPTZ,
        duration_seconds INT,
        recording_url TEXT,
        script_adherence FLOAT DEFAULT 0,
        sections_hit INT[] DEFAULT '{}',
        sections_missed INT[] DEFAULT '{}',
        talk_ratio FLOAT DEFAULT 0,
        question_count INT DEFAULT 0,
        longest_monologue INT DEFAULT 0,
        ae_word_count INT DEFAULT 0,
        prospect_question_count INT DEFAULT 0,
        patterns JSONB DEFAULT '{}',
        highlights JSONB DEFAULT '[]',
        call_quality_score FLOAT DEFAULT 0,
        game_score JSONB DEFAULT '{}',
        analyzed_at TIMESTAMPTZ DEFAULT NOW()
      );
    `,
  }).catch(() => ({ error: { message: 'rpc not available' } }));

  // Add columns if table already exists (migration for existing installs)
  await supabase.rpc('exec_sql', {
    sql: `
      ALTER TABLE ae_call_analysis ADD COLUMN IF NOT EXISTS game_score JSONB DEFAULT '{}';
      ALTER TABLE ae_call_analysis ADD COLUMN IF NOT EXISTS meeting_type TEXT DEFAULT 'first';
      ALTER TABLE ae_call_analysis ADD COLUMN IF NOT EXISTS meeting_classification JSONB DEFAULT '{}';
    `,
  }).catch(() => {});

  // Create ae_coaching_profiles table
  const { error: e2 } = await supabase.rpc('exec_sql', {
    sql: `
      CREATE TABLE IF NOT EXISTS ae_coaching_profiles (
        recorder_name TEXT PRIMARY KEY,
        total_calls INT DEFAULT 0,
        won_calls INT DEFAULT 0,
        lost_calls INT DEFAULT 0,
        win_rate FLOAT DEFAULT 0,
        avg_duration_won FLOAT DEFAULT 0,
        avg_duration_lost FLOAT DEFAULT 0,
        avg_script_adherence FLOAT DEFAULT 0,
        avg_talk_ratio FLOAT DEFAULT 0,
        avg_question_count FLOAT DEFAULT 0,
        avg_longest_monologue FLOAT DEFAULT 0,
        avg_call_quality FLOAT DEFAULT 0,
        avg_patterns_won JSONB DEFAULT '{}',
        avg_patterns_lost JSONB DEFAULT '{}',
        avg_patterns_all JSONB DEFAULT '{}',
        top_strengths TEXT[] DEFAULT '{}',
        top_weaknesses TEXT[] DEFAULT '{}',
        coaching_recs TEXT[] DEFAULT '{}',
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `,
  }).catch(() => ({ error: { message: 'rpc not available' } }));

  // Create indexes for ae_call_analysis (critical for dashboard performance)
  await supabase.rpc('exec_sql', {
    sql: `
      CREATE INDEX IF NOT EXISTS idx_ae_call_recorder ON ae_call_analysis(recorder_name);
      CREATE INDEX IF NOT EXISTS idx_ae_call_outcome ON ae_call_analysis(outcome);
      CREATE INDEX IF NOT EXISTS idx_ae_call_created ON ae_call_analysis(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ae_call_recorder_created ON ae_call_analysis(recorder_name, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ae_call_quality ON ae_call_analysis(call_quality_score DESC);
      CREATE INDEX IF NOT EXISTS idx_ae_call_recording ON ae_call_analysis(recording_id);
      CREATE INDEX IF NOT EXISTS idx_ae_call_deal ON ae_call_analysis(deal_name);
    `,
  }).catch(() => {});

  // Create coaching_interventions table (feedback loop)
  await supabase.rpc('exec_sql', {
    sql: `
      CREATE TABLE IF NOT EXISTS coaching_interventions (
        id TEXT PRIMARY KEY,
        recorder_name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        focus_area TEXT NOT NULL,
        focus_pillar TEXT,
        description TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'dashboard',
        baseline_quality FLOAT,
        baseline_metric FLOAT,
        baseline_pillar_score FLOAT,
        followup_at TIMESTAMPTZ,
        followup_quality FLOAT,
        followup_metric FLOAT,
        followup_pillar_score FLOAT,
        calls_since INT DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_by TEXT DEFAULT 'system',
        notes TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_interventions_ae ON coaching_interventions(recorder_name);
      CREATE INDEX IF NOT EXISTS idx_interventions_status ON coaching_interventions(status);
    `,
  }).catch(() => {});

  // If RPC not available, try direct table creation won't work either.
  // Tables should be created manually in Supabase dashboard if needed.
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Trim pattern evidence to max 3 items per dimension (to keep JSONB column small) */
function trimEvidence(evidence: Record<string, unknown[]>): Record<string, unknown[]> {
  const trimmed: Record<string, unknown[]> = {};
  for (const [key, items] of Object.entries(evidence)) {
    if (Array.isArray(items) && items.length > 0) {
      trimmed[key] = items.slice(0, 3);
    }
  }
  return trimmed;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('AE Call Analysis');
  console.log(`Mode: ${isFullMode ? 'FULL (re-analyze all)' : 'INCREMENTAL (new only)'}`);
  console.log('=====================\n');

  // Get all recordings with transcripts (paginated — Supabase returns max 1000 per query)
  const recordings: any[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data: page, error } = await supabase
      .from('recordings')
      .select('id, title, recorder_name, channel_name, transcript_text, duration_seconds, created_at, url, deal_name')
      .not('transcript_text', 'is', null)
      .not('recorder_name', 'is', null)
      .range(from, from + pageSize - 1);
    if (error) { console.error('Failed to fetch recordings:', error); process.exit(1); }
    if (!page || page.length === 0) break;
    recordings.push(...page);
    if (page.length < pageSize) break;
    from += pageSize;
  }
  console.log(`Found ${recordings.length} recordings with transcripts\n`);

  // Get already-analyzed IDs (skip if full mode)
  let analyzedIds = new Set<string>();
  if (!isFullMode) {
    const { data: existing } = await supabase
      .from('ae_call_analysis')
      .select('recording_id');
    if (existing) {
      analyzedIds = new Set(existing.map(r => r.recording_id));
    }
  }

  const toAnalyze = recordings.filter(r => !analyzedIds.has(r.id));
  console.log(`Analyzing ${toAnalyze.length} recordings (${recordings.length - toAnalyze.length} already done)\n`);

  // Pre-compute team benchmarks for relative coaching context
  let teamBenchmarks: SmartReviewBenchmarks = {};
  const aeAverages = new Map<string, { avgTalkRatio: number; avgQuestions: number }>();
  {
    const { data: profiles } = await supabase
      .from('ae_coaching_profiles')
      .select('recorder_name, avg_talk_ratio, avg_question_count');
    if (profiles && profiles.length > 0) {
      const avgArr = (arr: number[]) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
      teamBenchmarks.teamAvgTalkRatio = avgArr(profiles.map(p => p.avg_talk_ratio || 0));
      teamBenchmarks.teamAvgQuestions = avgArr(profiles.map(p => p.avg_question_count || 0));
      for (const p of profiles) {
        aeAverages.set(p.recorder_name, { avgTalkRatio: p.avg_talk_ratio || 0, avgQuestions: p.avg_question_count || 0 });
      }
      console.log(`Team benchmarks: talk ${teamBenchmarks.teamAvgTalkRatio}%, questions ${teamBenchmarks.teamAvgQuestions}/call (from ${profiles.length} AEs)\n`);
    }
  }

  // Build deal grouping for meeting classification
  // Group ALL recordings (not just toAnalyze) by deal_name to detect sequences
  const dealGroups = new Map<string, string[]>(); // deal_name -> recording IDs sorted by date
  const sortedByDate = [...recordings].sort((a, b) =>
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
  for (const rec of sortedByDate) {
    const dealKey = rec.deal_name || rec.deal_id;
    if (!dealKey) continue;
    const normalized = dealKey.trim().toLowerCase();
    if (!dealGroups.has(normalized)) dealGroups.set(normalized, []);
    dealGroups.get(normalized)!.push(rec.id);
  }
  const dealsWithMultiple = Array.from(dealGroups.entries()).filter(([, ids]) => ids.length > 1).length;
  console.log(`Deal grouping: ${dealGroups.size} deals, ${dealsWithMultiple} with multiple calls\n`);

  // Analyze each recording
  const allResults: Record<string, unknown>[] = [];
  let processed = 0;

  for (const rec of toAnalyze) {
    const parsed = parseTranscript(rec.transcript_text, rec.recorder_name);
    const analysis = analyzeCall(parsed.turns, rec.recorder_name, rec.url);
    // Determine outcome: channel name, deal name pattern, or unknown
    let outcome = 'unknown';
    if (rec.channel_name === 'Closed Won Analysis') outcome = 'won';
    else if (rec.channel_name === 'Closed Lost Analysis') outcome = 'lost';
    else if (/\b(starter|basic|pro|12m|12p|24m|12 month|24 month)\b/i.test(rec.deal_name || '')) outcome = 'won';
    // Classify meeting type
    const dealKey = (rec.deal_name || rec.deal_id || '').trim().toLowerCase();
    const dealRecIds = dealGroups.get(dealKey) || [];
    const meetingClass = dealRecIds.length > 0
      ? classifyWithDealContext(rec.id, rec.title || '', parsed.turns, rec.recorder_name, dealRecIds)
      : classifyMeeting(rec.title || '', parsed.turns, rec.recorder_name);

    // Merge team + AE-specific benchmarks for relative coaching
    const aeBm = aeAverages.get(rec.recorder_name);
    const callBenchmarks: SmartReviewBenchmarks = {
      ...teamBenchmarks,
      ...(aeBm ? { aeAvgTalkRatio: aeBm.avgTalkRatio, aeAvgQuestions: aeBm.avgQuestions } : {}),
    };
    const smartReview = generateSmartReview(
      parsed.turns,
      rec.recorder_name,
      analysis,
      Math.round(rec.duration_seconds || 0),
      callBenchmarks,
    );

    const row = {
      id: `analysis_${rec.id}`,
      recording_id: rec.id,
      recorder_name: rec.recorder_name,
      outcome,
      title: rec.title,
      deal_name: rec.deal_name,
      created_at: rec.created_at,
      duration_seconds: Math.round(rec.duration_seconds || 0),
      recording_url: rec.url,
      script_adherence: analysis.scriptAdherence,
      sections_hit: analysis.sectionsHit,
      sections_missed: analysis.sectionsMissed,
      talk_ratio: analysis.talkRatio,
      question_count: analysis.questionCount,
      longest_monologue: analysis.longestMonologue,
      ae_word_count: analysis.aeWordCount,
      prospect_question_count: analysis.prospectQuestionCount,
      patterns: analysis.patterns,
      highlights: analysis.highlights,
      prospect_engagement: analysis.prospectEngagement || {},
      call_verdict: analysis.callVerdict || [],
      meeting_type: meetingClass.type,
      meeting_classification: meetingClass,
      call_quality_score: computeCallQualityScore(analysis, meetingClass.type),
      pattern_evidence: trimEvidence(analysis.patternEvidence || {}),
      smart_review: smartReview,
      pillar_scores: scoreCallPillars(
        analysis.talkRatio, analysis.questionCount, analysis.patterns as Record<string, number>,
        analysis.highlights, analysis.callVerdict, analysis.sectionsHit,
        analysis.prospectEngagement, smartReview, meetingClass.type,
      ),
      game_score: scoreGame(parsed.turns, rec.recorder_name, outcome),
      analyzed_at: new Date().toISOString(),
    };

    allResults.push(row);
    processed++;
    if (processed % 25 === 0) console.log(`  Progress: ${processed}/${toAnalyze.length}`);
  }

  // Upsert analysis results in batches (with retry)
  if (allResults.length > 0) {
    for (let i = 0; i < allResults.length; i += 25) {
      const batch = allResults.slice(i, i + 25);
      let retries = 3;
      while (retries > 0) {
        const { error: upsertError } = await supabase
          .from('ae_call_analysis')
          .upsert(batch, { onConflict: 'id' });
        if (!upsertError) break;
        retries--;
        if (retries > 0) {
          console.warn(`Batch ${i} failed, retrying in 2s (${retries} left): ${upsertError.message}`);
          await new Promise(r => setTimeout(r, 2000));
        } else {
          console.error(`Batch ${i} failed permanently: ${upsertError.message}`);
        }
      }
    }
    console.log(`\nStored ${allResults.length} call analyses`);
  }

  // Build coaching profiles
  console.log('\nBuilding coaching profiles...');
  await buildCoachingProfiles();

  console.log('\nDone!');
}

// ─── Coaching Profiles ───────────────────────────────────────────────────────

async function buildCoachingProfiles() {
  // Paginated fetch — Supabase returns max 1000 per query
  const analyses: any[] = [];
  let from = 0;
  while (true) {
    const { data: page, error } = await supabase
      .from('ae_call_analysis')
      .select('recorder_name, outcome, patterns, call_quality_score, talk_ratio, question_count, script_adherence, prospect_engagement, highlights, duration_seconds, longest_monologue')
      .range(from, from + 999);
    if (error) { console.error('Failed to fetch analyses:', error); return; }
    if (!page || page.length === 0) break;
    analyses.push(...page);
    if (page.length < 1000) break;
    from += 1000;
  }
  if (analyses.length === 0) { console.error('No analyses found'); return; }
  console.log(`  Loaded ${analyses.length} analyses for profile building`);

  // Group by AE
  const byAE = new Map<string, typeof analyses>();
  for (const a of analyses) {
    const name = a.recorder_name;
    if (!byAE.has(name)) byAE.set(name, []);
    byAE.get(name)!.push(a);
  }

  const profiles: Record<string, unknown>[] = [];

  // Calculate team-wide averages for comparison (across ALL calls, not just won)
  const teamAvgPatternsAll = avgPatterns(analyses.map(a => a.patterns));

  for (const [name, calls] of byAE) {
    if (calls.length < 3) continue;

    const wonCalls = calls.filter(c => c.outcome === 'won');
    const lostCalls = calls.filter(c => c.outcome === 'lost');

    const wonPatterns = avgPatterns(wonCalls.map(c => c.patterns));
    const lostPatterns = avgPatterns(lostCalls.map(c => c.patterns));
    const allPatterns = avgPatterns(calls.map(c => c.patterns));

    // Compute call quality scores for each call (in case not yet stored)
    const callQualityScores = calls.map(c => c.call_quality_score || computeCallQualityScore(c));
    const avgCallQuality = Math.round(avg(callQualityScores));

    // Identify strengths/gaps by comparing AE's ALL-call patterns to team averages
    const strengths: string[] = [];
    const weaknesses: string[] = [];
    const recs: string[] = [];

    const dimensionLabels: Record<string, string> = {
      marketContext: 'Market context setting',
      contentEngine: 'Content engine explanation',
      roiReframe: 'ROI reframing',
      humor: 'Humor & rapport',
      theirBusiness: 'Prospect business focus',
      checkIn: 'Pace check-ins',
      opinionAsk: 'Opinion-asking',
      assumptiveClose: 'Assumptive closing',
      contract: 'Close language',
      urgency: 'Urgency creation',
      personalStory: 'Personal stories',
      priceAnchor: 'Price anchoring',
      vsAgency: 'Agency differentiation',
      research: 'Pre-call research',
      directness: 'Directness',
      activeListening: 'Active listening',
    };

    for (const [dim, label] of Object.entries(dimensionLabels)) {
      const aeVal = allPatterns[dim] || 0;
      const teamVal = teamAvgPatternsAll[dim] || 0;
      const diff = aeVal - teamVal;
      if (diff > 0.5) strengths.push(`${label} (${aeVal.toFixed(1)} vs ${teamVal.toFixed(1)} team avg)`);
      if (diff < -0.5) weaknesses.push(`${label} (${aeVal.toFixed(1)} vs ${teamVal.toFixed(1)} team avg)`);
    }

    // Generate coaching recommendations based on quality metrics
    const avgTalkRatio = avg(calls.map(c => c.talk_ratio));
    const avgQuestions = avg(calls.map(c => c.question_count));
    const avgScript = avg(calls.map(c => c.script_adherence));

    if (avgTalkRatio > 60) recs.push(`Talk ratio at ${avgTalkRatio}% — aim for 55% or less. Let the prospect talk more.`);
    if (avgQuestions < 18) recs.push(`Only ${avgQuestions} questions/call — top performers ask 22+. Prepare more discovery questions.`);
    if ((allPatterns.contract || 0) < 1) recs.push('Low contract/close language across calls. Practice assumptive closes.');
    if ((allPatterns.contentEngine || 0) < 10) recs.push('Content engine explanation below team avg. Go deeper on how the product works.');
    if ((allPatterns.roiReframe || 0) < 0.5) recs.push('Almost no ROI reframing. Use "investering" instead of "kosten".');
    if (avgCallQuality < 50) recs.push(`Call quality score at ${avgCallQuality} — focus on talk balance, discovery questions, and script coverage.`);

    profiles.push({
      recorder_name: name,
      total_calls: calls.length,
      won_calls: wonCalls.length,
      lost_calls: lostCalls.length,
      win_rate: Math.round(wonCalls.length / calls.length * 100),
      avg_duration_won: wonCalls.length > 0 ? Math.round(avg(wonCalls.map(c => c.duration_seconds || 0)) / 60) : 0,
      avg_duration_lost: lostCalls.length > 0 ? Math.round(avg(lostCalls.map(c => c.duration_seconds || 0)) / 60) : 0,
      avg_script_adherence: Math.round(avgScript),
      avg_talk_ratio: Math.round(avgTalkRatio),
      avg_question_count: Math.round(avgQuestions),
      avg_longest_monologue: Math.round(avg(calls.map(c => c.longest_monologue))),
      avg_call_quality: avgCallQuality,
      avg_patterns_won: wonPatterns,
      avg_patterns_lost: lostPatterns,
      avg_patterns_all: allPatterns,
      top_strengths: strengths.slice(0, 5),
      top_weaknesses: weaknesses.slice(0, 5),
      coaching_recs: recs.slice(0, 5),
      updated_at: new Date().toISOString(),
    });
  }

  // Upsert profiles
  if (profiles.length > 0) {
    const { error: upsertError } = await supabase
      .from('ae_coaching_profiles')
      .upsert(profiles, { onConflict: 'recorder_name' });
    if (upsertError) {
      console.error('Profile upsert error:', upsertError.message);
    } else {
      console.log(`Updated ${profiles.length} coaching profiles`);
    }
  }
}

function computeCallQualityScore(analysis: Record<string, any>, meetingType: string = 'first'): number {
  const isFollowUp = meetingType === 'follow-up';
  const talkRatio = analysis.talkRatio || analysis.talk_ratio || 50;
  const qCount = analysis.questionCount || analysis.question_count || 0;
  const scriptAdh = analysis.scriptAdherence || analysis.script_adherence || 0;
  const pe = analysis.prospectEngagement || analysis.prospect_engagement || {};
  const buying = pe.buyingSignals || 0;
  const engagement = pe.engagementIndicators || 0;
  const redFlags = pe.redFlags || 0;
  const netEngagement = buying + engagement - redFlags;
  const highlights = analysis.highlights || [];
  const coachableCount = Array.isArray(highlights) ? highlights.filter((h: any) => h.type === 'coachable').length : 0;
  const patterns = analysis.patterns || analysis.pattern || {};

  if (isFollowUp) {
    // ── Follow-up scoring: advancement > discovery, script less important ──
    //
    // Follow-ups should: advance the deal, handle objections, close or set hard next step.
    // Discovery is lighter (already done), full script isn't expected.

    // Talk ratio (15 pts, lower weight — follow-ups can be more AE-led)
    const talkDiff = Math.abs(talkRatio - 55); // ideal shifts to 55% (AE drives proposal)
    const talkPts = Math.max(0, 15 - talkDiff * 0.6);

    // Questions (10 pts, lower target — fewer but more pointed questions)
    const qPts = Math.min(10, Math.round((qCount / 12) * 10));

    // Advancement (25 pts, heavily weighted — this is the point of follow-ups)
    let advPts = 0;
    advPts += Math.min(8, (patterns.contract || 0) * 4);          // close language
    advPts += Math.min(8, (patterns.assumptiveClose || 0) * 4);   // assumptive close
    advPts += Math.min(5, (patterns.urgency || 0) * 2);           // urgency
    advPts += Math.min(4, (patterns.priceAnchor || 0) * 2);       // price anchoring
    advPts = Math.min(25, advPts);

    // Objection handling (20 pts — follow-ups surface objections)
    let objPts = 10; // base
    objPts += Math.min(5, (patterns.roiReframe || 0) * 3);
    objPts += Math.min(5, (patterns.challenging || 0) * 3);
    const accepted = Array.isArray(highlights) && highlights.some((h: any) => h.category === 'Accepted Think-It-Over');
    if (accepted) objPts -= 5;
    objPts = Math.max(0, Math.min(20, objPts));

    // Engagement (15 pts, same)
    const engPts = Math.max(0, Math.min(15, Math.round((netEngagement / 8) * 15)));

    // Discipline (15 pts)
    const coachPts = Math.max(0, 15 - coachableCount * 2);

    return Math.round(Math.max(0, Math.min(100, talkPts + qPts + advPts + objPts + engPts + coachPts)));
  }

  // ── First meeting scoring: discovery + gap creation, original weights ──

  // Talk ratio: closer to 50% = better, max 25 pts
  const talkDiff = Math.abs(talkRatio - 50);
  const talkPts = Math.max(0, 25 - talkDiff);

  // Question count: 22+ = full marks, max 20 pts
  const qPts = Math.min(20, Math.round((qCount / 22) * 20));

  // Script adherence: already 0-100, scale to max 20 pts
  const scriptPts = Math.round((scriptAdh / 100) * 20);

  // Prospect engagement net score: max 15 pts
  const engPts = Math.max(0, Math.min(15, Math.round((netEngagement / 8) * 15)));

  // Coachable moments: fewer = better, max 20 pts
  const coachPts = Math.max(0, 20 - coachableCount * 2);

  return Math.round(Math.max(0, Math.min(100, talkPts + qPts + scriptPts + engPts + coachPts)));
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function avgPatterns(patternList: Record<string, number>[]): Record<string, number> {
  if (patternList.length === 0) return {};
  const totals: Record<string, number> = {};
  for (const p of patternList) {
    if (!p) continue;
    for (const [k, v] of Object.entries(p)) {
      totals[k] = (totals[k] || 0) + (v || 0);
    }
  }
  const result: Record<string, number> = {};
  for (const [k, v] of Object.entries(totals)) {
    result[k] = +(v / patternList.length).toFixed(1);
  }
  return result;
}

main().catch(console.error);
