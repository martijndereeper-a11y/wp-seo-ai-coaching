/**
 * Admin Analytics — separate-password gated.
 *
 * Routes:
 *   POST /api/admin/login         → exchange password for admin token
 *   GET  /api/admin/analysis      → returns full call-engine analysis JSON (cached 5m)
 *   POST /api/admin/chat          → Sonnet conversation grounded in analysis + Supabase tool calls
 *
 * Auth: independent of the v1 user/lead role system. Header X-Admin-Token must match
 * the admin password (resolved via getAdminAnalyticsPassword).
 */

import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '../shared.ts';
import { getAdminAnalyticsPassword } from '../../config/settings.ts';
import { loadFeatureMatrix } from '../../analysis/call-engine/features.ts';
import { runCausalAnalysis, runQualityAssociations } from '../../analysis/call-engine/causal.ts';
import { profileAes } from '../../analysis/call-engine/profiler.ts';

const routes = new Hono();

// ─── Auth gate ────────────────────────────────────────────────────────────────

async function requireAdmin(c: Context, next: Next) {
  const token = c.req.header('X-Admin-Token') || c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return c.json({ error: 'Admin token required' }, 401);
  const expected = await getAdminAnalyticsPassword();
  if (token !== expected) return c.json({ error: 'Invalid admin token' }, 401);
  return next();
}

// ─── Login ────────────────────────────────────────────────────────────────────

routes.post('/login', async (c) => {
  const { password } = await c.req.json() as { password: string };
  if (!password) return c.json({ error: 'Password required' }, 400);
  const expected = await getAdminAnalyticsPassword();
  if (password !== expected) return c.json({ error: 'Invalid password' }, 401);
  return c.json({ ok: true, token: password });
});

// ─── Analysis snapshot ────────────────────────────────────────────────────────
// Runs the call-engine in-process. ~1s on the live ae_call_analysis table.

let analysisCache: { computedAt: number; data: any } | null = null;
const ANALYSIS_TTL_MS = 5 * 60 * 1000;

async function computeAnalysis() {
  const fm = await loadFeatureMatrix({ firstMeetingsOnly: true });
  const estimates = runCausalAnalysis(fm);
  const quality = runQualityAssociations(fm);
  const profiling = profileAes(fm);

  const totalCalls = fm.rows.length;
  const won = fm.rows.filter(r => r.outcome === 1).length;
  const lost = totalCalls - won;
  const overallCloseRate = totalCalls > 0 ? won / totalCalls : 0;

  const overallEstimates = estimates.filter(e => e.method === 'within_ae');
  const winningBehaviors = overallEstimates.filter(e => e.classification === 'winning');
  const harmfulBehaviors = overallEstimates.filter(e => e.classification === 'harmful');

  // Per-market summaries
  const markets = ['NL', 'DE', 'EN', 'OTHER'] as const;
  const marketSummary = markets.map(m => {
    const rs = fm.rows.filter(r => r.market === m);
    const w = rs.filter(r => r.outcome === 1).length;
    const sortedQuality = rs.map(r => r.callQuality).sort((a, b) => a - b);
    return {
      market: m,
      calls: rs.length,
      won: w,
      lost: rs.length - w,
      closeRate: rs.length > 0 ? Math.round((w / rs.length) * 1000) / 10 : null,
      medianQuality: sortedQuality.length > 0 ? sortedQuality[Math.floor(sortedQuality.length / 2)] : null,
      sigBehaviors: estimates.filter(e => e.context.startsWith(m) && e.classification !== 'neutral').map(e => ({
        treatment: e.treatment,
        effect: e.effect,
        ciLower: e.ciLower,
        ciUpper: e.ciUpper,
        classification: e.classification,
        nAes: e.nAes,
      })),
    };
  });

  // Top performer set + their fingerprint diff
  const topProfiles = profiling.profiles.filter(p => p.isTopPerformer);
  const restProfiles = profiling.profiles.filter(p => !p.isTopPerformer);

  // Coaching priorities: significant + wide top-rest gap + trainable/practice
  const TRAINABLE_OR_PRACTICE = new Set(['TRAINABLE', 'PRACTICE']);
  const coachingPriorities = Object.entries(profiling.differentials)
    .map(([behavior, d]) => {
      const causal = winningBehaviors.find(e => e.treatment === behavior);
      return {
        behavior,
        topRate: d.topRate,
        avgRate: d.avgRate,
        delta: d.delta,
        classification: d.classification,
        causal: causal ? {
          effect: causal.effect,
          ciLower: causal.ciLower,
          ciUpper: causal.ciUpper,
          pValue: causal.pValue,
        } : null,
      };
    })
    .filter(p => p.causal !== null && p.delta > 0.08 && TRAINABLE_OR_PRACTICE.has(p.classification))
    .sort((a, b) => b.delta - a.delta);

  // Calibration check
  const aeWinRates = profiling.profiles.map(p => p.closeRateRaw).sort((a, b) => a - b);
  const medianAeWinRate = aeWinRates.length > 0 ? aeWinRates[Math.floor(aeWinRates.length / 2)] : 0;
  const inflatedAEs = profiling.profiles.filter(p => p.closeRateRaw > 0.85 && p.totalCalls >= 20).length;

  return {
    generatedAt: new Date().toISOString(),
    overview: {
      totalCalls,
      won,
      lost,
      overallCloseRate: Math.round(overallCloseRate * 1000) / 10,
      aesProfiled: profiling.profiles.length,
      topPerformers: topProfiles.length,
      markets: Array.from(new Set(fm.rows.map(r => r.market))).sort(),
      behaviorsTested: fm.behaviorIds.length,
      calibration: {
        medianAeWinRate: Math.round(medianAeWinRate * 1000) / 10,
        inflatedAEs,
        healthy: inflatedAEs <= 2 && medianAeWinRate <= 0.6,
      },
    },
    causalEstimates: overallEstimates,
    winningBehaviors,
    harmfulBehaviors,
    marketSummary,
    qualityAssociations: quality,
    topPerformers: topProfiles.map(p => ({
      aeName: p.aeName,
      market: p.primaryMarket,
      totalCalls: p.totalCalls,
      wonCount: p.wonCount,
      lostCount: p.lostCount,
      closeRateRaw: p.closeRateRaw,
      residual: p.residual,
      residualRank: p.residualRank,
      strengths: p.strengths,
      gaps: p.gaps,
      pillarAvgs: p.pillarAvgs,
    })),
    restAEs: restProfiles.map(p => ({
      aeName: p.aeName,
      market: p.primaryMarket,
      totalCalls: p.totalCalls,
      closeRateRaw: p.closeRateRaw,
      residual: p.residual,
      residualRank: p.residualRank,
      gaps: p.gaps,
    })),
    behaviorDifferentials: profiling.differentials,
    coachingPriorities,
  };
}

routes.get('/analysis', requireAdmin, async (c) => {
  const refresh = c.req.query('refresh') === 'true';
  if (!refresh && analysisCache && Date.now() - analysisCache.computedAt < ANALYSIS_TTL_MS) {
    return c.json(analysisCache.data);
  }
  try {
    const data = await computeAnalysis();
    analysisCache = { computedAt: Date.now(), data };
    return c.json(data);
  } catch (err: any) {
    return c.json({ error: 'Analysis failed: ' + err.message }, 500);
  }
});

// ─── Chat tools (Sonnet calls these on demand) ────────────────────────────────

const TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: 'query_calls',
    description: 'Search the ae_call_analysis table. Use this to pull specific calls by AE, outcome, date range, or call quality.',
    input_schema: {
      type: 'object',
      properties: {
        ae_name: { type: 'string', description: 'Optional: filter to one AE (recorder_name)' },
        outcome: { type: 'string', enum: ['won', 'lost', 'open', 'unknown'], description: 'Optional outcome filter' },
        market: { type: 'string', enum: ['NL', 'DE', 'EN'], description: 'Optional market filter (joins recordings.transcript_lang)' },
        min_quality: { type: 'number', description: 'Optional min call_quality_score (0-100)' },
        max_quality: { type: 'number', description: 'Optional max call_quality_score' },
        days_back: { type: 'number', description: 'Optional: only return calls from the last N days', default: 60 },
        limit: { type: 'number', description: 'Max rows to return', default: 10, maximum: 50 },
      },
    },
  },
  {
    name: 'get_ae_profile',
    description: 'Pull the full coaching profile for one AE (averages, weaknesses, strengths, last call date).',
    input_schema: {
      type: 'object',
      properties: {
        ae_name: { type: 'string', description: 'recorder_name to look up' },
      },
      required: ['ae_name'],
    },
  },
  {
    name: 'get_call_detail',
    description: 'Get the full ae_call_analysis row for one recording — patterns, pillar scores, smart_review, vbat_classification, etc. Use for digging into specific calls flagged by query_calls.',
    input_schema: {
      type: 'object',
      properties: {
        recording_id: { type: 'string' },
      },
      required: ['recording_id'],
    },
  },
  {
    name: 'get_call_transcript',
    description: 'Pull the full transcript text for one recording. Expensive — use sparingly, only when verbatims are needed.',
    input_schema: {
      type: 'object',
      properties: {
        recording_id: { type: 'string' },
      },
      required: ['recording_id'],
    },
  },
  {
    name: 'get_behavior_evidence',
    description: 'For one behavior pattern across calls, return concrete examples (which AEs use it most/least, sample call titles, deal outcomes).',
    input_schema: {
      type: 'object',
      properties: {
        behavior: { type: 'string', description: 'Pattern key, e.g. contract, assumptiveClose, roiReframe, compounding, humor, opinionAsk, theirBusiness, priceAnchor, ...' },
        top_or_bottom: { type: 'string', enum: ['top', 'bottom', 'both'], default: 'both', description: 'AEs ranked by adoption rate' },
        outcome_filter: { type: 'string', enum: ['won', 'lost'], description: 'Optional: only return calls with this outcome' },
        limit: { type: 'number', default: 8, maximum: 20 },
      },
      required: ['behavior'],
    },
  },
];

async function executeToolCall(name: string, input: any): Promise<string> {
  try {
    if (name === 'query_calls') {
      const sinceIso = new Date(Date.now() - (input.days_back ?? 60) * 86400000).toISOString();
      let q = supabase
        .from('ae_call_analysis')
        .select('recording_id, recorder_name, title, outcome, deal_name, created_at, call_quality_score, talk_ratio, question_count, script_adherence, call_tier, recording_url')
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: false })
        .limit(Math.min(input.limit ?? 10, 50));
      if (input.ae_name) q = q.eq('recorder_name', input.ae_name);
      if (input.outcome) q = q.eq('outcome', input.outcome);
      if (typeof input.min_quality === 'number') q = q.gte('call_quality_score', input.min_quality);
      if (typeof input.max_quality === 'number') q = q.lte('call_quality_score', input.max_quality);
      const { data, error } = await q;
      if (error) return JSON.stringify({ error: error.message });

      let rows = data || [];
      if (input.market) {
        const recIds = rows.map(r => r.recording_id);
        const { data: recs } = await supabase.from('recordings').select('id, transcript_lang').in('id', recIds);
        const mapByLang = new Map((recs || []).map(r => [r.id, r.transcript_lang]));
        const langTarget = input.market.toLowerCase();
        rows = rows.filter(r => mapByLang.get(r.recording_id) === langTarget);
      }
      return JSON.stringify({ count: rows.length, calls: rows });
    }

    if (name === 'get_ae_profile') {
      const { data, error } = await supabase
        .from('ae_coaching_profiles')
        .select('*')
        .eq('recorder_name', input.ae_name)
        .single();
      if (error) return JSON.stringify({ error: error.message });

      const sinceIso = new Date(Date.now() - 60 * 86400000).toISOString();
      const { data: calls } = await supabase
        .from('ae_call_analysis')
        .select('outcome, patterns, vbat_classification, call_quality_score')
        .eq('recorder_name', input.ae_name)
        .gte('created_at', sinceIso);
      const won = (calls || []).filter(c => c.outcome === 'won').length;
      const lost = (calls || []).filter(c => c.outcome === 'lost').length;
      const fingerprint: Record<string, number> = {};
      for (const k of ['contract', 'assumptiveClose', 'roiReframe', 'compounding', 'humor', 'opinionAsk', 'theirBusiness', 'priceAnchor']) {
        const present = (calls || []).filter(c => (c.patterns as any)?.[k] >= 1).length;
        fingerprint[k] = (calls || []).length > 0 ? Math.round((present / (calls || []).length) * 100) : 0;
      }
      return JSON.stringify({ profile: data, last60d: { won, lost, total: (calls || []).length, fingerprint } });
    }

    if (name === 'get_call_detail') {
      const { data, error } = await supabase
        .from('ae_call_analysis')
        .select('*')
        .eq('recording_id', input.recording_id)
        .single();
      if (error) return JSON.stringify({ error: error.message });
      // Trim noisy fields
      const { highlights, ...rest } = data;
      return JSON.stringify({ call: rest, highlightsCount: Array.isArray(highlights) ? highlights.length : 0 });
    }

    if (name === 'get_call_transcript') {
      const { data, error } = await supabase
        .from('recordings')
        .select('id, title, transcript_text, transcript_lang, recorder_name, created_at')
        .eq('id', input.recording_id)
        .single();
      if (error) return JSON.stringify({ error: error.message });
      // Cap transcript at 60K chars to protect tokens
      const cappedTranscript = (data.transcript_text || '').slice(0, 60000);
      return JSON.stringify({
        recording_id: data.id,
        title: data.title,
        recorder_name: data.recorder_name,
        lang: data.transcript_lang,
        transcript: cappedTranscript,
        truncated: (data.transcript_text || '').length > 60000,
      });
    }

    if (name === 'get_behavior_evidence') {
      const sinceIso = new Date(Date.now() - 60 * 86400000).toISOString();
      let q = supabase
        .from('ae_call_analysis')
        .select('recording_id, recorder_name, title, outcome, patterns, call_quality_score, deal_name, created_at, recording_url')
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: false })
        .limit(800);
      if (input.outcome_filter) q = q.eq('outcome', input.outcome_filter);
      const { data, error } = await q;
      if (error) return JSON.stringify({ error: error.message });

      const withCount = (data || []).map(c => ({ ...c, count: ((c.patterns as any)?.[input.behavior] || 0) }));
      const sorted = withCount.sort((a, b) => b.count - a.count);
      const lim = Math.min(input.limit ?? 8, 20);
      const top = sorted.slice(0, lim);
      const bottom = sorted.filter(c => c.count === 0).slice(0, lim);

      // Per-AE adoption rate
      const byAe: Record<string, { with: number; total: number }> = {};
      for (const c of (data || [])) {
        if (!byAe[c.recorder_name]) byAe[c.recorder_name] = { with: 0, total: 0 };
        byAe[c.recorder_name].total++;
        if (((c.patterns as any)?.[input.behavior] || 0) >= 1) byAe[c.recorder_name].with++;
      }
      const aeAdoption = Object.entries(byAe)
        .map(([n, v]) => ({ ae: n, adoption: v.total > 0 ? Math.round((v.with / v.total) * 100) : 0, calls: v.total }))
        .filter(a => a.calls >= 5)
        .sort((a, b) => b.adoption - a.adoption);

      return JSON.stringify({
        behavior: input.behavior,
        outcome_filter: input.outcome_filter || null,
        sample_calls: input.top_or_bottom === 'bottom' ? bottom : input.top_or_bottom === 'top' ? top : { top: top.slice(0, lim / 2), zero: bottom.slice(0, lim / 2) },
        ae_adoption: aeAdoption,
      });
    }

    return JSON.stringify({ error: 'Unknown tool: ' + name });
  } catch (err: any) {
    return JSON.stringify({ error: err.message });
  }
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

routes.post('/chat', requireAdmin, async (c) => {
  const { messages } = await c.req.json() as {
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  };
  if (!Array.isArray(messages) || messages.length === 0) {
    return c.json({ error: 'messages array required' }, 400);
  }

  // Pull current analysis (cached) — gives the model immediate grounding
  let analysis: any;
  if (analysisCache && Date.now() - analysisCache.computedAt < ANALYSIS_TTL_MS) {
    analysis = analysisCache.data;
  } else {
    analysis = await computeAnalysis();
    analysisCache = { computedAt: Date.now(), data: analysis };
  }

  const systemPrompt = `You are an analytics assistant for the WP SEO AI sales coaching dashboard. Your job: answer the lead's questions about call data, AE performance, and the call-engine behavior analysis.

You have a snapshot of the current cross-team analysis below, plus tools to query Supabase live for individual calls, AE profiles, behavior evidence, and full transcripts.

RULES:
- Be terse and concrete. No filler.
- Lead with the answer, then evidence.
- When citing AEs, calls, or behaviors, use exact names from the data.
- For "show me 3 lost deals where..." use query_calls + get_call_detail / get_call_transcript as needed.
- For broad questions, answer from the analysis snapshot first; only use tools when the snapshot doesn't have it.
- Include recording IDs and Claap URLs when surfacing specific calls so the lead can click through.
- If the question is unclear, ask one short clarifying question — don't guess.

ANALYSIS SNAPSHOT (generated ${analysis.generatedAt}):
${JSON.stringify(analysis, null, 2)}
`;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return c.json({ error: 'ANTHROPIC_API_KEY not set' }, 500);

  const client = new Anthropic({ apiKey });

  // Tool-use loop: model may call multiple tools before final answer.
  const conversationMessages: Anthropic.Messages.MessageParam[] = messages.map(m => ({
    role: m.role,
    content: m.content,
  }));

  const MAX_TOOL_ROUNDS = 6;
  let toolsUsed: Array<{ name: string; input: any }> = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      tools: TOOLS,
      messages: conversationMessages,
    });

    // Append assistant message
    conversationMessages.push({ role: 'assistant', content: resp.content });

    if (resp.stop_reason === 'end_turn' || resp.stop_reason === 'stop_sequence') {
      // Final answer
      const textBlock = resp.content.find(b => b.type === 'text') as Anthropic.Messages.TextBlock | undefined;
      return c.json({
        reply: textBlock?.text || '(no text reply)',
        toolsUsed,
        usage: resp.usage,
      });
    }

    if (resp.stop_reason !== 'tool_use') {
      const textBlock = resp.content.find(b => b.type === 'text') as Anthropic.Messages.TextBlock | undefined;
      return c.json({
        reply: textBlock?.text || '(stopped: ' + resp.stop_reason + ')',
        toolsUsed,
        usage: resp.usage,
      });
    }

    // Execute all tool calls in this turn
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const block of resp.content) {
      if (block.type === 'tool_use') {
        toolsUsed.push({ name: block.name, input: block.input });
        const result = await executeToolCall(block.name, block.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result,
        });
      }
    }
    conversationMessages.push({ role: 'user', content: toolResults });
  }

  return c.json({ error: 'Max tool-use rounds exceeded', toolsUsed }, 500);
});

export default routes;
