import { Hono } from 'hono';
import { streamText } from 'hono/streaming';
import { requireRole } from '../auth.ts';
import { supabase, fetchParsedTranscript, computeQualityBreakdown } from '../shared.ts';
import {
  analyzeTimeframe, analyzeAllWindows, analyzeByInterval, compareTimeframes, PRESET_WINDOWS, type TimeWindow,
} from '../../analysis/timeframe-analyzer.ts';

const routes = new Hono();

// Single call detail
routes.get('/call/:id', async (c) => {
  const id = c.req.param('id');
  const { data, error } = await supabase
    .from('ae_call_analysis')
    .select('*')
    .eq('recording_id', id)
    .single();
  if (error) return c.json({ error: error.message }, 404);
  return c.json(data);
});

// Evidence drill-down for a specific dimension
routes.get('/call/:id/evidence/:dimension', async (c) => {
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

// Quality breakdown
routes.get('/call/:id/quality-breakdown', async (c) => {
  const id = c.req.param('id');
  const { data, error } = await supabase.from('ae_call_analysis').select('talk_ratio, question_count, script_adherence, prospect_engagement, highlights').eq('recording_id', id).single();
  if (error) return c.json({ error: error.message }, 404);
  return c.json(computeQualityBreakdown(data));
});

// Timeframe analysis for a single call
routes.get('/call/:id/timeframe', async (c) => {
  const id = c.req.param('id');
  const recording = await fetchParsedTranscript(id);
  if (!recording) return c.json({ error: 'Recording not found or has no transcript' }, 404);
  const { turns, recorderName, durationSeconds } = recording;
  const preset = c.req.query('preset');
  const interval = c.req.query('interval');
  const start = c.req.query('start');
  const end = c.req.query('end');

  if (interval) {
    const minutes = parseInt(interval, 10);
    if (isNaN(minutes) || minutes < 1) return c.json({ error: 'interval must be a positive number (minutes)' }, 400);
    return c.json({ recordingId: id, durationSeconds, windowType: 'interval', intervalMinutes: minutes, windows: analyzeByInterval(turns, recorderName, durationSeconds, minutes) });
  }
  if (preset === 'quarters' || preset === 'halves' || preset === 'presets') {
    return c.json({ recordingId: id, durationSeconds, windowType: preset, windows: analyzeAllWindows(turns, recorderName, durationSeconds, preset) });
  }
  if (preset && PRESET_WINDOWS[preset]) {
    const window = PRESET_WINDOWS[preset](durationSeconds);
    return c.json({ recordingId: id, durationSeconds, ...analyzeTimeframe(turns, recorderName, window) });
  }
  if (start !== undefined && end !== undefined) {
    const s = parseInt(start, 10);
    const e = parseInt(end, 10);
    if (isNaN(s) || isNaN(e) || s < 0 || e <= s) return c.json({ error: 'start and end must be valid seconds with end > start' }, 400);
    const window: TimeWindow = { startSeconds: s, endSeconds: e, label: `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}–${Math.floor(e/60)}:${String(e%60).padStart(2,'0')}` };
    return c.json({ recordingId: id, durationSeconds, ...analyzeTimeframe(turns, recorderName, window) });
  }
  return c.json({ recordingId: id, durationSeconds, windowType: 'quarters', windows: analyzeAllWindows(turns, recorderName, durationSeconds, 'quarters') });
});

// Compare timeframes across calls
routes.post('/timeframe/compare', async (c) => {
  const body = await c.req.json() as {
    recordingIds?: string[]; window?: string | { start: number; end: number };
    groupBy?: 'outcome' | 'ae' | 'period'; ae?: string; limit?: number;
    periodType?: 'month' | 'week' | 'custom'; periods?: Array<{ label: string; from: string; to: string }>;
    tierFilter?: string;  // 'A' | 'AB' | 'ABC' — default 'AB' (exclude troep)
  };
  const groupBy = body.groupBy || 'outcome';
  const windowParam = body.window || 'opening';
  const maxPerGroup = body.limit || 50;
  const tierFilter = (body.tierFilter || 'AB').toUpperCase();

  let windowArg: TimeWindow | string;
  if (typeof windowParam === 'string') {
    if (!PRESET_WINDOWS[windowParam]) return c.json({ error: `Unknown preset: ${windowParam}. Available: ${Object.keys(PRESET_WINDOWS).join(', ')}` }, 400);
    windowArg = windowParam;
  } else {
    windowArg = { startSeconds: windowParam.start, endSeconds: windowParam.end, label: `${Math.floor(windowParam.start/60)}:${String(windowParam.start%60).padStart(2,'0')}–${Math.floor(windowParam.end/60)}:${String(windowParam.end%60).padStart(2,'0')}` };
  }

  let recordingIds = body.recordingIds;
  let outcomeMap = new Map<string, string>();
  let aeMap = new Map<string, string>();
  let dateMap = new Map<string, string>();

  if (!recordingIds || recordingIds.length === 0) {
    let query = supabase.from('ae_call_analysis').select('recording_id, outcome, recorder_name, created_at, call_tier').order('created_at', { ascending: false }).limit(300);
    if (body.ae) query = query.eq('recorder_name', body.ae);
    const { data: analyses } = await query;
    if (!analyses || analyses.length === 0) return c.json({ error: 'No analyzed calls found' }, 404);
    // Filter by tier
    const filtered = analyses.filter(a => tierFilter.includes((a.call_tier || 'B').toUpperCase()));
    recordingIds = filtered.map(a => a.recording_id);
    for (const a of filtered) { outcomeMap.set(a.recording_id, a.outcome || 'unknown'); aeMap.set(a.recording_id, a.recorder_name); if (a.created_at) dateMap.set(a.recording_id, a.created_at); }
  } else {
    const { data: analyses } = await supabase.from('ae_call_analysis').select('recording_id, outcome, recorder_name, created_at, call_tier').in('recording_id', recordingIds);
    const filtered = (analyses || []).filter(a => tierFilter.includes((a.call_tier || 'B').toUpperCase()));
    for (const a of filtered) { outcomeMap.set(a.recording_id, a.outcome || 'unknown'); aeMap.set(a.recording_id, a.recorder_name); if (a.created_at) dateMap.set(a.recording_id, a.created_at); }
    recordingIds = filtered.map(a => a.recording_id);
  }

  function assignPeriodGroup(rid: string): string | null {
    const dateStr = dateMap.get(rid);
    if (!dateStr) return null;
    const date = new Date(dateStr);
    if (body.periodType === 'week') {
      const d = new Date(date); const day = d.getDay(); const diff = d.getDate() - day + (day === 0 ? -6 : 1); d.setDate(diff);
      return `Week of ${d.toISOString().slice(0, 10)}`;
    }
    if (body.periodType === 'custom' && body.periods) {
      for (const p of body.periods) { if (date >= new Date(p.from) && date < new Date(p.to)) return p.label; }
      return null;
    }
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[date.getMonth()]} ${date.getFullYear()}`;
  }

  // Pre-filter to eligible recordings and assign groups before fetching transcripts
  const eligible: Array<{ rid: string; group: string }> = [];
  const groupCounts = new Map<string, number>();
  for (const rid of recordingIds) {
    let group: string;
    if (groupBy === 'ae') group = aeMap.get(rid) || 'Unknown';
    else if (groupBy === 'period') { const pg = assignPeriodGroup(rid); if (!pg) continue; group = pg; }
    else group = outcomeMap.get(rid) || 'unknown';
    const count = groupCounts.get(group) || 0;
    if (count >= maxPerGroup) continue;
    eligible.push({ rid, group });
    groupCounts.set(group, count + 1);
  }
  if (eligible.length === 0) return c.json({ error: 'No calls found for the selected periods' }, 404);

  // Fetch transcripts in parallel (batches of 10 to avoid overwhelming DB)
  const calls: Array<{ turns: any[]; recorderName: string; durationSeconds: number; group: string }> = [];
  const BATCH = 10;
  for (let i = 0; i < eligible.length; i += BATCH) {
    const batch = eligible.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async ({ rid, group }) => {
      const recording = await fetchParsedTranscript(rid);
      if (!recording || recording.turns.length === 0) return null;
      return { turns: recording.turns, recorderName: recording.recorderName, durationSeconds: recording.durationSeconds, group };
    }));
    for (const r of results) { if (r) calls.push(r); }
  }
  if (calls.length === 0) return c.json({ error: 'No calls with transcripts found' }, 404);
  return c.json(compareTimeframes(calls, windowArg));
});

// Timeframe presets
routes.get('/timeframe/presets', (c) => {
  const duration = parseInt(c.req.query('duration') || '1800', 10);
  const presets: Record<string, TimeWindow> = {};
  for (const [name, fn] of Object.entries(PRESET_WINDOWS)) presets[name] = fn(duration);
  return c.json({ durationSeconds: duration, presets });
});

// Manual tier override
routes.put('/call/:id/tier', async (c) => {
  const id = c.req.param('id');
  const { tier } = await c.req.json() as { tier: string };
  if (!['A', 'B', 'C'].includes(tier)) return c.json({ error: 'Tier must be A, B, or C' }, 400);
  const { error } = await supabase.from('ae_call_analysis')
    .update({
      call_tier: tier,
      call_tier_classification: { tier, label: tier === 'A' ? 'Kanshebber' : tier === 'B' ? 'Full effort' : 'Troep', auto: false, signals: ['Handmatig ingesteld'] },
    })
    .eq('recording_id', id);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true, tier });
});

// Narrative coach — generate deep review
routes.post('/call/:id/narrative', requireRole('lead'), async (c) => {
  const recordingId = c.req.param('id');
  const { data: existing } = await supabase.from('ae_call_analysis').select('narrative_review').eq('recording_id', recordingId).single();
  if (existing?.narrative_review && Object.keys(existing.narrative_review).length > 0) return c.json(existing.narrative_review);

  const [{ data: analysis }, { data: recording }] = await Promise.all([
    supabase.from('ae_call_analysis').select('recording_id, recorder_name, title, duration_seconds, highlights').eq('recording_id', recordingId).single(),
    supabase.from('recordings').select('transcript_text').eq('id', recordingId).single(),
  ]);
  if (!analysis) return c.json({ error: 'Call not found' }, 404);
  if (!recording?.transcript_text) return c.json({ error: 'No transcript available for narrative analysis' }, 400);

  const { analyzeCallNarrative } = await import('../../analysis/narrative-coach.ts');
  const flaggedMoments = (analysis.highlights || []).map((h: any) => ({ type: h.type, category: h.category, timestamp: h.timestampDisplay, excerpt: h.excerpt, guidance: h.guidance || '' }));
  const narrative = await analyzeCallNarrative(recording.transcript_text, analysis.recorder_name, analysis.title || 'Untitled', Math.round((analysis.duration_seconds || 0) / 60), flaggedMoments);
  if (!narrative) return c.json({ error: 'Failed to generate narrative review. Check ANTHROPIC_API_KEY.' }, 500);
  await supabase.from('ae_call_analysis').update({ narrative_review: narrative }).eq('recording_id', recordingId);
  return c.json(narrative);
});

// Streaming narrative — emits text chunks as Claude generates
routes.post('/call/:id/narrative/stream', requireRole('lead'), async (c) => {
  const recordingId = c.req.param('id');
  const force = c.req.query('force') === 'true';

  // Serve from cache if present and not forced
  if (!force) {
    const { data: existing } = await supabase.from('ae_call_analysis').select('narrative_review').eq('recording_id', recordingId).single();
    const cached = existing?.narrative_review as Record<string, unknown> | null;
    if (cached && Object.keys(cached).length > 0) {
      // Send cache as a single chunk
      return streamText(c, async (stream) => {
        await stream.write(JSON.stringify({ cached: true, analysis: cached }));
      });
    }
  }

  // Load data for streaming
  const [{ data: analysis }, { data: recording }] = await Promise.all([
    supabase.from('ae_call_analysis').select('recording_id, recorder_name, title, duration_seconds, highlights').eq('recording_id', recordingId).single(),
    supabase.from('recordings').select('transcript_text').eq('id', recordingId).single(),
  ]);
  if (!analysis) return c.json({ error: 'Call not found' }, 404);
  if (!recording?.transcript_text) return c.json({ error: 'No transcript' }, 400);

  const { streamCallNarrative } = await import('../../analysis/narrative-coach.ts');
  const flagged = ((analysis.highlights as any[]) || []).map((h: any) => ({
    type: h.type, category: h.category, timestamp: h.timestampDisplay, excerpt: h.excerpt, guidance: h.guidance || '',
  }));

  return streamText(c, async (stream) => {
    let full = '';
    for await (const chunk of streamCallNarrative(
      recording.transcript_text,
      analysis.recorder_name,
      analysis.title || 'Untitled',
      Math.round((analysis.duration_seconds || 0) / 60),
      flagged,
    )) {
      full += chunk;
      await stream.write(chunk);
    }
    // Parse + cache the full result
    try {
      const { analyzeCallNarrative } = await import('../../analysis/narrative-coach.ts');
      // Re-use the parse logic by calling the non-streaming version on the buffered text
      // Simpler: store raw markdown and let client render sections
      const parsed = {
        summary: extractSection(full, '1. CALL SUMMARY', '2.'),
        objectionsAnalysis: extractSection(full, '2. WHERE DID THE PROSPECT SHOW DOUBTS', '3.'),
        buyingSignalsAnalysis: extractSection(full, '3. WHERE DID THE PROSPECT GIVE BUYING SIGNALS', '4.'),
        coachingMoments: extractSection(full, '4. KEY COACHING MOMENTS', '5.'),
        overallVerdict: extractSection(full, '5. OVERALL VERDICT', null),
        generatedAt: new Date().toISOString(),
      };
      await supabase.from('ae_call_analysis').update({ narrative_review: parsed }).eq('recording_id', recordingId);
    } catch (e) { /* non-fatal */ }
  });
});

function extractSection(text: string, startMarker: string, endMarker: string | null): string {
  const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) return '';
  let content: string;
  if (endMarker) {
    const endIdx = text.indexOf('### ' + endMarker, startIdx + startMarker.length);
    content = endIdx === -1 ? text.slice(startIdx + startMarker.length) : text.slice(startIdx + startMarker.length, endIdx);
  } else {
    content = text.slice(startIdx + startMarker.length);
  }
  return content.replace(/^[#\s]*/, '').trim();
}

// ─── VBAT endpoints ──────────────────────────────────────────────────────────

// Read VBAT classification from cache
routes.get('/call/:id/vbat', async (c) => {
  const id = c.req.param('id');
  const { data, error } = await supabase.from('ae_call_analysis').select('vbat_classification').eq('recording_id', id).single();
  if (error) return c.json({ error: error.message }, 404);
  const v = data?.vbat_classification as Record<string, unknown> | null;
  if (!v || Object.keys(v).length === 0) return c.json({ error: 'Not classified yet', status: 'missing' }, 404);
  return c.json(v);
});

// Regenerate VBAT (force re-classify, e.g. after AE flags a wrong verdict)
routes.post('/call/:id/vbat/regenerate', requireRole('lead'), async (c) => {
  const id = c.req.param('id')!;
  const recording = await fetchParsedTranscript(id);
  if (!recording) return c.json({ error: 'Recording or transcript not found' }, 404);
  const { data: row } = await supabase.from('ae_call_analysis').select('title, duration_seconds').eq('recording_id', id).single();
  if (!row) return c.json({ error: 'Call not analyzed' }, 404);

  const { classifyVBAT } = await import('../../analysis/vbat-classifier.ts');
  const result = await classifyVBAT(recording.turns, recording.recorderName, row.title || 'Untitled', row.duration_seconds || 0);
  if (!result) return c.json({ error: 'Classification failed' }, 500);
  await supabase.from('ae_call_analysis').update({ vbat_classification: result }).eq('recording_id', id);
  return c.json(result);
});

// SPICED discovery classification for a single call
routes.get('/call/:id/spiced', async (c) => {
  const id = c.req.param('id');
  const { data, error } = await supabase.from('ae_call_analysis').select('spiced_classification').eq('recording_id', id).single();
  if (error) return c.json({ error: error.message }, 404);
  const v = data?.spiced_classification as Record<string, unknown> | null;
  if (!v || Object.keys(v).length === 0) return c.json({ error: 'Not classified yet', status: 'missing' }, 404);
  return c.json(v);
});

// Regenerate SPICED (force re-classify)
routes.post('/call/:id/spiced/regenerate', requireRole('lead'), async (c) => {
  const id = c.req.param('id')!;
  const recording = await fetchParsedTranscript(id);
  if (!recording) return c.json({ error: 'Recording or transcript not found' }, 404);
  const { data: row } = await supabase.from('ae_call_analysis').select('title, duration_seconds').eq('recording_id', id).single();
  if (!row) return c.json({ error: 'Call not analyzed' }, 404);

  const { classifySPICED } = await import('../../analysis/spiced-classifier.ts');
  const result = await classifySPICED(recording.turns, recording.recorderName, row.title || 'Untitled', row.duration_seconds || 0);
  if (!result) return c.json({ error: 'Classification failed' }, 500);
  await supabase.from('ae_call_analysis').update({ spiced_classification: result }).eq('recording_id', id);
  return c.json(result);
});

// AE flags a VBAT verdict as incorrect
routes.post('/call/:id/vbat/feedback', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json() as { dimension: string; verdictWas: boolean; correctVerdict?: boolean; note?: string; voter?: string };
  if (!body.dimension || typeof body.verdictWas !== 'boolean') return c.json({ error: 'Missing dimension or verdictWas' }, 400);
  const { error } = await supabase.from('vbat_feedback').insert({
    id: `vfb_${id}_${body.dimension}_${Date.now()}`,
    recording_id: id,
    dimension: body.dimension,
    verdict_was: body.verdictWas,
    correct_verdict: body.correctVerdict ?? null,
    note: body.note || null,
    voter: body.voter || 'anonymous',
  });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});

// Live narrative
routes.post('/narrative/live', async (c) => {
  const body = await c.req.json() as { transcriptText: string; aeName: string; callTitle: string; durationMinutes: number; flaggedMoments: any[] };
  const { analyzeCallNarrative } = await import('../../analysis/narrative-coach.ts');
  const narrative = await analyzeCallNarrative(body.transcriptText, body.aeName, body.callTitle, body.durationMinutes, body.flaggedMoments || []);
  if (!narrative) return c.json({ error: 'Failed to generate narrative. Check ANTHROPIC_API_KEY.' }, 500);
  return c.json(narrative);
});

export default routes;
