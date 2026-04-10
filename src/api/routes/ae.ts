import { Hono } from 'hono';
import { requireRole } from '../auth.ts';
import { supabase, avg, PILLAR_KEYS, PILLAR_NAMES } from '../shared.ts';

const routes = new Hono();

// AE Profile
routes.get('/ae/:name', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  const { data, error } = await supabase
    .from('ae_coaching_profiles')
    .select('recorder_name, total_calls, won_calls, lost_calls, win_rate, avg_duration_won, avg_duration_lost, avg_script_adherence, avg_talk_ratio, avg_question_count, avg_longest_monologue, avg_call_quality, avg_patterns_won, avg_patterns_lost, avg_patterns_all, top_strengths, top_weaknesses, coaching_recs, updated_at')
    .eq('recorder_name', name)
    .single();
  if (error) return c.json({ error: error.message }, 404);
  return c.json(data);
});

// AE's calls
routes.get('/ae/:name/calls', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  const limit = parseInt(c.req.query('limit') || '100');
  const offset = parseInt(c.req.query('offset') || '0');
  const full = c.req.query('full') === 'true';
  const columns = full
    ? 'recording_id, recorder_name, title, deal_name, created_at, duration_seconds, recording_url, outcome, talk_ratio, question_count, script_adherence, longest_monologue, call_quality_score, patterns, highlights, sections_hit, sections_missed, prospect_engagement, call_verdict, pillar_scores, smart_review'
    : 'recording_id, recorder_name, title, deal_name, created_at, duration_seconds, recording_url, outcome, talk_ratio, question_count, script_adherence, call_quality_score, sections_hit, sections_missed, prospect_engagement, call_verdict, pillar_scores';
  const { data, error } = await supabase
    .from('ae_call_analysis')
    .select(columns)
    .eq('recorder_name', name)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

// AE progression — rolling 5-call averages for trend charts
routes.get('/ae/:name/trend', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  const { data, error } = await supabase
    .from('ae_call_analysis')
    .select('created_at, outcome, talk_ratio, question_count, script_adherence, call_quality_score, patterns')
    .eq('recorder_name', name)
    .order('created_at', { ascending: true });
  if (error) return c.json({ error: error.message }, 500);
  if (!data || data.length < 3) return c.json([]);
  const windowSize = 5;
  const points = [];
  for (let i = windowSize - 1; i < data.length; i++) {
    const window = data.slice(i - windowSize + 1, i + 1);
    const avgTalk = Math.round(window.reduce((s, d) => s + (d.talk_ratio || 0), 0) / windowSize);
    const avgQs = Math.round(window.reduce((s, d) => s + (d.question_count || 0), 0) / windowSize);
    const avgScript = Math.round(window.reduce((s, d) => s + (d.script_adherence || 0), 0) / windowSize);
    const avgQuality = Math.round(window.reduce((s, d) => s + (d.call_quality_score || 0), 0) / windowSize);
    points.push({
      date: data[i].created_at?.slice(0, 10) || '',
      callIndex: i + 1,
      talkRatio: avgTalk,
      questionCount: avgQs,
      scriptAdherence: avgScript,
      callQuality: avgQuality,
    });
  }
  return c.json(points);
});

// Available months with calls for an AE
routes.get('/ae/:name/months', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  let allCalls: any[] = [];
  let from = 0;
  while (true) {
    const { data: page } = await supabase.from('ae_call_analysis')
      .select('recording_id, title, created_at, call_quality_score, outcome, duration_seconds, talk_ratio, question_count, call_tier')
      .eq('recorder_name', name).order('created_at', { ascending: false }).range(from, from + 199);
    if (!page || page.length === 0) break;
    allCalls.push(...page);
    if (page.length < 200) break;
    from += 200;
  }
  if (allCalls.length === 0) return c.json([]);

  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const grouped = new Map<string, { label: string; sortKey: string; calls: any[] }>();
  for (const call of allCalls) {
    if (!call.created_at) continue;
    const d = new Date(call.created_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = `${monthNames[d.getMonth()]} ${d.getFullYear()}`;
    if (!grouped.has(key)) grouped.set(key, { label, sortKey: key, calls: [] });
    grouped.get(key)!.calls.push({
      id: call.recording_id,
      title: call.title || 'Untitled',
      date: call.created_at,
      quality: call.call_quality_score || 0,
      outcome: call.outcome || '',
      duration: Math.round((call.duration_seconds || 0) / 60),
      talkRatio: call.talk_ratio || 0,
      questions: call.question_count || 0,
      tier: call.call_tier || 'B',
    });
  }

  const months = Array.from(grouped.values())
    .sort((a, b) => b.sortKey.localeCompare(a.sortKey))
    .map(m => ({ label: m.label, sortKey: m.sortKey, callCount: m.calls.length, calls: m.calls }));
  return c.json(months);
});

// AE Pillars
routes.get('/ae/:name/pillars', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  const { data, error } = await supabase.from('ae_call_analysis').select('pillar_scores').eq('recorder_name', name).order('created_at', { ascending: false }).limit(20);
  if (error) return c.json({ error: error.message }, 500);
  if (!data || data.length === 0) return c.json({});
  const result: Record<string, any> = {};
  for (const key of PILLAR_KEYS) {
    const scores = data.filter(d => d.pillar_scores && (d.pillar_scores as any)[key]).map(d => ((d.pillar_scores as any)[key] as any).score || 0);
    const score = Math.round(avg(scores));
    result[key] = { name: PILLAR_NAMES[key], score, level: score >= 65 ? 'strong' : score >= 40 ? 'developing' : 'needs work' };
  }
  return c.json(result);
});

// AE Deep Analysis
routes.post('/ae/:name/deep-analysis', requireRole('lead'), async (c) => {
  const name = decodeURIComponent(c.req.param('name')!);
  const { data: profile } = await supabase.from('ae_coaching_profiles').select('total_calls, avg_talk_ratio, avg_question_count, avg_script_adherence, avg_call_quality, top_strengths, top_weaknesses').eq('recorder_name', name).single();

  const calls: any[] = [];
  let from = 0;
  while (true) {
    const { data: page } = await supabase.from('ae_call_analysis').select('title, created_at, duration_seconds, talk_ratio, question_count, script_adherence, call_quality_score, outcome, smart_review, call_verdict, sections_missed').eq('recorder_name', name).order('created_at', { ascending: false }).range(from, from + 99);
    if (!page || page.length === 0) break;
    calls.push(...page);
    if (page.length < 100) break;
    from += 100;
  }
  if (calls.length < 3) return c.json({ error: 'Not enough calls to generate deep analysis (need at least 3)' }, 400);

  const { data: allProfiles } = await supabase.from('ae_coaching_profiles').select('avg_talk_ratio, avg_question_count, avg_call_quality');
  const teamBenchmarks = {
    avgTalkRatio: Math.round(avg((allProfiles || []).map(p => p.avg_talk_ratio))),
    avgQuestions: Math.round(avg((allProfiles || []).map(p => p.avg_question_count))),
    avgQuality: Math.round(avg((allProfiles || []).map(p => p.avg_call_quality))),
  };

  const SECTION_NAMES = ['Origin','AI Search','SEO Bridge','Tools Gap','96.55%','Manual Pain','Sitemap','Pling','Clusters','Fisher/1999','Snowball','Pricing'];
  const callSummaries = calls.map(c => {
    const sr = c.smart_review || {};
    return {
      title: c.title || 'Untitled', date: (c.created_at || '').slice(0, 10),
      duration: Math.round((c.duration_seconds || 0) / 60), talkRatio: c.talk_ratio || 0,
      questionCount: c.question_count || 0, scriptAdherence: c.script_adherence || 0,
      quality: c.call_quality_score || 0, outcome: c.outcome || '',
      summary: sr.summary || '', oneThingToChange: sr.oneThingToChange || '',
      objections: (sr.objections || []).map((o: any) => ({ prospectSaid: o.prospectSaid || '', aeSaid: o.aeSaid || '', handling: o.handling || '' })),
      buyingSignals: (sr.buyingSignals || []).map((b: any) => ({ prospectSaid: b.prospectSaid || '', aeSaid: b.aeSaid || '', didAdvance: b.didAdvance || false })),
      callVerdict: Array.isArray(c.call_verdict) ? c.call_verdict : [],
      scriptMissed: (c.sections_missed || []).map((id: number) => SECTION_NAMES[id - 1] || `Section ${id}`),
    };
  });

  const profileData = {
    totalCalls: profile?.total_calls || calls.length, avgTalkRatio: profile?.avg_talk_ratio || 0,
    avgQuestions: profile?.avg_question_count || 0, avgScriptAdherence: profile?.avg_script_adherence || 0,
    avgQuality: profile?.avg_call_quality || 0, strengths: profile?.top_strengths || [], weaknesses: profile?.top_weaknesses || [],
  };

  const { analyzeAEDeep } = await import('../../analysis/narrative-coach.ts');
  const result = await analyzeAEDeep(name, callSummaries, profileData, teamBenchmarks);
  if (!result) return c.json({ error: 'Failed to generate deep analysis. Check ANTHROPIC_API_KEY.' }, 500);
  return c.json(result);
});

// Rep Coaching Cards
routes.get('/reps', async (c) => {
  const [{ data: profiles, error: profilesErr }, { data: allCalls, error: callsErr }] = await Promise.all([
    supabase.from('ae_coaching_profiles').select('recorder_name, total_calls, avg_call_quality, top_weaknesses'),
    supabase.from('ae_call_analysis').select('recorder_name, created_at, call_quality_score, talk_ratio, question_count, patterns').order('created_at', { ascending: false }).limit(500),
  ]);
  if (profilesErr) return c.json({ error: profilesErr.message }, 500);
  if (callsErr) return c.json({ error: callsErr.message }, 500);
  if (!profiles) return c.json([]);

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const callsByAE = new Map<string, any[]>();
  for (const call of (allCalls || [])) {
    if (!callsByAE.has(call.recorder_name)) callsByAE.set(call.recorder_name, []);
    const aeCalls = callsByAE.get(call.recorder_name)!;
    if (aeCalls.length < 20) aeCalls.push(call);
  }

  const result: any[] = [];
  for (const profile of profiles) {
    const aeCalls = callsByAE.get(profile.recorder_name) || [];
    const recent10 = aeCalls.slice(0, 10);
    const older10 = aeCalls.slice(10, 20);
    const recentAvg = avg(recent10.map((c: any) => c.call_quality_score || 0));
    const olderAvg = older10.length > 0 ? avg(older10.map((c: any) => c.call_quality_score || 0)) : recentAvg;
    const diff = recentAvg - olderAvg;
    const qualityTrend = diff > 3 ? 'up' : diff < -3 ? 'down' : 'flat';

    const avgTalkRatio = avg(aeCalls.map((c: any) => c.talk_ratio || 0));
    const avgQuestionCount = avg(aeCalls.map((c: any) => c.question_count || 0));
    const avgPatterns: Record<string, number> = {};
    for (const d of ['contract', 'contentEngine', 'roiReframe', 'assumptiveClose']) avgPatterns[d] = avg(aeCalls.map((c: any) => ((c.patterns as Record<string, number>) || {})[d] || 0));

    let coachingFocus: string;
    if (avgTalkRatio > 62) coachingFocus = `Talk less, listen more — averaging ${Math.round(avgTalkRatio)}%, aim for under 55%`;
    else if (avgQuestionCount < 16) coachingFocus = `Ask more discovery questions — averaging ${Math.round(avgQuestionCount)} per call, top performers ask 22+`;
    else if (avgPatterns.contract < 0.5) coachingFocus = 'Practice closing — end every call with a concrete next step';
    else if (avgPatterns.contentEngine < 8) coachingFocus = "Explain the product more deeply — prospects need to understand what they're buying";
    else if (avgPatterns.roiReframe < 0.3) coachingFocus = "Frame price as investment — say 'investering' not 'kosten'";
    else {
      const weaknesses = profile.top_weaknesses as string[] | null;
      coachingFocus = weaknesses && weaknesses.length > 0 ? `Focus on improving: ${weaknesses[0]}` : 'Maintain consistency across all calls';
    }

    result.push({ name: profile.recorder_name, totalCalls: profile.total_calls || aeCalls.length, qualityTrend, avgQuality: profile.avg_call_quality || Math.round(recentAvg), coachingFocus, recentCallCount: aeCalls.filter((c: any) => c.created_at >= thirtyDaysAgo).length });
  }
  result.sort((a, b) => (b.avgQuality || 0) - (a.avgQuality || 0));
  return c.json(result);
});

// Coaching Brief
routes.get('/rep/:name/coaching-brief', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  const [{ data: profile, error: profileErr }, { data: calls, error: callsErr }] = await Promise.all([
    supabase.from('ae_coaching_profiles').select('*').eq('recorder_name', name).single(),
    supabase.from('ae_call_analysis').select('recording_id, recorder_name, title, created_at, call_quality_score, call_verdict, talk_ratio, question_count, patterns, highlights, recording_url').eq('recorder_name', name).order('created_at', { ascending: false }).limit(10),
  ]);
  if (profileErr) return c.json({ error: profileErr.message }, 404);
  if (callsErr) return c.json({ error: callsErr.message }, 500);
  if (!calls || calls.length === 0) return c.json({ error: 'No calls found for this rep' }, 404);

  const avgTalkRatio = avg(calls.map((c: any) => c.talk_ratio || 0));
  const avgQuestionCount = avg(calls.map((c: any) => c.question_count || 0));
  const avgPatterns: Record<string, number> = {};
  for (const d of ['contract', 'contentEngine', 'roiReframe', 'assumptiveClose']) avgPatterns[d] = avg(calls.map((c: any) => ((c.patterns as Record<string, number>) || {})[d] || 0));

  let focusArea: string, focusSearchCategory: string, strengthCategory: string;
  if (avgTalkRatio > 62) { focusArea = `Talk less, listen more — averaging ${Math.round(avgTalkRatio)}%, aim for under 55%`; focusSearchCategory = 'Long Monologue'; strengthCategory = 'Active Listening'; }
  else if (avgQuestionCount < 16) { focusArea = `Ask more discovery questions — averaging ${Math.round(avgQuestionCount)} per call, top performers ask 22+`; focusSearchCategory = 'No Summary Before Pitch'; strengthCategory = 'Deep Discovery'; }
  else if (avgPatterns.contract < 0.5) { focusArea = 'Practice closing — end every call with a concrete next step'; focusSearchCategory = 'No Close'; strengthCategory = 'Assumptive Close'; }
  else if (avgPatterns.contentEngine < 8) { focusArea = "Explain the product more deeply — prospects need to understand what they're buying"; focusSearchCategory = 'Product Not Explained'; strengthCategory = 'Live Proof'; }
  else if (avgPatterns.roiReframe < 0.3) { focusArea = "Frame price as investment — say 'investering' not 'kosten'"; focusSearchCategory = 'Price Objection'; strengthCategory = 'ROI Reframe'; }
  else { const w = profile?.top_weaknesses as string[] | null; focusArea = w && w.length > 0 ? `Focus on improving: ${w[0]}` : 'Maintain consistency'; focusSearchCategory = 'coachable'; strengthCategory = 'Captured Buy Signal'; }

  let evidence: any = null;
  for (const call of calls) {
    const hl = (call.highlights as any[]) || [];
    const match = hl.find((h: any) => h.category === focusSearchCategory || h.type === 'coachable');
    if (match) { evidence = { callTitle: call.title || 'Untitled call', url: call.recording_url || '', timestamp: match.timestampDisplay || '0:00', excerpt: match.excerpt || '' }; break; }
  }

  let watchAndLearn: any = null;
  const { data: otherCalls } = await supabase.from('ae_call_analysis').select('recorder_name, title, recording_url, highlights').neq('recorder_name', name).order('call_quality_score', { ascending: false }).limit(15);
  if (otherCalls) {
    for (const call of otherCalls) {
      const hl = (call.highlights as any[]) || [];
      const match = hl.find((h: any) => h.type === 'strength' && (h.category === strengthCategory || h.category === 'Captured Buy Signal' || h.category === 'Assumptive Close'));
      if (match) { watchAndLearn = { ae: call.recorder_name, callTitle: call.title || 'Untitled call', url: call.recording_url || '', timestamp: match.timestampDisplay || '0:00', excerpt: match.excerpt || '', category: match.category || '' }; break; }
    }
  }

  const last5 = calls.slice(0, 5);
  const prev5 = calls.slice(5, 10);
  const recentAvg = Math.round(avg(last5.map((c: any) => c.call_quality_score || 0)));
  const previousAvg = prev5.length > 0 ? Math.round(avg(prev5.map((c: any) => c.call_quality_score || 0))) : recentAvg;
  const progressDiff = recentAvg - previousAvg;
  const direction = progressDiff > 3 ? 'Improving' : progressDiff < -3 ? 'Declining' : 'Steady';

  return c.json({
    name, avgQuality: profile?.avg_call_quality || recentAvg,
    qualityTrend: direction === 'Improving' ? 'up' : direction === 'Declining' ? 'down' : 'flat',
    currentFocus: { area: focusArea, reason: focusArea, evidence: evidence || { callTitle: '', url: '', timestamp: '', excerpt: '' } },
    watchAndLearn: watchAndLearn || { ae: '', callTitle: '', url: '', timestamp: '', excerpt: '', category: '' },
    progress: { recent: recentAvg, previous: previousAvg, direction },
    lastFiveCalls: last5.map((call: any) => {
      const verdict = call.call_verdict || '';
      return { title: call.title || 'Untitled call', date: call.created_at, quality: call.call_quality_score || 0, quickVerdict: verdict.includes(',') ? verdict.split(',')[0].trim() : (verdict || 'OK') };
    }),
  });
});

export default routes;
