-- The 7K Project: private custom-auth application schema.
create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  display_name text not null,
  role text not null default 'member' check (role in ('admin','member')),
  password_hash text not null,
  password_salt text not null,
  avatar_path text,
  bio text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  user_agent text
);
create index if not exists sessions_user_id_idx on public.sessions(user_id);
create index if not exists sessions_active_idx on public.sessions(token_hash,expires_at) where revoked_at is null;

create table if not exists public.runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  run_date timestamptz not null default now(),
  distance_km numeric(6,2) not null check (distance_km>0 and distance_km<=100),
  duration_seconds integer not null check (duration_seconds>0 and duration_seconds<=86400),
  pace_seconds_per_km integer generated always as (round(duration_seconds::numeric/distance_km)::integer) stored,
  difficulty smallint not null check (difficulty between 1 and 10),
  notes text check (char_length(notes)<=1200),
  strava_image_path text,
  extra_image_path text,
  created_at timestamptz not null default now()
);
create index if not exists runs_user_date_idx on public.runs(user_id,run_date desc);
create index if not exists runs_date_idx on public.runs(run_date desc);

create table if not exists public.goal_settings (
  id boolean primary key default true check (id),
  target_distance_km numeric(5,2) not null default 7 check (target_distance_km between 1 and 100),
  deadline date,
  banner_message text,
  updated_by uuid references public.users(id),
  updated_at timestamptz not null default now()
);
insert into public.goal_settings(id,target_distance_km) values(true,7) on conflict(id) do nothing;

create table if not exists public.activity_events (
  id bigint generated always as identity primary key,
  user_id uuid references public.users(id) on delete set null,
  event_type text not null,
  run_id uuid references public.runs(id) on delete set null,
  message text not null,
  created_at timestamptz not null default now()
);
create index if not exists activity_events_created_idx on public.activity_events(created_at desc);
create index if not exists activity_events_run_id_idx on public.activity_events(run_id);
create index if not exists activity_events_user_id_idx on public.activity_events(user_id);
create index if not exists goal_settings_updated_by_idx on public.goal_settings(updated_by);

alter table public.users enable row level security;
alter table public.sessions enable row level security;
alter table public.runs enable row level security;
alter table public.goal_settings enable row level security;
alter table public.activity_events enable row level security;
revoke all on public.users,public.sessions,public.runs,public.goal_settings,public.activity_events from public,anon,authenticated;
grant select,insert,update,delete on public.users,public.sessions,public.runs,public.goal_settings,public.activity_events to service_role;
do $$
declare t text;
begin
  foreach t in array array['users','sessions','runs','goal_settings','activity_events'] loop
    execute format('drop policy if exists deny_api_roles on public.%I',t);
    execute format('create policy deny_api_roles on public.%I for all to anon, authenticated using (false) with check (false)',t);
  end loop;
end $$;

create table if not exists public.login_attempts (
  id bigint generated always as identity primary key,
  username text not null,
  ip_hash text not null,
  attempted_at timestamptz not null default now()
);
create index if not exists login_attempts_rate_idx on public.login_attempts(username,ip_hash,attempted_at desc);
alter table public.login_attempts enable row level security;
revoke all on public.login_attempts from public,anon,authenticated;
grant select,insert,update,delete on public.login_attempts to service_role;
create policy deny_api_roles on public.login_attempts for all to anon,authenticated using(false) with check(false);

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('7k-media','7k-media',false,8388608,array['image/webp'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

create schema if not exists private;
revoke all on schema private from public,anon,authenticated;
create or replace function private.broadcast_team_refresh()
returns trigger language plpgsql security definer set search_path=pg_catalog
as $$
begin
  perform realtime.send(jsonb_build_object('refresh',true),'refresh','7k-team',false);
  return null;
end;
$$;
revoke all on function private.broadcast_team_refresh() from public,anon,authenticated;
drop trigger if exists runs_realtime_refresh on public.runs;
drop trigger if exists users_realtime_refresh on public.users;
drop trigger if exists goal_realtime_refresh on public.goal_settings;
drop trigger if exists events_realtime_refresh on public.activity_events;
create trigger runs_realtime_refresh after insert or update or delete on public.runs for each statement execute function private.broadcast_team_refresh();
create trigger users_realtime_refresh after insert or update or delete on public.users for each statement execute function private.broadcast_team_refresh();
create trigger goal_realtime_refresh after insert or update on public.goal_settings for each statement execute function private.broadcast_team_refresh();
create trigger events_realtime_refresh after insert on public.activity_events for each statement execute function private.broadcast_team_refresh();

revoke all on function public.rls_auto_enable() from public,anon,authenticated;
