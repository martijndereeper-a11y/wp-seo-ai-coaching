/**
 * Coaching Dashboard API
 *
 * Lightweight Hono server composing route modules.
 * Each domain lives in its own file under routes/.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authMiddleware, requireRole } from './auth.ts';
import { supabase, clearCache } from './shared.ts';
import { loadSettings, saveSetting, invalidateCache, getPasswords } from '../config/settings.ts';

// Route modules
import teamRoutes from './routes/team.ts';
import callRoutes from './routes/calls.ts';
import aeRoutes from './routes/ae.ts';
import dealRoutes from './routes/deals.ts';
import gameRoutes from './routes/game.ts';
import coachingRoutes from './routes/coaching.ts';
import mmRoutes from './routes/mm.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = new Hono();

app.use('*', cors());

// ─── Health Check (unauthenticated) ─────────────────────────────────────────

app.get('/api/health', async (c) => {
  const checks: Record<string, string> = { api: 'ok' };
  try {
    const { count, error } = await supabase.from('recordings').select('id', { count: 'exact', head: true });
    checks.supabase = error ? `error: ${error.message}` : 'ok';
    checks.recordings = String(count ?? 0);
  } catch (e) {
    checks.supabase = 'unreachable';
  }
  const allOk = Object.values(checks).every(v => v === 'ok' || !isNaN(Number(v)));
  return c.json({ status: allOk ? 'healthy' : 'degraded', checks, timestamp: new Date().toISOString() }, allOk ? 200 : 503);
});

// ─── Auth Login (unauthenticated) ───────────────────────────────────────────

// Legacy password login (backward compatible)
app.post('/api/auth/login', async (c) => {
  const body = await c.req.json() as { password?: string; email?: string };

  // Legacy: password-based login
  if (body.password) {
    const passwords = await getPasswords();
    if (body.password === passwords.lead) return c.json({ role: 'lead', token: body.password });
    if (body.password === passwords.ae) return c.json({ role: 'ae', token: body.password });
    return c.json({ error: 'Invalid password' }, 401);
  }

  // New: Supabase Auth magic link
  if (body.email) {
    const url = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;
    if (!url || !anonKey) return c.json({ error: 'Supabase Auth not configured' }, 500);
    const { createClient } = await import('@supabase/supabase-js');
    const authClient = createClient(url, anonKey);
    const { error } = await authClient.auth.signInWithOtp({
      email: body.email,
      options: { shouldCreateUser: false },
    });
    if (error) return c.json({ error: error.message }, 400);
    return c.json({ ok: true, message: 'Magic link sent — check your email' });
  }

  return c.json({ error: 'Provide password or email' }, 400);
});

// Get current user info (works with both auth methods)
app.get('/api/auth/me', async (c) => {
  // This will be called after auth middleware, so we can read context
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
    || c.req.header('X-Auth-Token');
  if (!token) return c.json({ error: 'Not authenticated' }, 401);

  // Try Supabase Auth
  if (token.startsWith('eyJ')) {
    const url = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;
    if (url && anonKey) {
      const { createClient } = await import('@supabase/supabase-js');
      const { data: { user } } = await createClient(url, anonKey).auth.getUser(token);
      if (user) return c.json({
        id: user.id, email: user.email, name: user.user_metadata?.name || user.email?.split('@')[0],
        role: user.user_metadata?.role || 'ae', authMethod: 'supabase',
      });
    }
  }

  // Legacy password
  const passwords = await getPasswords();
  if (token === passwords.lead) return c.json({ role: 'lead', authMethod: 'password' });
  if (token === passwords.ae) return c.json({ role: 'ae', authMethod: 'password' });
  return c.json({ error: 'Invalid token' }, 401);
});

// ─── Auth middleware for all other /api/* routes ────────────────────────────

app.use('/api/*', authMiddleware);

// ─── Settings (lead only) ───────────────────────────────────────────────────

app.get('/api/settings', requireRole('lead'), async (c) => {
  const settings = await loadSettings();
  const safe = { ...settings };
  if (safe.auth_passwords) safe.auth_passwords = { ae: '***', lead: '***' };
  return c.json(safe);
});

app.put('/api/settings/:key', requireRole('lead'), async (c) => {
  const key = c.req.param('key')!;
  const { value } = await c.req.json();
  const validKeys = ['auth_passwords','sync_channels','sync_personal_email','quality_weights','thresholds','deal_patterns','llm_model','coaching_rules','coaching_thresholds','script_sections'];
  if (!validKeys.includes(key)) return c.json({ error: 'Unknown setting: ' + key }, 400);
  const ok = await saveSetting(key, value as any);
  if (!ok) return c.json({ error: 'Failed to save setting' }, 500);
  clearCache();
  return c.json({ ok: true, key });
});

// ─── Route modules ──────────────────────────────────────────────────────────

app.route('/api', teamRoutes);
app.route('/api', callRoutes);
app.route('/api', aeRoutes);
app.route('/api', dealRoutes);
app.route('/api', gameRoutes);
app.route('/api', coachingRoutes);
app.route('/api', mmRoutes);

// ─── Dashboard HTML ─────────────────────────────────────────────────────────

function serveDashboardFile(c: any, filename: string) {
  const paths = [
    join(__dirname, '..', 'dashboard', filename),
    join(process.cwd(), 'src', 'dashboard', filename),
    join(__dirname, '..', '..', 'src', 'dashboard', filename),
  ];
  for (const p of paths) {
    if (existsSync(p)) return c.html(readFileSync(p, 'utf-8'));
  }
  return c.text(`${filename} not found. Tried: ${paths.join(', ')}`, 500);
}

app.get('/', (c) => serveDashboardFile(c, 'v1.html'));
app.get('/v1', (c) => serveDashboardFile(c, 'v1.html'));
app.get('/classic', (c) => serveDashboardFile(c, 'index.html'));
app.get('/deep', (c) => serveDashboardFile(c, 'index.html'));
app.get('/sales-os', (c) => serveDashboardFile(c, 'sales-os.html'));
app.get('/pipeline', (c) => serveDashboardFile(c, 'pipeline.html'));

// ─── Export ─────────────────────────────────────────────────────────────────

export default app;
export const appFetch = app.fetch;

if (process.argv[1] && (process.argv[1].includes('server.ts') || process.argv[1].includes('server.js'))) {
  import('@hono/node-server').then(({ serve }) => {
    const port = parseInt(process.env.PORT || '3000');
    console.log(`Coaching Dashboard running at http://localhost:${port}`);
    serve({ fetch: app.fetch, port });
  });
}
