import { Hono } from 'hono';
import { requireRole } from '../auth.ts';
import { supabase, getCached, setCache, avg, PILLAR_KEYS, PILLAR_NAMES } from '../shared.ts';
import { isExcludedAE } from '../../config/excluded-aes.ts';
import { coachingWindowCutoff, COACHING_WINDOW_DAYS } from '../../config/coaching-window.ts';

const routes = new Hono();

// Team overview
routes.get('/team', async (c) => {
  const cached = getCached('team');
  if (cached) return c.json(cached);
  const { data, error } = await supabase
    .from('ae_coaching_profiles')
    .select('recorder_name, total_calls, avg_call_quality, avg_talk_ratio, avg_question_count, avg_script_adherence, top_strengths, top_weaknesses, coaching_recs, avg_patterns_all')
    .order('avg_call_quality', { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  setCache('team', data);
  return c.json(data);
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

  const [teamRes, benchRes, pillarsRes] = await Promise.all([
    supabase.from('ae_coaching_profiles').select('recorder_name, total_calls, avg_call_quality, avg_talk_ratio, avg_question_count, avg_script_adherence, top_strengths, top_weaknesses, coaching_recs, avg_patterns_all').order('avg_call_quality', { ascending: false }),
    supabase.from('ae_coaching_profiles').select('avg_call_quality, avg_talk_ratio, avg_question_count, avg_script_adherence'),
    supabase.from('ae_call_analysis').select('recorder_name, pillar_scores').order('created_at', { ascending: false }).limit(500),
  ]);

  const team = teamRes.data || [];
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

  const [{ data: profiles }, { data: recentCalls }] = await Promise.all([
    supabase.from('ae_coaching_profiles').select('recorder_name, total_calls'),
    supabase.from('ae_call_analysis')
      .select('recorder_name, created_at, vbat_classification, call_tier, call_quality_score')
      .gte('created_at', sixtyDaysAgo)
      .order('created_at', { ascending: false })
      .limit(2000),
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

    return {
      name: p.recorder_name,
      totalCalls: p.total_calls || calls.length,
      recent60Days: recent60DayByAE.get(p.recorder_name) || 0,
      vbatHitRate: vbatPct,
      vbatCallsAnalyzed: vbatCalls.length,
      trend,
    };
  });

  rows.sort((a, b) => (b.vbatHitRate ?? -1) - (a.vbatHitRate ?? -1));
  setCache('v1-team', rows);
  return c.json(rows);
});

// V1 — Analyze Claap link → find call, trigger LLM regenerate, return recordingId
routes.post('/v1/analyze-link', requireRole('lead'), async (c) => {
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

  return c.json({
    name,
    windowDays: 60,
    totalRecent: calls.length,
    vbatAnalyzed: totalAnalyzed,
    hitsByDim,
    weakestDimension: weakest,
    weeklyTrend,
    weakestPinnedCalls,
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

// V1 — Pre-meeting brief
// Given an AE and prospect context, generate a Sonnet-powered prep brief
// that surfaces the AE's weakest VBAT dimensions, industry-matched customer proof,
// and concrete questions to ask early in the meeting.
routes.post('/v1/pre-meeting-brief', async (c) => {
  const { aeName, prospectContext } = await c.req.json() as { aeName: string; prospectContext: string };
  if (!aeName?.trim() || !prospectContext?.trim()) {
    return c.json({ error: 'aeName and prospectContext are required' }, 400);
  }

  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

  // Pull AE VBAT history
  const { data: calls } = await supabase
    .from('ae_call_analysis')
    .select('vbat_classification, created_at, title, call_quality_score, outcome')
    .eq('recorder_name', aeName)
    .gte('created_at', sixtyDaysAgo)
    .order('created_at', { ascending: false })
    .limit(100);

  const vbatCalls = (calls || []).filter((c: any) => c.vbat_classification && typeof (c.vbat_classification as any).hitCount === 'number');
  const dims: Array<'V' | 'B' | 'A' | 'T'> = ['V', 'B', 'A', 'T'];
  const hits: Record<string, number> = { V: 0, B: 0, A: 0, T: 0 };
  for (const call of vbatCalls) {
    const vb = call.vbat_classification as any;
    for (const d of dims) if (vb[d]?.confirmed) hits[d]++;
  }
  const hitRates: Record<string, number | null> = {};
  for (const d of dims) {
    hitRates[d] = vbatCalls.length > 0 ? Math.round((hits[d] / vbatCalls.length) * 100) : null;
  }

  // Weakest dimension
  let weakestDim: string | null = null;
  let weakestRate = 101;
  for (const d of dims) {
    if (hitRates[d] !== null && hitRates[d]! < weakestRate) {
      weakestDim = d;
      weakestRate = hitRates[d]!;
    }
  }

  const VBAT_NAMES: Record<string, string> = { V: 'Value', B: 'Budget', A: 'Authority', T: 'Timeline' };

  // Try to load industry database for relevant customer proof
  let industryData: any = null;
  try {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const path = join(process.cwd(), 'industries-data.json');
    industryData = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    // Industry data optional — brief still works without it
  }

  // Call Sonnet for brief
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const anthropic = new Anthropic();

  const aeStatsBlock = vbatCalls.length > 0
    ? `${aeName}'s VBAT performance over last 60 days (${vbatCalls.length} classified calls):
- V (Value): ${hitRates.V}% confirmation rate
- B (Budget): ${hitRates.B}% confirmation rate
- A (Authority): ${hitRates.A}% confirmation rate
- T (Timeline): ${hitRates.T}% confirmation rate

Weakest dimension: ${weakestDim ? `${weakestDim} (${VBAT_NAMES[weakestDim]}) at ${weakestRate}%` : 'insufficient data'}`
    : `No VBAT data available for ${aeName} yet — brief will rely on prospect context only.`;

  const industryCatalog = industryData?.industries
    ? industryData.industries.slice(0, 88).map((i: any, idx: number) =>
        `${idx + 1}. ${i.industry} (${i.total_companies} customers, ${i.finland} FI / ${i.international} INTL)
   Examples: ${i.sample_descriptions.slice(0, 2).join(' | ')}`
      ).join('\n\n')
    : '(Industry catalog unavailable)';

  const systemPrompt = `You are a sales coach preparing an AE for a specific upcoming meeting. Your job: produce a tight, actionable pre-meeting brief.

You have access to:
1. The AE's VBAT qualification performance across their recent calls (which dimensions they consistently hit vs. miss)
2. WP SEO AI's customer industry catalog for matching the prospect to relevant proof points

VBAT = Marc's qualification framework used by WP SEO AI AEs:
- V = Value (prospect articulates why they need this in their own words)
- B = Budget (explicit spend discussion)
- A = Authority (decision-maker confirmed)
- T = Timeline (concrete decision date within ~1 week)

INDUSTRY CATALOG (WP SEO AI's customer base, 2,490 customers across 88 industries):
${industryCatalog}

Your brief must be SHORT, CONCRETE, and ACTIONABLE. AEs read this 5 minutes before their meeting. Every word earns its place.`;

  const userPrompt = `AE STATS:
${aeStatsBlock}

PROSPECT CONTEXT (what the AE knows going in):
${prospectContext}

Generate the pre-meeting brief as ONLY valid JSON (no markdown):
{
  "prospectRead": "1-2 sentence read of who this prospect is and what they care about",
  "industryMatch": {
    "primary": "best-matching industry name from catalog",
    "customerCount": number (from catalog),
    "proofPoint": "one sentence the AE can say about similar customers WP SEO AI serves (use counts, not company names)"
  },
  "focusDimension": {
    "letter": "${weakestDim || 'T'}",
    "name": "${weakestDim ? VBAT_NAMES[weakestDim] : 'Timeline'}",
    "why": "one sentence on why this is the AE's focus based on their history"
  },
  "questionsToAsk": [
    "specific question 1 tailored to the prospect + focus dimension",
    "specific question 2",
    "specific question 3"
  ],
  "likelyObjections": [
    {"objection": "prospect's likely pushback", "response": "one-line handle"}
  ],
  "openingLine": "a concrete opening hook the AE can use in the first 30 seconds",
  "redFlags": ["things to watch for that signal the deal is at risk"]
}

Keep each field punchy. No fluff. Favor specifics from the prospect context over generic advice.`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: userPrompt },
        ],
      }],
    });

    const responseText = msg.content[0].type === 'text' ? msg.content[0].text : '{}';
    let parsed: any;
    try {
      parsed = JSON.parse(responseText.trim().replace(/^```json\s*/, '').replace(/\s*```$/, ''));
    } catch {
      return c.json({ error: 'AI returned malformed JSON', raw: responseText.slice(0, 300) }, 502);
    }

    return c.json({
      aeName,
      prospectContext,
      generatedAt: new Date().toISOString(),
      aeStats: {
        vbatCallsAnalyzed: vbatCalls.length,
        hitRates,
        weakestDimension: weakestDim,
      },
      brief: parsed,
      usage: {
        input_tokens: msg.usage?.input_tokens,
        output_tokens: msg.usage?.output_tokens,
      },
    });
  } catch (err: any) {
    return c.json({ error: 'Brief generation failed: ' + err.message }, 500);
  }
});

export default routes;
