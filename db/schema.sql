-- Mafia Night Action Tracker schema.
-- Run this in the Supabase SQL editor for a fresh project.

create extension if not exists pgcrypto;

create table if not exists games (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  is_active boolean not null default true,
  -- Bumped manually (e.g. via the Supabase table editor) at the start of
  -- each night phase. There's no automated bump yet.
  current_night_number int not null default 1,
  created_at timestamptz not null default now()
);

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  discord_id text unique,
  display_name text not null,
  aliases text[] not null default '{}',
  created_at timestamptz not null default now()
);

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

-- Enables the dashboard's realtime subscription.
alter publication supabase_realtime add table submissions;

-- The dashboard reads with the public anon key, so it needs read-only
-- access via RLS. The scraper writes with the service role key, which
-- bypasses RLS entirely, so no write policies are added here on purpose.
alter table games enable row level security;
alter table players enable row level security;
alter table game_players enable row level security;
alter table submissions enable row level security;

create policy "public read" on games for select using (true);
create policy "public read" on players for select using (true);
create policy "public read" on game_players for select using (true);
create policy "public read" on submissions for select using (true);
