-- Claap Recordings Database Schema
-- Run this in your Supabase SQL editor to create the tables.

-- ─── Recordings ─────────────────────────────────────────────────────────────────

create table if not exists recordings (
  id text primary key,                          -- Claap recording ID
  title text,
  channel_id text not null,
  channel_name text not null,
  state text not null default 'Ready',
  source text,                                  -- e.g. "GoogleMeet"
  created_at timestamptz not null,
  duration_seconds numeric,
  url text,                                     -- Claap app URL
  video_url text,                               -- Direct video URL (expires)
  thumbnail_url text,

  -- Recorder
  recorder_id text,
  recorder_name text,
  recorder_email text,

  -- Meeting metadata
  meeting_type text,                            -- "internal" or "external"
  meeting_started_at timestamptz,
  meeting_ended_at timestamptz,
  conference_url text,

  -- CRM
  crm_type text,                                -- "hubspot", "salesforce", etc.
  crm_deal_id text,
  deal_id text,
  deal_name text,

  -- Transcript
  transcript_text text,                         -- Full plain-text transcript
  transcript_lang text,                         -- Language code e.g. "nl", "en"

  -- AI-generated content
  key_takeaways text,
  outline text,

  -- Metadata
  labels text[] default '{}',
  synced_at timestamptz not null default now()
);

-- ─── MM Call Analysis ───────────────────────────────────────────────────────────

create table if not exists mm_call_analysis (
  recording_id text primary key references recordings(id) on delete cascade,
  deal_name text,
  recorder_name text,
  title text,
  created_at timestamptz,
  duration_seconds numeric,
  analysis jsonb not null default '{}',
  analyzed_at timestamptz not null default now()
);

create index if not exists idx_mm_analysis_deal on mm_call_analysis(deal_name);
create index if not exists idx_mm_analysis_date on mm_call_analysis(created_at desc);

-- ─── Participants ───────────────────────────────────────────────────────────────

create table if not exists participants (
  id bigint generated always as identity primary key,
  recording_id text not null references recordings(id) on delete cascade,
  name text,
  email text,
  attended boolean default false,
  is_internal boolean default false,            -- derived from @wpseoai.com email

  unique (recording_id, email)
);

-- ─── Companies ──────────────────────────────────────────────────────────────────

create table if not exists companies (
  id bigint generated always as identity primary key,
  recording_id text not null references recordings(id) on delete cascade,
  claap_company_id text,
  name text,

  unique (recording_id, claap_company_id)
);

-- ─── Insight Sections ───────────────────────────────────────────────────────────
-- Stores individual SPICED sections (Situation, Pain, Impact, etc.)

create table if not exists insight_sections (
  id bigint generated always as identity primary key,
  recording_id text not null references recordings(id) on delete cascade,
  template_title text not null,                 -- e.g. "SPICED (Ticket)"
  lang text,                                    -- e.g. "nl"
  section_title text not null,                  -- e.g. "❓ Situation"
  description text,

  unique (recording_id, template_title, section_title)
);

-- ─── Coaching Interventions (Feedback Loop) ─────────────────────────────────────
-- Tracks coaching actions → enables before/after measurement

create table if not exists coaching_interventions (
  id text primary key,                          -- intervention_{ae}_{timestamp}
  recorder_name text not null,                  -- AE receiving coaching
  created_at timestamptz not null default now(),

  -- What was coached
  focus_area text not null,                     -- e.g. "Discovery Questions", "Talk Ratio", "Closing"
  focus_pillar text,                            -- pillar key: control, discovery, gapCreation, objectionHandling, advancement
  description text not null,                    -- specific coaching rec given
  source text not null default 'dashboard',     -- dashboard, 1on1, review, digest

  -- Baseline metrics at time of intervention (snapshot)
  baseline_quality float,                       -- avg call quality at intervention time
  baseline_metric float,                        -- specific metric value (e.g. talk_ratio=62, question_count=11)
  baseline_pillar_score float,                  -- pillar score at time of intervention

  -- Follow-up measurement (filled after 5+ calls post-intervention)
  followup_at timestamptz,                      -- when measurement was taken
  followup_quality float,                       -- avg call quality after
  followup_metric float,                        -- specific metric after
  followup_pillar_score float,                  -- pillar score after
  calls_since int default 0,                    -- calls analyzed since intervention
  status text not null default 'active',        -- active, measured, effective, ineffective, dismissed

  -- Metadata
  created_by text default 'system',             -- who created (lead name or 'system')
  notes text
);

-- ─── Indexes ────────────────────────────────────────────────────────────────────

create index if not exists idx_recordings_channel on recordings(channel_id);
create index if not exists idx_recordings_created on recordings(created_at desc);
create index if not exists idx_recordings_deal on recordings(deal_name);
create index if not exists idx_recordings_recorder on recordings(recorder_name);
create index if not exists idx_participants_recording on participants(recording_id);
create index if not exists idx_participants_email on participants(email);
create index if not exists idx_companies_recording on companies(recording_id);
create index if not exists idx_insight_sections_recording on insight_sections(recording_id);

-- ─── ae_call_analysis indexes (critical for dashboard performance) ───────────

create index if not exists idx_ae_call_recorder on ae_call_analysis(recorder_name);
create index if not exists idx_ae_call_outcome on ae_call_analysis(outcome);
create index if not exists idx_ae_call_created on ae_call_analysis(created_at desc);
create index if not exists idx_ae_call_recorder_created on ae_call_analysis(recorder_name, created_at desc);
create index if not exists idx_ae_call_quality on ae_call_analysis(call_quality_score desc);
create index if not exists idx_ae_call_recording on ae_call_analysis(recording_id);
create index if not exists idx_ae_call_deal on ae_call_analysis(deal_name);

-- ─── coaching_interventions indexes ──────────────────────────────────────────

create index if not exists idx_interventions_ae on coaching_interventions(recorder_name);
create index if not exists idx_interventions_status on coaching_interventions(status);
create index if not exists idx_interventions_created on coaching_interventions(created_at desc);
