# Night Action Tracker - design

Living design doc. This captures the target model agreed in conversation.
Edit / redline freely; code follows this.

## What the app is

A host's workspace for a Mafia game's night phase. A scraper pulls a **draft**
set of actions from Discord; the host then reviews and edits them (assign
shared-channel actions to players, fix targets, add/delete, set results) and the
web graph visualizes the current state. It is not a passive live feed - the host
adjudicates.

## Game lifecycle

- **Active:** has a PIN, fully editable, and is the scraper's target. Only one
  game is active at a time (maps to the current Discord server).
- **Archived (finished):** "Finish game" removes the PIN and locks editing. The
  game becomes **public read-only** - anyone can open it and view the final
  board without a PIN. No further edits or scraping.

## Night windowing (planned, not built yet)

Only actions from the current night should count. The forum thread records exactly
when the day ended and the night started/ends. Plan: the sibling **Vote Parser**
(which already reads the thread and detects day/night boundaries) publishes the
current night's start/end timestamps into the same Supabase, keyed by game; this
app filters actions to that window. Until then, the game can carry a manually-set
night start/end. Deferred - noted so it isn't lost.

## Access model (simple, no admin tier)

- Anyone who opens the app sees the list of games, or can **Create game**
  (name + PIN).
- **One PIN per game = full access.** With a game's PIN you can do everything for
  that game: view the graph, edit players/aliases, define abilities, add/edit/
  delete actions, assign results. No separate host password, no view-only tier.
- Keep the PIN to hosts/co-hosts only - it also guards editing, so anyone with it
  can change the game's data. PIN minimum length enforced.
- Tables stay locked (RLS on, no direct anon access); all access is through
  PIN-gated database functions. Scraper writes with the service role.

## Everything is per-game (with a planned global player pool)

Abilities, channels, and aliases are themed and rebuilt each game. **Players are
currently per-game too**, but the target model is a **game-agnostic pool of
people** (~30 regulars + aliases): each game you pick the subset who are playing
and add any newcomers, instead of re-entering everyone. This is a planned schema
change (a persistent people table + per-game participation). Until then, the
Players tab has a **paste-a-list** box so bulk entry is quick.

## Data model

### players (per game)
- `display_name` - shown on the web (e.g. `Axatar`).
- `channel_name` - their personal Discord channel (e.g. `axatar`). This is how
  actions are attributed (see Attribution). Null for players without a personal
  channel.
- `aliases[]` - other names people use to target them (e.g. `joe`, his real
  name). Used for target resolution.

### abilities (per game)
- `names/aliases[]` - what players type in Discord (`investigate`, `check`, ...).
- `effect_text` - what is printed on the web instead of the raw ability name.
- `computable_type` - one of: `none`, `kill`, `save`, `track`, `watch`,
  `redirect`, `roleblock`. The category the app understands structurally.
- `splash_text` - optional message the *target* receives (e.g. roleblock:
  "You were roleblocked last night and were unable to act"), shown with a copy
  button so the host can paste it to the player. Not every ability has one.

### actions (per game, per night)  [replaces "submissions"]
- `actor_player_id` - who performed it. Auto-filled from the channel for
  personal channels; **null until the host assigns it** for shared channels.
- `ability_id` - resolved ability (or unresolved -> needs review).
- `target_player_id` - resolved via alias matching (or unresolved).
- `result` - host-assigned outcome (e.g. cop -> `non-town`). Free-form for now.
- `source` - `scraped` (with channel + discord message id) or `manual`.
- `night_number`, `raw_text`, `needs_review`, timestamps.
- Host can add, edit, and delete actions, then save.

## Attribution (channel -> actor)

Each player has a personal channel named after them; that is the source of truth
for who acted.

- Message in a channel whose name matches a player's `channel_name`,
  `display_name`, or any alias (normalized) -> actor = that player. So a
  channel named after a player's alias attributes automatically; you usually
  do not need to set `channel_name` at all.
- Message in any **other** included channel (mafia, lovers/duos, ...) -> it's a
  **shared channel**: the action is captured but `actor_player_id` is left null
  and flagged for the host to assign. Example: the mafia channel has 5 actions;
  the host assigns each to a player.
- Excluded channels (general, dead chat, ...) are skipped entirely.

So "shared channel" = any included channel that isn't someone's personal channel.
No extra configuration needed.

## Target resolution (aliases)

A target string is matched against every player's `display_name`, `channel_name`,
and `aliases[]`. Example: someone writes target `joe`; `joe` is an alias of the
player whose channel is `axatar`, so it resolves to Axatar. Fuzzy/typo-tolerant,
host-editable alias list per game. Unresolved targets are flagged for review.

## Manual editing + save

The dashboard (once unlocked with the PIN) is an editor, not just a viewer:
- Assign actors to shared-channel actions.
- Fix a wrong/unresolved target (pick the player).
- Add an action by hand; delete a bogus one.
- Set an action's result by clicking its arrow in the graph.
- Manage the alias list and abilities.
Changes are saved to Supabase via PIN-gated functions.

## Results

- Set per action by clicking its arrow in the web (e.g. cop -> `non-town`).
- Some results are derivable from the action graph later (track = who your target
  visited; watch = who visited your target; roleblock = whose action was
  cancelled) - `computable_type` is the hook for that. Alignment-type results
  (town/non-town) are always host-entered, since the app doesn't know hidden
  roles.

## Dashboard

- Landing: list games / create game / enter PIN.
- Unlocked: the action web (nodes = players, arrows = actions colored by ability,
  per night), plus editor panels for actions, players/aliases, and abilities.
- Splashes shown per targeted player with copy buttons.
- Polls ~10s for new scraped actions; host edits persist.

## Scraper changes from current code

- Attribute actor by **channel -> player**, not by Discord message author (the
  current code uses `message.author` - that changes).
- Load the per-game **abilities** catalog to resolve ability names + effects.
- Load per-game **players** (with channel_name + aliases) for attribution and
  target resolution.
- Insert draft actions; shared-channel actions get a null actor for the host to
  assign.

## Scraper trigger: Edge Function button, not a client-side call

The dashboard only holds the public anon key, which cannot safely hold the
Discord bot token or the Supabase service role key (both let you read every
game/channel, defeating the PIN). So the "Scrape now" button does not call
Discord or the database directly from the browser - it calls a **Supabase
Edge Function** (`supabase/functions/scrape/`), which holds those two secrets
server-side and re-verifies the caller's PIN before doing anything.

The scraping/attribution logic (`channelActor`, `buildActionRows`,
`scrapeGame`) lives in `src/scraper-core.js`, written with zero Node- or
Deno-specific APIs so it works unchanged in both the Node cron script
(`src/scrape.js`) and the Edge Function. It is **duplicated**, not imported
across, into `supabase/functions/_shared/` (Node and Deno don't share a module
graph, and Supabase's deploy bundling is per-function) - keep the two copies
in sync when editing either.

A scheduled cron (`.github/workflows/scrape.yml`) still exists as an optional
backup, disabled by default (no `schedule:` trigger), since the button covers
the normal case.

## Open decisions (defaults marked)

1. Players per-game, rebuilt each game *(default)*, with an optional
   import-from-previous-game later. OK, or keep a global reusable pool?
2. Shared channel = "any included channel that isn't a personal channel"
   *(default)*. OK, or list shared channels explicitly per game?
3. `result` is free-form text for now *(default)*; constrain per computable type
   later. OK?

## Build order

- **A. Schema rework** *(done)*: drop host-password/admin layer; PIN-gated
  full access; add per-game abilities + players.channel_name + actions(result,
  actor nullable, manual); open create-game.
- **B. Scraper** *(done)*: channel-based attribution + data-driven
  abilities/aliases (name/display_name/alias match, not just channel_name).
- **C. Dashboard editor** *(done)*: create-game + abilities editor +
  players/aliases editor (incl. paste-a-list) + action add/edit/delete +
  assign results by clicking arrows.
- **D. Effects + splashes rendering** *(done)*: board hover shows effect text
  and splashes, not raw ability names.
- **E. On-demand scrape button** *(done)*: Supabase Edge Function, see above.
- **F. (later) auto-derive** track/watch/roleblock results.
- **G. (later) game-agnostic player pool** - see "Everything is per-game"
  above.
