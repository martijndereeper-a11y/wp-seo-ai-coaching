/**
 * Load feature matrix from Supabase (ae_call_analysis + recordings) and binarize.
 * Mirrors layer1/3 feature_matrix in the Python engine.
 */

import { createSupabaseClient } from '../../database/supabase-client.ts';
import { SPICED_BEHAVIOR_IDS, type SPICEDKey } from '../spiced-classifier.ts';

const sb = createSupabaseClient();

const SPICED_KEYS: SPICEDKey[] = ['S', 'P', 'I', 'C', 'D'];

export type Market = 'NL' | 'DE' | 'EN' | 'OTHER';

export type CallRow = {
  callId: string;
  aeId: string;
  aeName: string;
  market: Market;
  outcome: 0 | 1;
  outcomeLabel: 'won' | 'lost';
  callQuality: number;
  scriptAdherence: number;
  talkRatio: number;
  questionCount: number;
  longestMonologue: number;
  sectionsHit: number[];
  patterns: Record<string, number>;
  pillars: Record<string, number>; // pillar -> score
  dealName: string | null;
  createdAt: string;
  duration: number | null;
  recordingUrl: string | null;
};

export type FeatureMatrix = {
  rows: CallRow[];
  behaviorIds: string[]; // binarized pattern names
  pillarIds: string[];
};

// Treat pattern count >= threshold as behavior "present"
const BEHAVIOR_THRESHOLD = 1;

function mapLangToMarket(lang: string | null | undefined): Market {
  if (!lang) return 'OTHER';
  const l = lang.toLowerCase();
  if (l === 'nl') return 'NL';
  if (l === 'de') return 'DE';
  if (l === 'en') return 'EN';
  return 'OTHER';
}

async function pageAll<T>(builder: () => any): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  while (true) {
    const q = builder().range(from, from + 999);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return rows;
}

export async function loadFeatureMatrix(opts?: { firstMeetingsOnly?: boolean }): Promise<FeatureMatrix> {
  const firstOnly = opts?.firstMeetingsOnly ?? true;

  // Pull call analysis rows with won/lost outcomes
  let callsRaw = await pageAll<any>(() => {
    let q = sb.from('ae_call_analysis')
      .select('recording_id, recorder_name, outcome, call_quality_score, script_adherence, talk_ratio, question_count, longest_monologue, sections_hit, patterns, pillar_scores, spiced_classification, meeting_type, deal_name, created_at, duration_seconds, recording_url')
      .in('outcome', ['won', 'lost'])
      .not('patterns', 'is', null);
    if (firstOnly) q = q.or('meeting_type.eq.first,meeting_type.is.null');
    return q;
  });

  // Pull recordings for market (language) in bulk
  const recIds = callsRaw.map(r => r.recording_id).filter(Boolean);
  const recMap = new Map<string, { lang: string; title: string }>();

  // Batch in chunks of 500 ids
  for (let i = 0; i < recIds.length; i += 500) {
    const batch = recIds.slice(i, i + 500);
    const { data, error } = await sb.from('recordings')
      .select('id, transcript_lang, title')
      .in('id', batch);
    if (error) throw error;
    for (const r of data || []) recMap.set(r.id, { lang: r.transcript_lang, title: r.title });
  }

  // Discover all behavior keys
  const keyUnion = new Set<string>();
  for (const c of callsRaw) {
    const p = c.patterns || {};
    for (const k of Object.keys(p)) keyUnion.add(k);
  }
  // SPICED elements are first-class behaviors: the LLM classifier produces a
  // per-call verdict, we treat each confirmed element as behavior "present" and
  // let the same within-AE causal engine measure its effect on close rate.
  for (const k of SPICED_KEYS) keyUnion.add(SPICED_BEHAVIOR_IDS[k]);
  const behaviorIds = Array.from(keyUnion).sort();

  const pillarSet = new Set<string>();
  for (const c of callsRaw) {
    const p = c.pillar_scores || {};
    for (const k of Object.keys(p)) pillarSet.add(k);
  }
  const pillarIds = Array.from(pillarSet).sort();

  const rows: CallRow[] = [];
  for (const c of callsRaw) {
    const rec = recMap.get(c.recording_id);
    const market = mapLangToMarket(rec?.lang);
    const patternsObj: Record<string, number> = {};
    const binPatterns: Record<string, number> = {};
    for (const k of behaviorIds) {
      const raw = c.patterns?.[k];
      const count = typeof raw === 'number' ? raw : 0;
      patternsObj[k] = count;
      binPatterns[k] = count >= BEHAVIOR_THRESHOLD ? 1 : 0;
    }

    // Overlay SPICED verdicts (source is spiced_classification, not patterns)
    const spiced = c.spiced_classification;
    if (spiced && typeof spiced === 'object') {
      for (const k of SPICED_KEYS) {
        const present = spiced[k]?.confirmed === true ? 1 : 0;
        binPatterns[SPICED_BEHAVIOR_IDS[k]] = present;
        patternsObj[SPICED_BEHAVIOR_IDS[k]] = present;
      }
    }

    const pillars: Record<string, number> = {};
    for (const k of pillarIds) {
      const v = c.pillar_scores?.[k];
      if (v && typeof v === 'object' && typeof v.score === 'number') pillars[k] = v.score;
      else pillars[k] = 0;
    }

    rows.push({
      callId: c.recording_id,
      aeId: c.recorder_name,
      aeName: c.recorder_name,
      market,
      outcome: c.outcome === 'won' ? 1 : 0,
      outcomeLabel: c.outcome as 'won' | 'lost',
      callQuality: c.call_quality_score ?? 0,
      scriptAdherence: c.script_adherence ?? 0,
      talkRatio: c.talk_ratio ?? 0,
      questionCount: c.question_count ?? 0,
      longestMonologue: c.longest_monologue ?? 0,
      sectionsHit: Array.isArray(c.sections_hit) ? c.sections_hit : [],
      patterns: binPatterns,
      pillars,
      dealName: c.deal_name,
      createdAt: c.created_at,
      duration: c.duration_seconds,
      recordingUrl: c.recording_url,
    });
  }

  return { rows, behaviorIds, pillarIds };
}
