import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { listTextChannels, fetchMessagesAfter, fetchRecentSince } from './discord.js';
import { parseMessage, isRecordableAction } from './parser.js';
import {
  createSupabase, getActiveGame, getPlayers, getAbilities,
  getLatestMessageId, insertAction,
} from './supabase.js';

function excludedChannels() {
  return (process.env.DISCORD_EXCLUDE_CHANNELS ?? 'general,dead-chat,dead,graveyard,spectators')
    .split(',').map((n) => n.trim().toLowerCase()).filter(Boolean);
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
 * `actor` is the channel's owning player (null for shared channels). Exposed for
 * testing the attribution logic without Discord/Supabase.
 */
export function buildActionRows(messages, { game, channel, actor, players, abilities }) {
  const rows = [];
  for (const message of messages) {
    if (message.author?.bot) continue;
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

async function scrapeChannel(supabase, channel, ctx) {
  const { game, players, abilities, personalChannel } = ctx;
  const actor = personalChannel.get(channel.name.toLowerCase()) ?? null;

  const cursor = await getLatestMessageId(supabase, game.id, channel.name);
  const messages = cursor
    ? await fetchMessagesAfter(channel.id, cursor)
    : await fetchRecentSince(channel.id, new Date(game.created_at));

  const rows = buildActionRows(messages, { game, channel, actor, players, abilities });
  let inserted = 0;
  for (const row of rows) {
    if (await insertAction(supabase, row)) inserted += 1;
  }
  return { channel: channel.name, shared: !actor, messages: messages.length, inserted };
}

async function main() {
  const GUILD_ID = process.env.DISCORD_GUILD_ID;
  if (!GUILD_ID) throw new Error('DISCORD_GUILD_ID must be set');
  const EXCLUDED_CHANNELS = excludedChannels();
  const supabase = createSupabase();

  const game = await getActiveGame(supabase);
  if (!game) {
    console.error('No active game found (games.status = active). Nothing to scrape.');
    process.exit(1);
  }

  const [players, abilities] = await Promise.all([
    getPlayers(supabase, game.id),
    getAbilities(supabase, game.id),
  ]);
  const personalChannel = new Map(
    players.filter((p) => p.channel_name).map((p) => [p.channel_name.toLowerCase(), p]),
  );

  const channels = (await listTextChannels(GUILD_ID))
    .filter((c) => !EXCLUDED_CHANNELS.includes(c.name.toLowerCase()));

  const ctx = { game, players, abilities, personalChannel };
  let totalMsgs = 0;
  let totalInserted = 0;
  for (const channel of channels) {
    try {
      const r = await scrapeChannel(supabase, channel, ctx);
      totalMsgs += r.messages;
      totalInserted += r.inserted;
    } catch (err) {
      console.warn(`Skipped #${channel.name} (${channel.id}): ${err.message}`);
    }
  }

  console.log(
    `Game "${game.name}" night ${game.current_night_number}: scanned ${channels.length} ` +
      `channel(s), ${totalMsgs} message(s), inserted ${totalInserted} action(s).`,
  );
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error('Scrape failed:', err); process.exit(1); });
}
