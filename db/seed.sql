-- Optional: create a test game with a couple of players and abilities using
-- the new functions, so you can validate the schema before the create-game UI
-- exists. Run AFTER schema.sql. Change the PIN first.
--
-- Watch the output for the "Created game <id> with pin <pin>" notice - you'll
-- use that game id + PIN to open it (and to test game_data / archive_game).

do $$
declare
  gid uuid;
  pin text := 'change-me-123';
begin
  gid := create_game('Test Game', pin);

  perform upsert_player(gid, pin, null, 'Axatar',  'axatar',  array['joe']);
  perform upsert_player(gid, pin, null, 'Bramble', 'bramble', array['bram']);
  perform upsert_player(gid, pin, null, 'Cortez',  'cortez',  array[]::text[]);

  perform upsert_ability(gid, pin, null, 'Investigate',
    array['cop','check','investigate'], 'Learns the target''s alignment', 'none', null);
  perform upsert_ability(gid, pin, null, 'Roleblock',
    array['block','roleblock'], 'Cancels the target''s action', 'roleblock',
    'You were roleblocked last night and were unable to act.');

  raise notice 'Created game % with pin %', gid, pin;
end $$;
