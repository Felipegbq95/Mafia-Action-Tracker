# Night Action Tracker

A Discord scraper + live dashboard that records Mafia night-phase role
submissions from a Discord channel, replacing manual spreadsheet
transcription. Sibling project to
[Mafia Vote Parser](https://github.com/Felipegbq95/Mafia-Vote-Parser).

Each game runs in its own dedicated Discord server, where players submit
night actions by bolding a message in their private channel, e.g.
`**cop: Axatar**`. A scraper reads every text channel in that server over
Discord's REST API, parses the submissions, and writes them to Supabase;
the dashboard subscribes to that table and updates live.

## How it reads Discord (no always-on bot)

Rather than a bot holding a continuous Gateway (websocket) connection,
this uses Discord's **REST API** to fetch channel history on demand. That
means nothing has to run 24/7 - you run the scraper when you want, or on
a schedule. It is "near-live" (polling) rather than instant, which is
fine for a bounded night phase.

Reading a channel over REST still requires a **bot token** (created once
in the Developer Portal). Using your own user account's token instead
would be a self-bot, which is against Discord's ToS and can get your
account banned - so we still create a bot application, we just do not
host it.

Because each game gets a fresh, dedicated server, the scraper just
auto-discovers every text channel in it - no per-game list of channel
IDs to maintain. Two channels' worth of chatter (general, dead chat) are
skipped by name, and only bolded, action-shaped messages are recorded
(see "Message parsing" below), so casual talk in the private channels
does not pollute the results.

## Status

Scaffolded, not yet run against a real Discord server or Supabase
project - neither exists yet, and creating them (Discord bot token,
Supabase project) is not something that can be done on your behalf. The
parser logic (`src/parser.js`) is unit-tested (`npm test`, 13 passing
cases) against the message-format variation you described, but the full
pipeline (Discord message -> Supabase row -> dashboard update) has not
been exercised end-to-end with live credentials. Treat this as a
functional skeleton to wire up and test against a real channel.

## Architecture

- **Scraper** (`src/`): Node.js, no runtime Discord library. `src/discord.js`
  lists the server's text channels and pages through each one's history
  over REST; `src/scrape.js` runs the parser over every message and writes
  a row per recorded submission to Supabase. It tracks a per-channel cursor
  (the newest message id already recorded in that channel) so each run only
  fetches new messages, and re-runs are safe (duplicate inserts are ignored
  via a unique constraint). A channel the bot cannot read is skipped with a
  warning rather than aborting the run.
- **Data layer**: Supabase (Postgres + realtime). Schema in
  `db/schema.sql`.
- **Dashboard** (`dashboard/`): plain static page (no build step),
  deployed via GitHub Pages. It is PIN-gated: the viewer picks a game and
  enters that game's PIN, and only then does the data load (see "Security
  model"). It polls every ~10s rather than using live push, because a
  PIN-gated feed cannot use Supabase realtime directly. The main view is a
  night-action graph: every player is a node on a ring, and each action is
  a colored arrow from actor to target (per night, with a night selector).
  Hovering a player highlights their actions; players who have not
  submitted are dimmed; actions that did not parse cleanly are surfaced in
  a "needs attention" panel. A plain list view is available via a toggle.
  Note it shows *actions only* - it does not compute outcomes (who died,
  whether a kill was blocked), because that depends on per-game role rules
  the app does not model.
- **Votes tab** (`dashboard/votes/`): the day-phase companion to the night
  tracker above - a separate, static, no-backend app
  ([Mafia-Vote-Parser](https://github.com/Felipegbq95/Mafia-Vote-Parser))
  ported in unchanged and run in its own iframe, so its behavior (and its
  own test suite) stay exactly what they are standalone. Paste a forum
  thread's "Print" view in and it detects the day, roster, and majority
  threshold, tallies `VOTE:`/`UNVOTE` posts, and produces ready-to-post
  BBCode. On its side it also `postMessage`s the "Day N Start" timestamps and
  a per-day alive roster it detects (see below). The timestamps the dashboard
  offers to turn into night windows (`nights.started_at`/`ends_at`) - night
  N's window is `[Day N's timestamp, Day N+1's timestamp)`, since Discord's
  private night channels never see day-phase forum content either way. Nothing
  is written until you review the detected windows and click Save.
- **Alive/dead players**: the Board and Sheet hide dead players so late-game
  views stay uncluttered, per night. When you run the vote counter, it extracts
  one alive roster per day from the print (`extractDayRosters`) and the
  dashboard persists each to its night (day N -> night N, `nights.alive_names`)
  automatically - so the state survives a reload and Night 2's board can show
  more players alive than Night 5's. A player absent from a night's saved roster
  reads as dead for that night. Each player also has a persisted manual override
  in the Players tab (`players.life_override`: `alive`/`dead`, null = follow the
  roster) that applies across all nights, for when the tracker's names don't
  line up with the print's or a death happens off-thread. Dead players stay
  listed in the Players tab (dimmed, tagged with what the current night's roster
  resolves them to) so you can still see and override them, and the Actions tab
  keeps every action editable regardless. The roster follows the print's alive
  list verbatim, so if a host miscounts (leaves a dead name on the list), the
  override is the fix.

## Security model

The browser talks to Supabase with the **public anon key**, so the anon key
must not be able to read the tables - otherwise anyone (e.g. a player who
opens dev tools) could bypass the PIN and pull the data straight from the
API. So:

- Row Level Security is ON for every table with **no read/write policies**,
  which denies the anon key all direct table access.
- All browser access goes through `SECURITY DEFINER` database functions (in
  `db/schema.sql`): `create_game`/`list_games` are open (game names aren't
  secret), `public_game_data` serves only archived games, and everything else
  (`game_data`, `upsert_*`, `delete_*`, `archive_game`, ...) verifies the
  game's PIN *first* via `verify_game_pin`, which checks it against a bcrypt
  hash (`pgcrypto`). One PIN per game grants full read+write access to that
  game - there is no separate host password.
- The scraper writes with the **service role key**, which bypasses RLS
  entirely.
- The **"Scrape now" button** calls a Supabase Edge Function
  (`supabase/functions/scrape/`) instead of talking to Discord/writing to the
  database directly from the browser. The Discord bot token and the service
  role key live only in the function's server-side secrets - the browser
  sends just the game's PIN, which the function re-verifies (via the same
  `verify_game_pin`) before scraping. This is the reason the button needs a
  one-time Edge Function deploy rather than being pure client-side JS: those
  two secrets can never be safely embedded in a static page.

This makes the game PIN a real server-side lock, not a client-side curtain.
PINs must be 6+ characters, because an open, server-checked endpoint can be
brute-forced if the secret is tiny (bcrypt's slowness is the main brake, but
a short numeric PIN would still be weak).

## Message parsing

Based on what you described, submissions vary in format:

- Separator varies: `Role: Target`, `Role - Target`, `Role — Target`.
- Sometimes the action is the whole message, sometimes it is bolded
  inline within a longer message.
- Sometimes players use the role name (`cop`), sometimes the ability
  name (`investigate`).

**Actor attribution is by channel, not message author** (see docs/DESIGN.md):
a message in a player's personal channel is attributed to that player; a
message in a shared channel (mafia, duos) is captured with a null actor for
the host to assign. `src/scrape.js` handles that; `src/parser.js` only extracts
"what ability, on whom" from the message text.

`src/parser.js`:

1. Extracts every `**bolded**` span (falls back to the full message text,
   flagged, if nothing is bolded).
2. Splits on a separator if present; otherwise matches a leading word against
   the ability aliases and treats the rest as the target.
3. Resolves the ability against the **per-game ability catalog** loaded from
   Supabase (each ability has names/aliases, an effect, a computable type, and
   an optional splash) - not a hardcoded list.
4. Fuzzy-matches the target against the roster - each player's `display_name`,
   `channel_name`, and `aliases`, so "joe" resolves to the player whose channel
   is "axatar".
5. Anything it cannot confidently resolve is written with `needs_review = true`
   rather than dropped, so it surfaces on the dashboard for the host to fix.

Because the private channels double as casual chat, the scraper only **records**
a message that (a) has a bold span and (b) looks like an action - it resolves an
ability, matches a player, or has a separator. Non-bolded chatter and stray
emphasis (`I **really** don't know`) are skipped. The trade-off: an action a
player forgets to bold is missed - the right call once chatty channels are in
scope. This lives in `isRecordableAction` in `src/parser.js`.

The ability catalog and player aliases are **defined per game in the app**, so
parsing is data-driven and themed games work without code changes.

## Setup

1. **Discord bot token**: create an application + bot user in the
   [Discord Developer Portal](https://discord.com/developers/applications),
   enable the "Message Content" privileged intent (Bot page), and invite
   it to the game server. Use **guild install** (not user install), and
   since the action channels are private, give the bot **Administrator**
   so it can read them all without per-channel setup - fine for a
   disposable per-game server. In OAuth2 -> URL Generator, tick scope
   `bot` and permission `Administrator`, open the URL, authorize. (The bot
   never needs to be "online" - the token just authenticates REST calls.)
2. **Server ID**: enable Developer Mode (Discord Settings -> Advanced),
   right-click the server icon -> Copy Server ID. That is
   `DISCORD_GUILD_ID`.
3. **Supabase**: create a free-tier project and run `db/schema.sql` in the
   SQL editor. That is all the DB setup - there is no host password.
   **Games, players, abilities, and aliases are all created in the app**
   (open the dashboard, "Create game", then use the Players/Abilities
   tabs). `db/seed.sql` is optional and only used to make a throwaway test
   game from SQL. See `GO-LIVE.md` for the click-by-click version.
4. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN`,
   `DISCORD_GUILD_ID`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. The
   optional `DISCORD_EXCLUDE_CHANNELS` (comma-separated channel names)
   defaults to `general,dead-chat,dead,graveyard,spectators`; adjust it to
   match what your server actually calls its non-action channels.
5. Fill in `dashboard/config.js` (already present as a placeholder) with
   `SUPABASE_URL` and `SUPABASE_ANON_KEY`. The anon key is meant to be
   public - it can only call the gated functions, not read the tables (see
   "Security model"). Do not put the service role key here. To view the
   dashboard, pick the game and enter its PIN.

### Running the scraper

There are three ways to run it, in order of how you'll actually use them:

- **"Scrape now" button in the dashboard (primary)**: `supabase/functions/scrape/`
  is a Supabase Edge Function - the button calls it with just the game's PIN;
  the Discord token and the database's full-access key stay server-side,
  never in the browser (see "Security model"). One-time CLI deploy, see
  `GO-LIVE.md` 3a.
- **Manually / locally**: `npm install && npm run scrape`. Useful for
  developing/debugging the scraper itself against a real Discord server.
- **On a schedule (optional backup)**: `.github/workflows/scrape.yml` can run
  `npm run scrape` on a cron with zero servers to maintain, independent of the
  button. It ships with the schedule trigger commented out (uncomment to use
  it) - GitHub's scheduler has a ~5 minute floor and runs best-effort, so it's
  near-live, not instant.

All three run the same logic: `src/scraper-core.js` holds the runtime-agnostic
scraping/attribution code, duplicated (not imported across, since Node and
Deno don't share a module graph) into `supabase/functions/_shared/` for the
Edge Function. Keep the two copies in sync when editing.

### Deploying the dashboard

The GitHub Pages workflow (`.github/workflows/deploy-pages.yml`) deploys
`dashboard/` on push to `main`. Enable Pages for this repo ("GitHub
Actions" source) and merge this branch to `main` to trigger the first
deploy.

## Known limitations / open items

- **Cold start**: the first scrape of a channel (before anything is
  recorded for it) pulls recent history back to the active game's creation
  time, capped at 1000 messages, so it does not scrape a channel's entire
  history. If a channel had more than 1000 messages before the first
  scrape, run the scraper early or raise the cap in `src/discord.js`.
- **False positives from bolded names**: because a bolded player name
  counts as an action signal, someone bolding another player's name in
  group/dead chat ("I think **Axatar** is scum") can create a
  `needs_review` row. Skim and dismiss those on the dashboard; tighten
  `isRecordableAction` if it happens a lot.
- **Bot access**: the bot only reads channels it can see. Administrator
  covers this; without it, private channels are silently skipped (logged
  as a warning in the run output).
- Night number (`games.current_night_number`) is bumped manually via the
  Supabase table editor between nights - no automated bump yet.
- If a single message contains more than one bolded action, only the
  first is guaranteed to persist (the `discord_message_id` unique
  constraint treats the second insert as a duplicate). Uncommon case,
  not handled specially yet.
- No cross-link to the vote counter yet - add once this has a real
  deployed dashboard URL, per the original plan.
- Visual design (fonts, icons, favicon) intentionally not invested in
  yet - the plan was to get one real end-to-end path working first, the
  same order the vote counter's design work happened in.

## Testing

```
npm install
npm test
```

Runs `src/parser.test.js` via Node's built-in test runner.
