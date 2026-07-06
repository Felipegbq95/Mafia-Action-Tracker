-- Mafia Night Action Tracker schema + security layer.
--
-- Safe to run top-to-bottom on a fresh Supabase project OR re-run on an
-- existing one: every statement is idempotent.
--
-- Security model (why this file looks the way it does):
--   - The browser talks to Supabase with the PUBLIC anon key, so it must
--     not be able to read the tables directly. Row Level Security is ON
--     for every table with NO read policies, which denies the anon key all
--     direct access.
--   - Instead, all browser access goes through SECURITY DEFINER functions
--     (RPCs) below, which run with elevated rights but only after checking
--     a password/PIN. That is what makes the game PIN a real server-side
--     lock rather than a client-side curtain.
--   - The scraper uses the SERVICE ROLE key, which bypasses RLS entirely,
--     so it keeps writing normally and is unaffected by any of this.
--
-- BOOTSTRAP (run once, in the SQL editor, after this file):
--   select set_host_password('choose-a-strong-host-password');

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists games (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  is_active boolean not null default true,
  -- Bumped at the start of each night phase (via the admin UI later, or the
  -- table editor for now).
  current_night_number int not null default 1,
  -- bcrypt hash of this game's dashboard PIN. Null = no PIN set yet, which
  -- means the dashboard cannot be unlocked until one is assigned.
  pin_hash text,
  created_at timestamptz not null default now()
);
alter table games add column if not exists pin_hash text;

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  discord_id text unique,
  display_name text not null,
  aliases text[] not null default '{}',
  -- Marks the "regulars" so the create-game screen can pre-select them.
  is_regular boolean not null default false,
  created_at timestamptz not null default now()
);
alter table players add column if not exists is_regular boolean not null default false;

-- Which players are in which game, so target fuzzy-matching is scoped to
-- the current roster rather than every player who has ever played.
create table if not exists game_players (
  game_id uuid not null references games(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  primary key (game_id, player_id)
);

create table if not exists submissions (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references games(id) on delete cascade,
  night_number int not null,

  discord_message_id text not null,
  discord_channel_id text not null,
  channel_name text,
  submitted_at timestamptz not null default now(),

  submitter_player_id uuid references players(id),
  submitter_discord_id text not null,

  raw_message text not null,
  role_raw text,
  role_canonical text,
  target_raw text,
  target_player_id uuid references players(id),
  target_match_score real,

  needs_review boolean not null default true,

  unique (discord_message_id)
);

create index if not exists submissions_game_night_idx on submissions (game_id, night_number);
create index if not exists submissions_needs_review_idx on submissions (needs_review) where needs_review;
-- Per-channel cursor lookup (highest message id seen per channel).
create index if not exists submissions_channel_idx on submissions (discord_channel_id);

-- Single-row table holding the shared host password hash.
create table if not exists app_config (
  id boolean primary key default true,
  host_password_hash text,
  constraint app_config_singleton check (id)
);
insert into app_config (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Lock everything down: RLS on, and remove any legacy public-read policies
-- so the anon key cannot touch the tables directly. All access is via the
-- functions below.
-- ---------------------------------------------------------------------------

alter table games enable row level security;
alter table players enable row level security;
alter table game_players enable row level security;
alter table submissions enable row level security;
alter table app_config enable row level security;

drop policy if exists "public read" on games;
drop policy if exists "public read" on players;
drop policy if exists "public read" on game_players;
drop policy if exists "public read" on submissions;

-- ---------------------------------------------------------------------------
-- Password / PIN helpers
-- ---------------------------------------------------------------------------

-- Sets (or changes) the shared host password. NOT granted to the anon role,
-- so it can only be run from the SQL editor (service role). This is the
-- bootstrap entry point.
create or replace function set_host_password(p_new text)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if length(coalesce(p_new, '')) < 8 then
    raise exception 'host password must be at least 8 characters';
  end if;
  update app_config
    set host_password_hash = crypt(p_new, gen_salt('bf'))
    where id;
end;
$$;
revoke all on function set_host_password(text) from public;

-- Internal: is this the host password? Used by the admin functions below.
create or replace function verify_host_password(p_password text)
returns boolean
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  select exists (
    select 1 from app_config
    where id
      and host_password_hash is not null
      and host_password_hash = crypt(p_password, host_password_hash)
  );
$$;
revoke all on function verify_host_password(text) from public;

-- ---------------------------------------------------------------------------
-- Admin RPCs (gated by the host password). Granted to anon because the
-- password check inside is the actual gate.
-- ---------------------------------------------------------------------------

create or replace function admin_list_players(p_host_password text)
returns table (id uuid, display_name text, aliases text[], is_regular boolean)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not verify_host_password(p_host_password) then
    raise exception 'invalid host password' using errcode = '28000';
  end if;
  return query
    select p.id, p.display_name, p.aliases, p.is_regular
    from players p
    order by p.is_regular desc, p.display_name;
end;
$$;

create or replace function admin_add_player(
  p_host_password text,
  p_display_name text,
  p_aliases text[] default '{}',
  p_is_regular boolean default false,
  p_discord_id text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id uuid;
begin
  if not verify_host_password(p_host_password) then
    raise exception 'invalid host password' using errcode = '28000';
  end if;
  insert into players (display_name, aliases, is_regular, discord_id)
  values (p_display_name, coalesce(p_aliases, '{}'), coalesce(p_is_regular, false), p_discord_id)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function admin_set_regular(
  p_host_password text,
  p_player_id uuid,
  p_is_regular boolean
)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not verify_host_password(p_host_password) then
    raise exception 'invalid host password' using errcode = '28000';
  end if;
  update players set is_regular = p_is_regular where id = p_player_id;
end;
$$;

-- Creates a game, marks it the single active game, sets its PIN, and links
-- the chosen players. Returns the new game id.
create or replace function admin_create_game(
  p_host_password text,
  p_name text,
  p_pin text,
  p_player_ids uuid[] default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_game_id uuid;
begin
  if not verify_host_password(p_host_password) then
    raise exception 'invalid host password' using errcode = '28000';
  end if;
  if length(coalesce(p_pin, '')) < 6 then
    raise exception 'pin must be at least 6 characters';
  end if;

  update games set is_active = false where is_active;

  insert into games (name, is_active, current_night_number, pin_hash)
  values (p_name, true, 1, crypt(p_pin, gen_salt('bf')))
  returning id into v_game_id;

  if p_player_ids is not null and array_length(p_player_ids, 1) is not null then
    insert into game_players (game_id, player_id)
    select v_game_id, pid from unnest(p_player_ids) as pid
    on conflict do nothing;
  end if;

  return v_game_id;
end;
$$;

create or replace function admin_set_game_pin(
  p_host_password text,
  p_game_id uuid,
  p_pin text
)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not verify_host_password(p_host_password) then
    raise exception 'invalid host password' using errcode = '28000';
  end if;
  if length(coalesce(p_pin, '')) < 6 then
    raise exception 'pin must be at least 6 characters';
  end if;
  update games set pin_hash = crypt(p_pin, gen_salt('bf')) where id = p_game_id;
end;
$$;

grant execute on function admin_list_players(text) to anon, authenticated;
grant execute on function admin_add_player(text, text, text[], boolean, text) to anon, authenticated;
grant execute on function admin_set_regular(text, uuid, boolean) to anon, authenticated;
grant execute on function admin_create_game(text, text, text, uuid[]) to anon, authenticated;
grant execute on function admin_set_game_pin(text, uuid, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Dashboard RPCs
-- ---------------------------------------------------------------------------

-- Game names are not secret (the actions are), so listing them unauthenticated
-- is fine and lets the dashboard show a game picker before the PIN prompt.
create or replace function list_games()
returns table (id uuid, name text, is_active boolean, created_at timestamptz)
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  select id, name, is_active, created_at from games order by created_at desc;
$$;
grant execute on function list_games() to anon, authenticated;

-- The PIN-gated read. Wrong or missing PIN raises, so the client can tell
-- "wrong PIN" apart from "no submissions yet".
create or replace function dashboard_submissions(p_game_id uuid, p_pin text)
returns table (
  id uuid,
  night_number int,
  channel_name text,
  submitter_name text,
  role_raw text,
  role_canonical text,
  target_name text,
  target_raw text,
  raw_message text,
  needs_review boolean,
  submitted_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_hash text;
begin
  select pin_hash into v_hash from games where id = p_game_id;
  if v_hash is null or v_hash <> crypt(p_pin, v_hash) then
    raise exception 'invalid pin' using errcode = '28000';
  end if;

  return query
    select
      s.id,
      s.night_number,
      s.channel_name,
      sp.display_name,
      s.role_raw,
      s.role_canonical,
      tp.display_name,
      s.target_raw,
      s.raw_message,
      s.needs_review,
      s.submitted_at
    from submissions s
    left join players sp on sp.id = s.submitter_player_id
    left join players tp on tp.id = s.target_player_id
    where s.game_id = p_game_id
    order by s.submitted_at desc;
end;
$$;
grant execute on function dashboard_submissions(uuid, text) to anon, authenticated;
