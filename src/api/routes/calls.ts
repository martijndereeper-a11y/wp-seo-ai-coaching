import { Hono } from 'hono';
import { requireRole } from '../auth.ts';
import { supabase, fetchParsedTranscript, computeQualityBreakdown } from '../shared.ts';
import {
  analyzeTimeframe, analyzeAllWindows, analyzeByInterval, compareTimeframes, PRESET_WINDOWS, type TimeWindow,
} from '../../analysis/timeframe-analyzer.ts';

const routes = new Hono();

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
  };
  const groupBy = body.groupBy || 'outcome';
  const windowParam = body.window || 'opening';
  const maxPerGroup = body.limit || 50;

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
    let query = supabase.from('ae_call_analysis').select('recording_id, outcome, recorder_name, created_at').order('created_at', { ascending: false }).limit(200);
    if (body.ae) query = query.eq('recorder_name', body.ae);
    const { data: analyses } = await query;
    if (!analyses || analyses.length === 0) return c.json({ error: 'No analyzed calls found' }, 404);
    recordingIds = analyses.map(a => a.recording_id);
    for (const a of analyses) { outcomeMap.set(a.recording_id, a.outcome || 'unknown'); aeMap.set(a.recording_id, a.recorder_name); if (a.created_at) dateMap.set(a.recording_id, a.created_at); }
  } else {
    const { data: analyses } = await supabase.from('ae_call_analysis').select('recording_id, outcome, recorder_name, created_at').in('recording_id', recordingIds);
    for (const a of (analyses || [])) { outcomeMap.set(a.recording_id, a.outcome || 'unknown'); aeMap.set(a.recording_id, a.recorder_name); if (a.created_at) dateMap.set(a.recording_id, a.created_at); }
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

  const calls: Array<{ turns: any[]; recorderName: string; durationSeconds: number; group: string }> = [];
  const groupCounts = new Map<string, number>();
  for (const rid of recordingIds) {
    let group: string;
    if (groupBy === 'ae') group = aeMap.get(rid) || 'Unknown';
    else if (groupBy === 'period') { const pg = assignPeriodGroup(rid); if (!pg) continue; group = pg; }
    else group = outcomeMap.get(rid) || 'unknown';
    const count = groupCounts.get(group) || 0;
    if (count >= maxPerGroup) continue;
    const recording = await fetchParsedTranscript(rid);
    if (!recording || recording.turns.length === 0) continue;
    calls.push({ turns: recording.turns, recorderName: recording.recorderName, durationSeconds: recording.durationSeconds, group });
    groupCounts.set(group, count + 1);
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

// Live narrative
routes.post('/narrative/live', async (c) => {
  const body = await c.req.json() as { transcriptText: string; aeName: string; callTitle: string; durationMinutes: number; flaggedMoments: any[] };
  const { analyzeCallNarrative } = await import('../../analysis/narrative-coach.ts');
  const narrative = await analyzeCallNarrative(body.transcriptText, body.aeName, body.callTitle, body.durationMinutes, body.flaggedMoments || []);
  if (!narrative) return c.json({ error: 'Failed to generate narrative. Check ANTHROPIC_API_KEY.' }, 500);
  return c.json(narrative);
});

export default routes;
