/**
 * Settings Loader — reads platform_settings from Supabase (key-value, JSONB values)
 * Caches in memory with 60s TTL.
 */

import { createSupabaseClient } from '../database/supabase-client.ts';

let cache: Record<string, any> = {};
let cacheTime = 0;
const CACHE_TTL = 60000;

export async function loadSettings(): Promise<Record<string, any>> {
  if (Date.now() - cacheTime < CACHE_TTL && Object.keys(cache).length > 0) return cache;
  const supabase = createSupabaseClient();
  const { data } = await supabase.from('platform_settings').select('key, value');
  cache = {};
  for (const row of data || []) cache[row.key] = row.value;
  cacheTime = Date.now();
  return cache;
}

export function invalidateCache() { cacheTime = 0; }

// Typed getters with fallback defaults
export async function getPasswords(): Promise<{ae: string; lead: string}> {
  const s = await loadSettings();
  return s.auth_passwords || { ae: 'wpseoai2026', lead: 'coaching2026!' };
}

/** Separate admin-analytics password for /admin (call-engine analysis + data chat).
 * Resolution: ADMIN_ANALYTICS_PASSWORD env var → platform_settings → fallback. */
export async function getAdminAnalyticsPassword(): Promise<string> {
  if (process.env.ADMIN_ANALYTICS_PASSWORD) return process.env.ADMIN_ANALYTICS_PASSWORD;
  const s = await loadSettings();
  return s.admin_analytics_password || 'admin-analytics-2026!';
}

export async function getQualityWeights() {
  const s = await loadSettings();
  return s.quality_weights || { talkBalance: 25, discovery: 20, scriptAdherence: 20, engagement: 15, coachable: 20 };
}

export async function getThresholds() {
  const s = await loadSettings();
  return s.thresholds || { talkRatioHigh: 60, questionCountLow: 18, questionCountTarget: 22, monologueWords: 100, softeningWordsPerTurn: 3 };
}

export async function getSyncChannels() {
  const s = await loadSettings();
  return s.sync_channels || [];
}

export async function getDealPatterns(): Promise<string[]> {
  const s = await loadSettings();
  return s.deal_patterns || ['starter','basic','pro','12m','12p','24m'];
}

export async function getLlmModel(): Promise<string> {
  const s = await loadSettings();
  return (typeof s.llm_model === 'string' ? s.llm_model : s.llm_model) || 'claude-sonnet-4-6';
}

export async function getCoachingRules(): Promise<string> {
  const s = await loadSettings();
  if (s.coaching_rules && typeof s.coaching_rules === 'string' && s.coaching_rules.length > 10) return s.coaching_rules;
  // Fallback to file
  try {
    const { readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const path = join(process.cwd(), 'coaching-guides', 'koen-rules.md');
    if (existsSync(path)) return readFileSync(path, 'utf-8');
  } catch {}
  return '';
}

export async function saveSetting(key: string, value: any): Promise<boolean> {
  const supabase = createSupabaseClient();
  const { error } = await supabase.from('platform_settings').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (!error) invalidateCache();
  return !error;
}
