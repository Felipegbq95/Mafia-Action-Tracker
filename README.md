# Night Action Tracker

A Discord scraper + live dashboard that records Mafia night-phase role
submissions from a Discord channel, replacing manual spreadsheet
transcription. Sibling project to
[Mafia Vote Parser](https://github.com/Felipegbq95/Mafia-Vote-Parser).

Players submit their night action by bolding a message in the
night-actions channel, e.g. `**cop: Axatar**`. A scraper reads the
channel over Discord's REST API, parses the submissions, and writes them
to Supabase; the dashboard subscribes to that table and updates live.

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
  pages through channel history over REST; `src/scrape.js` runs the parser
  over each message and writes a row per submission to Supabase. It tracks
  a cursor (the newest message id already recorded) so each run only
  fetches new messages, and re-runs are safe (duplicate inserts are
  ignored via a unique constraint).
- **Data layer**: Supabase (Postgres + realtime). Schema in
  `db/schema.sql`.
- **Dashboard** (`dashboard/`): plain static page (no build step),
  deployed via GitHub Pages, subscribed to Supabase realtime changes on
  `submissions`.

## Message parsing

Based on what you described, submissions vary in format:

- Separator varies: `Role: Target`, `Role - Target`, `Role — Target`.
- Sometimes the action is the whole message, sometimes it is bolded
  inline within a longer message.
- Sometimes players use the role name (`cop`), sometimes the ability
  name (`investigate`).

`src/parser.js` handles all of these:

1. Extracts every `**bolded**` span from the message (falls back to the
   full message text, flagged low-confidence, if nothing is bolded -
   better to surface a possible miss than silently drop it).
2. Splits on a separator if one is present; if not, tries to match a
   leading word against the role/ability alias list and treats the rest
   as the target.
3. Resolves the role/ability phrase against `src/roleAliases.js`.
4. Fuzzy-matches the target phrase against the current game's player
   roster (typo-tolerant, alias-aware - same approach the vote counter
   used for player names).
5. Anything it cannot confidently resolve is written with
   `needs_review = true` rather than dropped, so it surfaces on the
   dashboard for you to fix by hand.

**`src/roleAliases.js` is a first draft, written without seeing real
game messages.** Mafia rulesets vary a lot between games - edit that
file (or move it to a Supabase table if per-game customization turns
out to matter) once you have watched a real night phase and seen which
role/ability names actually show up.

## Setup

1. **Discord bot token**: create an application + bot user in the
   [Discord Developer Portal](https://discord.com/developers/applications),
   enable the "Message Content" privileged intent, invite it to your
   server with permission to read the night-actions channel. (The bot
   never needs to be "online" - the token is just used to authenticate
   REST calls.)
2. **Supabase**: create a free-tier project, run `db/schema.sql` in the
   SQL editor, insert a row into `games` for your current game (set
   `is_active = true`), and add its players to `players` /
   `game_players`.
3. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN`,
   `DISCORD_NIGHT_ACTIONS_CHANNEL_ID`, `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`.
4. Copy `dashboard/config.example.js` to `dashboard/config.js` (already
   present as a placeholder) and fill in `SUPABASE_URL` and
   `SUPABASE_ANON_KEY` - the anon key is meant to be public, row-level
   security (already set up in the schema) is what actually protects
   the data. Do not put the service role key here.

### Running the scraper

- **Manually / locally**: `npm install && npm run scrape`. Run it
  whenever you want to pull in new submissions (e.g. once at the end of
  a night, or a few times during).
- **On a schedule (no hosting)**: `.github/workflows/scrape.yml` runs
  `npm run scrape` on a cron with zero servers to maintain. Add your
  four env values as repository secrets (Settings -> Secrets and
  variables -> Actions): `DISCORD_TOKEN`,
  `DISCORD_NIGHT_ACTIONS_CHANNEL_ID`, `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`. GitHub's scheduler has a ~5 minute floor
  and runs best-effort (often a few minutes late), so it is near-live,
  not instant. When you are not running a game, disable the workflow from
  the Actions tab so it stops polling; you can still trigger it manually
  there any time.

### Deploying the dashboard

The GitHub Pages workflow (`.github/workflows/deploy-pages.yml`) deploys
`dashboard/` on push to `main`. Enable Pages for this repo ("GitHub
Actions" source) and merge this branch to `main` to trigger the first
deploy.

## Known limitations / open items

- **Cold start**: the first scrape (before anything is recorded) pulls
  recent history back to the active game's creation time, capped at 1000
  messages, so it does not scrape the entire channel. If a night had more
  than 1000 messages before the first scrape, run the scraper early or
  raise the cap in `src/discord.js`.
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
