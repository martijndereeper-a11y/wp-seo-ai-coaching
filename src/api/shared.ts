/**
 * Shared utilities for API route modules
 */

import { createSupabaseClient } from '../database/supabase-client.ts';
import { parseTranscript } from '../analysis/transcript-parser.ts';

export const supabase = createSupabaseClient();

// ─── Cache ──────────────────────────────────────────────────────────────────

const cache: Record<string, { data: any; time: number }> = {};
const CACHE_TTL = 120000; // 2 minutes

export function getCached(key: string): any | null {
  const entry = cache[key];
  if (entry && Date.now() - entry.time < CACHE_TTL) return entry.data;
  return null;
}

export function setCache(key: string, data: any): void {
  cache[key] = { data, time: Date.now() };
}

export function clearCache(): void {
  Object.keys(cache).forEach(k => delete cache[k]);
}

// ─── Team benchmarks cache ──────────────────────────────────────────────────

let _teamBenchCache: { data: any; ts: number } | null = null;
const BENCH_TTL = 5 * 60 * 1000;

export async function getTeamWonBenchmarks() {
  if (_teamBenchCache && Date.now() - _teamBenchCache.ts < BENCH_TTL) return _teamBenchCache.data;
  const { data: teamCalls } = await supabase
    .from('ae_call_analysis')
    .select('talk_ratio, question_count, script_adherence, patterns')
    .eq('outcome', 'won')
    .limit(500);
  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const calls = teamCalls || [];
  const dims = ['contentEngine','marketContext','roiReframe','humor','urgency','contract','checkIn','theirBusiness'];
  const patterns: Record<string, number> = {};
  for (const d of dims) patterns[d] = +(avg(calls.map(tc => (tc.patterns as Record<string,number>)?.[d] || 0))).toFixed(1);
  const result = {
    talkRatio: calls.length ? Math.round(avg(calls.map(tc => tc.talk_ratio || 0))) : 55,
    questionCount: calls.length ? Math.round(avg(calls.map(tc => tc.question_count || 0))) : 22,
    scriptAdherence: calls.length ? Math.round(avg(calls.map(tc => tc.script_adherence || 0))) : 50,
    patterns,
  };
  _teamBenchCache = { data: result, ts: Date.now() };
  return result;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function computeCallQualityScore(analysis: Record<string, any>): number {
  const talkRatio = analysis.talkRatio || analysis.talk_ratio || 50;
  const talkPts = Math.max(0, 25 - Math.abs(talkRatio - 50));
  const qCount = analysis.questionCount || analysis.question_count || 0;
  const qPts = Math.min(20, Math.round((qCount / 22) * 20));
  const scriptAdh = analysis.scriptAdherence || analysis.script_adherence || 0;
  const scriptPts = Math.round((scriptAdh / 100) * 20);
  const pe = analysis.prospectEngagement || analysis.prospect_engagement || {};
  const netEngagement = (pe.buyingSignals || 0) + (pe.engagementIndicators || 0) - (pe.redFlags || 0);
  const engPts = Math.max(0, Math.min(15, Math.round((netEngagement / 8) * 15)));
  const highlights = analysis.highlights || [];
  const coachableCount = Array.isArray(highlights) ? highlights.filter((h: any) => h.type === 'coachable').length : 0;
  const coachPts = Math.max(0, 20 - coachableCount * 2);
  return Math.round(Math.max(0, Math.min(100, talkPts + qPts + scriptPts + engPts + coachPts)));
}

export function computeQualityBreakdown(analysis: Record<string, any>) {
  const talkRatio = analysis.talkRatio || analysis.talk_ratio || 50;
  const talkPts = Math.max(0, 25 - Math.abs(talkRatio - 50));
  const qCount = analysis.questionCount || analysis.question_count || 0;
  const qPts = Math.min(20, Math.round((qCount / 22) * 20));
  const scriptAdh = analysis.scriptAdherence || analysis.script_adherence || 0;
  const scriptPts = Math.round((scriptAdh / 100) * 20);
  const pe = analysis.prospectEngagement || analysis.prospect_engagement || {};
  const netEngagement = (pe.buyingSignals || 0) + (pe.engagementIndicators || 0) - (pe.redFlags || 0);
  const engPts = Math.max(0, Math.min(15, Math.round((netEngagement / 8) * 15)));
  const highlights = analysis.highlights || [];
  const coachableCount = Array.isArray(highlights) ? highlights.filter((h: any) => h.type === 'coachable').length : 0;
  const coachPts = Math.max(0, 20 - coachableCount * 2);
  const total = Math.round(Math.max(0, Math.min(100, talkPts + qPts + scriptPts + engPts + coachPts)));
  return {
    total,
    subtasks: [
      { name: 'Talk Balance', score: Math.round(talkPts), max: 25, value: talkRatio, target: '45-55%', tip: talkRatio > 60 ? `${talkRatio}% — talk less, ask more` : `${talkRatio}% — good balance` },
      { name: 'Question Depth', score: Math.round(qPts), max: 20, value: qCount, target: '22+', tip: qCount < 16 ? `${qCount} questions — need more discovery` : `${qCount} questions — solid` },
      { name: 'Script Coverage', score: Math.round(scriptPts), max: 20, value: scriptAdh, target: '50%+', tip: scriptAdh < 30 ? `${scriptAdh}% — missing key sections` : `${scriptAdh}% — good coverage` },
      { name: 'Engagement', score: Math.round(engPts), max: 15, value: netEngagement, target: '4+', tip: netEngagement < 2 ? 'Low prospect engagement' : 'Prospect is engaged' },
      { name: 'Coachability', score: Math.round(coachPts), max: 20, value: coachableCount, target: '0-2', tip: coachableCount > 3 ? `${coachableCount} coachable moments — needs work` : 'Clean execution' },
    ],
  };
}

export async function fetchParsedTranscript(recordingId: string) {
  const { data, error } = await supabase
    .from('recordings')
    .select('transcript_text, recorder_name, duration_seconds')
    .eq('id', recordingId)
    .single();
  if (error || !data?.transcript_text) return null;
  const parsed = parseTranscript(data.transcript_text, data.recorder_name);
  return {
    turns: parsed.turns,
    recorderName: data.recorder_name || 'Unknown',
    durationSeconds: data.duration_seconds ? Number(data.duration_seconds) : parsed.durationSeconds,
  };
}

export function normalizeDealKey(title: string): string {
  const stripWords = ['wp seo ai', 'wpseoai', 'kennismaking', 'vervolg', 'follow-up', 'afstemmen', 'samenwerking', 'online meeting'];
  const stripChars = ['x', '&', '|', '<>'];
  let key = title.toLowerCase();
  for (const w of stripWords) key = key.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
  for (const ch of stripChars) key = key.split(ch).join(' ');
  return key.replace(/\s+/g, ' ').trim();
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function groupCallsIntoDeals(calls: any[]): Map<string, { name: string; calls: any[] }> {
  const deals = new Map<string, { name: string; calls: any[] }>();
  for (const call of calls) {
    let dealKey: string;
    let dealName: string;
    if (call.deal_name && call.deal_name.trim()) {
      dealKey = call.deal_name.trim().toLowerCase();
      dealName = call.deal_name.trim();
    } else {
      const title = call.title || '';
      dealKey = normalizeDealKey(title);
      dealName = dealKey || title || 'Unknown';
    }
    if (!dealKey) continue;
    if (!deals.has(dealKey)) deals.set(dealKey, { name: dealName, calls: [] });
    deals.get(dealKey)!.calls.push(call);
  }
  return deals;
}

export const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

export const PILLAR_KEYS = ['control','discovery','gapCreation','objectionHandling','advancement'] as const;
export const PILLAR_NAMES: Record<string, string> = { control: 'Control', discovery: 'Discovery', gapCreation: 'Gap Creation', objectionHandling: 'Objection Handling', advancement: 'Advancement' };
