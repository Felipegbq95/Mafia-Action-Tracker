import 'dotenv/config';
import {
  listTextChannels,
  fetchMessagesAfter,
  fetchRecentSince,
} from './discord.js';
import { parseMessage, isRecordableAction } from './parser.js';
import {
  createSupabase,
  getActiveGame,
  getRoster,
  getLatestMessageId,
  insertSubmission,
} from './supabase.js';

const GUILD_ID = process.env.DISCORD_GUILD_ID;
if (!GUILD_ID) {
  throw new Error('DISCORD_GUILD_ID must be set');
}

// Channels that hold chatter, not night actions. Matched case-insensitively
// by name. Override via DISCORD_EXCLUDE_CHANNELS (comma-separated names).
const EXCLUDED_CHANNELS = (
  process.env.DISCORD_EXCLUDE_CHANNELS ?? 'general,dead-chat,dead,graveyard,spectators'
)
  .split(',')
  .map((name) => name.trim().toLowerCase())
  .filter(Boolean);

async function scrapeChannel(supabase, channel, { game, roster, discordIdToPlayerId }) {
  const cursor = await getLatestMessageId(supabase, channel.id);
  const messages = cursor
    ? await fetchMessagesAfter(channel.id, cursor)
    : await fetchRecentSince(channel.id, new Date(game.created_at));

  let inserted = 0;
  let flagged = 0;

  for (const message of messages) {
    if (message.author?.bot) continue;

    const actions = parseMessage(message.content, roster);
    for (const action of actions) {
      if (!isRecordableAction(action)) continue;

      const wrote = await insertSubmission(supabase, {
        game_id: game.id,
        night_number: game.current_night_number,
        discord_message_id: message.id,
        discord_channel_id: channel.id,
        channel_name: channel.name,
        submitted_at: message.timestamp,
        submitter_player_id: discordIdToPlayerId.get(message.author.id) ?? null,
        submitter_discord_id: message.author.id,
        raw_message: message.content,
        role_raw: action.role.raw,
        role_canonical: action.role.canonical,
        target_raw: action.target.raw,
        target_player_id: action.target.player?.id ?? null,
        target_match_score: action.target.score,
        needs_review: action.needsReview,
      });
      if (wrote) {
        inserted += 1;
        if (action.needsReview) flagged += 1;
      }
    }
  }

  return { messages: messages.length, inserted, flagged };
}

async function main() {
  const supabase = createSupabase();

  const game = await getActiveGame(supabase);
  if (!game) {
    console.error('No active game found (games.is_active). Nothing to scrape.');
    process.exit(1);
  }

  const roster = await getRoster(supabase, game.id);
  const discordIdToPlayerId = new Map(
    roster.filter((p) => p.discordId).map((p) => [p.discordId, p.id]),
  );

  const allChannels = await listTextChannels(GUILD_ID);
  const channels = allChannels.filter(
    (c) => !EXCLUDED_CHANNELS.includes(c.name.toLowerCase()),
  );

  const totals = { messages: 0, inserted: 0, flagged: 0 };
  for (const channel of channels) {
    try {
      const result = await scrapeChannel(supabase, channel, {
        game,
        roster,
        discordIdToPlayerId,
      });
      totals.messages += result.messages;
      totals.inserted += result.inserted;
      totals.flagged += result.flagged;
    } catch (err) {
      // A channel the bot cannot read (missing permission) or a transient
      // error should not abort the whole run - skip it and keep going.
      console.warn(`Skipped #${channel.name} (${channel.id}): ${err.message}`);
    }
  }

  console.log(
    `Scanned ${channels.length} channel(s), ${totals.messages} message(s); ` +
      `inserted ${totals.inserted} submission(s)` +
      `${totals.flagged ? `, ${totals.flagged} flagged for review` : ''}.`,
  );
}

main().catch((err) => {
  console.error('Scrape failed:', err);
  process.exit(1);
});
