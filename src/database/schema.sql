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

-- ═══════════════════════════════════════════════════════════════════════════
-- USER ROLES — maps Supabase Auth users to dashboard roles
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  name text,
  role text not null default 'ae',               -- ae, lead
  ae_name text,                                   -- maps to recorder_name in call analysis
  created_at timestamptz not null default now()
);

create index if not exists idx_user_roles_email on user_roles(email);
create index if not exists idx_user_roles_ae on user_roles(ae_name);

-- ═══════════════════════════════════════════════════════════════════════════
-- CLOSED-LOOP ANALYTICS — connects GTM activity to revenue outcomes
-- "What would Noy do? Prove the ROI."
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Deals ─────────────────────────────────────────────────────────────────────
-- Single source of truth for deal lifecycle. Links calls, content, and outcomes.

create table if not exists deals (
  id text primary key,                            -- CRM deal ID or manual ID
  company_name text not null,
  deal_name text,
  segment text not null default 'smb',            -- smb, midmarket
  stage text not null default 'discovery',        -- discovery, evaluation, negotiation, closed_won, closed_lost
  ae_name text not null,                          -- owning AE
  arr_value numeric,                              -- deal value (ARR)
  close_date date,                                -- expected or actual close date
  outcome text,                                   -- won, lost, stalled
  loss_reason text,                               -- if lost: price, competitor, timing, no_decision, etc.
  competitor text,                                -- competing vendor if known
  champion_name text,                             -- internal champion
  decision_maker text,                            -- economic buyer

  -- Timeline
  created_at timestamptz not null default now(),
  first_meeting_at timestamptz,
  closed_at timestamptz,
  days_in_pipeline int,                           -- computed on close

  -- Scoring
  deal_score int,                                 -- 0-100 health score (computed)
  multi_thread_count int default 1,               -- number of contacts engaged
  meetings_count int default 0,                   -- total meetings held

  metadata jsonb default '{}'
);

-- ─── Content Attribution ───────────────────────────────────────────────────────
-- Tracks which sales assets were used in which deals and their impact.

create table if not exists content_usage (
  id bigint generated always as identity primary key,
  deal_id text references deals(id) on delete set null,
  recording_id text references recordings(id) on delete set null,

  -- What was used
  content_type text not null,                     -- deck, script, one_pager, case_study, proposal
  content_name text not null,                     -- e.g. "MM Sales Deck V6", "SMB Narrative April 2026"
  content_version text,                           -- e.g. "v6", "v3-B2C"

  -- Context
  used_at timestamptz not null default now(),
  used_in text,                                   -- meeting, email, follow_up, champion_enablement
  ae_name text,
  segment text,                                   -- smb, midmarket

  -- Outcome signal (filled after deal progresses)
  stage_before text,                              -- deal stage when content was used
  stage_after text,                               -- deal stage at next interaction
  advanced_deal boolean,                          -- did the deal move forward after this?

  metadata jsonb default '{}'
);

-- ─── Deal Events ───────────────────────────────────────────────────────────────
-- Timeline of significant events per deal for pipeline intelligence.

create table if not exists deal_events (
  id bigint generated always as identity primary key,
  deal_id text not null references deals(id) on delete cascade,
  event_type text not null,                       -- stage_change, meeting, objection, competitor_mention, champion_change, risk_flag
  event_data jsonb not null default '{}',         -- type-specific payload
  created_at timestamptz not null default now(),
  source text default 'system'                    -- system, manual, sync
);

-- ─── Narrative Performance ─────────────────────────────────────────────────────
-- Aggregated view: which narrative/deck version correlates with wins.

create table if not exists narrative_performance (
  id bigint generated always as identity primary key,
  content_name text not null,
  content_version text,
  segment text not null,

  -- Aggregated metrics (updated periodically)
  times_used int default 0,
  deals_advanced int default 0,                   -- deals that moved stage after use
  deals_won int default 0,
  deals_lost int default 0,
  avg_deal_velocity_days numeric,                 -- avg days to close when this content used
  win_rate numeric,                               -- deals_won / (deals_won + deals_lost)

  last_computed_at timestamptz not null default now(),

  unique (content_name, content_version, segment)
);

-- ─── Closed-loop indexes ───────────────────────────────────────────────────────

create index if not exists idx_deals_ae on deals(ae_name);
create index if not exists idx_deals_stage on deals(stage);
create index if not exists idx_deals_segment on deals(segment);
create index if not exists idx_deals_outcome on deals(outcome);
create index if not exists idx_deals_created on deals(created_at desc);
create index if not exists idx_content_usage_deal on content_usage(deal_id);
create index if not exists idx_content_usage_content on content_usage(content_name, content_version);
create index if not exists idx_content_usage_ae on content_usage(ae_name);
create index if not exists idx_deal_events_deal on deal_events(deal_id);
create index if not exists idx_deal_events_type on deal_events(event_type);
create index if not exists idx_narrative_perf_content on narrative_performance(content_name, segment);
