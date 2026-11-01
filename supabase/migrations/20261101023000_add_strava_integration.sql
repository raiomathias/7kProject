-- Strava OAuth connections, imported activity metadata, and webhook inbox.
-- Tokens are encrypted by the Edge Function using STRAVA_TOKEN_ENCRYPTION_KEY.
alter table public.runs
  add column if not exists source text not null default 'manual',
  add column if not exists strava_activity_id bigint,
  add column if not exists average_heartrate numeric,
  add column if not exists max_heartrate numeric,
  add column if not exists average_cadence numeric,
  add column if not exists total_elevation_gain numeric,
  add column if not exists average_speed numeric,
  add column if not exists max_speed numeric,
  add column if not exists calories numeric,
  add column if not exists summary_polyline text,
  add column if not exists start_latitude numeric,
  add column if not exists start_longitude numeric,
  add column if not exists strava_activity_url text,
  add column if not exists elapsed_seconds integer,
  add column if not exists strava_splits jsonb not null default '[]'::jsonb;

alter table public.runs drop constraint if exists runs_source_check;
alter table public.runs add constraint runs_source_check check (source in ('manual','strava'));
drop index if exists public.runs_strava_activity_id_uidx;
create unique index if not exists runs_strava_activity_id_uidx on public.runs(strava_activity_id);
create index if not exists runs_source_idx on public.runs(user_id,source,run_date desc);

create table if not exists public.strava_connections (
  user_id uuid primary key references public.users(id) on delete cascade,
  athlete_id bigint not null unique,
  athlete_username text,
  athlete_firstname text,
  athlete_lastname text,
  athlete_profile text,
  access_token_cipher text not null,
  access_token_nonce text not null,
  refresh_token_cipher text not null,
  refresh_token_nonce text not null,
  expires_at bigint not null,
  scopes text not null default '',
  connected boolean not null default true,
  last_sync_at timestamptz,
  last_sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.strava_oauth_states (
  state_hash text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists strava_oauth_states_expiry_idx on public.strava_oauth_states(expires_at);
create table if not exists public.strava_activity_details (
  strava_activity_id bigint primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  run_id uuid not null unique references public.runs(id) on delete cascade,
  activity_type text not null,
  timezone text,
  start_date_local timestamptz,
  moving_time integer,
  elapsed_time integer,
  streams jsonb not null default '{}'::jsonb,
  splits_metric jsonb not null default '[]'::jsonb,
  laps jsonb not null default '[]'::jsonb,
  raw_summary jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists strava_activity_details_user_idx on public.strava_activity_details(user_id);
create table if not exists public.strava_webhook_events (
  id bigint generated always as identity primary key,
  object_type text not null,
  object_id bigint not null,
  aspect_type text not null,
  owner_id bigint,
  updates jsonb not null default '{}'::jsonb,
  event_time bigint,
  payload jsonb not null,
  processed_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists strava_webhook_events_pending_idx on public.strava_webhook_events(created_at) where processed_at is null;

alter table public.strava_connections enable row level security;
alter table public.strava_oauth_states enable row level security;
alter table public.strava_activity_details enable row level security;
alter table public.strava_webhook_events enable row level security;
revoke all on public.strava_connections,public.strava_oauth_states,public.strava_activity_details,public.strava_webhook_events from public,anon,authenticated;
grant select,insert,update,delete on public.strava_connections,public.strava_oauth_states,public.strava_activity_details,public.strava_webhook_events to service_role;
create policy deny_api_roles on public.strava_connections for all to anon,authenticated using(false) with check(false);
create policy deny_api_roles on public.strava_oauth_states for all to anon,authenticated using(false) with check(false);
create policy deny_api_roles on public.strava_activity_details for all to anon,authenticated using(false) with check(false);
create policy deny_api_roles on public.strava_webhook_events for all to anon,authenticated using(false) with check(false);
