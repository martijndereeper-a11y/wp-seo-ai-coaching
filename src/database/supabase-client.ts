/**
 * Supabase client — initialized from environment variables.
 *
 * Set SUPABASE_URL and SUPABASE_SERVICE_KEY in your environment
 * or in ~/.config/document-hub/.env
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function loadEnvFile(): void {
  const envPath = join(homedir(), '.config', 'document-hub', '.env');
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

export function createSupabaseClient(): SupabaseClient {
  loadEnvFile();

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY. ' +
      'Set them as env vars or in ~/.config/document-hub/.env'
    );
  }

  return createClient(url, key);
}
