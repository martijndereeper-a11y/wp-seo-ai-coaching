/**
 * Auth Middleware — simple password-based auth for Hono
 *
 * Tokens are the passwords themselves (sent as Bearer token, X-Auth-Token header, or auth_token cookie).
 * Roles: 'lead' (full access) and 'ae' (restricted).
 */

import type { Context, Next } from 'hono';
import { getPasswords } from '../config/settings.ts';

export async function authMiddleware(c: Context, next: Next) {
  // Skip auth for login and public MM content endpoints
  if (c.req.path === '/api/auth/login') return next();
  if (c.req.path.startsWith('/api/mm/market-thesis')) return next();
  if (c.req.path.startsWith('/api/mm/narrative')) return next();

  const token = c.req.header('Authorization')?.replace('Bearer ', '')
    || c.req.header('X-Auth-Token')
    || getCookie(c, 'auth_token');

  if (!token) return c.json({ error: 'Authentication required' }, 401);

  const passwords = await getPasswords();
  if (token === passwords.lead) {
    c.set('role', 'lead');
  } else if (token === passwords.ae) {
    c.set('role', 'ae');
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
