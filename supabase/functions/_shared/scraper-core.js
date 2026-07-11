// Scraper logic shared between the Node cron script (src/scrape.js, runs via
// GitHub Actions) and the Supabase Edge Function
// (supabase/functions/scrape/index.js, runs on-demand from the dashboard
// button). Keep this file free of runtime-specific APIs - no `process`, no
// `Deno`, no `node:`/`npm:` imports - so it works unchanged in both. It is
// duplicated (not imported across) into supabase/functions/_shared/ because
// the two deploy pipelines don't share a module graph; keep the two copies in
// sync when editing.

import { parseMessage, isRecordableAction } from './parser.js';

const channelNorm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Finds the player a channel belongs to. A channel is a player's personal
 * channel if its name matches that player's channel_name, display_name, or any
 * alias (normalized, so "joe-smith" matches "Joe Smith"). Channels that match
 * nobody are group channels (mafia, duos) - this returns null for them and the
 * scraper leaves those actions' actor for the host to assign.
 */
export function channelActor(channelName, players) {
  const cn = channelNorm(channelName);
  if (!cn) return null;
  for (const p of players) {
    for (const key of [p.channel_name, p.display_name, ...(p.aliases ?? [])]) {
      if (key && channelNorm(key) === cn) return p;
    }
  }
  return null;
}

// Whether a message's author should be ignored entirely. Bots always are;
// mods are matched by Discord username, display name, or user id (normalized),
// because mods post bolded RESULTS into player channels that would otherwise be
// read as that player's action.
export function isIgnoredAuthor(author, mods = []) {
  if (!author) return false;
  if (author.bot) return true;
  const candidates = [author.id, author.username, author.global_name]
    .filter(Boolean).map((s) => String(s).trim().toLowerCase());
  for (const mod of mods) {
    const m = String(mod ?? '').trim().toLowerCase();
    if (m && candidates.includes(m)) return true;
  }
  return false;
}

/**
 * Assigns a message timestamp to a night using the host-defined windows
 * (nights: [{ night_number, started_at, ends_at }]). Rules:
 *  - no windows defined (or no usable timestamp) -> fallback night, keep.
 *  - timestamp inside a window (ends_at null = still open) -> that night.
 *  - windows defined but timestamp outside all of them -> skip (day-phase
 *    chatter is not a night action).
 */
export function nightForTimestamp(ts, nights = [], fallback = 1) {
  const windows = (nights ?? []).filter((n) => n.started_at);
  const t = ts ? new Date(ts).getTime() : NaN;
  if (windows.length === 0 || Number.isNaN(t)) return { night: fallback, skip: false };
  let best = null;
  for (const w of windows) {
    const start = new Date(w.started_at).getTime();
    const end = w.ends_at ? new Date(w.ends_at).getTime() : Infinity;
    if (t >= start && t <= end && (!best || start > best.start)) {
      best = { start, night: w.night_number };
    }
  }
  return best ? { night: best.night, skip: false } : { night: null, skip: true };
}

// Every recordable action in a message, in order. A single message can carry
// several bolded actions (e.g. the mafia channel posting the whole faction's
// night in one message) - each becomes its own row, keyed by span index.
export function recordableActions(content, players, abilities) {
  return parseMessage(content, players, abilities).filter(isRecordableAction);
}

// Kept for compatibility; prefer recordableActions.
export function firstAction(content, players, abilities) {
  return recordableActions(content, players, abilities)[0] ?? null;
}

/**
 * Pure mapping from fetched Discord messages to `actions` rows for one channel.
 * `actor` is the channel's owning player (null for shared channels). One row
 * per recordable bolded span (unique key: game + message id + span_index).
 */
export function buildActionRows(messages, { game, channel, actor, players, abilities, mods = [], nights = [] }) {
  const rows = [];
  for (const message of messages) {
    if (isIgnoredAuthor(message.author, mods)) continue;
    const { night, skip } = nightForTimestamp(message.timestamp, nights, game.current_night_number);
    if (skip) continue;
    const actions = recordableActions(message.content, players, abilities);
    actions.forEach((action, spanIndex) => {
      rows.push({
        game_id: game.id,
        night_number: night,
        actor_player_id: actor?.id ?? null,
        ability_id: action.ability.id,
        target_player_id: action.target.player?.id ?? null,
        result: null,
        source: 'scraped',
        source_channel: channel.name,
        discord_message_id: message.id,
        span_index: spanIndex,
        posted_at: message.timestamp ?? null,
        raw_text: message.content,
        actor_raw: message.author?.global_name ?? message.author?.username ?? null,
        ability_raw: action.ability.raw,
        target_raw: action.target.raw,
        // A shared channel (no personal-channel owner) needs the host to assign
        // the actor, so it always needs review.
        needs_review: !actor || action.needsReview,
      });
    });
  }
  return rows;
}

/**
 * Scrapes every included channel in a Discord guild for one game and inserts
 * the resulting actions. `discord` and `db` are small injected interfaces so
 * this stays runtime-agnostic:
 *   discord: { listTextChannels(guildId), fetchMessagesAfter(channelId, afterId), fetchRecentSince(channelId, notBefore) }
 *   db: { getLatestMessageId(gameId, channelName), insertAction(row) }
 * A channel that errors (e.g. the bot can't read it) is skipped, not fatal.
 * Returns { channels, messages, inserted, perChannel }.
 */
export async function scrapeGame({ discord, db, guildId, excludedChannels, game, players, abilities, mods = [], nights = [] }) {
  const channels = (await discord.listTextChannels(guildId))
    .filter((c) => !excludedChannels.includes(c.name.toLowerCase()));

  let totalMsgs = 0;
  let totalInserted = 0;
  const perChannel = [];

  for (const channel of channels) {
    try {
      const actor = channelActor(channel.name, players);
      const cursor = await db.getLatestMessageId(game.id, channel.name);
      const messages = cursor
        ? await discord.fetchMessagesAfter(channel.id, cursor)
        : await discord.fetchRecentSince(channel.id, new Date(game.created_at));

      const rows = buildActionRows(messages, { game, channel, actor, players, abilities, mods, nights });
      let inserted = 0;
      for (const row of rows) {
        if (await db.insertAction(row)) inserted += 1;
      }

      totalMsgs += messages.length;
      totalInserted += inserted;
      perChannel.push({ channel: channel.name, shared: !actor, messages: messages.length, inserted });
    } catch (err) {
      perChannel.push({ channel: channel.name, error: err.message });
    }
  }

  return { channels: channels.length, messages: totalMsgs, inserted: totalInserted, perChannel };
}
