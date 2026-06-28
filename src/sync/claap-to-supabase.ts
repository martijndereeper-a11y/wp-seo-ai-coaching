/**
 * Claap → Supabase Sync
 *
 * Fetches recordings from specified Claap channels and stores them in Supabase.
 * On subsequent runs, only new recordings (not yet in Supabase) are fetched.
 *
 * Usage:
 *   npm run sync                  # incremental sync (new recordings only)
 *   npm run sync -- --full        # full sync (re-fetch everything)
 */

import { createClaapClient } from '../integrations/claap-client.ts';
import { createSupabaseClient } from '../database/supabase-client.ts';
import type { ClaapRecording, ClaapClient } from '../integrations/claap-client.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

// ─── Config ─────────────────────────────────────────────────────────────────────

const TARGET_CHANNELS: Record<string, string> = {
  'EzTHCFMCAx': 'Closed Lost Analysis',
  'oYt3RmpIPq': 'Closed Won Analysis',
  'Dhb8c7uckQ': 'Sales Meetings',
};

const INTERNAL_DOMAIN = 'wpseoai.com';

// Personal meetings — synced by recorder email regardless of channel
const PERSONAL_RECORDER_EMAILS = [
  'martijn.dereeper@wpseoai.com',
  'chris.pinto@wpseoai.com',
  'christian.vandehoef@wpseoai.com',
  'carmen.lorje@wpseoai.com',
  'melissa.husmann@wpseoai.com',
];

// ─── Transform ──────────────────────────────────────────────────────────────────

function toRecordingRow(rec: ClaapRecording, transcript?: { text: string; lang: string }) {
  const firstTakeaway = rec.keyTakeaways?.find(k => k.text)?.text ?? null;
  const firstOutline = rec.outlines?.find(o => o.text)?.text ?? null;

  return {
    id: rec.id,
    title: rec.title,
    channel_id: rec.channel.id,
    channel_name: rec.channel.name,
    state: rec.state,
    source: (rec as Record<string, unknown>).source as string | null ?? null,
    created_at: rec.createdAt,
    duration_seconds: rec.durationSeconds,
    url: rec.url,
    video_url: rec.video?.url ?? null,
    thumbnail_url: rec.thumbnailUrl ?? null,
    recorder_id: rec.recorder?.id ?? null,
    recorder_name: rec.recorder?.name ?? null,
    recorder_email: rec.recorder?.email ?? null,
    meeting_type: rec.meeting?.type ?? null,
    meeting_started_at: rec.meeting?.startingAt ?? null,
    meeting_ended_at: rec.meeting?.endingAt ?? null,
    conference_url: rec.meeting?.conferenceUrl ?? null,
    crm_type: rec.crmInfo?.crm ?? null,
    crm_deal_id: rec.crmInfo?.deal?.id ?? null,
    deal_id: rec.deal?.id ?? null,
    deal_name: rec.deal?.name ?? null,
    transcript_text: transcript?.text ?? null,
    transcript_lang: transcript?.lang ?? null,
    key_takeaways: firstTakeaway,
    outline: firstOutline,
    labels: rec.labels ?? [],
    synced_at: new Date().toISOString(),
  };
}

function toParticipantRows(rec: ClaapRecording) {
  const participants = rec.meeting?.participants ?? [];
  return participants
    .filter(p => p.email)
    .map(p => ({
      recording_id: rec.id,
      name: p.name ?? null,
      email: p.email,
      attended: (p as Record<string, unknown>).attended as boolean ?? false,
      is_internal: p.email?.endsWith(`@${INTERNAL_DOMAIN}`) ?? false,
    }));
}

function toCompanyRows(rec: ClaapRecording) {
  return (rec.companies ?? []).map(c => ({
    recording_id: rec.id,
    claap_company_id: c.id,
    name: c.name,
  }));
}

function toInsightRows(rec: ClaapRecording) {
  const rows: Array<{
    recording_id: string;
    template_title: string;
    lang: string | null;
    section_title: string;
    description: string | null;
  }> = [];

  // New flat structure (Claap API change 2026-06-26): aiFields = [{ title, description }]
  if (rec.aiFields && rec.aiFields.length > 0) {
    for (const field of rec.aiFields) {
      rows.push({
        recording_id: rec.id,
        template_title: 'AI Fields',
        lang: null,
        section_title: field.title,
        description: field.description || null,
      });
    }
    return rows;
  }

  // Legacy nested structure — no longer populated after 2026-06-26, kept for older records
  for (const template of rec.insightTemplates ?? []) {
    for (const insight of template.insights as Array<{ langIso2?: string; sections?: Array<{ title: string; description: string }> }>) {
      for (const section of insight.sections ?? []) {
        rows.push({
          recording_id: rec.id,
          template_title: template.templateTitle,
          lang: insight.langIso2 ?? null,
          section_title: section.title,
          description: section.description || null,
        });
      }
    }
  }
  return rows;
}

// ─── Supabase helpers ───────────────────────────────────────────────────────────

/** Get all recording IDs already stored in Supabase for a given channel. */
async function getExistingRecordingIds(supabase: SupabaseClient, channelId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let from = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from('recordings')
      .select('id')
      .eq('channel_id', channelId)
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`Failed to query existing recordings: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const row of data) ids.add(row.id);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  return ids;
}

// ─── Fetch & store a single recording ───────────────────────────────────────────

async function fetchAndStoreRecording(
  claap: ClaapClient,
  supabase: SupabaseClient,
  recordingId: string,
): Promise<boolean> {
  const full = await claap.getRecording(recordingId, { returnAiFields: true });
  const rec = full.result.recording as ClaapRecording;

  if (rec.state !== 'Ready') return false;

  // Fetch transcript
  let transcript: { text: string; lang: string } | undefined;
  try {
    const activeTranscript = rec.transcripts?.find(t => t.isActive);
    const lang = activeTranscript?.langIso2;
    const transcriptText = await claap.getTranscript(rec.id, { format: 'text', lang }) as string;
    if (transcriptText) {
      transcript = { text: transcriptText, lang: lang ?? 'unknown' };
    }
  } catch {
    // Transcript may not be available
  }

  // Upsert recording
  const { error: recError } = await supabase
    .from('recordings')
    .upsert(toRecordingRow(rec, transcript), { onConflict: 'id' });

  if (recError) {
    console.error(`  Error upserting recording ${rec.id}:`, recError.message);
    return false;
  }

  // Upsert participants
  const participantRows = toParticipantRows(rec);
  if (participantRows.length > 0) {
    const { error } = await supabase
      .from('participants')
      .upsert(participantRows, { onConflict: 'recording_id,email' });
    if (error) console.error(`  Error upserting participants for ${rec.id}:`, error.message);
  }

  // Upsert companies
  const companyRows = toCompanyRows(rec);
  if (companyRows.length > 0) {
    const { error } = await supabase
      .from('companies')
      .upsert(companyRows, { onConflict: 'recording_id,claap_company_id' });
    if (error) console.error(`  Error upserting companies for ${rec.id}:`, error.message);
  }

  // Upsert insight sections
  const insightRows = toInsightRows(rec);
  if (insightRows.length > 0) {
    const { error } = await supabase
      .from('insight_sections')
      .upsert(insightRows, { onConflict: 'recording_id,template_title,section_title' });
    if (error) console.error(`  Error upserting insights for ${rec.id}:`, error.message);
  }

  return true;
}

// ─── Sync ───────────────────────────────────────────────────────────────────────

async function syncChannel(channelId: string, channelName: string, fullSync: boolean, sinceDate?: string) {
  const claap = createClaapClient();
  const supabase = createSupabaseClient();

  console.log(`\nSyncing channel: ${channelName} (${channelId})`);

  // Get IDs already in Supabase
  const existingIds = fullSync ? new Set<string>() : await getExistingRecordingIds(supabase, channelId);
  if (!fullSync) {
    console.log(`  ${existingIds.size} recordings already in database`);
  }

  // List recordings from Claap (optionally filtered by date) and find new ones
  const newRecordingIds: string[] = [];
  let cursor: string | undefined;
  let rateLimited = false;

  try {
    do {
      const response = await claap.listRecordings({ channelId, limit: 100, cursor, createdAfter: sinceDate, returnAiFields: true });
      const recordings = response.result.recordings;

      if (recordings.length === 0) break;

      for (const rec of recordings) {
        if (!existingIds.has(rec.id)) {
          newRecordingIds.push(rec.id);
        }
      }

      cursor = response.result.pagination.nextCursor;
    } while (cursor);
  } catch (err) {
    if ((err as { status?: number }).status === 429) {
      console.warn(`  Rate limited while listing recordings — proceeding with ${newRecordingIds.length} found so far`);
      rateLimited = true;
    } else {
      throw err;
    }
  }

  if (newRecordingIds.length === 0) {
    console.log('  No new recordings to sync');
    return 0;
  }

  console.log(`  ${newRecordingIds.length} new recordings to sync`);

  // Fetch full details + transcript and store each new recording
  let synced = 0;
  for (const id of newRecordingIds) {
    try {
      const stored = await fetchAndStoreRecording(claap, supabase, id);
      if (stored) {
        synced++;
        if (synced % 10 === 0) console.log(`  Progress: ${synced}/${newRecordingIds.length}`);
      }
    } catch (err) {
      if ((err as { status?: number }).status === 429) {
        console.warn(`  Rate limited after syncing ${synced}/${newRecordingIds.length} — will resume next run`);
        rateLimited = true;
        break;
      }
      console.error(`  Error processing recording ${id}:`, (err as Error).message);
    }
  }

  console.log(`  Done: ${synced} new recordings added for ${channelName}${rateLimited ? ' (partial — rate limited)' : ''}`);
  return synced;
}

// ─── Sync personal meetings (by recorder email, across all channels) ─────────

async function syncPersonalMeetings(recorderEmail: string, fullSync: boolean, sinceDate?: string) {
  const claap = createClaapClient();
  const supabase = createSupabaseClient();

  console.log(`\nSyncing personal meetings for: ${recorderEmail}`);

  // Get all existing IDs for this recorder
  const existingIds = new Set<string>();
  if (!fullSync) {
    let from = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await supabase
        .from('recordings')
        .select('id')
        .eq('recorder_email', recorderEmail)
        .range(from, from + pageSize - 1);
      if (error) throw new Error(`Failed to query existing recordings: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const row of data) existingIds.add(row.id);
      if (data.length < pageSize) break;
      from += pageSize;
    }
    console.log(`  ${existingIds.size} personal recordings already in database`);
  }

  // List recordings by this recorder (optionally filtered by date)
  const newRecordingIds: string[] = [];
  let cursor: string | undefined;
  let rateLimited = false;

  try {
    do {
      const response = await claap.listRecordings({ recorderEmail, limit: 100, cursor, createdAfter: sinceDate, returnAiFields: true });
      const recordings = response.result.recordings;

      if (recordings.length === 0) break;

      for (const rec of recordings) {
        if (!existingIds.has(rec.id)) {
          newRecordingIds.push(rec.id);
        }
      }

      cursor = response.result.pagination.nextCursor;
    } while (cursor);
  } catch (err) {
    if ((err as { status?: number }).status === 429) {
      console.warn(`  Rate limited while listing recordings — proceeding with ${newRecordingIds.length} found so far`);
      rateLimited = true;
    } else {
      throw err;
    }
  }

  if (newRecordingIds.length === 0) {
    console.log('  No new personal recordings to sync');
    return 0;
  }

  console.log(`  ${newRecordingIds.length} new personal recordings to sync`);

  let synced = 0;
  for (const id of newRecordingIds) {
    try {
      const stored = await fetchAndStoreRecording(claap, supabase, id);
      if (stored) {
        synced++;
        if (synced % 10 === 0) console.log(`  Progress: ${synced}/${newRecordingIds.length}`);
      }
    } catch (err) {
      if ((err as { status?: number }).status === 429) {
        console.warn(`  Rate limited after syncing ${synced}/${newRecordingIds.length} — will resume next run`);
        rateLimited = true;
        break;
      }
      console.error(`  Error processing recording ${id}:`, (err as Error).message);
    }
  }

  console.log(`  Done: ${synced} new personal recordings added${rateLimited ? ' (partial — rate limited)' : ''}`);
  return synced;
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const fullSync = process.argv.includes('--full');

  // --since YYYY-MM-DD  → only sync recordings created after this date
  // Default: 30 days ago (keeps daily cron fast, catches weekends/holidays)
  const sinceArg = process.argv.find(a => a.startsWith('--since='))?.split('=')[1];
  const defaultSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const sinceDate = fullSync ? undefined : (sinceArg ?? defaultSince);

  console.log('Claap → Supabase Sync');
  if (fullSync) {
    console.log('Mode: FULL (re-syncing all recordings)');
  } else {
    console.log(`Mode: INCREMENTAL (recordings since ${sinceDate})`);
  }
  console.log('=====================');

  let total = 0;

  // Sync channel-based recordings
  for (const [channelId, channelName] of Object.entries(TARGET_CHANNELS)) {
    total += await syncChannel(channelId, channelName, fullSync, sinceDate);
  }

  // Sync personal meetings (catches recordings in any channel)
  for (const email of PERSONAL_RECORDER_EMAILS) {
    total += await syncPersonalMeetings(email, fullSync, sinceDate);
  }

  console.log(`\nSync complete: ${total} new recordings added`);
}

main().catch(err => {
  console.error('Sync failed:', err);
  process.exit(1);
});
