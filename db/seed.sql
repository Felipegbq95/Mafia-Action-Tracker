-- One-time seed for a single game. Edit the values, then paste into the
-- Supabase SQL editor and run (after db/schema.sql has been run once).
--
-- This inserts a game, its players, and links every player to that game in
-- one shot, so you don't have to click rows into the table editor by hand.
--
-- Notes:
--  - display_name is what the parser fuzzy-matches action targets against.
--  - aliases are extra nicknames it should also match (use array[]::text[]
--    for none).
--  - discord_id is OPTIONAL. Fill it in to link who *submitted* each action
--    (right-click a user in Discord -> Copy User ID, Developer Mode on).
--    Leave it null and submissions still work, they just show the submitter
--    as unlinked. Target matching does not use it.
--  - Re-running this creates a second game; it's meant to be run once per
--    game. To start a new game later, set the old game's is_active = false
--    first, then run an edited copy of this.

with new_game as (
  insert into games (name, is_active, current_night_number)
  values ('REPLACE - name of this game', true, 1)
  returning id
),
new_players as (
  insert into players (display_name, discord_id, aliases)
  values
    ('REPLACE - Player One',   null, array['nickname1']),
    ('REPLACE - Player Two',   null, array[]::text[]),
    ('REPLACE - Player Three', null, array[]::text[])
    -- add one row per player...
  returning id
)
insert into game_players (game_id, player_id)
select new_game.id, new_players.id
from new_game cross join new_players;
