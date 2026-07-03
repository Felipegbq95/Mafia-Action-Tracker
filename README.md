# Night Action Tracker

A Discord bot + live dashboard that records Mafia night-phase role
submissions from a Discord channel, replacing manual spreadsheet
transcription. Sibling project to
[Mafia Vote Parser](https://github.com/Felipegbq95/Mafia-Vote-Parser).

Players submit their night action by bolding a message in the
night-actions channel, e.g. `**cop: Axatar**`. The bot parses these in
real time and writes them to Supabase; the dashboard subscribes to that
table and updates live.

## Status

Scaffolded, not yet run against a real Discord server or Supabase
project - neither exists yet, and creating them (Discord bot token,
Supabase project) isn't something that can be done on your behalf. The
parser logic (`bot/parser.js`) is unit-tested (`npm test`, 13 passing
cases) against the message-format variation you described, but the
full pipeline (Discord message -> Supabase row -> dashboard update) has
not been exercised end-to-end with live credentials. Treat this as a
functional skeleton to wire up and test against a real channel, not a
finished, battle-tested bot.

## Architecture

- **Bot** (`bot/`): Node.js + discord.js, listens on one configured
  channel, reads `message.content` directly (raw markdown, no DOM
  parsing needed), extracts and parses bolded action text, writes a row
  per submission to Supabase.
- **Data layer**: Supabase (Postgres + realtime). Schema in
  `db/schema.sql`.
- **Dashboard** (`dashboard/`): plain static page (no build step),
  deployed via GitHub Pages, subscribed to Supabase realtime changes on
  `submissions`.

## Message parsing

Based on what you described, submissions vary in format:

- Separator varies: `Role: Target`, `Role - Target`, `Role — Target`.
- Sometimes the action is the whole message, sometimes it's bolded
  inline within a longer message.
- Sometimes players use the role name (`cop`), sometimes the ability
  name (`investigate`).

`bot/parser.js` handles all of these:

1. Extracts every `**bolded**` span from the message (falls back to the
   full message text, flagged low-confidence, if nothing is bolded -
   better to surface a possible miss than silently drop it).
2. Splits on a separator if one is present; if not, tries to match a
   leading word against the role/ability alias list and treats the rest
   as the target.
3. Resolves the role/ability phrase against `bot/roleAliases.js`.
4. Fuzzy-matches the target phrase against the current game's player
   roster (typo-tolerant, alias-aware - same approach the vote counter
   used for player names).
5. Anything it can't confidently resolve is written with
   `needs_review = true` rather than dropped, so it surfaces on the
   dashboard for you to fix by hand.

**`bot/roleAliases.js` is a first draft, written without seeing real
game messages.** Mafia rulesets vary a lot between games - edit that
file (or move it to a Supabase table if per-game customization turns
out to matter) once you've watched a real night phase and seen which
role/ability names actually show up.

## Setup

1. **Discord bot**: create an application + bot user in the
   [Discord Developer Portal](https://discord.com/developers/applications),
   enable the "Message Content" privileged intent, invite it to your
   server with permission to read the night-actions channel.
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
   the data. Don't put the service role key here.
5. `npm install && npm start` runs the bot locally. For it to run
   continuously (needed to hold the Discord Gateway connection), it
   needs to live somewhere like Railway or Fly.io - not set up yet,
   this is a genuine step up in operational complexity from the vote
   counter, which has zero moving parts.
6. The GitHub Pages workflow (`.github/workflows/deploy-pages.yml`)
   deploys `dashboard/` on push to `main`. Enable Pages for this repo
   ("GitHub Actions" source) and merge this branch to `main` to trigger
   the first deploy.

## Known limitations / open items

- Night number (`games.current_night_number`) is bumped manually via
  the Supabase table editor between nights - no in-bot command for
  that yet.
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

Runs `bot/parser.test.js` via Node's built-in test runner.
