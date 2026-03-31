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

-- ─── Indexes ────────────────────────────────────────────────────────────────────

create index if not exists idx_recordings_channel on recordings(channel_id);
create index if not exists idx_recordings_created on recordings(created_at desc);
create index if not exists idx_recordings_deal on recordings(deal_name);
create index if not exists idx_participants_recording on participants(recording_id);
create index if not exists idx_participants_email on participants(email);
create index if not exists idx_companies_recording on companies(recording_id);
create index if not exists idx_insight_sections_recording on insight_sections(recording_id);
