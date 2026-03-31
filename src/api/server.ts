/**
 * Coaching Dashboard API
 *
 * Lightweight Hono server exposing analysis data from Supabase.
 * Serves the dashboard frontend and JSON API endpoints.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { createSupabaseClient } from '../database/supabase-client.ts';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const supabase = createSupabaseClient();
const app = new Hono();

app.use('*', cors());

// ─── Call Quality Score ───────────────────────────────────────────────────────

function computeCallQualityScore(analysis: Record<string, any>): number {
  const talkRatio = analysis.talkRatio || analysis.talk_ratio || 50;
  const talkPts = Math.max(0, 25 - Math.abs(talkRatio - 50));
  const qCount = analysis.questionCount || analysis.question_count || 0;
  const qPts = Math.min(20, Math.round((qCount / 22) * 20));
  const scriptAdh = analysis.scriptAdherence || analysis.script_adherence || 0;
  const scriptPts = Math.round((scriptAdh / 100) * 20);
  const pe = analysis.prospectEngagement || analysis.prospect_engagement || {};
  const netEngagement = (pe.buyingSignals || 0) + (pe.engagementIndicators || 0) - (pe.redFlags || 0);
  const engPts = Math.max(0, Math.min(15, Math.round((netEngagement / 8) * 15)));
  const highlights = analysis.highlights || [];
  const coachableCount = Array.isArray(highlights) ? highlights.filter((h: any) => h.type === 'coachable').length : 0;
  const coachPts = Math.max(0, 20 - coachableCount * 4);
  return Math.round(Math.max(0, Math.min(100, talkPts + qPts + scriptPts + engPts + coachPts)));
}

// ─── API Routes ──────────────────────────────────────────────────────────────

// Team overview — all AE profiles
app.get('/api/team', async (c) => {
  const { data, error } = await supabase
    .from('ae_coaching_profiles')
    .select('*')
    .order('avg_call_quality', { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

// Team benchmarks
app.get('/api/team/benchmarks', async (c) => {
  const { data, error } = await supabase
    .from('ae_coaching_profiles')
    .select('*');
  if (error) return c.json({ error: error.message }, 500);
  if (!data || data.length === 0) return c.json({});

  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const topPerformers = data.filter(d => (d.avg_call_quality || 0) > 65);

  return c.json({
    teamAvg: {
      callQuality: Math.round(avg(data.map(d => d.avg_call_quality || 0))),
      winRate: Math.round(avg(data.map(d => d.win_rate))),
      talkRatio: Math.round(avg(data.map(d => d.avg_talk_ratio))),
      questionCount: Math.round(avg(data.map(d => d.avg_question_count))),
      scriptAdherence: Math.round(avg(data.map(d => d.avg_script_adherence))),
    },
    topPerformerAvg: {
      callQuality: Math.round(avg(topPerformers.map(d => d.avg_call_quality || 0))),
      winRate: Math.round(avg(topPerformers.map(d => d.win_rate))),
      talkRatio: Math.round(avg(topPerformers.map(d => d.avg_talk_ratio))),
      questionCount: Math.round(avg(topPerformers.map(d => d.avg_question_count))),
      scriptAdherence: Math.round(avg(topPerformers.map(d => d.avg_script_adherence))),
    },
  });
});

// Single AE profile
app.get('/api/ae/:name', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  const { data, error } = await supabase
    .from('ae_coaching_profiles')
    .select('*')
    .eq('recorder_name', name)
    .single();
  if (error) return c.json({ error: error.message }, 404);
  return c.json(data);
});

// AE's calls — with analysis data
app.get('/api/ae/:name/calls', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  const limit = parseInt(c.req.query('limit') || '100');
  const offset = parseInt(c.req.query('offset') || '0');

  const { data, error } = await supabase
    .from('ae_call_analysis')
    .select('*')
    .eq('recorder_name', name)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

// AE progression — rolling metrics over time (for trend charts)
app.get('/api/ae/:name/trend', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  const { data, error } = await supabase
    .from('ae_call_analysis')
    .select('created_at, outcome, talk_ratio, question_count, script_adherence, call_quality_score, patterns')
    .eq('recorder_name', name)
    .order('created_at', { ascending: true });
  if (error) return c.json({ error: error.message }, 500);
  if (!data || data.length < 3) return c.json([]);

  // Compute rolling 5-call averages
  const windowSize = 5;
  const points = [];
  for (let i = windowSize - 1; i < data.length; i++) {
    const window = data.slice(i - windowSize + 1, i + 1);
    const wins = window.filter(d => d.outcome === 'won').length;
    const avgTalk = Math.round(window.reduce((s, d) => s + (d.talk_ratio || 0), 0) / windowSize);
    const avgQs = Math.round(window.reduce((s, d) => s + (d.question_count || 0), 0) / windowSize);
    const avgScript = Math.round(window.reduce((s, d) => s + (d.script_adherence || 0), 0) / windowSize);
    const avgQuality = Math.round(window.reduce((s, d) => s + (d.call_quality_score || 0), 0) / windowSize);
    points.push({
      date: data[i].created_at?.slice(0, 10) || '',
      callIndex: i + 1,
      winRate: Math.round(wins / windowSize * 100),
      talkRatio: avgTalk,
      questionCount: avgQs,
      scriptAdherence: avgScript,
      callQuality: avgQuality,
    });
  }
  return c.json(points);
});

// Team-wide insights — correlations, streaks, learning moments
app.get('/api/team/insights', async (c) => {
  const { data, error } = await supabase
    .from('ae_call_analysis')
    .select('recording_id, recorder_name, outcome, talk_ratio, question_count, duration_seconds, script_adherence, call_quality_score, sections_hit, patterns, highlights, recording_url, title, created_at')
    .order('created_at', { ascending: true });
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({});

  const avg = (arr: number[]) => arr.length ? arr.reduce((a,b) => a + b, 0) / arr.length : 0;

  // Compute median quality score to split high vs low quality calls
  const qualityScores = data.map(d => d.call_quality_score || 0).sort((a, b) => a - b);
  const medianQuality = qualityScores.length ? qualityScores[Math.floor(qualityScores.length / 2)] : 50;
  const highQuality = data.filter(d => (d.call_quality_score || 0) > medianQuality);
  const lowQuality = data.filter(d => (d.call_quality_score || 0) <= medianQuality);

  // Behavior correlations — what correlates with high call quality scores
  const dims = ['contentEngine','marketContext','roiReframe','humor','urgency','contract','checkIn','theirBusiness','activeListening','personalStory','vsAgency','directness','opinionAsk','research','priceAnchor','assumptiveClose'];
  const dimLabels: Record<string,string> = {contentEngine:'Product explanation',marketContext:'Market context',roiReframe:'ROI reframing',humor:'Humor',urgency:'Urgency',contract:'Close language',checkIn:'Check-ins',theirBusiness:'Their business',activeListening:'Active listening',personalStory:'Personal stories',vsAgency:'vs Agencies',directness:'Directness',opinionAsk:'Asking opinions',research:'Research shown',priceAnchor:'Price anchoring',assumptiveClose:'Assumptive close'};

  const correlations = dims.map(d => {
    const highAvg = avg(highQuality.map(c => (c.patterns as Record<string,number>)?.[d] || 0));
    const lowAvg = avg(lowQuality.map(c => (c.patterns as Record<string,number>)?.[d] || 0));
    const allAvg = avg(data.map(c => (c.patterns as Record<string,number>)?.[d] || 0));
    const above = data.filter(c => ((c.patterns as Record<string,number>)?.[d] || 0) > allAvg);
    const below = data.filter(c => ((c.patterns as Record<string,number>)?.[d] || 0) <= allAvg);
    const qAbove = above.length ? Math.round(avg(above.map(c => c.call_quality_score || 0))) : 0;
    const qBelow = below.length ? Math.round(avg(below.map(c => c.call_quality_score || 0))) : 0;
    return { dim: d, label: dimLabels[d] || d, highQualityAvg: +highAvg.toFixed(1), lowQualityAvg: +lowAvg.toFixed(1), lift: qAbove - qBelow };
  }).sort((a, b) => b.lift - a.lift);

  // Talk ratio buckets — avg quality score per bucket
  const talkBuckets = [
    { label: '<40%', min: 0, max: 40 },
    { label: '40-50%', min: 40, max: 50 },
    { label: '50-60%', min: 50, max: 60 },
    { label: '60-70%', min: 60, max: 70 },
    { label: '70%+', min: 70, max: 200 },
  ].map(b => {
    const calls = data.filter(c => c.talk_ratio >= b.min && c.talk_ratio < b.max);
    return { label: b.label, count: calls.length, avgQuality: calls.length ? Math.round(avg(calls.map(c => c.call_quality_score || 0))) : 0 };
  });

  // Quality trends per AE — detect declining quality
  const byAE = new Map<string, typeof data>();
  for (const d of data) {
    if (!byAE.has(d.recorder_name)) byAE.set(d.recorder_name, []);
    byAE.get(d.recorder_name)!.push(d);
  }
  const qualityAlerts: { name: string; trend: string; recentAvg: number; overallAvg: number; totalCalls: number }[] = [];
  for (const [name, calls] of byAE) {
    if (calls.length < 5) continue;
    const sorted = [...calls].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    const recent5 = sorted.slice(0, 5);
    const recentAvg = Math.round(avg(recent5.map(c => c.call_quality_score || 0)));
    const overallAvg = Math.round(avg(calls.map(c => c.call_quality_score || 0)));
    if (recentAvg < overallAvg - 8) {
      qualityAlerts.push({ name, trend: 'declining', recentAvg, overallAvg, totalCalls: calls.length });
    } else if (recentAvg > overallAvg + 8) {
      qualityAlerts.push({ name, trend: 'improving', recentAvg, overallAvg, totalCalls: calls.length });
    }
  }
  qualityAlerts.sort((a, b) => (a.trend === 'declining' ? 0 : 1) - (b.trend === 'declining' ? 0 : 1) || (a.recentAvg - b.recentAvg));

  // Top performer moments (learn from the best — based on quality score)
  const learnMoments: { ae: string; avgQuality: number; moments: unknown[] }[] = [];
  for (const [name, calls] of byAE) {
    const aeAvgQuality = avg(calls.map(c => c.call_quality_score || 0));
    if (aeAvgQuality < 60 || calls.length < 5) continue;
    const bestCalls = [...calls].sort((a, b) => (b.call_quality_score || 0) - (a.call_quality_score || 0));
    const allHighlights: { ts: number; display: string; category: string; excerpt: string; url: string; callTitle: string }[] = [];
    for (const c of bestCalls.slice(0, 6)) {
      for (const h of ((c.highlights as any[]) || []).filter((h: any) => h.type === 'strength')) {
        allHighlights.push({ ts: h.timestampSeconds, display: h.timestampDisplay, category: h.category, excerpt: h.excerpt, url: c.recording_url || '', callTitle: c.title || '' });
      }
    }
    const seen = new Set<string>();
    const best = [];
    for (const h of allHighlights) {
      if (!seen.has(h.category)) { best.push(h); seen.add(h.category); }
      if (best.length >= 4) break;
    }
    if (best.length > 0) learnMoments.push({ ae: name, avgQuality: Math.round(aeAvgQuality), moments: best });
  }

  const avgTeamQuality = Math.round(avg(data.map(d => d.call_quality_score || 0)));

  return c.json({ correlations, talkBuckets, qualityAlerts, learnMoments, totalCalls: data.length, avgTeamQuality });
});

// Live analyze a Claap recording by URL or ID
app.post('/api/analyze-call', async (c) => {
  const body = await c.req.json() as { url?: string; recordingId?: string };
  let recordingId = body.recordingId || '';

  // Extract recording ID from Claap URL
  // Format: https://app.claap.io/{workspace}/slug-c-{WORKSPACE_ID}-{RECORDING_ID}
  // The recording ID is always the LAST segment after the final hyphen
  if (body.url) {
    const match = body.url.match(/-c-[A-Za-z0-9_]+-([A-Za-z0-9_]+)$/);
    if (match) recordingId = match[1];
    // Fallback: last path segment after last hyphen
    if (!recordingId) {
      const path = body.url.split('/').pop() || '';
      const lastHyphen = path.lastIndexOf('-');
      if (lastHyphen > 0) recordingId = path.slice(lastHyphen + 1);
    }
  }

  if (!recordingId) {
    return c.json({ error: 'Could not extract recording ID from URL. Paste a Claap recording URL.' }, 400);
  }

  // Import analysis tools
  const { parseTranscript } = await import('../analysis/transcript-parser.ts');
  const { analyzeCall } = await import('../analysis/pattern-detector.ts');

  // First check: is this recording already analyzed in Supabase?
  const { data: existingAnalysis } = await supabase
    .from('ae_call_analysis')
    .select('*')
    .eq('recording_id', recordingId)
    .single();

  if (existingAnalysis) {
    // Already analyzed — build response from stored data without hitting Claap
    const { data: teamCalls } = await supabase.from('ae_call_analysis').select('talk_ratio, question_count, script_adherence, patterns, outcome').eq('outcome', 'won');
    const avg = (arr: number[]) => arr.length ? arr.reduce((a,b) => a + b, 0) / arr.length : 0;
    const teamAvgTalk = teamCalls ? Math.round(avg(teamCalls.map(tc => tc.talk_ratio || 0))) : 55;
    const teamAvgQs = teamCalls ? Math.round(avg(teamCalls.map(tc => tc.question_count || 0))) : 22;
    const teamAvgScript = teamCalls ? Math.round(avg(teamCalls.map(tc => tc.script_adherence || 0))) : 50;
    const teamPatterns: Record<string, number> = {};
    const dims = ['contentEngine','marketContext','roiReframe','humor','urgency','contract','checkIn','theirBusiness'];
    if (teamCalls) for (const d of dims) teamPatterns[d] = +(avg(teamCalls.map(tc => (tc.patterns as Record<string,number>)?.[d] || 0))).toFixed(1);

    const dimLabels: Record<string,string> = { contentEngine:'Product explanation', roiReframe:'ROI reframing', humor:'Humor', urgency:'Urgency', contract:'Close language', checkIn:'Check-ins' };
    const verdicts: any[] = [];
    verdicts.push({ metric:'Talk Ratio', value:existingAnalysis.talk_ratio+'%', teamAvg:teamAvgTalk+'%', verdict:existingAnalysis.talk_ratio<=55?'good':existingAnalysis.talk_ratio<=65?'warning':'bad', tip:existingAnalysis.talk_ratio>60?'Too much talking.':'Good balance.' });
    verdicts.push({ metric:'Questions', value:existingAnalysis.question_count, teamAvg:teamAvgQs, verdict:existingAnalysis.question_count>=20?'good':existingAnalysis.question_count>=14?'warning':'bad', tip:existingAnalysis.question_count<16?'Not enough discovery.':'Solid.' });
    verdicts.push({ metric:'Script Score', value:existingAnalysis.script_adherence+'%', teamAvg:teamAvgScript+'%', verdict:existingAnalysis.script_adherence>=50?'good':existingAnalysis.script_adherence>=30?'warning':'bad', tip:existingAnalysis.script_adherence<30?'Low script coverage.':'OK.' });
    for (const [d, label] of Object.entries(dimLabels)) {
      const val = (existingAnalysis.patterns as Record<string,number>)?.[d] || 0;
      const ta = teamPatterns[d] || 0;
      if (Math.abs(val - ta) > 1) verdicts.push({ metric:label, value:val, teamAvg:ta, verdict:val>ta?'good':'warning', tip:val<ta-1?`Below average (${ta}).`:'Above average.' });
    }

    const aeProfile = (await supabase.from('ae_coaching_profiles').select('win_rate, avg_call_quality, total_calls').eq('recorder_name', existingAnalysis.recorder_name).single()).data;

    return c.json({
      recording: { id: recordingId, title: existingAnalysis.title, recorder: existingAnalysis.recorder_name, duration: Math.round((existingAnalysis.duration_seconds||0)/60), url: existingAnalysis.recording_url, createdAt: existingAnalysis.created_at },
      analysis: { talkRatio: existingAnalysis.talk_ratio, questionCount: existingAnalysis.question_count, scriptAdherence: existingAnalysis.script_adherence, sectionsHit: existingAnalysis.sections_hit, sectionsMissed: existingAnalysis.sections_missed, patterns: existingAnalysis.patterns, highlights: existingAnalysis.highlights, longestMonologue: existingAnalysis.longest_monologue, callQualityScore: existingAnalysis.call_quality_score || 0 },
      verdicts,
      aeProfile: aeProfile ? { avgCallQuality: aeProfile.avg_call_quality || 0, totalCalls: aeProfile.total_calls } : null,
      source: 'cached',
    });
  }

  // Second check: is the recording in the recordings table but not yet analyzed?
  const { data: existingRec } = await supabase
    .from('recordings')
    .select('id, title, recorder_name, transcript_text, duration_seconds, url, created_at')
    .eq('id', recordingId)
    .single();

  if (existingRec && existingRec.transcript_text) {
    const parsed = parseTranscript(existingRec.transcript_text, existingRec.recorder_name || 'Unknown');
    const analysis = analyzeCall(parsed.turns, existingRec.recorder_name || 'Unknown', existingRec.url);

    const { data: teamCalls } = await supabase.from('ae_call_analysis').select('talk_ratio, question_count, script_adherence, patterns, outcome').eq('outcome', 'won');
    const avg = (arr: number[]) => arr.length ? arr.reduce((a,b) => a + b, 0) / arr.length : 0;
    const teamAvgTalk = teamCalls ? Math.round(avg(teamCalls.map(tc => tc.talk_ratio || 0))) : 55;
    const teamAvgQs = teamCalls ? Math.round(avg(teamCalls.map(tc => tc.question_count || 0))) : 22;
    const teamAvgScript = teamCalls ? Math.round(avg(teamCalls.map(tc => tc.script_adherence || 0))) : 50;

    const verdicts: any[] = [];
    verdicts.push({ metric:'Talk Ratio', value:analysis.talkRatio+'%', teamAvg:teamAvgTalk+'%', verdict:analysis.talkRatio<=55?'good':analysis.talkRatio<=65?'warning':'bad', tip:analysis.talkRatio>60?'Too much talking.':'Good balance.' });
    verdicts.push({ metric:'Questions', value:analysis.questionCount, teamAvg:teamAvgQs, verdict:analysis.questionCount>=20?'good':analysis.questionCount>=14?'warning':'bad', tip:analysis.questionCount<16?'Not enough discovery.':'Solid.' });
    verdicts.push({ metric:'Script Score', value:analysis.scriptAdherence+'%', teamAvg:teamAvgScript+'%', verdict:analysis.scriptAdherence>=50?'good':analysis.scriptAdherence>=30?'warning':'bad', tip:analysis.scriptAdherence<30?'Low coverage.':'OK.' });

    const aeProfile = (await supabase.from('ae_coaching_profiles').select('win_rate, avg_call_quality, total_calls').eq('recorder_name', existingRec.recorder_name).single()).data;

    return c.json({
      recording: { id: recordingId, title: existingRec.title, recorder: existingRec.recorder_name, duration: Math.round((existingRec.duration_seconds||0)/60), url: existingRec.url, createdAt: existingRec.created_at },
      analysis: { talkRatio: analysis.talkRatio, questionCount: analysis.questionCount, scriptAdherence: analysis.scriptAdherence, sectionsHit: analysis.sectionsHit, sectionsMissed: analysis.sectionsMissed, patterns: analysis.patterns, highlights: analysis.highlights, longestMonologue: analysis.longestMonologue, callQualityScore: computeCallQualityScore(analysis) },
      verdicts,
      aeProfile: aeProfile ? { avgCallQuality: aeProfile.avg_call_quality || 0, totalCalls: aeProfile.total_calls } : null,
      source: 'local',
    });
  }

  // Third: fetch from Claap API (only if not found locally)
  const { createClaapClient } = await import('../integrations/claap-client.ts');

  try {
    const claap = createClaapClient();

    // Fetch recording details
    const recResponse = await claap.getRecording(recordingId);
    const rec = recResponse.result.recording;
    if (!('durationSeconds' in rec)) {
      return c.json({ error: 'Recording is still processing or not ready' }, 400);
    }

    // Small delay to respect Claap rate limits (3 req/sec)
    await new Promise(r => setTimeout(r, 400));

    // Fetch transcript
    const txResponse = await claap.getTranscript(recordingId, { format: 'text' });
    const transcriptText = typeof txResponse === 'string' ? txResponse : '';
    if (!transcriptText) {
      return c.json({ error: 'No transcript available for this recording' }, 400);
    }

    const recorderName = rec.recorder?.name || 'Unknown';

    // Parse and analyze
    const parsed = parseTranscript(transcriptText, recorderName);
    const analysis = analyzeCall(parsed.turns, recorderName, rec.url);

    // Get team benchmarks for comparison
    const { data: teamProfiles } = await supabase.from('ae_coaching_profiles').select('*');
    const { data: teamCalls } = await supabase.from('ae_call_analysis').select('talk_ratio, question_count, script_adherence, patterns, outcome');

    const teamAvg = {
      talkRatio: 0, questionCount: 0, scriptAdherence: 0, patterns: {} as Record<string, number>,
    };
    if (teamCalls && teamCalls.length > 0) {
      const wonCalls = teamCalls.filter(tc => tc.outcome === 'won');
      teamAvg.talkRatio = Math.round(wonCalls.reduce((s, tc) => s + (tc.talk_ratio || 0), 0) / wonCalls.length);
      teamAvg.questionCount = Math.round(wonCalls.reduce((s, tc) => s + (tc.question_count || 0), 0) / wonCalls.length);
      teamAvg.scriptAdherence = Math.round(wonCalls.reduce((s, tc) => s + (tc.script_adherence || 0), 0) / wonCalls.length);
      const dims = ['contentEngine','marketContext','roiReframe','humor','urgency','contract','checkIn','theirBusiness'];
      for (const d of dims) {
        teamAvg.patterns[d] = +(wonCalls.reduce((s, tc) => s + ((tc.patterns as Record<string,number>)?.[d] || 0), 0) / wonCalls.length).toFixed(1);
      }
    }

    // Get AE's own profile for personal comparison
    const aeProfile = teamProfiles?.find(p => p.recorder_name === recorderName) || null;

    // Build comparison verdicts
    const verdicts: { metric: string; value: number | string; teamAvg: number | string; verdict: 'good' | 'warning' | 'bad'; tip: string }[] = [];

    verdicts.push({
      metric: 'Talk Ratio',
      value: analysis.talkRatio + '%',
      teamAvg: teamAvg.talkRatio + '%',
      verdict: analysis.talkRatio <= 55 ? 'good' : analysis.talkRatio <= 65 ? 'warning' : 'bad',
      tip: analysis.talkRatio > 60 ? 'Too much talking. Ask more questions and let the prospect speak.' : 'Good balance.',
    });
    verdicts.push({
      metric: 'Questions Asked',
      value: analysis.questionCount,
      teamAvg: teamAvg.questionCount,
      verdict: analysis.questionCount >= 20 ? 'good' : analysis.questionCount >= 14 ? 'warning' : 'bad',
      tip: analysis.questionCount < 16 ? 'Not enough discovery. Prepare 8-10 questions before every call.' : 'Solid discovery.',
    });
    verdicts.push({
      metric: 'Script Adherence',
      value: analysis.scriptAdherence + '%',
      teamAvg: teamAvg.scriptAdherence + '%',
      verdict: analysis.scriptAdherence >= 50 ? 'good' : analysis.scriptAdherence >= 30 ? 'warning' : 'bad',
      tip: analysis.sectionsMissed.length > 6 ? `Missed ${analysis.sectionsMissed.length} of 12 script phases. Review the deck.` : 'Good coverage.',
    });

    // Pattern comparisons
    const dimLabels: Record<string,string> = { contentEngine:'Product explanation', roiReframe:'ROI reframing', humor:'Humor', urgency:'Urgency', contract:'Close language', checkIn:'Check-ins' };
    for (const [d, label] of Object.entries(dimLabels)) {
      const val = (analysis.patterns as Record<string,number>)[d] || 0;
      const avg = teamAvg.patterns[d] || 0;
      const diff = val - avg;
      if (Math.abs(diff) > 1) {
        verdicts.push({
          metric: label,
          value: val,
          teamAvg: avg,
          verdict: diff > 0 ? 'good' : 'warning',
          tip: diff < -1 ? `Below team average. Top performers use ${label.toLowerCase()} ${avg}x per call.` : `Above average — strong.`,
        });
      }
    }

    return c.json({
      recording: {
        id: recordingId,
        title: rec.title,
        recorder: recorderName,
        duration: Math.round(rec.durationSeconds / 60),
        url: rec.url,
        createdAt: rec.createdAt,
      },
      analysis: {
        talkRatio: analysis.talkRatio,
        questionCount: analysis.questionCount,
        scriptAdherence: analysis.scriptAdherence,
        sectionsHit: analysis.sectionsHit,
        sectionsMissed: analysis.sectionsMissed,
        patterns: analysis.patterns,
        highlights: analysis.highlights,
        longestMonologue: analysis.longestMonologue,
        callQualityScore: computeCallQualityScore(analysis),
      },
      verdicts,
      aeProfile: aeProfile ? { avgCallQuality: aeProfile.avg_call_quality || 0, totalCalls: aeProfile.total_calls } : null,
    });
  } catch (err: any) {
    return c.json({ error: err.message || 'Failed to fetch recording from Claap' }, 500);
  }
});

// Single call detail with highlights
app.get('/api/call/:id', async (c) => {
  const id = c.req.param('id');
  const { data, error } = await supabase
    .from('ae_call_analysis')
    .select('*, pattern_evidence')
    .eq('recording_id', id)
    .single();
  if (error) return c.json({ error: error.message }, 404);
  return c.json(data);
});

// Evidence drill-down for a specific dimension in a specific call
app.get('/api/call/:id/evidence/:dimension', async (c) => {
  const id = c.req.param('id');
  const dimension = c.req.param('dimension');
  const { data, error } = await supabase
    .from('ae_call_analysis')
    .select('pattern_evidence')
    .eq('recording_id', id)
    .single();
  if (error) return c.json({ error: error.message }, 404);
  const evidence = (data?.pattern_evidence as Record<string, unknown[]>) || {};
  return c.json(evidence[dimension] || []);
});

// ─── Feature: Weekly Coaching Agenda ──────────────────────────────────────────

app.get('/api/team/coaching-agenda', async (c) => {
  // Fetch all recent calls and coaching profiles
  const [{ data: calls, error: callsErr }, { data: profiles, error: profilesErr }] = await Promise.all([
    supabase.from('ae_call_analysis')
      .select('recording_id, recorder_name, outcome, title, deal_name, created_at, script_adherence, talk_ratio, question_count, longest_monologue, patterns, highlights, recording_url, sections_hit, sections_missed, call_quality_score')
      .order('created_at', { ascending: false }),
    supabase.from('ae_coaching_profiles')
      .select('*'),
  ]);
  if (callsErr) return c.json({ error: callsErr.message }, 500);
  if (profilesErr) return c.json({ error: profilesErr.message }, 500);
  if (!calls || !profiles) return c.json([]);

  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  // Group calls by AE, take last 10 per AE
  const byAE = new Map<string, typeof calls>();
  for (const call of calls) {
    if (!byAE.has(call.recorder_name)) byAE.set(call.recorder_name, []);
    const aeCalls = byAE.get(call.recorder_name)!;
    if (aeCalls.length < 10) aeCalls.push(call);
  }

  const agenda: {
    ae: string;
    priority: 'urgent' | 'high' | 'medium';
    focusArea: string;
    reason: string;
    listenTo: { callTitle: string; url: string; timestamp: string; excerpt: string };
  }[] = [];

  for (const [ae, aeCalls] of byAE) {
    if (aeCalls.length < 3) continue;

    const profile = profiles.find(p => p.recorder_name === ae);

    // Detect quality decline (rolling avg dropping)
    const recentQuality = avg(aeCalls.slice(0, 5).map(c => c.call_quality_score || 0));
    const olderQuality = aeCalls.length > 5 ? avg(aeCalls.slice(5).map(c => c.call_quality_score || 0)) : recentQuality;
    const qualityDecline = olderQuality - recentQuality;

    // Identify focus area based on recent performance
    const recentTalkRatio = avg(aeCalls.map(c => c.talk_ratio || 0));
    const recentQuestions = avg(aeCalls.map(c => c.question_count || 0));
    const recentScript = avg(aeCalls.map(c => c.script_adherence || 0));
    const recentMonologue = avg(aeCalls.map(c => c.longest_monologue || 0));

    // Score potential focus areas
    const focusAreas: { area: string; score: number; reason: string }[] = [];

    if (recentTalkRatio > 65) focusAreas.push({ area: 'Talk Ratio', score: recentTalkRatio - 55, reason: `Averaging ${Math.round(recentTalkRatio)}% talk ratio — needs more prospect participation` });
    if (recentQuestions < 12) focusAreas.push({ area: 'Discovery Questions', score: 15 - recentQuestions, reason: `Only ${Math.round(recentQuestions)} questions per call — insufficient discovery` });
    if (recentScript < 30) focusAreas.push({ area: 'Script Adherence', score: 50 - recentScript, reason: `${Math.round(recentScript)}% script coverage — missing key narrative sections` });
    if (recentMonologue > 200) focusAreas.push({ area: 'Monologue Control', score: (recentMonologue - 100) / 10, reason: `Longest monologues averaging ${Math.round(recentMonologue)} words — losing prospect attention` });

    // Check for missing sections across recent calls
    const sectionMissCounts: Record<number, number> = {};
    for (const call of aeCalls) {
      for (const missed of (call.sections_missed as number[] || [])) {
        sectionMissCounts[missed] = (sectionMissCounts[missed] || 0) + 1;
      }
    }
    const alwaysMissed = Object.entries(sectionMissCounts).filter(([, count]) => count >= aeCalls.length * 0.8);
    if (alwaysMissed.length >= 3) {
      focusAreas.push({ area: 'Narrative Gaps', score: alwaysMissed.length * 3, reason: `Consistently skips ${alwaysMissed.length} script sections — narrative has holes` });
    }

    // Check for no-close pattern
    const noCloseCount = aeCalls.filter(c => {
      const p = c.patterns as Record<string, number> | null;
      return p && (p.contract || 0) === 0 && (p.assumptiveClose || 0) === 0;
    }).length;
    if (noCloseCount >= aeCalls.length * 0.6) {
      focusAreas.push({ area: 'Closing', score: noCloseCount * 2, reason: `${noCloseCount} of last ${aeCalls.length} calls ended without close attempt` });
    }

    if (focusAreas.length === 0) {
      focusAreas.push({ area: 'General Refinement', score: 1, reason: 'No major issues — focus on consistency and edge cases' });
    }

    // Pick top focus area
    focusAreas.sort((a, b) => b.score - a.score);
    const topFocus = focusAreas[0];

    // Find the best call to listen to for this focus area
    let listenCall = aeCalls[0];
    const allHighlights = [];
    for (const call of aeCalls) {
      const hl = (call.highlights as any[] || []).filter((h: any) => h.type === 'coachable');
      if (hl.length > 0) {
        for (const h of hl) allHighlights.push({ ...h, call });
      }
    }
    // Find a highlight related to the focus area
    const relevantHighlight = allHighlights.find(h => {
      if (topFocus.area === 'Talk Ratio' || topFocus.area === 'Monologue Control') return h.category === 'Long Monologue';
      if (topFocus.area === 'Discovery Questions') return h.category === 'No Summary Before Pitch' || h.category === 'No Prospect Focus';
      if (topFocus.area === 'Closing') return h.category === 'No Close' || h.category === 'Missed Buy Signal';
      if (topFocus.area === 'Script Adherence' || topFocus.area === 'Narrative Gaps') return h.category === 'Too Abstract' || h.category === 'Product Not Explained';
      return true;
    }) || allHighlights[0];

    if (relevantHighlight) {
      listenCall = relevantHighlight.call;
    }

    // Determine priority based on quality gaps
    let priority: 'urgent' | 'high' | 'medium' = 'medium';
    if (qualityDecline > 15) priority = 'urgent';
    else if (topFocus.score > 10 || recentQuality < 40) priority = 'high';

    agenda.push({
      ae,
      priority,
      focusArea: topFocus.area,
      reason: qualityDecline > 15
        ? `QUALITY DECLINING (${Math.round(recentQuality)} recent vs ${Math.round(olderQuality)} prior avg). ${topFocus.reason}`
        : topFocus.reason,
      listenTo: {
        callTitle: listenCall.title || 'Untitled call',
        url: listenCall.recording_url || '',
        timestamp: relevantHighlight?.timestampDisplay || '0:00',
        excerpt: relevantHighlight?.excerpt || '',
      },
    });
  }

  // Sort by priority: urgent > high > medium
  const priorityOrder = { urgent: 0, high: 1, medium: 2 };
  agenda.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  return c.json(agenda);
});

// ─── Feature: Narrative Consistency Score ─────────────────────────────────────

app.get('/api/team/narrative-consistency', async (c) => {
  const [{ data: calls, error: callsErr }, { data: profiles, error: profilesErr }] = await Promise.all([
    supabase.from('ae_call_analysis')
      .select('recorder_name, outcome, sections_hit, sections_missed, script_adherence')
      .order('created_at', { ascending: false }),
    supabase.from('ae_coaching_profiles')
      .select('recorder_name, win_rate, avg_call_quality, total_calls'),
  ]);
  if (callsErr) return c.json({ error: callsErr.message }, 500);
  if (profilesErr) return c.json({ error: profilesErr.message }, 500);
  if (!calls || !profiles) return c.json({});

  // Import script sections for names
  const { SCRIPT_SECTIONS } = await import('../analysis/script-sections.ts');

  // Group calls by AE
  const byAE = new Map<string, typeof calls>();
  for (const call of calls) {
    if (!byAE.has(call.recorder_name)) byAE.set(call.recorder_name, []);
    byAE.get(call.recorder_name)!.push(call);
  }

  // For each section, calculate coverage % per AE
  const sectionConsistency: {
    section: string;
    sectionId: number;
    coverageByAE: Record<string, number>;
    teamAvg: number;
  }[] = [];

  for (const section of SCRIPT_SECTIONS) {
    const coverageByAE: Record<string, number> = {};
    const coverages: number[] = [];

    for (const [ae, aeCalls] of byAE) {
      if (aeCalls.length < 3) continue;
      const hitsCount = aeCalls.filter(c => {
        const hits = c.sections_hit as number[] | null;
        return hits && hits.includes(section.id);
      }).length;
      const pct = Math.round(hitsCount / aeCalls.length * 100);
      coverageByAE[ae] = pct;
      coverages.push(pct);
    }

    const teamAvg = coverages.length ? Math.round(coverages.reduce((a, b) => a + b, 0) / coverages.length) : 0;
    sectionConsistency.push({
      section: section.name,
      sectionId: section.id,
      coverageByAE,
      teamAvg,
    });
  }

  // Identify drift: sections that top performers (quality >65) cover but struggling AEs (quality <45) skip
  const topPerformers = profiles.filter(p => (p.avg_call_quality || 0) > 65).map(p => p.recorder_name);
  const strugglingAEs = profiles.filter(p => (p.avg_call_quality || 0) < 45 && p.total_calls >= 5).map(p => p.recorder_name);
  const driftAlerts: string[] = [];

  for (const sc of sectionConsistency) {
    const topAvg = topPerformers.length
      ? topPerformers.reduce((s, ae) => s + (sc.coverageByAE[ae] || 0), 0) / topPerformers.length
      : 0;
    const struggleAvg = strugglingAEs.length
      ? strugglingAEs.reduce((s, ae) => s + (sc.coverageByAE[ae] || 0), 0) / strugglingAEs.length
      : 0;

    if (topAvg > 60 && struggleAvg < 30 && topPerformers.length > 0 && strugglingAEs.length > 0) {
      driftAlerts.push(
        `"${sc.section}" — top performers cover it ${Math.round(topAvg)}% of the time, struggling AEs only ${Math.round(struggleAvg)}%`
      );
    }
  }

  // Identify outliers: AEs who deviate most from team narrative
  const outliers: { ae: string; deviationScore: number; details: string[] }[] = [];

  for (const [ae, aeCalls] of byAE) {
    if (aeCalls.length < 3) continue;
    let totalDeviation = 0;
    const deviationDetails: string[] = [];

    for (const sc of sectionConsistency) {
      const aeVal = sc.coverageByAE[ae] || 0;
      const diff = Math.abs(aeVal - sc.teamAvg);
      if (diff > 30) {
        totalDeviation += diff;
        if (aeVal < sc.teamAvg) {
          deviationDetails.push(`Skips "${sc.section}" (${aeVal}% vs team ${sc.teamAvg}%)`);
        }
      }
    }

    if (totalDeviation > 0) {
      outliers.push({ ae, deviationScore: Math.round(totalDeviation / sectionConsistency.length), details: deviationDetails });
    }
  }

  outliers.sort((a, b) => b.deviationScore - a.deviationScore);

  return c.json({ sectionConsistency, driftAlerts, outliers });
});

// ─── Narrative Coach (LLM-powered deep analysis) ─────────────────────────────

// Generate deep narrative review for a call
app.post('/api/call/:id/narrative', async (c) => {
  const recordingId = c.req.param('id');

  // Check if we already have a narrative cached
  const { data: existing } = await supabase
    .from('ae_call_analysis')
    .select('narrative_review')
    .eq('recording_id', recordingId)
    .single();

  if (existing?.narrative_review && Object.keys(existing.narrative_review).length > 0) {
    return c.json(existing.narrative_review);
  }

  // Get the call analysis and transcript
  const { data: analysis } = await supabase
    .from('ae_call_analysis')
    .select('*, recording_id')
    .eq('recording_id', recordingId)
    .single();

  if (!analysis) return c.json({ error: 'Call not found' }, 404);

  // Get the transcript from recordings table
  const { data: recording } = await supabase
    .from('recordings')
    .select('transcript_text')
    .eq('id', recordingId)
    .single();

  if (!recording?.transcript_text) {
    return c.json({ error: 'No transcript available for narrative analysis' }, 400);
  }

  // Import and run narrative coach
  const { analyzeCallNarrative } = await import('../analysis/narrative-coach.ts');

  const flaggedMoments = (analysis.highlights || []).map((h: any) => ({
    type: h.type,
    category: h.category,
    timestamp: h.timestampDisplay,
    excerpt: h.excerpt,
    guidance: h.guidance || '',
  }));

  const narrative = await analyzeCallNarrative(
    recording.transcript_text,
    analysis.recorder_name,
    analysis.title || 'Untitled',
    Math.round((analysis.duration_seconds || 0) / 60),
    flaggedMoments,
  );

  if (!narrative) {
    return c.json({ error: 'Failed to generate narrative review. Check ANTHROPIC_API_KEY.' }, 500);
  }

  // Cache the narrative in Supabase
  await supabase
    .from('ae_call_analysis')
    .update({ narrative_review: narrative })
    .eq('recording_id', recordingId);

  return c.json(narrative);
});

// Generate narrative for a live-analyzed call (pass transcript directly)
app.post('/api/narrative/live', async (c) => {
  const body = await c.req.json() as {
    transcriptText: string;
    aeName: string;
    callTitle: string;
    durationMinutes: number;
    flaggedMoments: any[];
  };

  const { analyzeCallNarrative } = await import('../analysis/narrative-coach.ts');

  const narrative = await analyzeCallNarrative(
    body.transcriptText,
    body.aeName,
    body.callTitle,
    body.durationMinutes,
    body.flaggedMoments || [],
  );

  if (!narrative) {
    return c.json({ error: 'Failed to generate narrative. Check ANTHROPIC_API_KEY.' }, 500);
  }

  return c.json(narrative);
});

// ─── AE Deep Analysis (cross-call LLM review) ───────────────────────────────

app.post('/api/ae/:name/deep-analysis', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));

  // Check cache first
  const { data: profile } = await supabase
    .from('ae_coaching_profiles')
    .select('*')
    .eq('recorder_name', name)
    .single();

  // Get all calls with smart reviews for this AE
  const calls: any[] = [];
  let from = 0;
  while (true) {
    const { data: page } = await supabase
      .from('ae_call_analysis')
      .select('title, created_at, duration_seconds, talk_ratio, question_count, script_adherence, call_quality_score, outcome, smart_review, call_verdict, sections_missed')
      .eq('recorder_name', name)
      .order('created_at', { ascending: false })
      .range(from, from + 99);
    if (!page || page.length === 0) break;
    calls.push(...page);
    if (page.length < 100) break;
    from += 100;
  }

  if (calls.length < 3) {
    return c.json({ error: 'Not enough calls to generate deep analysis (need at least 3)' }, 400);
  }

  // Get team benchmarks
  const { data: allProfiles } = await supabase.from('ae_coaching_profiles').select('avg_talk_ratio, avg_question_count, avg_call_quality');
  const avg = (arr: number[]) => arr.length ? Math.round(arr.reduce((a,b) => a + b, 0) / arr.length) : 0;
  const teamBenchmarks = {
    avgTalkRatio: avg((allProfiles || []).map(p => p.avg_talk_ratio)),
    avgQuestions: avg((allProfiles || []).map(p => p.avg_question_count)),
    avgQuality: avg((allProfiles || []).map(p => p.avg_call_quality)),
  };

  // Build call summaries from smart reviews
  const SECTION_NAMES = ['Origin','AI Search','SEO Bridge','Tools Gap','96.55%','Manual Pain','Sitemap','Pling','Clusters','Fisher/1999','Snowball','Pricing'];
  const callSummaries = calls.map(c => {
    const sr = c.smart_review || {};
    return {
      title: c.title || 'Untitled',
      date: (c.created_at || '').slice(0, 10),
      duration: Math.round((c.duration_seconds || 0) / 60),
      talkRatio: c.talk_ratio || 0,
      questionCount: c.question_count || 0,
      scriptAdherence: c.script_adherence || 0,
      quality: c.call_quality_score || 0,
      outcome: c.outcome || '',
      summary: sr.summary || '',
      oneThingToChange: sr.oneThingToChange || '',
      objections: (sr.objections || []).map((o: any) => ({ prospectSaid: o.prospectSaid || '', aeSaid: o.aeSaid || '', handling: o.handling || '' })),
      buyingSignals: (sr.buyingSignals || []).map((b: any) => ({ prospectSaid: b.prospectSaid || '', aeSaid: b.aeSaid || '', didAdvance: b.didAdvance || false })),
      callVerdict: Array.isArray(c.call_verdict) ? c.call_verdict : [],
      scriptMissed: (c.sections_missed || []).map((id: number) => SECTION_NAMES[id - 1] || `Section ${id}`),
    };
  });

  const profileData = {
    totalCalls: profile?.total_calls || calls.length,
    avgTalkRatio: profile?.avg_talk_ratio || 0,
    avgQuestions: profile?.avg_question_count || 0,
    avgScriptAdherence: profile?.avg_script_adherence || 0,
    avgQuality: profile?.avg_call_quality || 0,
    strengths: profile?.top_strengths || [],
    weaknesses: profile?.top_weaknesses || [],
  };

  const { analyzeAEDeep } = await import('../analysis/narrative-coach.ts');
  const result = await analyzeAEDeep(name, callSummaries, profileData, teamBenchmarks);

  if (!result) {
    return c.json({ error: 'Failed to generate deep analysis. Check ANTHROPIC_API_KEY.' }, 500);
  }

  return c.json(result);
});

// ─── Feedback ────────────────────────────────────────────────────────────────

// Submit feedback on a coaching moment
app.post('/api/feedback', async (c) => {
  const body = await c.req.json() as { recordingId: string; category: string; excerpt?: string; vote: 'up' | 'down'; voter?: string };
  if (!body.recordingId || !body.category || !body.vote) {
    return c.json({ error: 'Missing recordingId, category, or vote' }, 400);
  }
  const id = `fb_${body.recordingId}_${body.category}_${Date.now()}`;
  const { error } = await supabase.from('coaching_feedback').upsert({
    id,
    recording_id: body.recordingId,
    moment_category: body.category,
    moment_excerpt: body.excerpt?.slice(0, 300) || '',
    vote: body.vote,
    voter: body.voter || 'anonymous',
    created_at: new Date().toISOString(),
  });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});

// Detection health — aggregated across all calls (MUST be before :recordingId route)
app.get('/api/feedback/health', async (c) => {
  const { data, error } = await supabase
    .from('coaching_feedback')
    .select('moment_category, vote');
  if (error) return c.json({ error: error.message }, 500);

  const byCategory: Record<string, { up: number; down: number; total: number }> = {};
  for (const row of data || []) {
    if (!byCategory[row.moment_category]) byCategory[row.moment_category] = { up: 0, down: 0, total: 0 };
    byCategory[row.moment_category][row.vote as 'up' | 'down']++;
    byCategory[row.moment_category].total++;
  }

  const health = Object.entries(byCategory).map(([category, counts]) => ({
    category,
    totalVotes: counts.total,
    upVotes: counts.up,
    downVotes: counts.down,
    trustScore: counts.total > 0 ? Math.round(counts.up / counts.total * 100) : null,
    status: counts.total < 3 ? 'insufficient_data' : counts.up / counts.total >= 0.7 ? 'trusted' : counts.up / counts.total >= 0.4 ? 'review' : 'untrusted',
  })).sort((a, b) => (a.trustScore ?? 100) - (b.trustScore ?? 100));

  return c.json(health);
});

// Get feedback counts for a specific call
app.get('/api/feedback/:recordingId', async (c) => {
  const recordingId = c.req.param('recordingId');
  const { data, error } = await supabase
    .from('coaching_feedback')
    .select('moment_category, vote')
    .eq('recording_id', recordingId);
  if (error) return c.json({ error: error.message }, 500);
  const counts: Record<string, { up: number; down: number }> = {};
  for (const row of data || []) {
    if (!counts[row.moment_category]) counts[row.moment_category] = { up: 0, down: 0 };
    counts[row.moment_category][row.vote as 'up' | 'down']++;
  }
  return c.json(counts);
});

// ─── V2 Coaching Dashboard ────────────────────────────────────────────────────

// Helper: normalize a company name from a call title for deal grouping
function normalizeDealKey(title: string): string {
  const stripWords = ['wp seo ai', 'wpseoai', 'kennismaking', 'vervolg', 'follow-up', 'afstemmen', 'samenwerking', 'online meeting'];
  const stripChars = ['x', '&', '|', '<>'];
  let key = title.toLowerCase();
  for (const w of stripWords) key = key.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
  for (const ch of stripChars) key = key.split(ch).join(' ');
  return key.replace(/\s+/g, ' ').trim();
}

// Helper: slugify a deal name for use as an id
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Helper: group calls into deals
function groupCallsIntoDeals(calls: any[]): Map<string, { name: string; calls: any[] }> {
  const deals = new Map<string, { name: string; calls: any[] }>();

  for (const call of calls) {
    let dealKey: string;
    let dealName: string;

    if (call.deal_name && call.deal_name.trim()) {
      dealKey = call.deal_name.trim().toLowerCase();
      dealName = call.deal_name.trim();
    } else {
      const title = call.title || '';
      dealKey = normalizeDealKey(title);
      dealName = dealKey || title || 'Unknown';
    }

    if (!dealKey) continue;

    if (!deals.has(dealKey)) {
      deals.set(dealKey, { name: dealName, calls: [] });
    }
    deals.get(dealKey)!.calls.push(call);
  }

  return deals;
}

// GET /api/deals — Deal Board Data
app.get('/api/deals', async (c) => {
  const { data, error } = await supabase
    .from('ae_call_analysis')
    .select('recording_id, recorder_name, title, deal_name, created_at, duration_seconds, recording_url, outcome, patterns, highlights, call_verdict, prospect_engagement, call_quality_score, narrative_review')
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json([]);

  const deals = groupCallsIntoDeals(data);
  const result: any[] = [];

  for (const [, deal] of deals) {
    const sortedCalls = [...deal.calls].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    const latest = sortedCalls[0];
    const latestPatterns = (latest.patterns as Record<string, number>) || {};
    const latestVerdict = latest.call_verdict || '';

    // Health signals
    const discoveryDone = (latest.question_count > 12) || (latestPatterns.theirBusiness > 0);
    const demoShown = deal.calls.some((call: any) => {
      const p = (call.patterns as Record<string, number>) || {};
      const hl = (call.highlights as any[]) || [];
      return (p.contentEngine > 5) || hl.some((h: any) => h.category === 'Live Proof');
    });
    const pricingDiscussed = deal.calls.some((call: any) => {
      const p = (call.patterns as Record<string, number>) || {};
      return (p.pricing > 0);
    });
    const noNextStep = latestVerdict.includes('No Close') || latestVerdict.includes('Never attempted to close');
    const nextStepDefined = !noNextStep && (latestPatterns.contract > 0 || latestPatterns.assumptiveClose > 0);
    const latestDate = new Date(latest.created_at || 0);
    const daysSinceLatest = (Date.now() - latestDate.getTime()) / (1000 * 60 * 60 * 24);
    const stalling = daysSinceLatest > 7 && latest.outcome !== 'won';
    const thinkItOver = deal.calls.some((call: any) => {
      const hl = (call.highlights as any[]) || [];
      return hl.some((h: any) => h.category === 'Accepted Think-It-Over');
    });

    // Assign column
    let column: string;
    if (deal.calls.some((call: any) => call.outcome === 'won')) {
      column = 'closed';
    } else if (noNextStep || stalling || thinkItOver) {
      column = 'attention';
    } else {
      column = 'active';
    }

    result.push({
      id: slugify(deal.name),
      name: deal.name,
      ae: latest.recorder_name,
      callCount: deal.calls.length,
      lastCallDate: latest.created_at,
      column,
      healthSignals: { discoveryDone, demoShown, pricingDiscussed, nextStepDefined, noNextStep, stalling, thinkItOver },
      calls: sortedCalls.map((call: any) => ({
        recording_id: call.recording_id,
        title: call.title,
        date: call.created_at,
        quality: call.call_quality_score || 0,
        hasNarrative: !!(call.narrative_review && Object.keys(call.narrative_review).length > 0),
      })),
    });
  }

  // Sort by lastCallDate desc
  result.sort((a, b) => (b.lastCallDate || '').localeCompare(a.lastCallDate || ''));
  return c.json(result);
});

// GET /api/deal/:name — Deal Timeline
app.get('/api/deal/:name', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));

  const { data, error } = await supabase
    .from('ae_call_analysis')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json([]);

  // Find matching calls: by deal_name, by grouping logic, or by title containing the name
  const nameLower = name.toLowerCase();
  const matchingCalls = data.filter((call: any) => {
    // Direct deal_name match
    if (call.deal_name && call.deal_name.trim().toLowerCase() === nameLower) return true;
    // Title contains the name
    if (call.title && call.title.toLowerCase().includes(nameLower)) return true;
    // Normalized key match
    const key = normalizeDealKey(call.title || '');
    if (key === nameLower || key.includes(nameLower) || nameLower.includes(key)) return true;
    return false;
  });

  const result = matchingCalls.map((call: any) => ({
    ...call,
    hasNarrative: !!(call.narrative_review && Object.keys(call.narrative_review).length > 0),
  }));

  return c.json(result);
});

// GET /api/reps — Rep Coaching Cards
app.get('/api/reps', async (c) => {
  const [{ data: profiles, error: profilesErr }, { data: allCalls, error: callsErr }] = await Promise.all([
    supabase.from('ae_coaching_profiles').select('*'),
    supabase.from('ae_call_analysis')
      .select('recorder_name, created_at, call_quality_score, talk_ratio, question_count, patterns')
      .order('created_at', { ascending: false }),
  ]);
  if (profilesErr) return c.json({ error: profilesErr.message }, 500);
  if (callsErr) return c.json({ error: callsErr.message }, 500);
  if (!profiles) return c.json([]);

  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // Group calls by AE, keep last 20
  const callsByAE = new Map<string, any[]>();
  for (const call of (allCalls || [])) {
    if (!callsByAE.has(call.recorder_name)) callsByAE.set(call.recorder_name, []);
    const aeCalls = callsByAE.get(call.recorder_name)!;
    if (aeCalls.length < 20) aeCalls.push(call);
  }

  const result: any[] = [];

  for (const profile of profiles) {
    const aeCalls = callsByAE.get(profile.recorder_name) || [];

    // Quality trend: avg of calls 0-9 vs 10-19
    const recent10 = aeCalls.slice(0, 10);
    const older10 = aeCalls.slice(10, 20);
    const recentAvg = avg(recent10.map((c: any) => c.call_quality_score || 0));
    const olderAvg = older10.length > 0 ? avg(older10.map((c: any) => c.call_quality_score || 0)) : recentAvg;
    const diff = recentAvg - olderAvg;
    const qualityTrend = diff > 3 ? 'up' : diff < -3 ? 'down' : 'flat';

    // Coaching focus
    const avgTalkRatio = avg(aeCalls.map((c: any) => c.talk_ratio || 0));
    const avgQuestionCount = avg(aeCalls.map((c: any) => c.question_count || 0));
    const avgPatterns: Record<string, number> = {};
    const dims = ['contract', 'contentEngine', 'roiReframe', 'assumptiveClose'];
    for (const d of dims) {
      avgPatterns[d] = avg(aeCalls.map((c: any) => ((c.patterns as Record<string, number>) || {})[d] || 0));
    }

    let coachingFocus: string;
    if (avgTalkRatio > 62) {
      coachingFocus = `Talk less, listen more — averaging ${Math.round(avgTalkRatio)}%, aim for under 55%`;
    } else if (avgQuestionCount < 16) {
      coachingFocus = `Ask more discovery questions — averaging ${Math.round(avgQuestionCount)} per call, top performers ask 22+`;
    } else if (avgPatterns.contract < 0.5) {
      coachingFocus = 'Practice closing — end every call with a concrete next step';
    } else if (avgPatterns.contentEngine < 8) {
      coachingFocus = "Explain the product more deeply — prospects need to understand what they're buying";
    } else if (avgPatterns.roiReframe < 0.3) {
      coachingFocus = "Frame price as investment — say 'investering' not 'kosten'";
    } else {
      // Fallback: pick from top_weaknesses
      const weaknesses = profile.top_weaknesses as string[] | null;
      coachingFocus = weaknesses && weaknesses.length > 0
        ? `Focus on improving: ${weaknesses[0]}`
        : 'Maintain consistency across all calls';
    }

    const recentCallCount = aeCalls.filter((c: any) => c.created_at >= thirtyDaysAgo).length;

    result.push({
      name: profile.recorder_name,
      totalCalls: profile.total_calls || aeCalls.length,
      qualityTrend,
      avgQuality: profile.avg_call_quality || Math.round(recentAvg),
      coachingFocus,
      recentCallCount,
    });
  }

  result.sort((a, b) => (b.avgQuality || 0) - (a.avgQuality || 0));
  return c.json(result);
});

// GET /api/rep/:name/coaching-brief — 1:1 Prep
app.get('/api/rep/:name/coaching-brief', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  const [{ data: profile, error: profileErr }, { data: calls, error: callsErr }] = await Promise.all([
    supabase.from('ae_coaching_profiles').select('*').eq('recorder_name', name).single(),
    supabase.from('ae_call_analysis')
      .select('recording_id, recorder_name, title, created_at, call_quality_score, call_verdict, talk_ratio, question_count, patterns, highlights, recording_url, narrative_review')
      .eq('recorder_name', name)
      .order('created_at', { ascending: false })
      .limit(10),
  ]);
  if (profileErr) return c.json({ error: profileErr.message }, 404);
  if (callsErr) return c.json({ error: callsErr.message }, 500);
  if (!calls || calls.length === 0) return c.json({ error: 'No calls found for this rep' }, 404);

  // Determine coaching focus with same priority logic
  const avgTalkRatio = avg(calls.map((c: any) => c.talk_ratio || 0));
  const avgQuestionCount = avg(calls.map((c: any) => c.question_count || 0));
  const avgPatterns: Record<string, number> = {};
  const dims = ['contract', 'contentEngine', 'roiReframe', 'assumptiveClose'];
  for (const d of dims) {
    avgPatterns[d] = avg(calls.map((c: any) => ((c.patterns as Record<string, number>) || {})[d] || 0));
  }

  let focusArea: string;
  let focusSearchCategory: string;
  let strengthCategory: string;
  if (avgTalkRatio > 62) {
    focusArea = `Talk less, listen more — averaging ${Math.round(avgTalkRatio)}%, aim for under 55%`;
    focusSearchCategory = 'Long Monologue';
    strengthCategory = 'Active Listening';
  } else if (avgQuestionCount < 16) {
    focusArea = `Ask more discovery questions — averaging ${Math.round(avgQuestionCount)} per call, top performers ask 22+`;
    focusSearchCategory = 'No Summary Before Pitch';
    strengthCategory = 'Deep Discovery';
  } else if (avgPatterns.contract < 0.5) {
    focusArea = 'Practice closing — end every call with a concrete next step';
    focusSearchCategory = 'No Close';
    strengthCategory = 'Assumptive Close';
  } else if (avgPatterns.contentEngine < 8) {
    focusArea = "Explain the product more deeply — prospects need to understand what they're buying";
    focusSearchCategory = 'Product Not Explained';
    strengthCategory = 'Live Proof';
  } else if (avgPatterns.roiReframe < 0.3) {
    focusArea = "Frame price as investment — say 'investering' not 'kosten'";
    focusSearchCategory = 'Price Objection';
    strengthCategory = 'ROI Reframe';
  } else {
    const weaknesses = profile?.top_weaknesses as string[] | null;
    focusArea = weaknesses && weaknesses.length > 0
      ? `Focus on improving: ${weaknesses[0]}`
      : 'Maintain consistency across all calls';
    focusSearchCategory = 'coachable';
    strengthCategory = 'Captured Buy Signal';
  }

  // Find evidence for the focus area from this AE's calls
  let evidence: { callTitle: string; url: string; timestamp: string; excerpt: string } | null = null;
  for (const call of calls) {
    const hl = (call.highlights as any[]) || [];
    const match = hl.find((h: any) => h.category === focusSearchCategory || h.type === 'coachable');
    if (match) {
      evidence = {
        callTitle: call.title || 'Untitled call',
        url: call.recording_url || '',
        timestamp: match.timestampDisplay || '0:00',
        excerpt: match.excerpt || '',
      };
      break;
    }
  }

  // watchAndLearn: find another AE's strength highlight that addresses this AE's weakness
  let watchAndLearn: { ae: string; callTitle: string; url: string; timestamp: string; excerpt: string; category: string } | null = null;
  const { data: otherCalls } = await supabase
    .from('ae_call_analysis')
    .select('recorder_name, title, recording_url, highlights')
    .neq('recorder_name', name)
    .order('call_quality_score', { ascending: false })
    .limit(50);

  if (otherCalls) {
    for (const call of otherCalls) {
      const hl = (call.highlights as any[]) || [];
      const match = hl.find((h: any) => h.type === 'strength' && (h.category === strengthCategory || h.category === 'Captured Buy Signal' || h.category === 'Assumptive Close'));
      if (match) {
        watchAndLearn = {
          ae: call.recorder_name,
          callTitle: call.title || 'Untitled call',
          url: call.recording_url || '',
          timestamp: match.timestampDisplay || '0:00',
          excerpt: match.excerpt || '',
          category: match.category || '',
        };
        break;
      }
    }
  }

  // Progress: avg quality of last 5 vs previous 5
  const last5 = calls.slice(0, 5);
  const prev5 = calls.slice(5, 10);
  const recentAvg = Math.round(avg(last5.map((c: any) => c.call_quality_score || 0)));
  const previousAvg = prev5.length > 0 ? Math.round(avg(prev5.map((c: any) => c.call_quality_score || 0))) : recentAvg;
  const progressDiff = recentAvg - previousAvg;
  const direction = progressDiff > 3 ? 'Improving' : progressDiff < -3 ? 'Declining' : 'Steady';

  // Last five calls
  const lastFiveCalls = last5.map((call: any) => {
    const verdict = call.call_verdict || '';
    const firstVerdict = verdict.includes(',') ? verdict.split(',')[0].trim() : (verdict || 'OK');
    return {
      title: call.title || 'Untitled call',
      date: call.created_at,
      quality: call.call_quality_score || 0,
      quickVerdict: firstVerdict,
    };
  });

  return c.json({
    name,
    avgQuality: profile?.avg_call_quality || recentAvg,
    qualityTrend: direction === 'Improving' ? 'up' : direction === 'Declining' ? 'down' : 'flat',
    currentFocus: {
      area: focusArea,
      reason: focusArea,
      evidence: evidence || { callTitle: '', url: '', timestamp: '', excerpt: '' },
    },
    watchAndLearn: watchAndLearn || { ae: '', callTitle: '', url: '', timestamp: '', excerpt: '', category: '' },
    progress: {
      recent: recentAvg,
      previous: previousAvg,
      direction,
    },
    lastFiveCalls,
  });
});

// ─── Dashboard ───────────────────────────────────────────────────────────────

app.get('/', (c) => {
  const html = readFileSync(join(__dirname, '..', 'dashboard', 'index.html'), 'utf-8');
  return c.html(html);
});

// ─── Start ───────────────────────────────────────────────────────────────────

const port = parseInt(process.env.PORT || '3000');
console.log(`Coaching Dashboard running at http://localhost:${port}`);
serve({ fetch: app.fetch, port });
