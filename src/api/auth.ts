/**
 * Auth Middleware — hybrid: supports both legacy passwords AND Supabase Auth (JWT)
 *
 * Migration path:
 * 1. Current: passwords still work (backward compatible)
 * 2. New: Supabase Auth JWTs accepted — user identity preserved
 * 3. Future: remove password auth once all users on Supabase Auth
 *
 * Roles: 'lead' (full access) and 'ae' (restricted)
 * When using Supabase Auth, role is determined by user_metadata.role
 */

import type { Context, Next } from 'hono';
import { getPasswords } from '../config/settings.ts';
import { createClient } from '@supabase/supabase-js';

// Supabase Auth client (uses anon key for JWT verification)
function getAuthClient() {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !anonKey) return null;
  return createClient(url, anonKey);
}

export async function authMiddleware(c: Context, next: Next) {
  // Skip auth for login, health, and public endpoints
  if (c.req.path === '/api/auth/login') return next();
  if (c.req.path === '/api/health') return next();
  if (c.req.path.startsWith('/api/mm/market-thesis')) return next();
  if (c.req.path.startsWith('/api/mm/narrative')) return next();

  const token = c.req.header('Authorization')?.replace('Bearer ', '')
    || c.req.header('X-Auth-Token')
    || getCookie(c, 'auth_token');

  if (!token) return c.json({ error: 'Authentication required' }, 401);

  // Try Supabase Auth JWT first (starts with 'eyJ')
  if (token.startsWith('eyJ')) {
    const authClient = getAuthClient();
    if (authClient) {
      const { data: { user }, error } = await authClient.auth.getUser(token);
      if (!error && user) {
        const role = (user.user_metadata?.role as string) || 'ae';
        c.set('role', role);
        c.set('userId', user.id);
        c.set('userEmail', user.email);
        c.set('userName', user.user_metadata?.name || user.email?.split('@')[0] || 'Unknown');
        c.set('authMethod', 'supabase');
        return next();
      }
    }
  }

  // Fallback: legacy password auth
  const passwords = await getPasswords();
  if (token === passwords.lead) {
    c.set('role', 'lead');
    c.set('authMethod', 'password');
  } else if (token === passwords.ae) {
    c.set('role', 'ae');
    c.set('authMethod', 'password');
  } else {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  return next();
}

export function requireRole(role: string) {
  return async (c: Context, next: Next) => {
    const userRole = c.get('role');
    if (role === 'lead' && userRole !== 'lead') {
      return c.json({ error: 'Lead access required' }, 403);
    }
    return next();
  };
}

function getCookie(c: Context, name: string): string | undefined {
  const cookies = c.req.header('Cookie') || '';
  const match = cookies.match(new RegExp(`${name}=([^;]+)`));
  return match?.[1];
}
