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

// One action per Discord message (the unique key is game + message id): take
// the first bolded, action-shaped span. Extra actions in one message are the
// host's to add by hand.
export function firstAction(content, players, abilities) {
  for (const candidate of parseMessage(content, players, abilities)) {
    if (isRecordableAction(candidate)) return candidate;
  }
  return null;
}

/**
 * Pure mapping from fetched Discord messages to `actions` rows for one channel.
 * `actor` is the channel's owning player (null for shared channels).
 */
export function buildActionRows(messages, { game, channel, actor, players, abilities, mods = [] }) {
  const rows = [];
  for (const message of messages) {
    if (isIgnoredAuthor(message.author, mods)) continue;
    const action = firstAction(message.content, players, abilities);
    if (!action) continue;
    rows.push({
      game_id: game.id,
      night_number: game.current_night_number,
      actor_player_id: actor?.id ?? null,
      ability_id: action.ability.id,
      target_player_id: action.target.player?.id ?? null,
      result: null,
      source: 'scraped',
      source_channel: channel.name,
      discord_message_id: message.id,
      raw_text: message.content,
      actor_raw: message.author?.global_name ?? message.author?.username ?? null,
      ability_raw: action.ability.raw,
      target_raw: action.target.raw,
      // A shared channel (no personal-channel owner) needs the host to assign
      // the actor, so it always needs review.
      needs_review: !actor || action.needsReview,
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
export async function scrapeGame({ discord, db, guildId, excludedChannels, game, players, abilities, mods = [] }) {
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

      const rows = buildActionRows(messages, { game, channel, actor, players, abilities, mods });
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
