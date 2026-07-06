import 'dotenv/config';
import { fetchMessagesAfter, fetchRecentSince } from './discord.js';
import { parseMessage } from './parser.js';
import {
  createSupabase,
  getActiveGame,
  getRoster,
  getLatestMessageId,
  insertSubmission,
} from './supabase.js';

const CHANNEL_ID = process.env.DISCORD_NIGHT_ACTIONS_CHANNEL_ID;
if (!CHANNEL_ID) {
  throw new Error('DISCORD_NIGHT_ACTIONS_CHANNEL_ID must be set');
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

  const cursor = await getLatestMessageId(supabase, CHANNEL_ID);
  const messages = cursor
    ? await fetchMessagesAfter(CHANNEL_ID, cursor)
    : await fetchRecentSince(CHANNEL_ID, new Date(game.created_at));

  let inserted = 0;
  let flagged = 0;

  for (const message of messages) {
    if (message.author?.bot) continue;

    const actions = parseMessage(message.content, roster);
    for (const action of actions) {
      const wrote = await insertSubmission(supabase, {
        game_id: game.id,
        night_number: game.current_night_number,
        discord_message_id: message.id,
        discord_channel_id: CHANNEL_ID,
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

  console.log(
    `Scraped ${messages.length} message(s), inserted ${inserted} submission(s)` +
      `${flagged ? `, ${flagged} flagged for review` : ''}.`,
  );
}

main().catch((err) => {
  console.error('Scrape failed:', err);
  process.exit(1);
});
