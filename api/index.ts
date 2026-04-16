/**
 * Vercel Serverless Handler — replaces Hono-based API server
 *
 * Single entry point for all routes. Uses VercelRequest/VercelResponse
 * with direct @supabase/supabase-js calls. No Hono dependency.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const config = { runtime: 'nodejs', maxDuration: 30 };

// ─── Lazy Supabase Client ──────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';

let _supabase: any = null;
function getSupabase() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  _supabase = createClient(url, key);
  return _supabase;
}

// ─── In-memory Cache ───────────────────────────────────────────────────────

const cache: Record<string, { data: any; time: number }> = {};
const CACHE_TTL = 120_000;

function getCached(key: string): any | null {
  const entry = cache[key];
  if (entry && Date.now() - entry.time < CACHE_TTL) return entry.data;
  return null;
}

function setCache(key: string, data: any): void {
  cache[key] = { data, time: Date.now() };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

const PILLAR_KEYS = ['control', 'discovery', 'gapCreation', 'objectionHandling', 'advancement'] as const;
const PILLAR_NAMES: Record<string, string> = {
  control: 'Control', discovery: 'Discovery', gapCreation: 'Gap Creation',
  objectionHandling: 'Objection Handling', advancement: 'Advancement',
};

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function normalizeDealKey(title: string): string {
  const stripWords = ['wp seo ai', 'wpseoai', 'kennismaking', 'vervolg', 'follow-up', 'afstemmen', 'samenwerking', 'online meeting'];
  let key = title.toLowerCase();
  for (const w of stripWords) key = key.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
  return key.replace(/\s+/g, ' ').trim();
}

function groupCallsIntoDeals(calls: any[]): Map<string, { name: string; calls: any[] }> {
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

function computeQualityBreakdown(analysis: Record<string, any>) {
  const talkRatio = analysis.talk_ratio || 50;
  const talkPts = Math.max(0, 25 - Math.abs(talkRatio - 50));
  const qCount = analysis.question_count || 0;
  const qPts = Math.min(20, Math.round((qCount / 22) * 20));
  const scriptAdh = analysis.script_adherence || 0;
  const scriptPts = Math.round((scriptAdh / 100) * 20);
  const pe = analysis.prospect_engagement || {};
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

function getCookie(req: VercelRequest, name: string): string | undefined {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(new RegExp(`${name}=([^;]+)`));
  return match?.[1];
}

function isActualMM(dealName: string): boolean {
  if (!dealName) return false;
  return /\bMM\b/i.test(dealName) || /mid[\s-]?market/i.test(dealName);
}

// ─── Auth ──────────────────────────────────────────────────────────────────

async function getPasswords(): Promise<{ ae: string; lead: string }> {
  try {
    const supabase = getSupabase();
    const { data } = await supabase.from('platform_settings').select('key, value').eq('key', 'auth_passwords').single();
    if (data?.value) return data.value;
  } catch {}
  return { ae: 'wpseoai2026', lead: 'coaching2026!' };
}

async function authenticate(req: VercelRequest): Promise<{ role: string; authMethod: string } | null> {
  const token = req.headers.authorization?.replace('Bearer ', '')
    || (req.headers['x-auth-token'] as string)
    || getCookie(req, 'auth_token');

  if (!token) return null;

  // Try Supabase Auth JWT
  if (token.startsWith('eyJ')) {
    const url = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;
    if (url && anonKey) {
      try {
        // createClient imported at top level
        const authClient = createClient(url, anonKey);
        const { data: { user }, error } = await authClient.auth.getUser(token);
        if (!error && user) {
          return { role: (user.user_metadata?.role as string) || 'ae', authMethod: 'supabase' };
        }
      } catch {}
    }
  }

  // Legacy password auth
  const passwords = await getPasswords();
  if (token === passwords.lead) return { role: 'lead', authMethod: 'password' };
  if (token === passwords.ae) return { role: 'ae', authMethod: 'password' };
  return null;
}

// ─── Response Helpers ──────────────────────────────────────────────────────

function json(res: VercelResponse, data: any, status = 200) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Auth-Token');
  return res.status(status).json(data);
}

function text(res: VercelResponse, body: string, status = 200) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Auth-Token');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  return res.status(status).send(body);
}

function html(res: VercelResponse, body: string, status = 200) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(status).send(body);
}

// ─── Route Matching ────────────────────────────────────────────────────────

function matchRoute(path: string, pattern: string): Record<string, string> | null {
  const pathParts = path.split('/').filter(Boolean);
  const patternParts = pattern.split('/').filter(Boolean);
  if (pathParts.length !== patternParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

// ─── Dashboard HTML Serving ────────────────────────────────────────────────

function serveDashboard(res: VercelResponse, filename: string) {
  const cwd = process.cwd();
  const paths = [
    join(cwd, 'src', 'dashboard', filename),
    join(cwd, '..', 'src', 'dashboard', filename),
  ];
  for (const p of paths) {
    if (existsSync(p)) return html(res, readFileSync(p, 'utf-8'));
  }
  return text(res, `${filename} not found`, 404);
}

// ─── Settings Helper ───────────────────────────────────────────────────────

let _settingsCache: { data: Record<string, any>; time: number } | null = null;
const SETTINGS_TTL = 60_000;

async function loadSettings(): Promise<Record<string, any>> {
  if (_settingsCache && Date.now() - _settingsCache.time < SETTINGS_TTL) return _settingsCache.data;
  const supabase = getSupabase();
  const { data } = await supabase.from('platform_settings').select('key, value');
  const settings: Record<string, any> = {};
  for (const row of data || []) settings[row.key] = row.value;
  _settingsCache = { data: settings, time: Date.now() };
  return settings;
}

async function saveSetting(key: string, value: any): Promise<boolean> {
  const supabase = getSupabase();
  const { error } = await supabase.from('platform_settings').upsert(
    { key, value, updated_at: new Date().toISOString() },
    { onConflict: 'key' }
  );
  if (!error) _settingsCache = null;
  return !error;
}

// ─── MM File Helper ────────────────────────────────────────────────────────

function serveMarkdownFile(res: VercelResponse, filename: string, label: string) {
  const p = join(process.cwd(), 'work', 'midmarket', filename);
  if (existsSync(p)) return text(res, readFileSync(p, 'utf-8'));
  return text(res, `${label} not found`, 404);
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════════════

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Auth-Token');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }

  const url = new URL(req.url || '/', `https://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  const method = req.method || 'GET';

  try {
    // ── Static HTML routes ─────────────────────────────────────────────
    if (path === '/' && method === 'GET') return serveDashboard(res, 'use-cases.html');
    if (path === '/admin' && method === 'GET') return serveDashboard(res, 'use-cases-admin.html');
    if (path === '/dashboard' && method === 'GET') return serveDashboard(res, 'index.html');
    if (path === '/sales-os' && method === 'GET') return serveDashboard(res, 'sales-os.html');
    if (path === '/pipeline' && method === 'GET') return serveDashboard(res, 'pipeline.html');
    if (path === '/use-cases' && method === 'GET') return serveDashboard(res, 'use-cases.html');

    // ── Use Case Finder API (unauthenticated) ──────────────────────────
    if (path === '/api/use-cases' && method === 'GET') return handleUseCases(req, res);
    if (path === '/api/use-cases/search' && method === 'GET') return handleUseCaseSearch(req, res);
    if (path === '/api/use-cases/by-objection' && method === 'GET') return handleUseCaseByObjection(req, res);
    if (path === '/health' && method === 'GET') return json(res, { ok: true });

    // ── Use Case Admin API (password-protected) ───────────────────────
    if (path === '/api/admin/login' && method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const adminPw = process.env.ADMIN_PASSWORD || 'wpseoai2026';
      if (body?.password === adminPw) return json(res, { ok: true, token: adminPw });
      return json(res, { error: 'Wrong password' }, 401);
    }
    if (path === '/api/admin/cases' && method === 'GET') return handleUseCases(req, res);
    if (path === '/api/admin/cases' && method === 'POST') return handleAdminSaveCase(req, res);
    if (path === '/api/admin/analyze-pdf' && method === 'POST') return handleAnalyzePdf(req, res);
    if (path === '/api/admin/enrich-url' && method === 'POST') return handleEnrichUrl(req, res);
    const adminDeleteMatch = matchRoute(path, '/api/admin/cases/:id');
    if (adminDeleteMatch && method === 'DELETE') return handleAdminDeleteCase(req, res, adminDeleteMatch.id);

    // ── Health (unauthenticated) ───────────────────────────────────────
    if (path === '/api/health' && method === 'GET') return handleHealth(req, res);

    // ── Auth Login (unauthenticated) ───────────────────────────────────
    if (path === '/api/auth/login' && method === 'POST') return handleAuthLogin(req, res);
    if (path === '/api/auth/me' && method === 'GET') return handleAuthMe(req, res);

    // ── MM public routes (unauthenticated) ─────────────────────────────
    if (path === '/api/mm/market-thesis' && method === 'GET') return serveMarkdownFile(res, 'WP SEO AI - Market Thesis - April 2026.md', 'Market thesis');
    if (path === '/api/mm/narrative' && method === 'GET') return serveMarkdownFile(res, 'MM Narrative V3 - April 2026.md', 'Narrative');
    if (path === '/api/mm/narrative-b2c' && method === 'GET') return serveMarkdownFile(res, 'MM Narrative V3 - B2C - April 2026.md', 'B2C Narrative');

    // ── Auth-protected routes ──────────────────────────────────────────
    const auth = await authenticate(req);
    if (!path.startsWith('/api/')) return json(res, { error: 'Not found' }, 404);
    if (!auth) return json(res, { error: 'Authentication required' }, 401);

    const { role } = auth;

    // ── Settings (lead only) ───────────────────────────────────────────
    if (path === '/api/settings' && method === 'GET') {
      if (role !== 'lead') return json(res, { error: 'Lead access required' }, 403);
      return handleGetSettings(req, res);
    }
    const settingsMatch = matchRoute(path, '/api/settings/:key');
    if (settingsMatch && method === 'PUT') {
      if (role !== 'lead') return json(res, { error: 'Lead access required' }, 403);
      return handlePutSetting(req, res, settingsMatch.key);
    }

    // ── Team routes ────────────────────────────────────────────────────
    if (path === '/api/team' && method === 'GET') return handleTeam(req, res);
    if (path === '/api/team/benchmarks' && method === 'GET') return handleTeamBenchmarks(req, res);
    if (path === '/api/team/pillars' && method === 'GET') return handleTeamPillars(req, res);
    if (path === '/api/team/what-good-looks-like' && method === 'GET') return handleWGLL(req, res);
    if (path === '/api/team/narrative-consistency' && method === 'GET') return handleNarrativeConsistency(req, res);
    if (path === '/api/dashboard' && method === 'GET') return handleDashboard(req, res);

    // ── AE routes ──────────────────────────────────────────────────────
    let params: Record<string, string> | null;

    params = matchRoute(path, '/api/ae/:name/calls');
    if (params && method === 'GET') return handleAECalls(req, res, params.name);

    params = matchRoute(path, '/api/ae/:name/trend');
    if (params && method === 'GET') return handleAETrend(req, res, params.name);

    params = matchRoute(path, '/api/ae/:name/months');
    if (params && method === 'GET') return handleAEMonths(req, res, params.name);

    params = matchRoute(path, '/api/ae/:name/pillars');
    if (params && method === 'GET') return handleAEPillars(req, res, params.name);

    params = matchRoute(path, '/api/ae/:name/interventions');
    if (params && method === 'GET') return handleAEInterventions(req, res, params.name);

    params = matchRoute(path, '/api/ae/:name/deep-analysis');
    if (params && method === 'POST') {
      if (role !== 'lead') return json(res, { error: 'Lead access required' }, 403);
      return json(res, { error: 'Deep analysis not available in serverless mode — requires LLM call' }, 501);
    }

    params = matchRoute(path, '/api/ae/:name');
    if (params && method === 'GET') return handleAEProfile(req, res, params.name);

    // ── Call routes ────────────────────────────────────────────────────
    params = matchRoute(path, '/api/call/:id/quality-breakdown');
    if (params && method === 'GET') return handleCallQualityBreakdown(req, res, params.id);

    params = matchRoute(path, '/api/call/:id/evidence/:dimension');
    if (params && method === 'GET') return handleCallEvidence(req, res, params.id, params.dimension);

    params = matchRoute(path, '/api/call/:id/tier');
    if (params && method === 'PUT') return handleCallTierUpdate(req, res, params.id);

    params = matchRoute(path, '/api/call/:id/game-score');
    if (params && method === 'GET') return handleCallGameScore(req, res, params.id);

    params = matchRoute(path, '/api/call/:id/timeframe');
    if (params && method === 'GET') return json(res, { error: 'Timeframe analysis not available in serverless mode' }, 501);

    params = matchRoute(path, '/api/call/:id/narrative');
    if (params && method === 'POST') return json(res, { error: 'Narrative review not available in serverless mode — requires LLM call' }, 501);

    params = matchRoute(path, '/api/call/:id');
    if (params && method === 'GET') return handleCallDetail(req, res, params.id);

    if (path === '/api/calls' && method === 'GET') return handleCalls(req, res);

    // ── Deal routes ────────────────────────────────────────────────────
    if (path === '/api/deals' && method === 'GET') return handleDeals(req, res);

    params = matchRoute(path, '/api/deal/:name');
    if (params && method === 'GET') return handleDealTimeline(req, res, params.name);

    if (path === '/api/pipeline' && method === 'GET') {
      if (role !== 'lead') return json(res, { error: 'Lead access required' }, 403);
      return json(res, { error: 'Pipeline summary not available in serverless mode' }, 501);
    }

    params = matchRoute(path, '/api/deals/:id/score');
    if (params && method === 'GET') {
      if (role !== 'lead') return json(res, { error: 'Lead access required' }, 403);
      return json(res, { error: 'Deal scoring not available in serverless mode' }, 501);
    }

    if (path === '/api/deals/link' && method === 'POST') {
      if (role !== 'lead') return json(res, { error: 'Lead access required' }, 403);
      return json(res, { error: 'Deal linking not available in serverless mode' }, 501);
    }

    // ── Game routes ────────────────────────────────────────────────────
    if (path === '/api/game/leaderboard' && method === 'GET') return handleGameLeaderboard(req, res);

    params = matchRoute(path, '/api/game/ae/:name');
    if (params && method === 'GET') return handleGameAE(req, res, params.name);

    // ── Reps & Coaching ────────────────────────────────────────────────
    if (path === '/api/reps' && method === 'GET') return handleReps(req, res);

    params = matchRoute(path, '/api/rep/:name/coaching-brief');
    if (params && method === 'GET') return handleCoachingBrief(req, res, params.name);

    if (path === '/api/feedback' && method === 'POST') return handleFeedbackSubmit(req, res);
    if (path === '/api/feedback/health' && method === 'GET') return handleFeedbackHealth(req, res);

    params = matchRoute(path, '/api/feedback/:recordingId');
    if (params && method === 'GET') return handleFeedbackForCall(req, res, params.recordingId);

    if (path === '/api/interventions' && method === 'GET') {
      if (role !== 'lead') return json(res, { error: 'Lead access required' }, 403);
      return handleInterventions(req, res);
    }
    if (path === '/api/interventions' && method === 'POST') {
      if (role !== 'lead') return json(res, { error: 'Lead access required' }, 403);
      return handleCreateIntervention(req, res);
    }
    if (path === '/api/interventions/measure' && method === 'POST') {
      if (role !== 'lead') return json(res, { error: 'Lead access required' }, 403);
      return json(res, { error: 'Intervention measurement not available in serverless mode' }, 501);
    }

    params = matchRoute(path, '/api/interventions/:id/dismiss');
    if (params && method === 'PUT') {
      if (role !== 'lead') return json(res, { error: 'Lead access required' }, 403);
      return handleDismissIntervention(req, res, params.id);
    }

    if (path === '/api/calibration' && method === 'GET') {
      if (role !== 'lead') return json(res, { error: 'Lead access required' }, 403);
      return handleCalibration(req, res);
    }

    // ── MM routes ──────────────────────────────────────────────────────
    if (path === '/api/mm/calls' && method === 'GET') return handleMMCalls(req, res);

    params = matchRoute(path, '/api/mm/call/:id');
    if (params && method === 'GET') return handleMMCallDetail(req, res, params.id);

    if (path === '/api/mm/analyses' && method === 'GET') return handleMMAnalyses(req, res);
    if (path === '/api/mm/analyze-call' && method === 'POST') return json(res, { error: 'MM call analysis not available in serverless mode — requires LLM call' }, 501);
    if (path === '/api/mm/scenario-chat' && method === 'POST') return json(res, { error: 'Scenario chat not available in serverless mode — requires LLM call' }, 501);

    // ── Timeframe/Narrative (complex, not ported) ──────────────────────
    if (path === '/api/timeframe/presets' && method === 'GET') return json(res, { error: 'Timeframe presets not available in serverless mode' }, 501);
    if (path === '/api/timeframe/compare' && method === 'POST') return json(res, { error: 'Timeframe compare not available in serverless mode' }, 501);
    if (path === '/api/narrative/live' && method === 'POST') return json(res, { error: 'Live narrative not available in serverless mode — requires LLM call' }, 501);
    if (path === '/api/content/track' && method === 'POST') return json(res, { error: 'Content tracking not available in serverless mode' }, 501);
    if (path === '/api/content/performance' && method === 'GET') return json(res, { error: 'Content performance not available in serverless mode' }, 501);

    return json(res, { error: 'Not found', path }, 404);

  } catch (err: any) {
    console.error('Handler error:', err);
    return json(res, { error: err.message || 'Internal server error' }, 500);
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// ROUTE HANDLERS
// ═══════════════════════════════════════════════════════════════════════════


// ── Use Case Finder ───────────────────────────────────────────────────────

function loadSeedCases(): any[] {
  const dataFile = join(process.cwd(), 'data', 'use-cases-data.json');
  if (existsSync(dataFile)) {
    try { return JSON.parse(readFileSync(dataFile, 'utf-8')); } catch {}
  }
  return [];
}

async function loadAdminAddedCases(): Promise<any[]> {
  try {
    const supabase = getSupabase();
    const { data } = await supabase.from('platform_settings').select('value').eq('key', 'use_cases_added').single();
    if (data?.value && Array.isArray(data.value)) return data.value;
  } catch {}
  return [];
}

async function loadAllUseCases(): Promise<any[]> {
  const seed = loadSeedCases();
  const added = await loadAdminAddedCases();
  // Merge: added cases override seed by id
  const addedIds = new Set(added.map((c: any) => c.id));
  const fromSeed = seed.filter((c: any) => !addedIds.has(c.id));
  return [...fromSeed, ...added];
}

async function saveAdminCase(newCase: any): Promise<void> {
  const supabase = getSupabase();
  const existing = await loadAdminAddedCases();
  const idx = existing.findIndex((c: any) => c.id === newCase.id);
  if (idx >= 0) existing[idx] = newCase;
  else existing.push(newCase);
  await supabase.from('platform_settings').upsert({ key: 'use_cases_added', value: existing }, { onConflict: 'key' });
}

async function deleteAdminCase(id: string): Promise<boolean> {
  const existing = await loadAdminAddedCases();
  const filtered = existing.filter((c: any) => c.id !== id);
  if (filtered.length === existing.length) return false;
  const supabase = getSupabase();
  await supabase.from('platform_settings').upsert({ key: 'use_cases_added', value: filtered }, { onConflict: 'key' });
  return true;
}

const USE_CASE_OBJECTIONS = [
  'Niche market, too specific for online marketing',
  'B2B sector, nobody searches for our services',
  'Our sector is too technical or complex for AI content',
  'Trust-sensitive sector where mistakes are not allowed',
  'We are too small for this kind of approach',
  'We tried it before and it didn\'t work',
  'It takes too long before you see results',
  'Our customers are not online',
  'We get everything from word of mouth',
  'We already do Google Ads, why also SEO',
];

async function handleUseCases(_req: VercelRequest, res: VercelResponse) {
  const cases = await loadAllUseCases();
  const painPatterns = [...new Set(cases.map((c: any) => c.painPattern))];
  const industries = [...new Set(cases.map((c: any) => c.industry))];
  const objectionCounts = USE_CASE_OBJECTIONS.map((obj) => ({
    objection: obj,
    count: cases.filter((c: any) => c.objections?.includes(obj)).length,
  }));
  return json(res, { cases, painPatterns, industries, objections: USE_CASE_OBJECTIONS, objectionCounts });
}

async function handleUseCaseSearch(req: VercelRequest, res: VercelResponse) {
  const q = ((req.query?.q as string) || '').toLowerCase().trim();
  const cases = await loadAllUseCases();
  if (!q) return json(res, { results: cases });

  const terms = q.split(/\s+/);
  const scored = cases.map((uc: any) => {
    const searchable = [
      uc.company, uc.industry, uc.painPattern, uc.headline,
      uc.outcome, uc.result, uc.summary, uc.businessType, uc.marketPosition,
      ...(uc.keywords || []), ...(uc.objections || []), ...(uc.countries || []),
    ].join(' ').toLowerCase();

    let score = 0;
    for (const term of terms) {
      if (searchable.includes(term)) score += 1;
      if ((uc.keywords || []).some((k: string) => k.includes(term))) score += 1;
      if (uc.company?.toLowerCase().includes(term)) score += 2;
      if (uc.industry?.toLowerCase().includes(term)) score += 2;
      if (uc.businessType?.toLowerCase() === term) score += 2;
      if ((uc.objections || []).some((o: string) => o.toLowerCase().includes(term))) score += 1;
    }
    return { ...uc, score };
  });

  const results = scored.filter((r: any) => r.score > 0).sort((a: any, b: any) => b.score - a.score);
  return json(res, { results });
}

async function handleUseCaseByObjection(req: VercelRequest, res: VercelResponse) {
  const obj = (req.query?.objection as string) || '';
  const cases = await loadAllUseCases();
  const results = cases.filter((uc: any) => (uc.objections || []).includes(obj));
  return json(res, { results });
}

/** Read raw body from request stream */
async function getRawBody(req: VercelRequest): Promise<Buffer> {
  // Vercel may have pre-parsed into req.body
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body);

  // Read from stream
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    (req as any).on('data', (chunk: Buffer) => chunks.push(chunk));
    (req as any).on('end', () => resolve(Buffer.concat(chunks)));
    (req as any).on('error', reject);
  });
}

/** Parse multipart form fields from raw body (stream-based for Vercel) */
async function parseMultipartFields(req: VercelRequest): Promise<Record<string, string>> {
  const contentType = req.headers['content-type'] || '';

  // JSON — simple case
  if (contentType.includes('application/json')) {
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
    if (typeof req.body === 'object' && req.body && !Buffer.isBuffer(req.body)) return req.body;
    return {};
  }

  // Vercel may have parsed it into an object
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    const fields: Record<string, string> = {};
    for (const [key, val] of Object.entries(req.body)) {
      if (typeof val === 'string') fields[key] = val;
    }
    if (Object.keys(fields).length > 0) return fields;
  }

  // Read raw body from stream
  const raw = await getRawBody(req);
  if (!raw || raw.length === 0) return {};

  // URL-encoded
  if (contentType.includes('urlencoded')) {
    const fields: Record<string, string> = {};
    for (const pair of raw.toString().split('&')) {
      const [k, v] = pair.split('=');
      if (k) fields[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
    return fields;
  }

  // Multipart — parse from raw buffer
  const boundaryMatch = contentType.match(/boundary=(.+)/);
  if (!boundaryMatch) return {};

  const fields: Record<string, string> = {};
  const boundary = '--' + boundaryMatch[1].trim();
  const rawStr = raw.toString('utf-8');
  const parts = rawStr.split(boundary);
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const header = part.substring(0, headerEnd);
    const nameMatch = header.match(/name="([^"]+)"/);
    if (!nameMatch) continue;
    if (header.includes('filename=')) continue;
    let value = part.substring(headerEnd + 4);
    if (value.endsWith('\r\n')) value = value.slice(0, -2);
    fields[nameMatch[1]] = value;
  }
  return fields;
}

/** Parse form fields from multipart body, URL-encoded, or JSON (sync version for non-stream) */
function parseFormFields(req: VercelRequest): Record<string, string> {
  const body = req.body;
  const contentType = req.headers['content-type'] || '';

  if (!body) return {};

  // JSON body
  if (contentType.includes('application/json')) {
    if (typeof body === 'string') { try { return JSON.parse(body); } catch { return {}; } }
    if (typeof body === 'object' && !Buffer.isBuffer(body)) return body;
  }

  // Vercel may have already parsed multipart into an object
  if (typeof body === 'object' && !Buffer.isBuffer(body) && !Array.isArray(body)) {
    // Vercel parsed it — fields are strings, files are objects
    const fields: Record<string, string> = {};
    for (const [key, val] of Object.entries(body)) {
      if (typeof val === 'string') fields[key] = val;
    }
    if (Object.keys(fields).length > 0) return fields;
  }

  // Raw buffer — parse multipart manually
  const raw = Buffer.isBuffer(body) ? body : (typeof body === 'string' ? Buffer.from(body) : null);
  if (!raw) return {};

  // URL-encoded
  if (contentType.includes('urlencoded')) {
    const fields: Record<string, string> = {};
    for (const pair of raw.toString().split('&')) {
      const [k, v] = pair.split('=');
      if (k) fields[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
    return fields;
  }

  // Multipart
  const boundaryMatch = contentType.match(/boundary=(.+)/);
  if (!boundaryMatch) return {};

  const fields: Record<string, string> = {};
  const boundary = '--' + boundaryMatch[1].trim();
  const rawStr = raw.toString('utf-8');
  const parts = rawStr.split(boundary);
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const header = part.substring(0, headerEnd);
    const nameMatch = header.match(/name="([^"]+)"/);
    if (!nameMatch) continue;
    if (header.includes('filename=')) continue;
    let value = part.substring(headerEnd + 4);
    // Trim trailing \r\n before next boundary
    if (value.endsWith('\r\n')) value = value.slice(0, -2);
    fields[nameMatch[1]] = value;
  }
  return fields;
}

async function handleAdminSaveCase(req: VercelRequest, res: VercelResponse) {
  const fields = await parseMultipartFields(req);
  const company = fields.company?.trim();
  if (!company) return json(res, { error: 'Company name required' }, 400);

  // Parse objections (pipe-separated from form) or JSON array
  let objections: string[] = [];
  if (fields.objections) {
    objections = fields.objections.includes('|||')
      ? fields.objections.split('|||').filter(Boolean)
      : (Array.isArray(fields.objections) ? fields.objections : [fields.objections]);
  }

  // Parse keywords (comma-separated) and countries
  const keywords = fields.keywords ? fields.keywords.split(',').map((k: string) => k.trim().toLowerCase()).filter(Boolean) : [];
  const countries = fields.countries ? fields.countries.split(',').map((c: string) => c.trim()).filter(Boolean) : [];

  const id = fields.id || company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const useCase = {
    id,
    company,
    industry: fields.industry || 'General',
    painPattern: fields.painPattern || 'Other',
    headline: fields.headline || '',
    outcome: fields.outcome || '',
    result: fields.result || '',
    summary: fields.summary || '',
    businessType: fields.businessType || 'B2B',
    marketPosition: fields.marketPosition || 'Mainstream',
    trustSensitive: fields.trustSensitive === 'true',
    clickTier: fields.clickTier || 'Small base (100-500)',
    objections,
    countries,
    keywords,
    pdfFile: fields.pdfFile || null,
  };

  await saveAdminCase(useCase);
  return json(res, { ok: true, id, case: useCase });
}

async function handleEnrichUrl(req: VercelRequest, res: VercelResponse) {
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const url = body?.url?.trim();
  if (!url) return json(res, { error: 'URL is required' }, 400);

  try {
    // Fetch the page (follow redirects, handle HTTPS)
    const fetchUrl = url.startsWith('http') ? url : 'https://' + url;
    const response = await fetch(fetchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return json(res, { error: `Website returned ${response.status}` }, 400);
    const html = await response.text();

    // Strip HTML tags, keep text
    const textContent = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 4000);

    // Extract meta description and title
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
    const metaMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
    const pageTitle = titleMatch?.[1] || '';
    const metaDesc = metaMatch?.[1] || '';

    // Send to Claude for enrichment
    const AnthropicMod = await import('@anthropic-ai/sdk');
    const Anthropic = AnthropicMod.default || AnthropicMod;
    const anthropic = new Anthropic();

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Analyze this company website and extract structured data. Return ONLY valid JSON.

URL: ${url}
Page title: ${pageTitle}
Meta description: ${metaDesc}
Page text (first 4000 chars):
${textContent}

Return this JSON:
{
  "company": "official company name",
  "industry": "industry in 2-4 words, e.g. Energy / Installation Services",
  "summary": "2-3 sentence description of what this company does, their market, and scale",
  "businessType": "B2B or B2C or Mix",
  "marketPosition": "Niche or Mainstream",
  "countries": ["country/countries they operate in"],
  "keywords": ["5-8 lowercase keywords relevant for finding this company as a use case"]
}`,
      }],
    });

    let responseText = msg.content[0].type === 'text' ? msg.content[0].text : '';
    // Strip markdown code fences if present
    responseText = responseText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    const enriched = JSON.parse(responseText);
    return json(res, { enriched });
  } catch (err: any) {
    return json(res, { error: 'Enrichment failed: ' + err.message }, 500);
  }
}

async function handleAdminDeleteCase(req: VercelRequest, res: VercelResponse, id: string) {
  const ok = await deleteAdminCase(id);
  if (!ok) return json(res, { error: 'Case not found or is a seed case' }, 404);
  return json(res, { ok: true });
}

// ── PDF Analysis ──────────────────────────────────────────────────────────

function detectObjectionsFromText(text: string): string[] {
  const t = text.toLowerCase();
  const patterns: Array<{ objection: string; keywords: string[] }> = [
    { objection: 'Niche market, too specific for online marketing', keywords: ['niche', 'specifiek', 'specific', 'te klein', 'small market', 'niche markt', 'specialistisch'] },
    { objection: 'B2B sector, nobody searches for our services', keywords: ['b2b', 'niemand zoekt', 'nobody searches', 'geen zoekvolume', 'low search volume'] },
    { objection: 'Our sector is too technical or complex for AI content', keywords: ['technisch', 'technical', 'complex', 'ai content', 'expertise', 'kennisintensief'] },
    { objection: 'Trust-sensitive sector where mistakes are not allowed', keywords: ['vertrouwen', 'trust', 'medisch', 'medical', 'juridisch', 'legal', 'fouten', 'compliance'] },
    { objection: 'We are too small for this kind of approach', keywords: ['te klein', 'too small', 'klein bedrijf', 'small business', 'mkb', 'sme'] },
    { objection: 'We tried it before and it didn\'t work', keywords: ['eerder geprobeerd', 'tried before', 'didn\'t work', 'werkte niet', 'teleurgesteld'] },
    { objection: 'It takes too long before you see results', keywords: ['te lang', 'too long', 'duurt lang', 'takes time', 'slow results', 'langzaam'] },
    { objection: 'Our customers are not online', keywords: ['niet online', 'not online', 'offline', 'klanten zitten niet'] },
    { objection: 'We get everything from word of mouth', keywords: ['mond-tot-mond', 'word of mouth', 'referral', 'netwerk', 'aanbeveling'] },
    { objection: 'We already do Google Ads, why also SEO', keywords: ['google ads', 'adwords', 'sea', 'advertenties', 'paid search', 'waarom ook seo'] },
  ];
  return patterns.filter(({ keywords }) => keywords.some((kw) => t.includes(kw))).map(p => p.objection);
}

async function handleAnalyzePdf(req: VercelRequest, res: VercelResponse) {
  try {
    // Vercel buffers the raw body — parse multipart manually
    let pdfBuffer: Buffer | null = null;

    // Get raw body — Vercel may have pre-parsed it or left it as stream
    let rawBody: Buffer;
    if (req.body && Buffer.isBuffer(req.body)) {
      rawBody = req.body;
    } else if (typeof req.body === 'string') {
      rawBody = Buffer.from(req.body, 'binary');
    } else {
      // Read from stream
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        (req as any).on('data', (chunk: Buffer) => chunks.push(chunk));
        (req as any).on('end', resolve);
        (req as any).on('error', reject);
        // Timeout after 5s in case stream is already consumed
        setTimeout(resolve, 5000);
      });
      rawBody = Buffer.concat(chunks);
    }

    // Extract PDF from multipart boundary
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (boundaryMatch && rawBody.length > 0) {
      const boundary = '--' + boundaryMatch[1].trim();
      const boundaryBuf = Buffer.from(boundary);
      // Split by boundary
      let pos = 0;
      while (pos < rawBody.length) {
        const bStart = rawBody.indexOf(boundaryBuf, pos);
        if (bStart === -1) break;
        const partStart = bStart + boundaryBuf.length;
        const bEnd = rawBody.indexOf(boundaryBuf, partStart);
        if (bEnd === -1) break;
        const part = rawBody.subarray(partStart, bEnd);
        // Find header/body separator
        const sep = part.indexOf(Buffer.from('\r\n\r\n'));
        if (sep !== -1) {
          const header = part.subarray(0, sep).toString();
          if (header.includes('name="pdf"')) {
            // Body starts after \r\n\r\n, ends before trailing \r\n
            let body = part.subarray(sep + 4);
            if (body[body.length - 1] === 0x0a && body[body.length - 2] === 0x0d) {
              body = body.subarray(0, body.length - 2);
            }
            pdfBuffer = Buffer.from(body);
            break;
          }
        }
        pos = bEnd;
      }
    }

    if (!pdfBuffer || pdfBuffer.length === 0) {
      return json(res, { error: 'No PDF file received' }, 400);
    }

    // Send PDF directly to Claude for extraction (supports PDF natively)
    let extracted: Record<string, any> = {};
    let text = '';
    try {
      const AnthropicMod = await import('@anthropic-ai/sdk');
      const Anthropic = AnthropicMod.default || AnthropicMod;
      const anthropic = new Anthropic();
      const pdfBase64 = pdfBuffer.toString('base64');

      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
            { type: 'text', text: `Extract structured data from this success case PDF. Return ONLY valid JSON, no markdown.

Return this exact JSON structure:
{
  "company": "company name",
  "industry": "industry in 2-4 words",
  "headline": "one-line headline describing the case",
  "outcome": "short outcome phrase, e.g. +253% organic traffic",
  "result": "1-2 sentence concrete result with numbers",
  "summary": "2-3 sentence context about the company, challenge, and achievement",
  "businessType": "B2B or B2C or Mix",
  "marketPosition": "Niche or Mainstream",
  "trustSensitive": true or false,
  "countries": ["country names where this company operates"],
  "keywords": ["5-8 lowercase search keywords"],
  "painPattern": "best matching: No time / capacity for SEO, Underperforming agency / high SEO cost, AI / LLM search opportunity, Relied on single channel, Lack of control / visibility, Going international / scaling, Efficiency gap, Limited marketing capacity, Other",
  "fullText": "first 2000 chars of readable text from the PDF for objection matching"
}` },
          ],
        }],
      });
      let responseText = msg.content[0].type === 'text' ? msg.content[0].text : '';
      responseText = responseText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
      extracted = JSON.parse(responseText);
      text = extracted.fullText || '';
      delete extracted.fullText;
    } catch (aiErr: any) {
      extracted = { _error: aiErr.message };
    }

    // Keyword-based objection detection on extracted text
    const suggestedObjections = detectObjectionsFromText(text || JSON.stringify(extracted));

    return json(res, { suggestedObjections, extracted, preview: text.slice(0, 500).trim() });
  } catch (err: any) {
    return json(res, { error: 'Failed to analyze PDF: ' + err.message }, 500);
  }
}

// ── Health ─────────────────────────────────────────────────────────────────

async function handleHealth(_req: VercelRequest, res: VercelResponse) {
  const checks: Record<string, string> = { api: 'ok' };
  try {
    const supabase = getSupabase();
    const { count, error } = await supabase.from('recordings').select('id', { count: 'exact', head: true });
    checks.supabase = error ? `error: ${error.message}` : 'ok';
    checks.recordings = String(count ?? 0);
  } catch {
    checks.supabase = 'unreachable';
  }
  const allOk = Object.values(checks).every(v => v === 'ok' || !isNaN(Number(v)));
  return json(res, { status: allOk ? 'healthy' : 'degraded', checks, timestamp: new Date().toISOString() }, allOk ? 200 : 503);
}


// ── Auth ───────────────────────────────────────────────────────────────────

async function handleAuthLogin(req: VercelRequest, res: VercelResponse) {
  const body = req.body || {};

  if (body.password) {
    const passwords = await getPasswords();
    if (body.password === passwords.lead) return json(res, { role: 'lead', token: body.password });
    if (body.password === passwords.ae) return json(res, { role: 'ae', token: body.password });
    return json(res, { error: 'Invalid password' }, 401);
  }

  if (body.email) {
    const url = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;
    if (!url || !anonKey) return json(res, { error: 'Supabase Auth not configured' }, 500);
    const { createClient } = require('@supabase/supabase-js');
    const authClient = createClient(url, anonKey);
    const { error } = await authClient.auth.signInWithOtp({ email: body.email, options: { shouldCreateUser: false } });
    if (error) return json(res, { error: error.message }, 400);
    return json(res, { ok: true, message: 'Magic link sent — check your email' });
  }

  return json(res, { error: 'Provide password or email' }, 400);
}

async function handleAuthMe(req: VercelRequest, res: VercelResponse) {
  const token = req.headers.authorization?.replace('Bearer ', '')
    || (req.headers['x-auth-token'] as string);
  if (!token) return json(res, { error: 'Not authenticated' }, 401);

  if (token.startsWith('eyJ')) {
    const url = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;
    if (url && anonKey) {
      const { createClient } = require('@supabase/supabase-js');
      const { data: { user } } = await createClient(url, anonKey).auth.getUser(token);
      if (user) return json(res, {
        id: user.id, email: user.email, name: user.user_metadata?.name || user.email?.split('@')[0],
        role: user.user_metadata?.role || 'ae', authMethod: 'supabase',
      });
    }
  }

  const passwords = await getPasswords();
  if (token === passwords.lead) return json(res, { role: 'lead', authMethod: 'password' });
  if (token === passwords.ae) return json(res, { role: 'ae', authMethod: 'password' });
  return json(res, { error: 'Invalid token' }, 401);
}


// ── Settings ───────────────────────────────────────────────────────────────

async function handleGetSettings(_req: VercelRequest, res: VercelResponse) {
  const settings = await loadSettings();
  const safe = { ...settings };
  if (safe.auth_passwords) safe.auth_passwords = { ae: '***', lead: '***' };
  return json(res, safe);
}

async function handlePutSetting(req: VercelRequest, res: VercelResponse, key: string) {
  const { value } = req.body || {};
  const validKeys = ['auth_passwords', 'sync_channels', 'sync_personal_email', 'quality_weights', 'thresholds', 'deal_patterns', 'llm_model', 'coaching_rules', 'coaching_thresholds', 'script_sections'];
  if (!validKeys.includes(key)) return json(res, { error: 'Unknown setting: ' + key }, 400);
  const ok = await saveSetting(key, value);
  if (!ok) return json(res, { error: 'Failed to save setting' }, 500);
  return json(res, { ok: true, key });
}


// ── Team ───────────────────────────────────────────────────────────────────

async function handleTeam(_req: VercelRequest, res: VercelResponse) {
  const cached = getCached('team');
  if (cached) return json(res, cached);
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('ae_coaching_profiles')
    .select('recorder_name, total_calls, avg_call_quality, avg_talk_ratio, avg_question_count, avg_script_adherence, top_strengths, top_weaknesses, coaching_recs, avg_patterns_all')
    .order('avg_call_quality', { ascending: false });
  if (error) return json(res, { error: error.message }, 500);
  setCache('team', data);
  return json(res, data);
}

async function handleTeamBenchmarks(_req: VercelRequest, res: VercelResponse) {
  const cached = getCached('benchmarks');
  if (cached) return json(res, cached);
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('ae_coaching_profiles')
    .select('avg_call_quality, avg_talk_ratio, avg_question_count, avg_script_adherence');
  if (error) return json(res, { error: error.message }, 500);
  const benchmarks = {
    teamAvg: {
      callQuality: Math.round(avg((data || []).map((d: any) => d.avg_call_quality || 0))),
      talkRatio: Math.round(avg((data || []).map((d: any) => d.avg_talk_ratio || 0))),
      questionCount: Math.round(avg((data || []).map((d: any) => d.avg_question_count || 0))),
      scriptAdherence: Math.round(avg((data || []).map((d: any) => d.avg_script_adherence || 0))),
    },
  };
  setCache('benchmarks', benchmarks);
  return json(res, benchmarks);
}

async function handleTeamPillars(_req: VercelRequest, res: VercelResponse) {
  const cached = getCached('pillars');
  if (cached) return json(res, cached);
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('ae_call_analysis')
    .select('recorder_name, pillar_scores')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return json(res, { error: error.message }, 500);
  if (!data) return json(res, {});

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
  return json(res, result);
}

async function handleWGLL(_req: VercelRequest, res: VercelResponse) {
  const cached = getCached('wgll');
  if (cached) return json(res, cached);
  const supabase = getSupabase();

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

  if (allCalls.length < 8) return json(res, { error: 'Not enough calls for comparison' }, 400);

  const cutoff = Math.max(1, Math.floor(allCalls.length * 0.25));
  const highQuality = allCalls.slice(0, cutoff);
  const lowQuality = allCalls.slice(-cutoff);

  const dims = ['contentEngine', 'marketContext', 'roiReframe', 'humor', 'urgency', 'contract', 'checkIn', 'theirBusiness', 'activeListening', 'personalStory', 'vsAgency', 'directness', 'opinionAsk', 'research', 'priceAnchor', 'assumptiveClose'];
  const dimLabels: Record<string, string> = { contentEngine: 'Product explanation', marketContext: 'Market context', roiReframe: 'ROI reframing', humor: 'Humor', urgency: 'Urgency', contract: 'Close language', checkIn: 'Check-ins', theirBusiness: 'Their business', activeListening: 'Active listening', personalStory: 'Personal stories', vsAgency: 'vs Agencies', directness: 'Directness', opinionAsk: 'Asking opinions', research: 'Research shown', priceAnchor: 'Price anchoring', assumptiveClose: 'Assumptive close' };

  const patterns = dims.map(d => {
    const highAvg = +(avg(highQuality.map(c => ((c.patterns as Record<string, number>) || {})[d] || 0))).toFixed(1);
    const lowAvg = +(avg(lowQuality.map(c => ((c.patterns as Record<string, number>) || {})[d] || 0))).toFixed(1);
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
    patterns, pillars: { high: pillarHigh, low: pillarLow }, metrics,
  };
  setCache('wgll', wgllResult);
  return json(res, wgllResult);
}

async function handleNarrativeConsistency(_req: VercelRequest, res: VercelResponse) {
  const cached = getCached('narrative-consistency');
  if (cached) return json(res, cached);
  // Simplified version — returns section coverage without script-sections dependency
  return json(res, { error: 'Narrative consistency not available in serverless mode — requires script-sections module' }, 501);
}

async function handleDashboard(_req: VercelRequest, res: VercelResponse) {
  const cached = getCached('dashboard');
  if (cached) return json(res, cached);
  const supabase = getSupabase();

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
  return json(res, result);
}


// ── AE ─────────────────────────────────────────────────────────────────────

async function handleAEProfile(_req: VercelRequest, res: VercelResponse, name: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('ae_coaching_profiles')
    .select('recorder_name, total_calls, won_calls, lost_calls, win_rate, avg_duration_won, avg_duration_lost, avg_script_adherence, avg_talk_ratio, avg_question_count, avg_longest_monologue, avg_call_quality, avg_patterns_won, avg_patterns_lost, avg_patterns_all, top_strengths, top_weaknesses, coaching_recs, updated_at')
    .eq('recorder_name', name)
    .single();
  if (error) return json(res, { error: error.message }, 404);
  return json(res, data);
}

async function handleAECalls(req: VercelRequest, res: VercelResponse, name: string) {
  const supabase = getSupabase();
  const limit = parseInt((req.query.limit as string) || '100');
  const offset = parseInt((req.query.offset as string) || '0');
  const full = req.query.full === 'true';
  const columns = full
    ? 'recording_id, recorder_name, title, deal_name, created_at, duration_seconds, recording_url, outcome, talk_ratio, question_count, script_adherence, longest_monologue, call_quality_score, patterns, highlights, sections_hit, sections_missed, prospect_engagement, call_verdict, pillar_scores, smart_review'
    : 'recording_id, recorder_name, title, deal_name, created_at, duration_seconds, recording_url, outcome, talk_ratio, question_count, script_adherence, call_quality_score, sections_hit, sections_missed, prospect_engagement, call_verdict, pillar_scores';
  const { data, error } = await supabase
    .from('ae_call_analysis')
    .select(columns)
    .eq('recorder_name', name)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return json(res, { error: error.message }, 500);
  return json(res, data);
}

async function handleAETrend(_req: VercelRequest, res: VercelResponse, name: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('ae_call_analysis')
    .select('created_at, outcome, talk_ratio, question_count, script_adherence, call_quality_score, patterns')
    .eq('recorder_name', name)
    .order('created_at', { ascending: true });
  if (error) return json(res, { error: error.message }, 500);
  if (!data || data.length < 3) return json(res, []);
  const windowSize = 5;
  const points = [];
  for (let i = windowSize - 1; i < data.length; i++) {
    const window = data.slice(i - windowSize + 1, i + 1);
    points.push({
      date: data[i].created_at?.slice(0, 10) || '',
      callIndex: i + 1,
      talkRatio: Math.round(window.reduce((s: number, d: any) => s + (d.talk_ratio || 0), 0) / windowSize),
      questionCount: Math.round(window.reduce((s: number, d: any) => s + (d.question_count || 0), 0) / windowSize),
      scriptAdherence: Math.round(window.reduce((s: number, d: any) => s + (d.script_adherence || 0), 0) / windowSize),
      callQuality: Math.round(window.reduce((s: number, d: any) => s + (d.call_quality_score || 0), 0) / windowSize),
    });
  }
  return json(res, points);
}

async function handleAEMonths(_req: VercelRequest, res: VercelResponse, name: string) {
  const supabase = getSupabase();
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
  if (allCalls.length === 0) return json(res, []);

  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const grouped = new Map<string, { label: string; sortKey: string; calls: any[] }>();
  for (const call of allCalls) {
    if (!call.created_at) continue;
    const d = new Date(call.created_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = `${monthNames[d.getMonth()]} ${d.getFullYear()}`;
    if (!grouped.has(key)) grouped.set(key, { label, sortKey: key, calls: [] });
    grouped.get(key)!.calls.push({
      id: call.recording_id, title: call.title || 'Untitled', date: call.created_at,
      quality: call.call_quality_score || 0, outcome: call.outcome || '',
      duration: Math.round((call.duration_seconds || 0) / 60),
      talkRatio: call.talk_ratio || 0, questions: call.question_count || 0, tier: call.call_tier || 'B',
    });
  }

  const months = Array.from(grouped.values())
    .sort((a, b) => b.sortKey.localeCompare(a.sortKey))
    .map(m => ({ label: m.label, sortKey: m.sortKey, callCount: m.calls.length, calls: m.calls }));
  return json(res, months);
}

async function handleAEPillars(_req: VercelRequest, res: VercelResponse, name: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('ae_call_analysis').select('pillar_scores').eq('recorder_name', name).order('created_at', { ascending: false }).limit(20);
  if (error) return json(res, { error: error.message }, 500);
  if (!data || data.length === 0) return json(res, {});
  const result: Record<string, any> = {};
  for (const key of PILLAR_KEYS) {
    const scores = data.filter(d => d.pillar_scores && (d.pillar_scores as any)[key]).map(d => ((d.pillar_scores as any)[key] as any).score || 0);
    const score = Math.round(avg(scores));
    result[key] = { name: PILLAR_NAMES[key], score, level: score >= 65 ? 'strong' : score >= 40 ? 'developing' : 'needs work' };
  }
  return json(res, result);
}

async function handleAEInterventions(_req: VercelRequest, res: VercelResponse, name: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('coaching_interventions').select('*').eq('recorder_name', name).order('created_at', { ascending: false }).limit(20);
  if (error) return json(res, { error: error.message }, 500);
  return json(res, data || []);
}


// ── Calls ──────────────────────────────────────────────────────────────────

async function handleCallDetail(_req: VercelRequest, res: VercelResponse, id: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('ae_call_analysis').select('*').eq('recording_id', id).single();
  if (error) return json(res, { error: error.message }, 404);
  return json(res, data);
}

async function handleCallEvidence(_req: VercelRequest, res: VercelResponse, id: string, dimension: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('ae_call_analysis').select('pattern_evidence').eq('recording_id', id).single();
  if (error) return json(res, { error: error.message }, 404);
  const evidence = (data?.pattern_evidence as Record<string, unknown[]>) || {};
  return json(res, evidence[dimension] || []);
}

async function handleCallQualityBreakdown(_req: VercelRequest, res: VercelResponse, id: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('ae_call_analysis').select('talk_ratio, question_count, script_adherence, prospect_engagement, highlights').eq('recording_id', id).single();
  if (error) return json(res, { error: error.message }, 404);
  return json(res, computeQualityBreakdown(data));
}

async function handleCallTierUpdate(req: VercelRequest, res: VercelResponse, id: string) {
  const { tier } = req.body || {};
  if (!['A', 'B', 'C'].includes(tier)) return json(res, { error: 'Tier must be A, B, or C' }, 400);
  const supabase = getSupabase();
  const { error } = await supabase.from('ae_call_analysis')
    .update({
      call_tier: tier,
      call_tier_classification: { tier, label: tier === 'A' ? 'Kanshebber' : tier === 'B' ? 'Full effort' : 'Troep', auto: false, signals: ['Handmatig ingesteld'] },
    })
    .eq('recording_id', id);
  if (error) return json(res, { error: error.message }, 500);
  return json(res, { ok: true, tier });
}

async function handleCallGameScore(_req: VercelRequest, res: VercelResponse, id: string) {
  const supabase = getSupabase();
  const { data: analysis } = await supabase.from('ae_call_analysis').select('game_score, outcome').eq('recording_id', id).single();
  if (analysis?.game_score?.totalPoints !== undefined) return json(res, analysis.game_score);
  return json(res, { error: 'Game score not available — requires transcript parsing' }, 501);
}

async function handleCalls(req: VercelRequest, res: VercelResponse) {
  const supabase = getSupabase();
  const limit = parseInt((req.query.limit as string) || '50');
  const offset = parseInt((req.query.offset as string) || '0');
  const { data, error } = await supabase
    .from('ae_call_analysis')
    .select('recording_id, recorder_name, title, deal_name, created_at, duration_seconds, outcome, call_quality_score, talk_ratio, question_count, call_tier')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return json(res, { error: error.message }, 500);
  return json(res, data);
}


// ── Deals ──────────────────────────────────────────────────────────────────

async function handleDeals(_req: VercelRequest, res: VercelResponse) {
  const cached = getCached('deals');
  if (cached) return json(res, cached);
  const supabase = getSupabase();
  const cutoffDate = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
  const [{ data, error }, { data: narrativeIds }] = await Promise.all([
    supabase.from('ae_call_analysis')
      .select('recording_id, recorder_name, title, deal_name, created_at, duration_seconds, recording_url, outcome, call_verdict, call_quality_score, question_count, patterns')
      .gte('created_at', cutoffDate).order('created_at', { ascending: false }).limit(1000),
    supabase.from('ae_call_analysis').select('recording_id').not('narrative_review', 'is', null).limit(1000),
  ]);
  if (error) return json(res, { error: error.message }, 500);
  if (!data) return json(res, []);

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
  return json(res, result);
}

async function handleDealTimeline(_req: VercelRequest, res: VercelResponse, name: string) {
  const supabase = getSupabase();
  const [{ data: byDeal, error }, { data: byTitle }, { data: narrativeIds }] = await Promise.all([
    supabase.from('ae_call_analysis').select('recording_id, recorder_name, title, deal_name, created_at, duration_seconds, recording_url, outcome, talk_ratio, question_count, script_adherence, longest_monologue, call_quality_score, patterns, highlights, sections_hit, sections_missed, prospect_engagement, call_verdict, pillar_scores').ilike('deal_name', `%${name}%`).order('created_at', { ascending: true }),
    supabase.from('ae_call_analysis').select('recording_id, recorder_name, title, deal_name, created_at, duration_seconds, recording_url, outcome, talk_ratio, question_count, script_adherence, longest_monologue, call_quality_score, patterns, highlights, sections_hit, sections_missed, prospect_engagement, call_verdict, pillar_scores').ilike('title', `%${name}%`).order('created_at', { ascending: true }),
    supabase.from('ae_call_analysis').select('recording_id').not('narrative_review', 'is', null).limit(1000),
  ]);
  if (error) return json(res, { error: error.message }, 500);
  const seen = new Set<string>();
  const data: any[] = [];
  for (const call of [...(byDeal || []), ...(byTitle || [])]) {
    if (!seen.has(call.recording_id)) { seen.add(call.recording_id); data.push(call); }
  }
  data.sort((a: any, b: any) => (a.created_at || '').localeCompare(b.created_at || ''));
  const narrativeSet = new Set((narrativeIds || []).map((r: any) => r.recording_id));
  return json(res, data.map((call: any) => ({ ...call, hasNarrative: narrativeSet.has(call.recording_id) })));
}


// ── Game ───────────────────────────────────────────────────────────────────

async function handleGameLeaderboard(_req: VercelRequest, res: VercelResponse) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('ae_call_analysis')
    .select('recorder_name, game_score, outcome, created_at')
    .not('game_score', 'is', null)
    .order('created_at', { ascending: false });
  if (error) return json(res, { error: error.message }, 500);

  const byAE = new Map<string, any[]>();
  for (const row of (data || [])) {
    if (!row.game_score || row.game_score.totalPoints === undefined) continue;
    const name = row.recorder_name;
    if (!byAE.has(name)) byAE.set(name, []);
    byAE.get(name)!.push(row);
  }

  const leaderboard = Array.from(byAE.entries()).map(([name, calls]) => {
    const scores = calls.map(c => c.game_score.totalPoints || 0);
    const avgScore = Math.round(scores.reduce((a: number, b: number) => a + b, 0) / scores.length);
    const perfectGames = calls.filter(c => c.game_score.totalPoints === c.game_score.maxPoints).length;

    const actionHits: Record<string, number> = {};
    for (const id of ['A', 'B', 'C', 'D', 'E', 'F']) {
      const earned = calls.filter(c => c.game_score.actions?.find((a: any) => a.id === id && a.earned)).length;
      actionHits[id] = Math.round((earned / calls.length) * 100);
    }

    return { name, totalCalls: calls.length, avgScore, perfectGames, actionHitRates: actionHits, recentScores: scores.slice(0, 5) };
  });

  leaderboard.sort((a, b) => b.avgScore - a.avgScore);
  return json(res, { leaderboard });
}

async function handleGameAE(_req: VercelRequest, res: VercelResponse, name: string) {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('ae_call_analysis')
    .select('recording_id, title, deal_name, outcome, created_at, game_score')
    .eq('recorder_name', name)
    .not('game_score', 'is', null)
    .order('created_at', { ascending: false })
    .limit(50);
  return json(res, {
    ae: name,
    calls: (data || []).map(d => ({
      recordingId: d.recording_id, title: d.title, deal: d.deal_name,
      outcome: d.outcome, date: d.created_at, gameScore: d.game_score,
    })),
  });
}


// ── Reps & Coaching ────────────────────────────────────────────────────────

async function handleReps(_req: VercelRequest, res: VercelResponse) {
  const supabase = getSupabase();
  const [{ data: profiles, error: profilesErr }, { data: allCalls, error: callsErr }] = await Promise.all([
    supabase.from('ae_coaching_profiles').select('recorder_name, total_calls, avg_call_quality, top_weaknesses'),
    supabase.from('ae_call_analysis').select('recorder_name, created_at, call_quality_score, talk_ratio, question_count, patterns').order('created_at', { ascending: false }).limit(500),
  ]);
  if (profilesErr) return json(res, { error: profilesErr.message }, 500);
  if (callsErr) return json(res, { error: callsErr.message }, 500);
  if (!profiles) return json(res, []);

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
  return json(res, result);
}

async function handleCoachingBrief(_req: VercelRequest, res: VercelResponse, name: string) {
  const supabase = getSupabase();
  const [{ data: profile, error: profileErr }, { data: calls, error: callsErr }] = await Promise.all([
    supabase.from('ae_coaching_profiles').select('*').eq('recorder_name', name).single(),
    supabase.from('ae_call_analysis').select('recording_id, recorder_name, title, created_at, call_quality_score, call_verdict, talk_ratio, question_count, patterns, highlights, recording_url').eq('recorder_name', name).order('created_at', { ascending: false }).limit(10),
  ]);
  if (profileErr) return json(res, { error: profileErr.message }, 404);
  if (callsErr) return json(res, { error: callsErr.message }, 500);
  if (!calls || calls.length === 0) return json(res, { error: 'No calls found for this rep' }, 404);

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

  return json(res, {
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
}


// ── Coaching Feedback ──────────────────────────────────────────────────────

async function handleFeedbackSubmit(req: VercelRequest, res: VercelResponse) {
  const body = req.body || {};
  if (!body.recordingId || !body.category || !body.vote) return json(res, { error: 'Missing recordingId, category, or vote' }, 400);
  const supabase = getSupabase();
  const id = `fb_${body.recordingId}_${body.category}_${Date.now()}`;
  const { error } = await supabase.from('coaching_feedback').upsert({
    id, recording_id: body.recordingId, moment_category: body.category,
    moment_excerpt: body.excerpt?.slice(0, 300) || '', vote: body.vote,
    voter: body.voter || 'anonymous', created_at: new Date().toISOString(),
  });
  if (error) return json(res, { error: error.message }, 500);
  return json(res, { ok: true });
}

async function handleFeedbackHealth(_req: VercelRequest, res: VercelResponse) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('coaching_feedback').select('moment_category, vote');
  if (error) return json(res, { error: error.message }, 500);
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
  return json(res, health);
}

async function handleFeedbackForCall(_req: VercelRequest, res: VercelResponse, recordingId: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('coaching_feedback').select('moment_category, vote').eq('recording_id', recordingId);
  if (error) return json(res, { error: error.message }, 500);
  const counts: Record<string, { up: number; down: number }> = {};
  for (const row of data || []) {
    if (!counts[row.moment_category]) counts[row.moment_category] = { up: 0, down: 0 };
    counts[row.moment_category][row.vote as 'up' | 'down']++;
  }
  return json(res, counts);
}


// ── Interventions ──────────────────────────────────────────────────────────

async function handleInterventions(_req: VercelRequest, res: VercelResponse) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('coaching_interventions').select('*').in('status', ['active', 'measured']).order('created_at', { ascending: false }).limit(50);
  if (error) return json(res, { error: error.message }, 500);
  return json(res, data || []);
}

async function handleCreateIntervention(req: VercelRequest, res: VercelResponse) {
  const body = req.body || {};
  if (!body.recorderName || !body.focusArea || !body.description) return json(res, { error: 'Missing recorderName, focusArea, or description' }, 400);
  const supabase = getSupabase();

  const [{ data: profile }, { data: recentCalls }] = await Promise.all([
    supabase.from('ae_coaching_profiles').select('avg_call_quality, avg_talk_ratio, avg_question_count, avg_script_adherence').eq('recorder_name', body.recorderName).single(),
    supabase.from('ae_call_analysis').select('pillar_scores').eq('recorder_name', body.recorderName).order('created_at', { ascending: false }).limit(10),
  ]);

  let baselinePillar: number | null = null;
  if (body.focusPillar && recentCalls && recentCalls.length > 0) {
    const pillarScores = recentCalls.filter((c: any) => c.pillar_scores && (c.pillar_scores as any)[body.focusPillar]).map((c: any) => ((c.pillar_scores as any)[body.focusPillar] as any).score || 0);
    if (pillarScores.length > 0) baselinePillar = Math.round(pillarScores.reduce((a: number, b: number) => a + b, 0) / pillarScores.length);
  }

  let baselineMetric: number | null = null;
  if (profile) {
    const fa = body.focusArea.toLowerCase();
    if (fa.includes('talk')) baselineMetric = profile.avg_talk_ratio;
    else if (fa.includes('question') || fa.includes('discovery')) baselineMetric = profile.avg_question_count;
    else if (fa.includes('script')) baselineMetric = profile.avg_script_adherence;
    else baselineMetric = profile.avg_call_quality;
  }

  const id = `int_${body.recorderName.replace(/\s+/g, '_')}_${Date.now()}`;
  const { error } = await supabase.from('coaching_interventions').upsert({
    id, recorder_name: body.recorderName, focus_area: body.focusArea, focus_pillar: body.focusPillar || null,
    description: body.description, source: body.source || 'dashboard', baseline_quality: profile?.avg_call_quality || null,
    baseline_metric: baselineMetric, baseline_pillar_score: baselinePillar, created_by: 'lead', notes: body.notes || null,
    created_at: new Date().toISOString(),
  });
  if (error) return json(res, { error: error.message }, 500);
  return json(res, { ok: true, id });
}

async function handleDismissIntervention(_req: VercelRequest, res: VercelResponse, id: string) {
  const supabase = getSupabase();
  const { error } = await supabase.from('coaching_interventions').update({ status: 'dismissed' }).eq('id', id);
  if (error) return json(res, { error: error.message }, 500);
  return json(res, { ok: true });
}


// ── Calibration ────────────────────────────────────────────────────────────

async function handleCalibration(_req: VercelRequest, res: VercelResponse) {
  const supabase = getSupabase();
  const allCalls: any[] = [];
  let from = 0;
  while (true) {
    const { data: page } = await supabase.from('ae_call_analysis').select('outcome, talk_ratio, question_count, script_adherence, call_quality_score, pillar_scores').in('outcome', ['won', 'lost']).range(from, from + 999);
    if (!page || page.length === 0) break;
    allCalls.push(...page);
    if (page.length < 1000) break;
    from += 1000;
  }
  if (allCalls.length < 20) return json(res, { error: 'Need 20+ won/lost calls for calibration' }, 400);

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

  return json(res, {
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
}


// ── MM Routes ──────────────────────────────────────────────────────────────

const MM_DEAL_FILTER = 'deal_name.ilike.%- MM%,deal_name.ilike.%MM -%,deal_name.ilike.%MM Pilot%,deal_name.ilike.%MM Expansion%,deal_name.ilike.%MidMarket%,deal_name.ilike.%Mid Market%,deal_name.ilike.%Mid market%';

async function handleMMCalls(_req: VercelRequest, res: VercelResponse) {
  const cached = getCached('mm-calls');
  if (cached) return json(res, cached);
  const supabase = getSupabase();
  const { data, error } = await supabase.from('recordings')
    .select('id, title, deal_name, channel_name, recorder_name, created_at, duration_seconds, url, key_takeaways, outline')
    .or(MM_DEAL_FILTER).order('created_at', { ascending: false });
  if (error) return json(res, { error: error.message }, 500);

  const mmRecs = (data || []).filter((r: any) => isActualMM(r.deal_name));
  const byDeal: Record<string, any> = {};
  mmRecs.forEach((r: any) => {
    const deal = r.deal_name || 'Unknown';
    if (!byDeal[deal]) byDeal[deal] = { deal, recordings: [], totalMinutes: 0, aes: new Set(), latestDate: r.created_at };
    byDeal[deal].recordings.push(r);
    byDeal[deal].totalMinutes += Math.round((r.duration_seconds || 0) / 60);
    if (r.recorder_name) byDeal[deal].aes.add(r.recorder_name);
  });

  const deals = Object.values(byDeal).map((d: any) => ({ ...d, aes: [...d.aes] })).sort((a: any, b: any) => new Date(b.latestDate).getTime() - new Date(a.latestDate).getTime());
  const result = {
    totalRecordings: mmRecs.length, totalDeals: deals.length,
    totalMinutes: mmRecs.reduce((s: number, r: any) => s + Math.round((r.duration_seconds || 0) / 60), 0),
    aes: [...new Set(mmRecs.map((r: any) => r.recorder_name).filter(Boolean))], deals,
  };
  setCache('mm-calls', result);
  return json(res, result);
}

async function handleMMCallDetail(_req: VercelRequest, res: VercelResponse, id: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('recordings')
    .select('id, title, deal_name, channel_name, recorder_name, created_at, duration_seconds, url, transcript_text, key_takeaways, outline')
    .eq('id', id).single();
  if (error) return json(res, { error: error.message }, 500);
  return json(res, data);
}

async function handleMMAnalyses(_req: VercelRequest, res: VercelResponse) {
  const cached = getCached('mm-analyses');
  if (cached) return json(res, cached);
  const supabase = getSupabase();
  const { data, error } = await supabase.from('mm_call_analysis').select('*').order('created_at', { ascending: false });
  if (error) return json(res, { analyses: [], learnings: [] });

  const allLearnings: any[] = [];
  (data || []).forEach((a: any) => {
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
  return json(res, result);
}
