import { Hono } from 'hono';
import { requireRole } from '../auth.ts';
import { supabase, avg } from '../shared.ts';

const routes = new Hono();

// Submit feedback on a coaching moment
routes.post('/feedback', async (c) => {
  const body = await c.req.json() as { recordingId: string; category: string; excerpt?: string; vote: 'up' | 'down'; voter?: string };
  if (!body.recordingId || !body.category || !body.vote) return c.json({ error: 'Missing recordingId, category, or vote' }, 400);
  const id = `fb_${body.recordingId}_${body.category}_${Date.now()}`;
  const { error } = await supabase.from('coaching_feedback').upsert({
    id, recording_id: body.recordingId, moment_category: body.category,
    moment_excerpt: body.excerpt?.slice(0, 300) || '', vote: body.vote,
    voter: body.voter || 'anonymous', created_at: new Date().toISOString(),
  });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});

// Detection health
routes.get('/feedback/health', async (c) => {
  const { data, error } = await supabase.from('coaching_feedback').select('moment_category, vote');
  if (error) return c.json({ error: error.message }, 500);
  const byCategory: Record<string, { up: number; down: number; total: number }> = {};
  for (const row of data || []) {
    if (!byCategory[row.moment_category]) byCategory[row.moment_category] = { up: 0, down: 0, total: 0 };
    byCategory[row.moment_category][row.vote as 'up' | 'down']++;
    byCategory[row.moment_category].total++;
  }
  const health = Object.entries(byCategory).map(([category, counts]) => ({
    category, totalVotes: counts.total, upVotes: counts.up, downVotes: counts.down,
    trustScore: counts.total > 0 ? Math.round(counts.up / counts.total * 100) : null,
    status: counts.total < 3 ? 'insufficient_data' : counts.up / counts.total >= 0.7 ? 'trusted' : counts.up / counts.total >= 0.4 ? 'review' : 'untrusted',
  })).sort((a, b) => (a.trustScore ?? 100) - (b.trustScore ?? 100));
  return c.json(health);
});

// Feedback for specific call
routes.get('/feedback/:recordingId', async (c) => {
  const recordingId = c.req.param('recordingId');
  const { data, error } = await supabase.from('coaching_feedback').select('moment_category, vote').eq('recording_id', recordingId);
  if (error) return c.json({ error: error.message }, 500);
  const counts: Record<string, { up: number; down: number }> = {};
  for (const row of data || []) {
    if (!counts[row.moment_category]) counts[row.moment_category] = { up: 0, down: 0 };
    counts[row.moment_category][row.vote as 'up' | 'down']++;
  }
  return c.json(counts);
});

// Create intervention
routes.post('/interventions', requireRole('lead'), async (c) => {
  const body = await c.req.json() as { recorderName: string; focusArea: string; focusPillar?: string; description: string; source?: string; notes?: string };
  if (!body.recorderName || !body.focusArea || !body.description) return c.json({ error: 'Missing recorderName, focusArea, or description' }, 400);

  const [{ data: profile }, { data: recentCalls }] = await Promise.all([
    supabase.from('ae_coaching_profiles').select('avg_call_quality, avg_talk_ratio, avg_question_count, avg_script_adherence').eq('recorder_name', body.recorderName).single(),
    supabase.from('ae_call_analysis').select('pillar_scores').eq('recorder_name', body.recorderName).order('created_at', { ascending: false }).limit(10),
  ]);

  let baselinePillar: number | null = null;
  if (body.focusPillar && recentCalls && recentCalls.length > 0) {
    const pillarScores = recentCalls.filter(c => c.pillar_scores && (c.pillar_scores as any)[body.focusPillar!]).map(c => ((c.pillar_scores as any)[body.focusPillar!] as any).score || 0);
    if (pillarScores.length > 0) baselinePillar = Math.round(pillarScores.reduce((a, b) => a + b, 0) / pillarScores.length);
  }

  let baselineMetric: number | null = null;
  if (profile) {
    if (body.focusArea.toLowerCase().includes('talk')) baselineMetric = profile.avg_talk_ratio;
    else if (body.focusArea.toLowerCase().includes('question') || body.focusArea.toLowerCase().includes('discovery')) baselineMetric = profile.avg_question_count;
    else if (body.focusArea.toLowerCase().includes('script')) baselineMetric = profile.avg_script_adherence;
    else baselineMetric = profile.avg_call_quality;
  }

  const id = `int_${body.recorderName.replace(/\s+/g, '_')}_${Date.now()}`;
  const { error } = await supabase.from('coaching_interventions').upsert({
    id, recorder_name: body.recorderName, focus_area: body.focusArea, focus_pillar: body.focusPillar || null,
    description: body.description, source: body.source || 'dashboard', baseline_quality: profile?.avg_call_quality || null,
    baseline_metric: baselineMetric, baseline_pillar_score: baselinePillar, created_by: 'lead', notes: body.notes || null,
    created_at: new Date().toISOString(),
  });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true, id });
});

// AE interventions
routes.get('/ae/:name/interventions', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  const { data, error } = await supabase.from('coaching_interventions').select('*').eq('recorder_name', name).order('created_at', { ascending: false }).limit(20);
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data || []);
});

// All active interventions
routes.get('/interventions', requireRole('lead'), async (c) => {
  const { data, error } = await supabase.from('coaching_interventions').select('*').in('status', ['active', 'measured']).order('created_at', { ascending: false }).limit(50);
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data || []);
});

// Measure intervention outcomes
routes.post('/interventions/measure', requireRole('lead'), async (c) => {
  const { data: interventions } = await supabase.from('coaching_interventions').select('*').eq('status', 'active').limit(100);
  if (!interventions || interventions.length === 0) return c.json({ measured: 0 });

  let measured = 0;
  for (const int of interventions) {
    const { data: newCalls } = await supabase.from('ae_call_analysis')
      .select('call_quality_score, talk_ratio, question_count, script_adherence, pillar_scores, created_at')
      .eq('recorder_name', int.recorder_name).gt('created_at', int.created_at)
      .order('created_at', { ascending: false }).limit(20);

    if (!newCalls || newCalls.length < 5) continue;

    const followupQuality = Math.round(avg(newCalls.map(c => c.call_quality_score || 0)));
    const fa = int.focus_area.toLowerCase();
    let followupMetric: number | null = null;
    if (fa.includes('talk')) followupMetric = Math.round(avg(newCalls.map(c => c.talk_ratio || 0)));
    else if (fa.includes('question') || fa.includes('discovery')) followupMetric = Math.round(avg(newCalls.map(c => c.question_count || 0)));
    else if (fa.includes('script')) followupMetric = Math.round(avg(newCalls.map(c => c.script_adherence || 0)));
    else followupMetric = followupQuality;

    let followupPillar: number | null = null;
    if (int.focus_pillar) {
      const ps = newCalls.filter(c => c.pillar_scores && (c.pillar_scores as any)[int.focus_pillar]).map(c => ((c.pillar_scores as any)[int.focus_pillar] as any).score || 0);
      if (ps.length > 0) followupPillar = Math.round(avg(ps));
    }

    const qualityDelta = followupQuality - (int.baseline_quality || 0);
    const metricImproved = followupMetric !== null && int.baseline_metric !== null;
    let status = 'measured';
    if (qualityDelta > 5 || (metricImproved && Math.abs(followupMetric! - int.baseline_metric!) > 3)) {
      if (fa.includes('talk')) status = Math.abs(followupMetric! - 50) < Math.abs(int.baseline_metric! - 50) ? 'effective' : 'ineffective';
      else status = followupMetric! > int.baseline_metric! ? 'effective' : 'ineffective';
    }

    await supabase.from('coaching_interventions').update({
      followup_at: new Date().toISOString(), followup_quality: followupQuality,
      followup_metric: followupMetric, followup_pillar_score: followupPillar,
      calls_since: newCalls.length, status,
    }).eq('id', int.id);
    measured++;
  }
  return c.json({ measured });
});

// Dismiss intervention
routes.put('/interventions/:id/dismiss', requireRole('lead'), async (c) => {
  const id = c.req.param('id');
  const { error } = await supabase.from('coaching_interventions').update({ status: 'dismissed' }).eq('id', id);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});

// Calibration study
routes.get('/calibration', requireRole('lead'), async (c) => {
  const allCalls: any[] = [];
  let from = 0;
  while (true) {
    const { data: page } = await supabase.from('ae_call_analysis').select('outcome, talk_ratio, question_count, script_adherence, call_quality_score, pillar_scores').in('outcome', ['won', 'lost']).range(from, from + 999);
    if (!page || page.length === 0) break;
    allCalls.push(...page);
    if (page.length < 1000) break;
    from += 1000;
  }
  if (allCalls.length < 20) return c.json({ error: 'Need 20+ won/lost calls for calibration' }, 400);

  const winRate = (calls: any[]) => calls.length === 0 ? 0 : Math.round(calls.filter(c => c.outcome === 'won').length / calls.length * 100);

  const questionBuckets = [{ label: '0-10', min: 0, max: 10 }, { label: '11-15', min: 11, max: 15 }, { label: '16-21', min: 16, max: 21 }, { label: '22+', min: 22, max: 999 }].map(b => {
    const calls = allCalls.filter(c => c.question_count >= b.min && c.question_count <= b.max);
    return { ...b, count: calls.length, winRate: winRate(calls), avgQuality: +(avg(calls.map(c => c.call_quality_score || 0))).toFixed(1) };
  });
  const talkBuckets = [{ label: '<45%', min: 0, max: 44 }, { label: '45-55%', min: 45, max: 55 }, { label: '56-65%', min: 56, max: 65 }, { label: '66%+', min: 66, max: 200 }].map(b => {
    const calls = allCalls.filter(c => c.talk_ratio >= b.min && c.talk_ratio <= b.max);
    return { ...b, count: calls.length, winRate: winRate(calls), avgQuality: +(avg(calls.map(c => c.call_quality_score || 0))).toFixed(1) };
  });
  const scriptBuckets = [{ label: '0-25%', min: 0, max: 25 }, { label: '26-50%', min: 26, max: 50 }, { label: '51-75%', min: 51, max: 75 }, { label: '76%+', min: 76, max: 100 }].map(b => {
    const calls = allCalls.filter(c => c.script_adherence >= b.min && c.script_adherence <= b.max);
    return { ...b, count: calls.length, winRate: winRate(calls), avgQuality: +(avg(calls.map(c => c.call_quality_score || 0))).toFixed(1) };
  });
  const qualityBuckets = [{ label: '0-30', min: 0, max: 30 }, { label: '31-50', min: 31, max: 50 }, { label: '51-65', min: 51, max: 65 }, { label: '66-80', min: 66, max: 80 }, { label: '81+', min: 81, max: 100 }].map(b => {
    const calls = allCalls.filter(c => (c.call_quality_score || 0) >= b.min && (c.call_quality_score || 0) <= b.max);
    return { ...b, count: calls.length, winRate: winRate(calls) };
  });

  const pillarKeys = ['control', 'discovery', 'gapCreation', 'objectionHandling', 'advancement'];
  const pillarCalibration = pillarKeys.map(key => {
    const withPillar = allCalls.filter(c => c.pillar_scores && (c.pillar_scores as any)[key]);
    const strong = withPillar.filter(c => ((c.pillar_scores as any)[key] as any).score >= 65);
    const developing = withPillar.filter(c => { const s = ((c.pillar_scores as any)[key] as any).score; return s >= 40 && s < 65; });
    const needsWork = withPillar.filter(c => ((c.pillar_scores as any)[key] as any).score < 40);
    return { pillar: key, strong: { count: strong.length, winRate: winRate(strong) }, developing: { count: developing.length, winRate: winRate(developing) }, needsWork: { count: needsWork.length, winRate: winRate(needsWork) } };
  });

  const won = allCalls.filter(c => c.outcome === 'won');
  const lost = allCalls.filter(c => c.outcome === 'lost');

  return c.json({
    totalCalls: allCalls.length, wonCalls: won.length, lostCalls: lost.length, overallWinRate: winRate(allCalls),
    wonVsLost: {
      won: { avgQuality: +(avg(won.map(c => c.call_quality_score || 0))).toFixed(1), avgTalkRatio: +(avg(won.map(c => c.talk_ratio || 0))).toFixed(1), avgQuestions: +(avg(won.map(c => c.question_count || 0))).toFixed(1), avgScript: +(avg(won.map(c => c.script_adherence || 0))).toFixed(1) },
      lost: { avgQuality: +(avg(lost.map(c => c.call_quality_score || 0))).toFixed(1), avgTalkRatio: +(avg(lost.map(c => c.talk_ratio || 0))).toFixed(1), avgQuestions: +(avg(lost.map(c => c.question_count || 0))).toFixed(1), avgScript: +(avg(lost.map(c => c.script_adherence || 0))).toFixed(1) },
    },
    questionBuckets, talkBuckets, scriptBuckets, qualityBuckets, pillarCalibration,
    thresholdRecommendations: {
      questionTarget: questionBuckets.reduce((best, b) => b.winRate > best.winRate ? b : best).label,
      talkRatioSweet: talkBuckets.reduce((best, b) => b.winRate > best.winRate ? b : best).label,
      scriptMinimum: scriptBuckets.reduce((best, b) => b.winRate > best.winRate ? b : best).label,
      qualityThreshold: qualityBuckets.reduce((best, b) => b.winRate > best.winRate ? b : best).label,
    },
  });
});

export default routes;
