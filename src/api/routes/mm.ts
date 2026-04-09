import { Hono } from 'hono';
import { supabase, getCached, setCache } from '../shared.ts';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const routes = new Hono();

const MM_DEAL_FILTER = 'deal_name.ilike.%- MM%,deal_name.ilike.%MM -%,deal_name.ilike.%MM Pilot%,deal_name.ilike.%MM Expansion%,deal_name.ilike.%MidMarket%,deal_name.ilike.%Mid Market%,deal_name.ilike.%Mid market%';

function isActualMM(dealName: string): boolean {
  if (!dealName) return false;
  return /\bMM\b/i.test(dealName) || /mid[\s-]?market/i.test(dealName);
}

// Market thesis
routes.get('/mm/market-thesis', (c) => {
  const paths = [join(process.cwd(), 'work', 'midmarket', 'WP SEO AI - Market Thesis - April 2026.md')];
  for (const p of paths) { if (existsSync(p)) return c.text(readFileSync(p, 'utf-8')); }
  return c.text('Market thesis not found', 404);
});

// Narrative
routes.get('/mm/narrative', (c) => {
  const paths = [join(process.cwd(), 'work', 'midmarket', 'MM Narrative V3 - April 2026.md')];
  for (const p of paths) { if (existsSync(p)) return c.text(readFileSync(p, 'utf-8')); }
  return c.text('Narrative not found', 404);
});

routes.get('/mm/narrative-b2c', (c) => {
  const paths = [join(process.cwd(), 'work', 'midmarket', 'MM Narrative V3 - B2C - April 2026.md')];
  for (const p of paths) { if (existsSync(p)) return c.text(readFileSync(p, 'utf-8')); }
  return c.text('B2C Narrative not found', 404);
});

// MM Calls
routes.get('/mm/calls', async (c) => {
  const cached = getCached('mm-calls');
  if (cached) return c.json(cached);
  const { data, error } = await supabase.from('recordings')
    .select('id, title, deal_name, channel_name, recorder_name, created_at, duration_seconds, url, key_takeaways, outline')
    .or(MM_DEAL_FILTER).order('created_at', { ascending: false });
  if (error) return c.json({ error: error.message }, 500);

  const mmRecs = (data || []).filter(r => isActualMM(r.deal_name));
  const byDeal: Record<string, any> = {};
  mmRecs.forEach(r => {
    const deal = r.deal_name || 'Unknown';
    if (!byDeal[deal]) byDeal[deal] = { deal, recordings: [], totalMinutes: 0, aes: new Set(), latestDate: r.created_at };
    byDeal[deal].recordings.push(r);
    byDeal[deal].totalMinutes += Math.round((r.duration_seconds || 0) / 60);
    if (r.recorder_name) byDeal[deal].aes.add(r.recorder_name);
  });

  const deals = Object.values(byDeal).map((d: any) => ({ ...d, aes: [...d.aes] })).sort((a: any, b: any) => new Date(b.latestDate).getTime() - new Date(a.latestDate).getTime());
  const result = {
    totalRecordings: mmRecs.length, totalDeals: deals.length,
    totalMinutes: mmRecs.reduce((s, r) => s + Math.round((r.duration_seconds || 0) / 60), 0),
    aes: [...new Set(mmRecs.map(r => r.recorder_name).filter(Boolean))], deals,
  };
  setCache('mm-calls', result);
  return c.json(result);
});

// Single MM call
routes.get('/mm/call/:id', async (c) => {
  const id = c.req.param('id');
  const { data, error } = await supabase.from('recordings')
    .select('id, title, deal_name, channel_name, recorder_name, created_at, duration_seconds, url, transcript_text, key_takeaways, outline')
    .eq('id', id).single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

// AI MM call analysis
routes.post('/mm/analyze-call', async (c) => {
  const { recordingId } = await c.req.json() as { recordingId: string };
  const { data: rec, error } = await supabase.from('recordings')
    .select('id, title, deal_name, recorder_name, created_at, duration_seconds, transcript_text, key_takeaways, outline')
    .eq('id', recordingId).single();
  if (error || !rec) return c.json({ error: 'Recording not found' }, 404);
  if (!rec.transcript_text) return c.json({ error: 'No transcript available' }, 400);

  const transcript = rec.transcript_text.length > 12000 ? rec.transcript_text.substring(0, 12000) + '\n[...transcript truncated...]' : rec.transcript_text;

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 2000,
      messages: [{ role: 'user', content: `You are analyzing a mid-market sales call for WP SEO AI, a Search Visibility Platform (SEO + GEO + SEA managed service).\n\nCONTEXT:\n- Call: "${rec.title}" with ${rec.recorder_name} on ${new Date(rec.created_at).toISOString().split('T')[0]}\n- Deal: ${rec.deal_name}\n- Duration: ${Math.round((rec.duration_seconds || 0) / 60)} minutes\n\nOUR MM SALES PROCESS (6 stages):\nStage 0: BDR Qualification (deal hypothesis)\nStage 1: Problem Framing (no demo, no pitch — reframe SEO/GEO as systemic problem, test rejection of status quo)\nStage 2: Current State Deconstruction (map workflow, expose waste, identify bottlenecks)\nStage 2.5: Validation Demo (system proof gate, not a sales demo)\nStage 3: Economic Framing (translate waste into business impact, decision map)\nStage 4: Proposal & Commitment (mutual action plan)\nStage 5: Close or Clean Loss\n\nKEY RULES:\n- Multi-threading is mandatory (single-threaded deals cannot pass Stage 2)\n- Artifacts required at every stage\n- Problem statement must be in buyer language\n- No demo before discovery is complete\n\nTRANSCRIPT:\n${transcript}\n\nAnalyze this call and return a JSON object with exactly these fields:\n{\n  "stageDetected": "0" | "1" | "2" | "2.5" | "3" | "4" | "5",\n  "stageConfidence": "high" | "medium" | "low",\n  "processCompliance": { "score": 0-100, "followed": [], "missed": [], "violations": [] },\n  "narrativeDelivery": { "marketShiftLanded": true/false, "threeChannelExplained": true/false, "ceilingValidated": true/false, "managedServicePositioned": true/false, "notes": "" },\n  "multiThreading": { "stakeholdersMentioned": [], "newAccessRequested": true/false, "notes": "" },\n  "discoveryDepth": { "score": 0-100, "inputsCaptured": [], "inputsMissing": [], "buyerLanguageUsed": true/false },\n  "learnings": [{ "category": "Process"|"ICP"|"Pricing"|"Narrative"|"Objections"|"Competitive"|"Discovery"|"Expansion"|"Team", "insight": "", "evidence": "", "confidenceImpact": "" }],\n  "keyMoments": [{ "timestamp": "", "type": "strength"|"missed_opportunity"|"objection"|"breakthrough", "description": "", "recommendation": "" }],\n  "overallAssessment": "",\n  "actionItems": []\n}\n\nReturn ONLY valid JSON, no markdown formatting.` }]
    });
    const text = msg.content[0].type === 'text' ? msg.content[0].text : '';
    let analysis;
    try { analysis = JSON.parse(text); } catch { const jsonMatch = text.match(/\{[\s\S]*\}/); analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : { error: 'Failed to parse analysis', raw: text }; }

    const { error: upsertError } = await supabase.from('mm_call_analysis').upsert({
      recording_id: rec.id, deal_name: rec.deal_name, recorder_name: rec.recorder_name,
      title: rec.title, created_at: rec.created_at, duration_seconds: rec.duration_seconds,
      analysis, analyzed_at: new Date().toISOString(),
    }, { onConflict: 'recording_id' });
    if (upsertError) console.warn('Could not store MM analysis:', upsertError.message);
    return c.json({ recording: rec, analysis });
  } catch (err: any) { return c.json({ error: err.message }, 500); }
});

// All MM analyses
routes.get('/mm/analyses', async (c) => {
  const cached = getCached('mm-analyses');
  if (cached) return c.json(cached);
  const { data, error } = await supabase.from('mm_call_analysis').select('*').order('created_at', { ascending: false });
  if (error) return c.json({ analyses: [], learnings: [] });

  const allLearnings: any[] = [];
  (data || []).forEach(a => {
    const analysis = a.analysis as any;
    if (analysis?.learnings) {
      analysis.learnings.forEach((l: any) => {
        allLearnings.push({ ...l, dealName: a.deal_name, recorderName: a.recorder_name, callTitle: a.title, callDate: a.created_at, recordingId: a.recording_id });
      });
    }
  });
  const byCat: Record<string, number> = {};
  allLearnings.forEach(l => { byCat[l.category] = (byCat[l.category] || 0) + 1; });
  const result = { analyses: data || [], learnings: allLearnings, learningsByCategory: byCat, totalCalls: (data || []).length, totalLearnings: allLearnings.length };
  setCache('mm-analyses', result);
  return c.json(result);
});

export default routes;
