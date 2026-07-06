-- One-time load of your "regular" players - the people who usually play, so
-- the create-game screen can pre-select them and you don't re-type them each
-- game. Edit the rows, paste into the Supabase SQL editor, run.
--
-- Games themselves are created through the app (admin screen), not here, so
-- this file only seeds the player pool. Run it once; add stragglers later
-- from the admin screen.
--
--  - display_name: the name the parser matches action targets against (use
--    what players actually type when targeting each other).
--  - aliases: extra nicknames to also match; array[]::text[] for none.
--  - discord_id: optional; links who *submitted* an action. Right-click a
--    user in Discord (Developer Mode on) -> Copy User ID. Null is fine.
--
-- Re-running is safe for new names; a duplicate discord_id will error
-- (that column is unique), which just means that player already exists.

insert into players (display_name, aliases, is_regular, discord_id)
values
  ('REPLACE - Player One',   array['nickname1'], true, null),
  ('REPLACE - Player Two',   array[]::text[],    true, null),
  ('REPLACE - Player Three', array[]::text[],    true, null)
  -- add one row per regular...
;
