import { Hono } from 'hono';
import { requireRole } from '../auth.ts';
import { supabase, getCached, setCache, clearCache, slugify, groupCallsIntoDeals } from '../shared.ts';
import { linkRecordingsToDeals, trackContentUsage, computeNarrativePerformance, scoreDealHealth, getPipelineSummary } from '../../analysis/deal-intelligence.ts';

const routes = new Hono();

// Deal Board
routes.get('/deals', async (c) => {
  const cached = getCached('deals');
  if (cached) return c.json(cached);
  const cutoffDate = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
  const [{ data, error }, { data: narrativeIds }] = await Promise.all([
    supabase.from('ae_call_analysis')
      .select('recording_id, recorder_name, title, deal_name, created_at, duration_seconds, recording_url, outcome, call_verdict, call_quality_score, question_count, patterns')
      .gte('created_at', cutoffDate).order('created_at', { ascending: false }).limit(1000),
    supabase.from('ae_call_analysis').select('recording_id').not('narrative_review', 'is', null).limit(1000),
  ]);
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json([]);
  const narrativeSet = new Set((narrativeIds || []).map((r: any) => r.recording_id));
  const deals = groupCallsIntoDeals(data);
  const result: any[] = [];

  for (const [, deal] of deals) {
    const sortedCalls = [...deal.calls].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    const latest = sortedCalls[0];
    const latestPatterns = (latest.patterns as Record<string, number>) || {};
    const latestVerdict = latest.call_verdict || '';
    const discoveryDone = (latest.question_count > 12) || (latestPatterns.theirBusiness > 0);
    const demoShown = deal.calls.some((call: any) => { const p = (call.patterns as Record<string, number>) || {}; return p.contentEngine > 5 || p.visibility > 3; });
    const pricingDiscussed = deal.calls.some((call: any) => { const p = (call.patterns as Record<string, number>) || {}; return p.pricing > 0; });
    const noNextStep = latestVerdict.includes('No Close') || latestVerdict.includes('Never attempted to close');
    const nextStepDefined = !noNextStep && (latestPatterns.contract > 0 || latestPatterns.assumptiveClose > 0);
    const daysSinceLatest = (Date.now() - new Date(latest.created_at || 0).getTime()) / (1000 * 60 * 60 * 24);
    const stalling = daysSinceLatest > 7 && latest.outcome !== 'won';
    const thinkItOver = latestVerdict.includes('Accepted') || latestVerdict.includes('think');
    let column: string;
    if (deal.calls.some((call: any) => call.outcome === 'won')) column = 'closed';
    else if (noNextStep || stalling || thinkItOver) column = 'attention';
    else column = 'active';

    result.push({
      id: slugify(deal.name), name: deal.name, ae: latest.recorder_name, callCount: deal.calls.length,
      lastCallDate: latest.created_at, column,
      healthSignals: { discoveryDone, demoShown, pricingDiscussed, nextStepDefined, noNextStep, stalling, thinkItOver },
      calls: sortedCalls.map((call: any) => ({ recording_id: call.recording_id, title: call.title, date: call.created_at, quality: call.call_quality_score || 0, hasNarrative: narrativeSet.has(call.recording_id) })),
    });
  }
  result.sort((a, b) => (b.lastCallDate || '').localeCompare(a.lastCallDate || ''));
  setCache('deals', result);
  return c.json(result);
});

// Deal Timeline
routes.get('/deal/:name', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  const [{ data: byDeal, error }, { data: byTitle }, { data: narrativeIds }] = await Promise.all([
    supabase.from('ae_call_analysis').select('recording_id, recorder_name, title, deal_name, created_at, duration_seconds, recording_url, outcome, talk_ratio, question_count, script_adherence, longest_monologue, call_quality_score, patterns, highlights, sections_hit, sections_missed, prospect_engagement, call_verdict, pillar_scores').ilike('deal_name', `%${name}%`).order('created_at', { ascending: true }),
    supabase.from('ae_call_analysis').select('recording_id, recorder_name, title, deal_name, created_at, duration_seconds, recording_url, outcome, talk_ratio, question_count, script_adherence, longest_monologue, call_quality_score, patterns, highlights, sections_hit, sections_missed, prospect_engagement, call_verdict, pillar_scores').ilike('title', `%${name}%`).order('created_at', { ascending: true }),
    supabase.from('ae_call_analysis').select('recording_id').not('narrative_review', 'is', null).limit(1000),
  ]);
  if (error) return c.json({ error: error.message }, 500);
  const seen = new Set<string>();
  const data: any[] = [];
  for (const call of [...(byDeal || []), ...(byTitle || [])]) { if (!seen.has(call.recording_id)) { seen.add(call.recording_id); data.push(call); } }
  data.sort((a: any, b: any) => (a.created_at || '').localeCompare(b.created_at || ''));
  const narrativeSet = new Set((narrativeIds || []).map((r: any) => r.recording_id));
  return c.json(data.map((call: any) => ({ ...call, hasNarrative: narrativeSet.has(call.recording_id) })));
});

// Pipeline summary
routes.get('/pipeline', requireRole('lead'), async (c) => {
  const segment = c.req.query('segment');
  const cached = getCached(`pipeline_${segment || 'all'}`);
  if (cached) return c.json(cached);
  const summary = await getPipelineSummary(segment || undefined);
  setCache(`pipeline_${segment || 'all'}`, summary);
  return c.json(summary);
});

// Deal health score
routes.get('/deals/:id/score', requireRole('lead'), async (c) => {
  const dealId = c.req.param('id')!;
  const score = await scoreDealHealth(dealId);
  return c.json({ deal_id: dealId, score });
});

// Link recordings to deals
routes.post('/deals/link', requireRole('lead'), async (c) => {
  const result = await linkRecordingsToDeals();
  clearCache();
  return c.json(result);
});

// Content tracking
routes.post('/content/track', requireRole('lead'), async (c) => {
  const usage = await c.req.json();
  const ok = await trackContentUsage(usage);
  return ok ? c.json({ ok: true }) : c.json({ error: 'Failed to track' }, 500);
});

// Content performance
routes.get('/content/performance', requireRole('lead'), async (c) => {
  const cached = getCached('narrative_perf');
  if (cached) return c.json(cached);
  const perf = await computeNarrativePerformance();
  setCache('narrative_perf', perf);
  return c.json(perf);
});

export default routes;
