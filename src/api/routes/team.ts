import { Hono } from 'hono';
import { requireRole } from '../auth.ts';
import { supabase, getCached, setCache, avg, PILLAR_KEYS, PILLAR_NAMES } from '../shared.ts';

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

export default routes;
