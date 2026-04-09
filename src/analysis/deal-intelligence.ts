/**
 * Deal Intelligence — Closed-Loop Analytics Engine
 *
 * Connects recordings to deals, tracks content attribution,
 * and computes narrative performance metrics.
 *
 * What would Noy do? Prove that every deck, every call, every coaching
 * session actually moves the revenue needle.
 */

import { createSupabaseClient } from '../database/supabase-client.ts';

const supabase = createSupabaseClient();

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Deal {
  id: string;
  company_name: string;
  deal_name?: string;
  segment: 'smb' | 'midmarket';
  stage: string;
  ae_name: string;
  arr_value?: number;
  outcome?: string;
  loss_reason?: string;
  competitor?: string;
  champion_name?: string;
  decision_maker?: string;
  first_meeting_at?: string;
  closed_at?: string;
  days_in_pipeline?: number;
  deal_score?: number;
  multi_thread_count?: number;
  meetings_count?: number;
}

export interface ContentUsageRecord {
  deal_id?: string;
  recording_id?: string;
  content_type: string;
  content_name: string;
  content_version?: string;
  used_in?: string;
  ae_name?: string;
  segment?: string;
  stage_before?: string;
}

export interface NarrativePerformance {
  content_name: string;
  content_version?: string;
  segment: string;
  times_used: number;
  deals_advanced: number;
  deals_won: number;
  deals_lost: number;
  avg_deal_velocity_days?: number;
  win_rate?: number;
}

// ─── Deal Linking ───────────────────────────────────────────────────────────
// Auto-links recordings to deals by matching deal_name from Claap metadata

export async function linkRecordingsToDeals(): Promise<{ linked: number; created: number }> {
  const { data: unlinked } = await supabase
    .from('recordings')
    .select('id, deal_name, recorder_name, created_at, companies(name)')
    .not('deal_name', 'is', null)
    .limit(200);

  if (!unlinked?.length) return { linked: 0, created: 0 };

  let linked = 0;
  let created = 0;

  for (const rec of unlinked) {
    if (!rec.deal_name) continue;

    // Check if deal exists
    const { data: existing } = await supabase
      .from('deals')
      .select('id')
      .eq('deal_name', rec.deal_name)
      .maybeSingle();

    let dealId = existing?.id;

    // Auto-create deal from recording metadata if not found
    if (!dealId) {
      const companyName = (rec as any).companies?.[0]?.name || rec.deal_name;
      const newDeal: Partial<Deal> = {
        id: `deal_${rec.deal_name.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}`,
        company_name: companyName,
        deal_name: rec.deal_name,
        segment: 'smb',
        stage: 'discovery',
        ae_name: rec.recorder_name || 'unknown',
        first_meeting_at: rec.created_at,
      };

      const { data: inserted } = await supabase
        .from('deals')
        .insert(newDeal)
        .select('id')
        .single();

      if (inserted) {
        dealId = inserted.id;
        created++;
      }
    }

    if (dealId) {
      // Log a deal event for the meeting
      await supabase.from('deal_events').insert({
        deal_id: dealId,
        event_type: 'meeting',
        event_data: { recording_id: rec.id, title: rec.deal_name },
        created_at: rec.created_at,
        source: 'sync',
      });

      // Update meeting count
      await supabase.rpc('increment_deal_meetings', { deal_id_input: dealId }).then(
        () => {},
        () => {} // RPC may not exist yet — non-critical
      );

      linked++;
    }
  }

  return { linked, created };
}

// ─── Content Attribution ────────────────────────────────────────────────────
// Records that a specific piece of content was used in a deal context

export async function trackContentUsage(usage: ContentUsageRecord): Promise<boolean> {
  const { error } = await supabase.from('content_usage').insert(usage);
  return !error;
}

// ─── Narrative Performance Computation ──────────────────────────────────────
// Aggregates content_usage + deals to compute which narratives/decks win

export async function computeNarrativePerformance(): Promise<NarrativePerformance[]> {
  const { data: usage } = await supabase
    .from('content_usage')
    .select('content_name, content_version, segment, deal_id, advanced_deal, deals(outcome, days_in_pipeline)')
    .not('deal_id', 'is', null);

  if (!usage?.length) return [];

  // Group by content_name + version + segment
  const groups = new Map<string, {
    name: string; version?: string; segment: string;
    used: number; advanced: number; won: number; lost: number; velocities: number[];
  }>();

  for (const u of usage) {
    const key = `${u.content_name}|${u.content_version || ''}|${u.segment || 'smb'}`;
    if (!groups.has(key)) {
      groups.set(key, {
        name: u.content_name, version: u.content_version ?? undefined,
        segment: u.segment || 'smb', used: 0, advanced: 0, won: 0, lost: 0, velocities: [],
      });
    }
    const g = groups.get(key)!;
    g.used++;
    if (u.advanced_deal) g.advanced++;
    const deal = (u as any).deals;
    if (deal?.outcome === 'won') { g.won++; if (deal.days_in_pipeline) g.velocities.push(deal.days_in_pipeline); }
    if (deal?.outcome === 'lost') g.lost++;
  }

  const results: NarrativePerformance[] = [];

  for (const g of groups.values()) {
    const perf: NarrativePerformance = {
      content_name: g.name,
      content_version: g.version,
      segment: g.segment,
      times_used: g.used,
      deals_advanced: g.advanced,
      deals_won: g.won,
      deals_lost: g.lost,
      avg_deal_velocity_days: g.velocities.length
        ? Math.round(g.velocities.reduce((a, b) => a + b, 0) / g.velocities.length)
        : undefined,
      win_rate: (g.won + g.lost) > 0
        ? Math.round((g.won / (g.won + g.lost)) * 100)
        : undefined,
    };
    results.push(perf);

    // Upsert into narrative_performance table
    await supabase
      .from('narrative_performance')
      .upsert({
        content_name: perf.content_name,
        content_version: perf.content_version ?? null,
        segment: perf.segment,
        times_used: perf.times_used,
        deals_advanced: perf.deals_advanced,
        deals_won: perf.deals_won,
        deals_lost: perf.deals_lost,
        avg_deal_velocity_days: perf.avg_deal_velocity_days ?? null,
        win_rate: perf.win_rate ?? null,
        last_computed_at: new Date().toISOString(),
      }, { onConflict: 'content_name,content_version,segment' });
  }

  return results;
}

// ─── Deal Health Score ──────────────────────────────────────────────────────
// Computes a 0-100 deal health score based on signals from calls + events

export async function scoreDealHealth(dealId: string): Promise<number> {
  const { data: deal } = await supabase
    .from('deals')
    .select('*')
    .eq('id', dealId)
    .single();

  if (!deal) return 0;

  let score = 50; // baseline

  // Multi-threading: more contacts = healthier
  const threads = deal.multi_thread_count || 1;
  if (threads >= 3) score += 15;
  else if (threads >= 2) score += 8;
  else score -= 10; // single-threaded = risk

  // Meeting cadence: recent activity is good
  const { data: recentEvents } = await supabase
    .from('deal_events')
    .select('created_at')
    .eq('deal_id', dealId)
    .eq('event_type', 'meeting')
    .order('created_at', { ascending: false })
    .limit(3);

  if (recentEvents?.length) {
    const lastMeeting = new Date(recentEvents[0].created_at);
    const daysSince = (Date.now() - lastMeeting.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince <= 7) score += 10;
    else if (daysSince <= 14) score += 5;
    else if (daysSince > 30) score -= 15; // gone cold
  } else {
    score -= 10; // no meetings logged
  }

  // Champion identified
  if (deal.champion_name) score += 10;

  // Decision maker identified
  if (deal.decision_maker) score += 5;

  // Call quality from latest analysis
  const { data: latestCall } = await supabase
    .from('ae_call_analysis')
    .select('call_quality_score')
    .eq('deal_name', deal.deal_name)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestCall?.call_quality_score) {
    if (latestCall.call_quality_score >= 75) score += 10;
    else if (latestCall.call_quality_score < 40) score -= 10;
  }

  // Risk events
  const { count: riskCount } = await supabase
    .from('deal_events')
    .select('id', { count: 'exact', head: true })
    .eq('deal_id', dealId)
    .eq('event_type', 'risk_flag');

  if (riskCount && riskCount > 0) score -= riskCount * 5;

  return Math.max(0, Math.min(100, score));
}

// ─── Pipeline Summary ───────────────────────────────────────────────────────
// Aggregated pipeline view for dashboard

export async function getPipelineSummary(segment?: string) {
  let query = supabase
    .from('deals')
    .select('stage, outcome, arr_value, segment, ae_name, days_in_pipeline')
    .not('stage', 'in', '(closed_won,closed_lost)');

  if (segment) query = query.eq('segment', segment);

  const { data: activeDeals } = await query;
  const { data: closedDeals } = await supabase
    .from('deals')
    .select('outcome, arr_value, segment, days_in_pipeline, loss_reason, competitor')
    .in('outcome', ['won', 'lost'])
    .gte('closed_at', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString());

  const active = activeDeals || [];
  const closed = closedDeals || [];
  const won = closed.filter(d => d.outcome === 'won');
  const lost = closed.filter(d => d.outcome === 'lost');

  return {
    active_deals: active.length,
    pipeline_value: active.reduce((sum, d) => sum + (d.arr_value || 0), 0),
    by_stage: active.reduce((acc, d) => {
      const s = d.stage || 'unknown';
      (acc[s] = acc[s] || []).push(d);
      return acc;
    }, {} as Record<string, typeof active>),
    last_90_days: {
      won: won.length,
      lost: lost.length,
      win_rate: (won.length + lost.length) > 0
        ? Math.round((won.length / (won.length + lost.length)) * 100)
        : null,
      avg_deal_size: won.length
        ? Math.round(won.reduce((s, d) => s + (d.arr_value || 0), 0) / won.length)
        : null,
      avg_cycle_days: won.length
        ? Math.round(won.reduce((s, d) => s + (d.days_in_pipeline || 0), 0) / won.length)
        : null,
      top_loss_reasons: Object.entries(
        lost.reduce((acc, d) => { if (d.loss_reason) acc[d.loss_reason] = (acc[d.loss_reason] || 0) + 1; return acc; }, {} as Record<string, number>)
      ).sort((a, b) => b[1] - a[1]).slice(0, 3),
    },
  };
}
