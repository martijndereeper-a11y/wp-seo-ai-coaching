import { Hono } from 'hono';
import { requireRole } from '../auth.ts';
import { supabase, getCached, setCache, avg, PILLAR_KEYS, PILLAR_NAMES } from '../shared.ts';
import { isExcludedAE } from '../../config/excluded-aes.ts';
import { coachingWindowCutoff, COACHING_WINDOW_DAYS } from '../../config/coaching-window.ts';

const routes = new Hono();

// Team (market) derived from each AE's dominant call language.
// nl → Netherlands, de → Germany, en → UK. Other languages don't count
// toward the assignment; an AE with no recognized-language calls is "Other".
const LANG_TEAM: Record<string, string> = { nl: 'Netherlands', de: 'Germany', en: 'UK' };

/** Map recorder_name → team label by tallying transcript_lang across all recordings. */
async function aeTeamMap(): Promise<Record<string, string>> {
  const tally: Record<string, Record<string, number>> = {};
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('recordings')
      .select('recorder_name, transcript_lang')
      .range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    for (const r of data) {
      const team = LANG_TEAM[(r.transcript_lang || '').toLowerCase()];
      if (!r.recorder_name || !team) continue;
      (tally[r.recorder_name] ||= {})[team] = (tally[r.recorder_name]?.[team] || 0) + 1;
    }
    if (data.length < PAGE) break;
  }
  const result: Record<string, string> = {};
  for (const [ae, teams] of Object.entries(tally)) {
    result[ae] = Object.entries(teams).sort((a, b) => b[1] - a[1])[0][0];
  }
  return result;
}

// Team overview
routes.get('/team', async (c) => {
  const cached = getCached('team');
  if (cached) return c.json(cached);
  const { data, error } = await supabase
    .from('ae_coaching_profiles')
    .select('recorder_name, total_calls, avg_call_quality, avg_talk_ratio, avg_question_count, avg_script_adherence, top_strengths, top_weaknesses, coaching_recs, avg_patterns_all')
    .order('avg_call_quality', { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  const filtered = (data || []).filter((p: any) => !isExcludedAE(p.recorder_name));
  setCache('team', filtered);
  return c.json(filtered);
});

// Team benchmarks
routes.get('/team/benchmarks', async (c) => {
  const cached = getCached('benchmarks');
  if (cached) return c.json(cached);
  const { data, error } = await supabase
    .from('ae_coaching_profiles')
    .select('avg_call_quality, avg_talk_ratio, avg_question_count, avg_script_adherence');
  if (error) return c.json({ error: error.message }, 500);
  const benchmarks = {
    teamAvg: {
      callQuality: Math.round(avg((data || []).map((d: any) => d.avg_call_quality || 0))),
      talkRatio: Math.round(avg((data || []).map((d: any) => d.avg_talk_ratio || 0))),
      questionCount: Math.round(avg((data || []).map((d: any) => d.avg_question_count || 0))),
      scriptAdherence: Math.round(avg((data || []).map((d: any) => d.avg_script_adherence || 0))),
    },
  };
  setCache('benchmarks', benchmarks);
  return c.json(benchmarks);
});

// Team pillars
routes.get('/team/pillars', async (c) => {
  const cached = getCached('pillars');
  if (cached) return c.json(cached);
  const { data, error } = await supabase
    .from('ae_call_analysis')
    .select('recorder_name, pillar_scores')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({});

  const byAE = new Map<string, any[]>();
  for (const row of data) {
    if (!row.pillar_scores) continue;
    if (!byAE.has(row.recorder_name)) byAE.set(row.recorder_name, []);
    const aeCalls = byAE.get(row.recorder_name)!;
    if (aeCalls.length < 20) aeCalls.push(row);
  }

  const result: Record<string, Record<string, { score: number; level: string }>> = {};
  for (const [ae, rows] of byAE) {
    result[ae] = {};
    for (const key of PILLAR_KEYS) {
      const scores = rows.filter(r => (r.pillar_scores as any)[key]).map(r => ((r.pillar_scores as any)[key] as any).score || 0);
      const score = Math.round(avg(scores));
      result[ae][key] = { score, level: score >= 65 ? 'strong' : score >= 40 ? 'developing' : 'needs work' };
    }
  }

  setCache('pillars', result);
  return c.json(result);
});

// What Good Looks Like
routes.get('/team/what-good-looks-like', async (c) => {
  const cached = getCached('wgll');
  if (cached) return c.json(cached);
  const allCalls: any[] = [];
  let from = 0;
  while (true) {
    const { data: page } = await supabase
      .from('ae_call_analysis')
      .select('call_quality_score, talk_ratio, question_count, script_adherence, patterns, pillar_scores')
      .order('call_quality_score', { ascending: false })
      .range(from, from + 999);
    if (!page || page.length === 0) break;
    allCalls.push(...page);
    if (page.length < 1000) break;
    from += 1000;
  }

  if (allCalls.length < 8) return c.json({ error: 'Not enough calls for comparison' }, 400);

  const cutoff = Math.max(1, Math.floor(allCalls.length * 0.25));
  const highQuality = allCalls.slice(0, cutoff);
  const lowQuality = allCalls.slice(-cutoff);

  const dims = ['contentEngine','marketContext','roiReframe','humor','urgency','contract','checkIn','theirBusiness','activeListening','personalStory','vsAgency','directness','opinionAsk','research','priceAnchor','assumptiveClose'];
  const dimLabels: Record<string,string> = {contentEngine:'Product explanation',marketContext:'Market context',roiReframe:'ROI reframing',humor:'Humor',urgency:'Urgency',contract:'Close language',checkIn:'Check-ins',theirBusiness:'Their business',activeListening:'Active listening',personalStory:'Personal stories',vsAgency:'vs Agencies',directness:'Directness',opinionAsk:'Asking opinions',research:'Research shown',priceAnchor:'Price anchoring',assumptiveClose:'Assumptive close'};

  const patterns = dims.map(d => {
    const highAvg = +(avg(highQuality.map(c => ((c.patterns as Record<string,number>) || {})[d] || 0))).toFixed(1);
    const lowAvg = +(avg(lowQuality.map(c => ((c.patterns as Record<string,number>) || {})[d] || 0))).toFixed(1);
    return { name: dimLabels[d] || d, dim: d, highAvg, lowAvg, diff: +(highAvg - lowAvg).toFixed(1) };
  }).sort((a, b) => b.diff - a.diff);

  const pillarHigh: Record<string, number> = {};
  const pillarLow: Record<string, number> = {};
  for (const key of PILLAR_KEYS) {
    const highVals = highQuality.filter(c => c.pillar_scores && (c.pillar_scores as any)[key]).map(c => ((c.pillar_scores as any)[key] as any).score || 0);
    const lowVals = lowQuality.filter(c => c.pillar_scores && (c.pillar_scores as any)[key]).map(c => ((c.pillar_scores as any)[key] as any).score || 0);
    pillarHigh[key] = highVals.length ? Math.round(avg(highVals)) : 0;
    pillarLow[key] = lowVals.length ? Math.round(avg(lowVals)) : 0;
  }

  const metrics = {
    high: {
      talkRatio: Math.round(avg(highQuality.map(c => c.talk_ratio || 0))),
      questionCount: Math.round(avg(highQuality.map(c => c.question_count || 0))),
      scriptAdherence: Math.round(avg(highQuality.map(c => c.script_adherence || 0))),
    },
    low: {
      talkRatio: Math.round(avg(lowQuality.map(c => c.talk_ratio || 0))),
      questionCount: Math.round(avg(lowQuality.map(c => c.question_count || 0))),
      scriptAdherence: Math.round(avg(lowQuality.map(c => c.script_adherence || 0))),
    },
  };

  const wgllResult = {
    highQualityCalls: highQuality.length,
    lowQualityCalls: lowQuality.length,
    totalCalls: allCalls.length,
    patterns,
    pillars: { high: pillarHigh, low: pillarLow },
    metrics,
  };
  setCache('wgll', wgllResult);
  return c.json(wgllResult);
});

// Narrative consistency
routes.get('/team/narrative-consistency', async (c) => {
  const cached = getCached('narrative-consistency');
  if (cached) return c.json(cached);
  const [{ data: calls, error: callsErr }, { data: profiles, error: profilesErr }] = await Promise.all([
    supabase.from('ae_call_analysis')
      .select('recorder_name, sections_hit, call_quality_score')
      .order('created_at', { ascending: false })
      .limit(500),
    supabase.from('ae_coaching_profiles')
      .select('recorder_name, avg_call_quality, total_calls'),
  ]);
  if (callsErr) return c.json({ error: callsErr.message }, 500);
  if (profilesErr) return c.json({ error: profilesErr.message }, 500);
  if (!calls || !profiles) return c.json({});

  const { SCRIPT_SECTIONS } = await import('../../analysis/script-sections.ts');

  const byAE = new Map<string, typeof calls>();
  for (const call of calls) {
    if (!byAE.has(call.recorder_name)) byAE.set(call.recorder_name, []);
    byAE.get(call.recorder_name)!.push(call);
  }

  const sectionConsistency: { section: string; sectionId: number; coverageByAE: Record<string, number>; teamAvg: number }[] = [];

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
    sectionConsistency.push({ section: section.name, sectionId: section.id, coverageByAE, teamAvg });
  }

  const topPerformers = profiles.filter(p => (p.avg_call_quality || 0) > 65).map(p => p.recorder_name);
  const strugglingAEs = profiles.filter(p => (p.avg_call_quality || 0) < 45 && p.total_calls >= 5).map(p => p.recorder_name);
  const driftAlerts: string[] = [];

  for (const sc of sectionConsistency) {
    const topAvg = topPerformers.length ? topPerformers.reduce((s, ae) => s + (sc.coverageByAE[ae] || 0), 0) / topPerformers.length : 0;
    const struggleAvg = strugglingAEs.length ? strugglingAEs.reduce((s, ae) => s + (sc.coverageByAE[ae] || 0), 0) / strugglingAEs.length : 0;
    if (topAvg > 60 && struggleAvg < 30 && topPerformers.length > 0 && strugglingAEs.length > 0) {
      driftAlerts.push(`"${sc.section}" — top performers cover it ${Math.round(topAvg)}% of the time, struggling AEs only ${Math.round(struggleAvg)}%`);
    }
  }

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
        if (aeVal < sc.teamAvg) deviationDetails.push(`Skips "${sc.section}" (${aeVal}% vs team ${sc.teamAvg}%)`);
      }
    }
    if (totalDeviation > 0) outliers.push({ ae, deviationScore: Math.round(totalDeviation / sectionConsistency.length), details: deviationDetails });
  }
  outliers.sort((a, b) => b.deviationScore - a.deviationScore);

  const consistencyResult = { sectionConsistency, driftAlerts, outliers };
  setCache('narrative-consistency', consistencyResult);
  return c.json(consistencyResult);
});

// Consolidated dashboard
routes.get('/dashboard', async (c) => {
  const cached = getCached('dashboard');
  if (cached) return c.json(cached);

  const [teamRes, benchRes, pillarsRes, teamByAE] = await Promise.all([
    supabase.from('ae_coaching_profiles').select('recorder_name, total_calls, avg_call_quality, avg_talk_ratio, avg_question_count, avg_script_adherence, top_strengths, top_weaknesses, coaching_recs, avg_patterns_all').order('avg_call_quality', { ascending: false }),
    supabase.from('ae_coaching_profiles').select('avg_call_quality, avg_talk_ratio, avg_question_count, avg_script_adherence'),
    supabase.from('ae_call_analysis').select('recorder_name, pillar_scores').order('created_at', { ascending: false }).limit(500),
    aeTeamMap(),
  ]);

  const team = (teamRes.data || [])
    .filter((p: any) => !isExcludedAE(p.recorder_name))
    .map((ae: any) => ({ ...ae, team: teamByAE[ae.recorder_name] || 'Other' }));
  const bench = benchRes.data || [];

  const pillarsByAE: Record<string, any> = {};
  const pillarCounts: Record<string, number> = {};
  for (const row of pillarsRes.data || []) {
    if (!row.pillar_scores || !row.recorder_name) continue;
    if ((pillarCounts[row.recorder_name] || 0) >= 20) continue;
    pillarCounts[row.recorder_name] = (pillarCounts[row.recorder_name] || 0) + 1;
    if (!pillarsByAE[row.recorder_name]) pillarsByAE[row.recorder_name] = {};
    const ps = row.pillar_scores as any;
    for (const key of PILLAR_KEYS) {
      if (!ps[key]) continue;
      if (!pillarsByAE[row.recorder_name][key]) pillarsByAE[row.recorder_name][key] = [];
      pillarsByAE[row.recorder_name][key].push(ps[key].score || 0);
    }
  }

  const teamPillars: Record<string, any> = {};
  for (const [ae, dims] of Object.entries(pillarsByAE)) {
    teamPillars[ae] = {};
    for (const [key, scores] of Object.entries(dims as Record<string, number[]>)) {
      const score = Math.round(avg(scores));
      teamPillars[ae][key] = { name: PILLAR_NAMES[key], score, level: score >= 65 ? 'strong' : score >= 40 ? 'developing' : 'needs work' };
    }
  }

  const result = {
    team,
    benchmarks: {
      teamAvg: {
        callQuality: Math.round(avg(bench.map((d: any) => d.avg_call_quality || 0))),
        talkRatio: Math.round(avg(bench.map((d: any) => d.avg_talk_ratio || 0))),
        questionCount: Math.round(avg(bench.map((d: any) => d.avg_question_count || 0))),
        scriptAdherence: Math.round(avg(bench.map((d: any) => d.avg_script_adherence || 0))),
      },
    },
    teamPillars,
  };

  setCache('dashboard', result);
  return c.json(result);
});

// ─── V1 endpoints — simplified team + AE views ──────────────────────────────

// V1 Team — AE rows with VBAT hit rate across last 60 days
routes.get('/v1/team', async (c) => {
  const cached = getCached('v1-team');
  if (cached) return c.json(cached);

  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [{ data: profiles }, { data: recentCalls }, teamByAE] = await Promise.all([
    supabase.from('ae_coaching_profiles').select('recorder_name, total_calls'),
    supabase.from('ae_call_analysis')
      .select('recorder_name, created_at, vbat_classification, call_tier, call_quality_score, outcome')
      .gte('created_at', sixtyDaysAgo)
      .order('created_at', { ascending: false })
      .limit(2000),
    aeTeamMap(),
  ]);

  if (!profiles) return c.json([]);

  const activeProfiles = profiles.filter((p: any) => !isExcludedAE(p.recorder_name));
  const callsByAE = new Map<string, any[]>();
  const recent60DayByAE = new Map<string, number>();

  for (const call of recentCalls || []) {
    const name = call.recorder_name;
    if (!name) continue;
    if (!callsByAE.has(name)) callsByAE.set(name, []);
    callsByAE.get(name)!.push(call);
    recent60DayByAE.set(name, (recent60DayByAE.get(name) || 0) + 1);
  }

  const rows = activeProfiles.map((p: any) => {
    const calls = callsByAE.get(p.recorder_name) || [];
    const last30 = calls.filter((c: any) => c.created_at >= thirtyDaysAgo);
    const prev30 = calls.filter((c: any) => c.created_at < thirtyDaysAgo);

    // VBAT hit rate across full 60-day window
    const vbatCalls = calls.filter((c: any) => c.vbat_classification && typeof (c.vbat_classification as any).hitCount === 'number');
    const vbatTotal = vbatCalls.reduce((s: number, c: any) => s + ((c.vbat_classification as any).hitCount || 0), 0);
    const vbatMax = vbatCalls.length * 4;
    const vbatPct = vbatMax > 0 ? Math.round((vbatTotal / vbatMax) * 100) : null;

    // Trend: last 30 days vs prior 30 days
    const lastVbat = last30.filter((c: any) => c.vbat_classification && typeof (c.vbat_classification as any).hitCount === 'number');
    const prevVbat = prev30.filter((c: any) => c.vbat_classification && typeof (c.vbat_classification as any).hitCount === 'number');
    const lastTotal = lastVbat.reduce((s: number, c: any) => s + ((c.vbat_classification as any).hitCount || 0), 0);
    const prevTotal = prevVbat.reduce((s: number, c: any) => s + ((c.vbat_classification as any).hitCount || 0), 0);
    const lastMax = lastVbat.length * 4;
    const prevMax = prevVbat.length * 4;
    const lastPct = lastMax > 0 ? Math.round((lastTotal / lastMax) * 100) : null;
    const prevPct = prevMax > 0 ? Math.round((prevTotal / prevMax) * 100) : null;
    let trend: 'up' | 'flat' | 'down' | 'new' = 'flat';
    if (lastPct === null || prevPct === null) trend = 'new';
    else if (lastPct - prevPct > 5) trend = 'up';
    else if (lastPct - prevPct < -5) trend = 'down';

    // Real close rate from HubSpot-grounded outcome (60d, won/lost only)
    const decided = calls.filter((c: any) => c.outcome === 'won' || c.outcome === 'lost');
    const wonCount = decided.filter((c: any) => c.outcome === 'won').length;
    const closeRate = decided.length > 0 ? Math.round((wonCount / decided.length) * 100) : null;

    const lastDecided = last30.filter((c: any) => c.outcome === 'won' || c.outcome === 'lost');
    const prevDecided = prev30.filter((c: any) => c.outcome === 'won' || c.outcome === 'lost');
    const lastClose = lastDecided.length > 0 ? Math.round((lastDecided.filter((c: any) => c.outcome === 'won').length / lastDecided.length) * 100) : null;
    const prevClose = prevDecided.length > 0 ? Math.round((prevDecided.filter((c: any) => c.outcome === 'won').length / prevDecided.length) * 100) : null;
    let closeTrend: 'up' | 'flat' | 'down' | 'new' = 'flat';
    if (lastClose === null || prevClose === null) closeTrend = 'new';
    else if (lastClose - prevClose > 5) closeTrend = 'up';
    else if (lastClose - prevClose < -5) closeTrend = 'down';

    return {
      name: p.recorder_name,
      team: teamByAE[p.recorder_name] || 'Other',
      totalCalls: p.total_calls || calls.length,
      recent60Days: recent60DayByAE.get(p.recorder_name) || 0,
      vbatHitRate: vbatPct,
      vbatCallsAnalyzed: vbatCalls.length,
      trend,
      closeRate,
      closeTrend,
      decidedCalls: decided.length,
      wonCalls: wonCount,
      lostCalls: decided.length - wonCount,
    };
  });

  rows.sort((a, b) => (b.closeRate ?? -1) - (a.closeRate ?? -1));
  setCache('v1-team', rows);
  return c.json(rows);
});

// V1 — Analyze Claap link → find call, trigger LLM regenerate, return recordingId
// Available to all authenticated users (AEs need this to dig into their own calls + peer calls).
routes.post('/v1/analyze-link', async (c) => {
  const { url } = await c.req.json() as { url: string };
  if (!url) return c.json({ error: 'Missing url' }, 400);

  // Claap URLs end with `-<recordingId>` where recordingId is 10-16 alphanumeric chars.
  // Examples:
  //   https://app.claap.io/daycore-x-wp-seo-ai-c-bIxluE4i2U-YEuXWxmkkJTc
  //   https://app.claap.io/wp-seo-ai-1/daycore-x-wp-seo-ai-c-bIxluE4i2U-YEuXWxmkkJTc
  // Strip trailing ?query/#hash first, then take the final [A-Za-z0-9]+ segment.
  const cleaned = url.split('?')[0].split('#')[0].replace(/\/$/, '');
  const tailMatch = cleaned.match(/([A-Za-z0-9]{8,})$/);
  const candidateId = tailMatch ? tailMatch[1] : null;

  let rec: { id: string; recorder_name: string | null; title: string | null; duration_seconds: number | null } | null = null;

  if (candidateId) {
    const { data: byId } = await supabase
      .from('recordings')
      .select('id, recorder_name, title, duration_seconds')
      .eq('id', candidateId)
      .maybeSingle();
    if (byId) rec = byId;
  }

  // Fallback 1: exact URL match (covers edge cases where the trailing segment isn't the ID)
  if (!rec) {
    const { data: byUrl } = await supabase
      .from('recordings')
      .select('id, recorder_name, title, duration_seconds')
      .eq('url', url)
      .maybeSingle();
    if (byUrl) rec = byUrl;
  }

  // Fallback 2: ilike on any URL containing the candidate fragment
  if (!rec && candidateId) {
    const { data: byFragment } = await supabase
      .from('recordings')
      .select('id, recorder_name, title, duration_seconds')
      .ilike('url', `%${candidateId}%`)
      .limit(1)
      .maybeSingle();
    if (byFragment) rec = byFragment;
  }

  if (!rec) {
    return c.json({ error: 'Call not found in database. Run sync (npm run sync) and try again.' }, 404);
  }

  // Check if analysis exists
  const { data: analysis } = await supabase
    .from('ae_call_analysis')
    .select('recording_id, vbat_classification, narrative_review')
    .eq('recording_id', rec.id)
    .maybeSingle();

  return c.json({
    recordingId: rec.id,
    recorderName: rec.recorder_name,
    title: rec.title,
    durationMinutes: Math.round((rec.duration_seconds || 0) / 60),
    hasAnalysis: !!analysis,
    hasVBAT: !!(analysis?.vbat_classification && Object.keys(analysis.vbat_classification as object).length > 0),
    hasNarrative: !!(analysis?.narrative_review && Object.keys(analysis.narrative_review as object).length > 0),
  });
});

// V1 AE — VBAT pattern across last 10 calls (within coaching window)
routes.get('/v1/ae/:name', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  if (isExcludedAE(name)) return c.json({ error: 'AE excluded from coaching view' }, 404);

  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

  const { data: calls } = await supabase
    .from('ae_call_analysis')
    .select('recording_id, title, created_at, duration_seconds, outcome, call_tier, call_quality_score, vbat_classification, smart_review, recording_url')
    .eq('recorder_name', name)
    .gte('created_at', sixtyDaysAgo)
    .order('created_at', { ascending: false })
    .limit(200);

  if (!calls) return c.json({ error: 'Not found' }, 404);

  const vbatCalls = calls.filter((c: any) => c.vbat_classification && typeof (c.vbat_classification as any).hitCount === 'number');
  const dims: Array<'V' | 'B' | 'A' | 'T'> = ['V', 'B', 'A', 'T'];
  const hitsByDim: Record<string, number> = { V: 0, B: 0, A: 0, T: 0 };
  for (const call of vbatCalls) {
    const vb = call.vbat_classification as any;
    for (const d of dims) if (vb[d]?.confirmed) hitsByDim[d]++;
  }
  const totalAnalyzed = vbatCalls.length;

  // Weakest dimension overall
  let weakest: string | null = null;
  let weakestRate = 2;
  for (const d of dims) {
    if (totalAnalyzed === 0) break;
    const rate = hitsByDim[d] / totalAnalyzed;
    if (rate < weakestRate) { weakestRate = rate; weakest = d; }
  }

  // ── Weekly trend: 9 weeks, hit rate per dimension per week
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const weeklyTrend: Array<{ weekStart: string; label: string; calls: number; V: number | null; B: number | null; A: number | null; T: number | null; overall: number | null }> = [];
  for (let i = 8; i >= 0; i--) {
    const end = now - (i * weekMs);
    const start = end - weekMs;
    const inWeek = vbatCalls.filter((c: any) => {
      const t = new Date(c.created_at).getTime();
      return t >= start && t < end;
    });
    const callCount = inWeek.length;
    const dimRates: Record<string, number | null> = { V: null, B: null, A: null, T: null };
    let overallHits = 0;
    for (const d of dims) {
      const hits = inWeek.filter((c: any) => (c.vbat_classification as any)[d]?.confirmed).length;
      dimRates[d] = callCount > 0 ? Math.round((hits / callCount) * 100) : null;
      overallHits += hits;
    }
    const overallMax = callCount * 4;
    const overallRate = overallMax > 0 ? Math.round((overallHits / overallMax) * 100) : null;
    const weekStart = new Date(start).toISOString().slice(0, 10);
    const labelDate = new Date(start);
    const label = `${labelDate.toLocaleDateString('en', { month: 'short' })} ${labelDate.getDate()}`;
    weeklyTrend.push({ weekStart, label, calls: callCount, V: dimRates.V, B: dimRates.B, A: dimRates.A, T: dimRates.T, overall: overallRate });
  }

  // ── Worst-miss pinned calls: 3 recent calls where weakest dimension was missed
  let weakestPinnedCalls: any[] = [];
  if (weakest) {
    weakestPinnedCalls = vbatCalls
      .filter((c: any) => (c.vbat_classification as any)[weakest!]?.confirmed === false)
      .slice(0, 3)
      .map((c: any) => ({
        recordingId: c.recording_id,
        title: c.title || 'Untitled',
        createdAt: c.created_at,
        recordingUrl: c.recording_url || '',
        evidence: (c.vbat_classification as any)[weakest!]?.evidence || '',
      }));
  }

  // ── Real close rate from HubSpot-grounded outcome
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const decided = calls.filter((c: any) => c.outcome === 'won' || c.outcome === 'lost');
  const won = decided.filter((c: any) => c.outcome === 'won').length;
  const closeRate = decided.length > 0 ? Math.round((won / decided.length) * 100) : null;
  const lastDecided = decided.filter((c: any) => c.created_at >= thirtyDaysAgo);
  const prevDecided = decided.filter((c: any) => c.created_at < thirtyDaysAgo);
  const lastClose = lastDecided.length > 0 ? Math.round((lastDecided.filter((c: any) => c.outcome === 'won').length / lastDecided.length) * 100) : null;
  const prevClose = prevDecided.length > 0 ? Math.round((prevDecided.filter((c: any) => c.outcome === 'won').length / prevDecided.length) * 100) : null;

  return c.json({
    name,
    windowDays: 60,
    totalRecent: calls.length,
    vbatAnalyzed: totalAnalyzed,
    hitsByDim,
    weakestDimension: weakest,
    weeklyTrend,
    weakestPinnedCalls,
    closeRate,
    decidedCalls: decided.length,
    wonCalls: won,
    lostCalls: decided.length - won,
    lastClose,
    prevClose,
    calls: calls.slice(0, 30).map((c: any) => ({
      recordingId: c.recording_id,
      title: c.title || 'Untitled',
      createdAt: c.created_at,
      duration: Math.round((c.duration_seconds || 0) / 60),
      outcome: c.outcome || '',
      tier: c.call_tier || 'B',
      quality: c.call_quality_score || 0,
      vbat: c.vbat_classification || null,
      oneThingToChange: (c.smart_review as any)?.oneThingToChange || '',
      summary: (c.smart_review as any)?.summary || '',
    })),
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// V1 — Call Engine view (option A: behaviors as dimensions)
// Powered by within-AE causal analysis. The 4 dimensions are the highest-impact
// behaviors from src/analysis/call-engine: Contract / commitment, Assumptive close,
// ROI reframe, Compounding value framing.
// ═══════════════════════════════════════════════════════════════════════════

const CALL_ENGINE_BEHAVIORS = [
  { key: 'contract', label: 'Contract / commitment', short: 'C' },
  { key: 'assumptiveClose', label: 'Assumptive close', short: 'A' },
  { key: 'roiReframe', label: 'ROI reframe', short: 'R' },
  { key: 'compounding', label: 'Compounding value', short: 'V' },
] as const;

type BehaviorKey = typeof CALL_ENGINE_BEHAVIORS[number]['key'];
const BEHAVIOR_KEYS: BehaviorKey[] = CALL_ENGINE_BEHAVIORS.map(b => b.key) as BehaviorKey[];

function behaviorPresent(patterns: any, key: BehaviorKey): boolean {
  if (!patterns) return false;
  const v = patterns[key];
  return typeof v === 'number' && v >= 1;
}

routes.get('/v1/team/call-engine', async (c) => {
  const cached = getCached('v1-team-call-engine');
  if (cached) return c.json(cached);

  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [{ data: profiles }, { data: recentCalls }, teamByAE] = await Promise.all([
    supabase.from('ae_coaching_profiles').select('recorder_name, total_calls'),
    supabase.from('ae_call_analysis')
      .select('recorder_name, created_at, patterns, outcome')
      .gte('created_at', sixtyDaysAgo)
      .order('created_at', { ascending: false })
      .limit(2000),
    aeTeamMap(),
  ]);

  if (!profiles) return c.json([]);

  const activeProfiles = profiles.filter((p: any) => !isExcludedAE(p.recorder_name));
  const callsByAE = new Map<string, any[]>();
  for (const call of recentCalls || []) {
    if (!call.recorder_name) continue;
    if (!callsByAE.has(call.recorder_name)) callsByAE.set(call.recorder_name, []);
    callsByAE.get(call.recorder_name)!.push(call);
  }

  const rows = activeProfiles.map((p: any) => {
    const calls = callsByAE.get(p.recorder_name) || [];
    if (calls.length === 0) {
      return {
        name: p.recorder_name,
        team: teamByAE[p.recorder_name] || 'Other',
        totalCalls: p.total_calls || 0,
        recent60Days: 0,
        adoptionRate: null,
        adoptionTrend: 'new' as const,
        decidedCalls: 0,
        wonCalls: 0,
        lostCalls: 0,
        closeRate: null,
        byBehavior: Object.fromEntries(BEHAVIOR_KEYS.map(k => [k, null])) as Record<string, number | null>,
      };
    }

    // Per-behavior adoption rate over 60 days
    const byBehavior: Record<string, number | null> = {};
    let sumAdoption = 0;
    let counted = 0;
    for (const k of BEHAVIOR_KEYS) {
      const presentCount = calls.filter((c: any) => behaviorPresent(c.patterns, k)).length;
      const rate = Math.round((presentCount / calls.length) * 100);
      byBehavior[k] = rate;
      sumAdoption += rate;
      counted++;
    }
    const adoptionRate = counted > 0 ? Math.round(sumAdoption / counted) : null;

    // Trend: avg adoption last 30 vs prior 30
    const last30 = calls.filter((c: any) => c.created_at >= thirtyDaysAgo);
    const prev30 = calls.filter((c: any) => c.created_at < thirtyDaysAgo);
    const avgAdoption = (cs: any[]) => {
      if (cs.length === 0) return null;
      let s = 0;
      for (const k of BEHAVIOR_KEYS) s += cs.filter(c => behaviorPresent(c.patterns, k)).length / cs.length;
      return Math.round((s / BEHAVIOR_KEYS.length) * 100);
    };
    const lastAdoption = avgAdoption(last30);
    const prevAdoption = avgAdoption(prev30);
    let adoptionTrend: 'up' | 'flat' | 'down' | 'new' = 'flat';
    if (lastAdoption === null || prevAdoption === null) adoptionTrend = 'new';
    else if (lastAdoption - prevAdoption > 5) adoptionTrend = 'up';
    else if (lastAdoption - prevAdoption < -5) adoptionTrend = 'down';

    // Real close rate
    const decided = calls.filter((c: any) => c.outcome === 'won' || c.outcome === 'lost');
    const won = decided.filter((c: any) => c.outcome === 'won').length;
    const closeRate = decided.length > 0 ? Math.round((won / decided.length) * 100) : null;

    return {
      name: p.recorder_name,
      team: teamByAE[p.recorder_name] || 'Other',
      totalCalls: p.total_calls || calls.length,
      recent60Days: calls.length,
      adoptionRate,
      adoptionTrend,
      decidedCalls: decided.length,
      wonCalls: won,
      lostCalls: decided.length - won,
      closeRate,
      byBehavior,
    };
  });

  rows.sort((a, b) => (b.adoptionRate ?? -1) - (a.adoptionRate ?? -1));
  setCache('v1-team-call-engine', rows);
  return c.json(rows);
});

routes.get('/v1/ae/:name/call-engine', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  if (isExcludedAE(name)) return c.json({ error: 'AE excluded' }, 404);

  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

  const { data: calls } = await supabase
    .from('ae_call_analysis')
    .select('recording_id, title, created_at, duration_seconds, outcome, patterns, recording_url, smart_review')
    .eq('recorder_name', name)
    .gte('created_at', sixtyDaysAgo)
    .order('created_at', { ascending: false })
    .limit(200);

  if (!calls) return c.json({ error: 'Not found' }, 404);

  // ── Per-behavior adoption (60-day)
  const byBehavior: Record<string, { adoption: number | null; topAvg: number | null; gap: number | null }> = {};

  // Compute team-wide top-AE benchmark adoption (avg across all AEs in 60d, used as "top performer" baseline)
  // Pull all AE patterns to build comparator
  const { data: allCalls60 } = await supabase
    .from('ae_call_analysis')
    .select('recorder_name, patterns, outcome, created_at')
    .gte('created_at', sixtyDaysAgo)
    .limit(3000);

  // Build top performer set: top 25% AEs by close rate (≥10 decided calls)
  const aeStats = new Map<string, { wins: number; decided: number; calls: any[] }>();
  for (const c of allCalls60 || []) {
    if (!c.recorder_name || isExcludedAE(c.recorder_name)) continue;
    if (!aeStats.has(c.recorder_name)) aeStats.set(c.recorder_name, { wins: 0, decided: 0, calls: [] });
    const s = aeStats.get(c.recorder_name)!;
    s.calls.push(c);
    if (c.outcome === 'won') { s.wins++; s.decided++; }
    else if (c.outcome === 'lost') { s.decided++; }
  }
  const aeRanked = Array.from(aeStats.entries())
    .filter(([, s]) => s.decided >= 10)
    .map(([n, s]) => ({ name: n, calls: s.calls, closeRate: s.wins / s.decided }))
    .sort((a, b) => b.closeRate - a.closeRate);
  // Guard: when no AE has enough decided (won/lost) calls, aeRanked is empty.
  // Math.max(1, …) would otherwise force topN=1 and read aeRanked[0] (undefined) → 500.
  const topN = aeRanked.length > 0 ? Math.max(1, Math.floor(aeRanked.length * 0.25)) : 0;
  const topCalls: any[] = [];
  for (let i = 0; i < topN; i++) topCalls.push(...aeRanked[i].calls);

  for (const k of BEHAVIOR_KEYS) {
    const adopt = calls.filter(c => behaviorPresent(c.patterns, k)).length / Math.max(1, calls.length);
    const topAdopt = topCalls.length > 0
      ? topCalls.filter(c => behaviorPresent(c.patterns, k)).length / topCalls.length
      : null;
    byBehavior[k] = {
      adoption: Math.round(adopt * 100),
      topAvg: topAdopt !== null ? Math.round(topAdopt * 100) : null,
      gap: topAdopt !== null ? Math.round((adopt - topAdopt) * 100) : null,
    };
  }

  // ── Weekly trend: 9 weeks × 4 behaviors
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const weeklyTrend: any[] = [];
  for (let i = 8; i >= 0; i--) {
    const end = now - (i * weekMs);
    const start = end - weekMs;
    const inWeek = calls.filter(c => {
      const t = new Date(c.created_at).getTime();
      return t >= start && t < end;
    });
    const week: any = {
      weekStart: new Date(start).toISOString().slice(0, 10),
      label: `${new Date(start).toLocaleDateString('en', { month: 'short' })} ${new Date(start).getDate()}`,
      calls: inWeek.length,
    };
    for (const k of BEHAVIOR_KEYS) {
      week[k] = inWeek.length > 0 ? Math.round((inWeek.filter(c => behaviorPresent(c.patterns, k)).length / inWeek.length) * 100) : null;
    }
    weeklyTrend.push(week);
  }

  // ── Pinned: lost calls where the AE skipped the highest-causal behavior (contract)
  // and ideally also skipped a second one. Score 0-4 = number of behaviors missed.
  const pinned = calls
    .filter(c => c.outcome === 'lost')
    .map(c => ({
      ...c,
      missedCount: BEHAVIOR_KEYS.filter(k => !behaviorPresent(c.patterns, k)).length,
      missedKeys: BEHAVIOR_KEYS.filter(k => !behaviorPresent(c.patterns, k)),
    }))
    .sort((a, b) => b.missedCount - a.missedCount)
    .slice(0, 3)
    .map(c => ({
      recordingId: c.recording_id,
      title: c.title || 'Untitled',
      createdAt: c.created_at,
      recordingUrl: c.recording_url || '',
      missedCount: c.missedCount,
      missedKeys: c.missedKeys,
      summary: (c.smart_review as any)?.oneThingToChange || (c.smart_review as any)?.summary || '',
    }));

  // ── Real close rate
  const decided = calls.filter(c => c.outcome === 'won' || c.outcome === 'lost');
  const won = decided.filter(c => c.outcome === 'won').length;
  const closeRate = decided.length > 0 ? Math.round((won / decided.length) * 100) : null;
  const expectedRate = aeRanked.length > 0 ? Math.round((aeRanked.reduce((s, a) => s + a.closeRate, 0) / aeRanked.length) * 100) : null;
  const residual = (closeRate !== null && expectedRate !== null) ? closeRate - expectedRate : null;

  return c.json({
    name,
    windowDays: 60,
    totalRecent: calls.length,
    behaviors: CALL_ENGINE_BEHAVIORS,
    byBehavior,
    weeklyTrend,
    pinnedLostCalls: pinned,
    closeRate,
    decidedCalls: decided.length,
    wonCalls: won,
    lostCalls: decided.length - won,
    expectedRate,
    residual,
  });
});


export default routes;
