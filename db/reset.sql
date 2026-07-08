-- Reset: drop all Night Action Tracker objects so schema.sql can recreate them
-- cleanly. Run this FIRST if re-running schema.sql on a project that has an
-- older version of the schema (symptom: "column status does not exist", or
-- other "column ... does not exist" errors).
--
-- DESTRUCTIVE: deletes all games / players / abilities / actions in this
-- project. Only do this on a project with no data you want to keep. After
-- running this, run db/schema.sql.

drop table if exists actions cascade;
drop table if exists abilities cascade;
drop table if exists players cascade;
drop table if exists games cascade;

-- tables from older versions of the schema
drop table if exists submissions cascade;
drop table if exists game_players cascade;
drop table if exists app_config cascade;

-- functions from older versions that are no longer in schema.sql
drop function if exists set_host_password(text);
drop function if exists verify_host_password(text);
drop function if exists admin_list_players(text);
drop function if exists admin_add_player(text, text, text[], boolean, text);
drop function if exists admin_set_regular(text, uuid, boolean);
drop function if exists admin_create_game(text, text, text, uuid[]);
drop function if exists admin_set_game_pin(text, uuid, text);
drop function if exists dashboard_submissions(uuid, text);
drop function if exists dashboard_roster(uuid, text);
