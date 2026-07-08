-- Mafia Night Action Tracker - schema + access layer.
--
-- Run top-to-bottom on a fresh Supabase project.
--
-- If you previously ran an OLDER version of this schema in the same project,
-- the old tables have the wrong shape and re-running fails with errors like
-- "column status does not exist". Fix: run db/reset.sql first (it drops the
-- old objects), then run this file. reset.sql is destructive - only use it on
-- a project with no data you want to keep.
--
-- Access model (see docs/DESIGN.md):
--   * Anyone can create a game (create_game) and list games (list_games).
--   * One PIN per game grants FULL access to that game (view + edit) via the
--     PIN-gated functions below.
--   * "Finish" a game (archive_game) removes its PIN and locks editing; it then
--     becomes public read-only via public_game_data.
--   * Tables have RLS on with no policies, so the anon key cannot touch them
--     directly - everything goes through the SECURITY DEFINER functions here.
--     The scraper writes with the service role key, which bypasses RLS.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tables (everything is per-game; games are themed and rebuilt each time)
-- ---------------------------------------------------------------------------

create table if not exists games (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'active' check (status in ('active', 'archived')),
  -- bcrypt hash of the game PIN. Null once archived (PIN removed -> public).
  pin_hash text,
  current_night_number int not null default 1,
  -- optional manually-set night window until vote-parser integration exists
  night_started_at timestamptz,
  night_ends_at timestamptz,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references games(id) on delete cascade,
  display_name text not null,
  -- their personal Discord channel; actions in it are attributed to them
  channel_name text,
  -- other names people use to target them (e.g. real name vs handle)
  aliases text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists abilities (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references games(id) on delete cascade,
  name text not null,
  -- what players type in Discord for this ability
  aliases text[] not null default '{}',
  -- printed on the web instead of the raw ability name
  effect_text text,
  computable_type text not null default 'none'
    check (computable_type in ('none','kill','save','track','watch','redirect','roleblock')),
  -- message the TARGET receives, for the host to copy-paste (optional)
  splash_text text,
  created_at timestamptz not null default now()
);

create table if not exists actions (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references games(id) on delete cascade,
  night_number int not null default 1,

  -- who performed it. Null until assigned (shared channels: mafia, duos).
  actor_player_id uuid references players(id) on delete set null,
  ability_id uuid references abilities(id) on delete set null,
  target_player_id uuid references players(id) on delete set null,

  -- host-assigned outcome (e.g. cop -> 'non-town'); free-form for now
  result text,

  source text not null default 'scraped' check (source in ('scraped','manual')),
  source_channel text,
  discord_message_id text,
  raw_text text,
  -- what the scraper saw before resolving, kept for review
  actor_raw text,
  ability_raw text,
  target_raw text,

  needs_review boolean not null default true,
  created_at timestamptz not null default now()
);

-- Dedup scraped messages (manual actions have a null message id, allowed many).
create unique index if not exists actions_msg_uniq
  on actions (game_id, discord_message_id) where discord_message_id is not null;
create index if not exists actions_game_night_idx on actions (game_id, night_number);

-- ---------------------------------------------------------------------------
-- Lock the tables: RLS on, no policies -> anon has no direct access.
-- ---------------------------------------------------------------------------
alter table games enable row level security;
alter table players enable row level security;
alter table abilities enable row level security;
alter table actions enable row level security;

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------

-- True only if the game is active and the PIN matches.
create or replace function verify_game_pin(p_game_id uuid, p_pin text)
returns boolean
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  select exists (
    select 1 from games
    where id = p_game_id
      and status = 'active'
      and pin_hash is not null
      and pin_hash = crypt(p_pin, pin_hash)
  );
$$;
revoke all on function verify_game_pin(uuid, text) from public;

-- Builds the full game payload as json (game meta + players + abilities +
-- resolved actions). Used by both the gated and public read paths.
create or replace function game_json(p_game_id uuid)
returns json
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  select json_build_object(
    'game', (select json_build_object(
        'id', g.id, 'name', g.name, 'status', g.status,
        'current_night_number', g.current_night_number,
        'night_started_at', g.night_started_at, 'night_ends_at', g.night_ends_at,
        'created_at', g.created_at, 'archived_at', g.archived_at)
      from games g where g.id = p_game_id),
    'players', coalesce((select json_agg(json_build_object(
        'id', p.id, 'display_name', p.display_name,
        'channel_name', p.channel_name, 'aliases', p.aliases) order by p.display_name)
      from players p where p.game_id = p_game_id), '[]'::json),
    'abilities', coalesce((select json_agg(json_build_object(
        'id', a.id, 'name', a.name, 'aliases', a.aliases, 'effect_text', a.effect_text,
        'computable_type', a.computable_type, 'splash_text', a.splash_text) order by a.name)
      from abilities a where a.game_id = p_game_id), '[]'::json),
    'actions', coalesce((select json_agg(json_build_object(
        'id', act.id, 'night_number', act.night_number,
        'actor_player_id', act.actor_player_id, 'actor_name', ap.display_name,
        'ability_id', act.ability_id, 'ability_name', ab.name,
        'effect_text', ab.effect_text, 'computable_type', ab.computable_type,
        'splash_text', ab.splash_text,
        'target_player_id', act.target_player_id, 'target_name', tp.display_name,
        'result', act.result, 'source', act.source, 'source_channel', act.source_channel,
        'raw_text', act.raw_text, 'actor_raw', act.actor_raw,
        'ability_raw', act.ability_raw, 'target_raw', act.target_raw,
        'needs_review', act.needs_review, 'created_at', act.created_at)
        order by act.night_number, act.created_at)
      from actions act
      left join players ap on ap.id = act.actor_player_id
      left join abilities ab on ab.id = act.ability_id
      left join players tp on tp.id = act.target_player_id
      where act.game_id = p_game_id), '[]'::json)
  );
$$;
revoke all on function game_json(uuid) from public;

-- Raises unless the PIN is valid for an active game. Helper for edit funcs.
create or replace function assert_game_pin(p_game_id uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not verify_game_pin(p_game_id, p_pin) then
    raise exception 'invalid pin or game not editable' using errcode = '28000';
  end if;
end;
$$;
revoke all on function assert_game_pin(uuid, text) from public;

-- ---------------------------------------------------------------------------
-- Open functions (no PIN)
-- ---------------------------------------------------------------------------

create or replace function list_games()
returns table (id uuid, name text, status text, created_at timestamptz)
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  select id, name, status, created_at from games order by created_at desc;
$$;
grant execute on function list_games() to anon, authenticated;

create or replace function create_game(p_name text, p_pin text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare v_id uuid;
begin
  if length(coalesce(p_pin, '')) < 6 then
    raise exception 'pin must be at least 6 characters';
  end if;
  insert into games (name, pin_hash)
  values (coalesce(nullif(trim(p_name), ''), 'Untitled game'), crypt(p_pin, gen_salt('bf')))
  returning id into v_id;
  return v_id;
end;
$$;
grant execute on function create_game(text, text) to anon, authenticated;

-- Public read for FINISHED games only (archived -> no PIN, read-only).
create or replace function public_game_data(p_game_id uuid)
returns json
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not exists (select 1 from games where id = p_game_id and status = 'archived') then
    raise exception 'game is not public' using errcode = '28000';
  end if;
  return game_json(p_game_id);
end;
$$;
grant execute on function public_game_data(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- PIN-gated functions (full access to one game)
-- ---------------------------------------------------------------------------

create or replace function game_data(p_game_id uuid, p_pin text)
returns json
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform assert_game_pin(p_game_id, p_pin);
  return game_json(p_game_id);
end;
$$;
grant execute on function game_data(uuid, text) to anon, authenticated;

-- players -------------------------------------------------------------------
create or replace function upsert_player(
  p_game_id uuid, p_pin text, p_player_id uuid,
  p_display_name text, p_channel_name text, p_aliases text[])
returns uuid
language plpgsql security definer set search_path = public, extensions, pg_temp
as $$
declare v_id uuid;
begin
  perform assert_game_pin(p_game_id, p_pin);
  if p_player_id is null then
    insert into players (game_id, display_name, channel_name, aliases)
    values (p_game_id, p_display_name, nullif(trim(p_channel_name), ''), coalesce(p_aliases, '{}'))
    returning id into v_id;
  else
    update players set display_name = p_display_name,
      channel_name = nullif(trim(p_channel_name), ''), aliases = coalesce(p_aliases, '{}')
    where id = p_player_id and game_id = p_game_id
    returning id into v_id;
  end if;
  return v_id;
end;
$$;
grant execute on function upsert_player(uuid, text, uuid, text, text, text[]) to anon, authenticated;

create or replace function delete_player(p_game_id uuid, p_pin text, p_player_id uuid)
returns void
language plpgsql security definer set search_path = public, extensions, pg_temp
as $$
begin
  perform assert_game_pin(p_game_id, p_pin);
  delete from players where id = p_player_id and game_id = p_game_id;
end;
$$;
grant execute on function delete_player(uuid, text, uuid) to anon, authenticated;

-- abilities -----------------------------------------------------------------
create or replace function upsert_ability(
  p_game_id uuid, p_pin text, p_ability_id uuid,
  p_name text, p_aliases text[], p_effect_text text,
  p_computable_type text, p_splash_text text)
returns uuid
language plpgsql security definer set search_path = public, extensions, pg_temp
as $$
declare v_id uuid;
begin
  perform assert_game_pin(p_game_id, p_pin);
  if p_ability_id is null then
    insert into abilities (game_id, name, aliases, effect_text, computable_type, splash_text)
    values (p_game_id, p_name, coalesce(p_aliases, '{}'), p_effect_text,
            coalesce(p_computable_type, 'none'), p_splash_text)
    returning id into v_id;
  else
    update abilities set name = p_name, aliases = coalesce(p_aliases, '{}'),
      effect_text = p_effect_text, computable_type = coalesce(p_computable_type, 'none'),
      splash_text = p_splash_text
    where id = p_ability_id and game_id = p_game_id
    returning id into v_id;
  end if;
  return v_id;
end;
$$;
grant execute on function upsert_ability(uuid, text, uuid, text, text[], text, text, text) to anon, authenticated;

create or replace function delete_ability(p_game_id uuid, p_pin text, p_ability_id uuid)
returns void
language plpgsql security definer set search_path = public, extensions, pg_temp
as $$
begin
  perform assert_game_pin(p_game_id, p_pin);
  delete from abilities where id = p_ability_id and game_id = p_game_id;
end;
$$;
grant execute on function delete_ability(uuid, text, uuid) to anon, authenticated;

-- actions -------------------------------------------------------------------
create or replace function upsert_action(
  p_game_id uuid, p_pin text, p_action_id uuid, p_night_number int,
  p_actor_player_id uuid, p_ability_id uuid, p_target_player_id uuid,
  p_result text, p_raw_text text, p_needs_review boolean)
returns uuid
language plpgsql security definer set search_path = public, extensions, pg_temp
as $$
declare v_id uuid;
begin
  perform assert_game_pin(p_game_id, p_pin);
  if p_action_id is null then
    insert into actions (game_id, night_number, actor_player_id, ability_id,
      target_player_id, result, raw_text, source, needs_review)
    values (p_game_id, coalesce(p_night_number, 1), p_actor_player_id, p_ability_id,
      p_target_player_id, p_result, p_raw_text, 'manual', coalesce(p_needs_review, false))
    returning id into v_id;
  else
    update actions set night_number = coalesce(p_night_number, night_number),
      actor_player_id = p_actor_player_id, ability_id = p_ability_id,
      target_player_id = p_target_player_id, result = p_result,
      needs_review = coalesce(p_needs_review, needs_review)
    where id = p_action_id and game_id = p_game_id
    returning id into v_id;
  end if;
  return v_id;
end;
$$;
grant execute on function upsert_action(uuid, text, uuid, int, uuid, uuid, uuid, text, text, boolean) to anon, authenticated;

create or replace function delete_action(p_game_id uuid, p_pin text, p_action_id uuid)
returns void
language plpgsql security definer set search_path = public, extensions, pg_temp
as $$
begin
  perform assert_game_pin(p_game_id, p_pin);
  delete from actions where id = p_action_id and game_id = p_game_id;
end;
$$;
grant execute on function delete_action(uuid, text, uuid) to anon, authenticated;

-- game settings -------------------------------------------------------------
create or replace function set_game_pin(p_game_id uuid, p_pin text, p_new_pin text)
returns void
language plpgsql security definer set search_path = public, extensions, pg_temp
as $$
begin
  perform assert_game_pin(p_game_id, p_pin);
  if length(coalesce(p_new_pin, '')) < 6 then
    raise exception 'pin must be at least 6 characters';
  end if;
  update games set pin_hash = crypt(p_new_pin, gen_salt('bf')) where id = p_game_id;
end;
$$;
grant execute on function set_game_pin(uuid, text, text) to anon, authenticated;

create or replace function set_current_night(p_game_id uuid, p_pin text, p_night int)
returns void
language plpgsql security definer set search_path = public, extensions, pg_temp
as $$
begin
  perform assert_game_pin(p_game_id, p_pin);
  update games set current_night_number = greatest(1, p_night) where id = p_game_id;
end;
$$;
grant execute on function set_current_night(uuid, text, int) to anon, authenticated;

-- Finish a game: remove the PIN and lock editing; becomes public read-only.
create or replace function archive_game(p_game_id uuid, p_pin text)
returns void
language plpgsql security definer set search_path = public, extensions, pg_temp
as $$
begin
  perform assert_game_pin(p_game_id, p_pin);
  update games set status = 'archived', pin_hash = null, archived_at = now()
  where id = p_game_id;
end;
$$;
grant execute on function archive_game(uuid, text) to anon, authenticated;
