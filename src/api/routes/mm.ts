import { Hono } from 'hono';
import { supabase, getCached, setCache } from '../shared.ts';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getLlmModel } from '../../config/settings.ts';

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
      model: 'claude-sonnet-5', max_tokens: 2000,
      thinking: { type: 'disabled' },  // pure JSON extraction — no thinking (Sonnet 5 runs adaptive by default, which would eat max_tokens)
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

// ── Scenario Planner Chat ──────────────────────────────────────────────────

const SCENARIO_SYSTEM = `You are the GTM strategist for WP SEO AI, a Search Visibility Platform (SEO + GEO + SEA managed service). You help the Head of GTM think through the mid-market motion roll-out by adjusting the revenue scenario and writing the narrative.

CONTEXT:
- Target: €2M NEW deal ARR by EOY 2026 (expansion revenue from pilot conversions is upside, not counted)
- Tiers: Pilot €15K ARR (6-month term), Medium €50K ARR (12 months), Large €100K+ ARR (multi-year)
- Pilots convert at month-5 review. Conversion rates are adjustable.
- AE productivity: configurable €K/quarter per fully ramped AE. New hires ramp at 50%/75%/100% over 3 months.
- Months: Apr through Dec 2026 (9 months, indices 0-8).

You receive the current scenario state as JSON. When the user talks about changes ("push large deals later", "add another AE in Sep", "what if close rate drops to 7%"), you MUST respond with:

1. Your conversational reply. Lead with the CONSEQUENCES of the proposed change: what happens to ARR, what the capacity gap looks like, what risks emerge. Be specific with numbers. Then explain the trade-offs. Do NOT say "I've updated the scenario" — you are PROPOSING changes, the user decides whether to commit.

2. A JSON block wrapped in <updates> tags containing ONLY the parameters that would change. Keys must match exactly:
   - pilots, directMed, directBig: arrays of 9 numbers (deal counts per month, Apr-Dec)
   - aesRamped, aesNew, bdrs: arrays of 9 numbers (headcount per month)
   - convToMed, convToBig: numbers (0-100, percentage)
   - closePilot, closeMed, closeBig: numbers (0-100, percentage)
   - bdrMeetings: number (meetings per BDR per month)
   - aeQuarterlyTarget: number (€K per quarter per fully ramped AE)
   Only include keys that actually change. Example: <updates>{"pilots":[0,2,5,5,5,5,6,8,9],"closePilot":8}</updates>

3. A narrative block wrapped in <narrative> tags. This is the FULL motion roll-out narrative that reflects what the scenario WOULD look like if the proposed changes are accepted. It should read like an internal memo: what we're doing, why, the key bets, the risks, the timeline. 3-5 paragraphs, written for a CEO/board audience. Rewrite it fully each time.

IMPORTANT: When the user says "commit", "apply", "do it", "yes", or confirms a previous proposal, respond with the SAME <updates> from the previous proposal (re-emit them) so they get applied. If the user says "no", "reject", or "nevermind", skip the <updates> tags entirely and acknowledge.

If the user is just asking a question (not requesting changes), skip the <updates> tags but still include the <narrative> based on the current state.

Be direct. No fluff. This is a revenue planning tool, not a chatbot.`;

routes.post('/mm/scenario-chat', async (c) => {
  const { messages, scenario } = await c.req.json() as {
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    scenario: Record<string, any>;
  };

  if (!messages?.length) return c.json({ error: 'No messages provided' }, 400);

  const model = 'claude-haiku-4-5-20251001'; // fast model for interactive chat
  const stateBlock = `CURRENT SCENARIO STATE:\n${JSON.stringify(scenario, null, 2)}`;

  // Inject scenario state into the first user message
  const apiMessages = messages.map((m, i) => ({
    role: m.role as 'user' | 'assistant',
    content: i === messages.length - 1 && m.role === 'user'
      ? `${stateBlock}\n\nUSER: ${m.content}`
      : m.content,
  }));

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic();
    const msg = await client.messages.create({
      model, max_tokens: 1500,
      system: SCENARIO_SYSTEM,
      messages: apiMessages,
    });

    const text = msg.content[0].type === 'text' ? msg.content[0].text : '';

    // Parse updates
    let updates: Record<string, any> | null = null;
    const updMatch = text.match(/<updates>([\s\S]*?)<\/updates>/);
    if (updMatch) {
      try { updates = JSON.parse(updMatch[1]); } catch { updates = null; }
    }

    // Parse narrative
    let narrative: string | null = null;
    const narMatch = text.match(/<narrative>([\s\S]*?)<\/narrative>/);
    if (narMatch) narrative = narMatch[1].trim();

    // Clean reply (remove tags)
    const reply = text
      .replace(/<updates>[\s\S]*?<\/updates>/g, '')
      .replace(/<narrative>[\s\S]*?<\/narrative>/g, '')
      .trim();

    return c.json({ reply, updates, narrative });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default routes;
