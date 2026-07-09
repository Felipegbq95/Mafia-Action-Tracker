import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { listTextChannels, fetchMessagesAfter, fetchRecentSince } from './discord.js';
import { scrapeGame, channelActor, firstAction, buildActionRows } from './scraper-core.js';
import {
  createSupabase, getActiveGame, getPlayers, getAbilities,
  getLatestMessageId, insertAction,
} from './supabase.js';

// Re-exported for src/scrape.test.js; canonical definitions live in
// scraper-core.js (shared with the Supabase Edge Function).
export { channelActor, firstAction, buildActionRows };

function excludedChannels() {
  return (process.env.DISCORD_EXCLUDE_CHANNELS ?? 'general,dead-chat,dead,graveyard,spectators')
    .split(',').map((n) => n.trim().toLowerCase()).filter(Boolean);
}

async function main() {
  const GUILD_ID = process.env.DISCORD_GUILD_ID;
  if (!GUILD_ID) throw new Error('DISCORD_GUILD_ID must be set');
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

  const result = await scrapeGame({
    discord: { listTextChannels, fetchMessagesAfter, fetchRecentSince },
    db: {
      getLatestMessageId: (gameId, channelName) => getLatestMessageId(supabase, gameId, channelName),
      insertAction: (row) => insertAction(supabase, row),
    },
    guildId: GUILD_ID,
    excludedChannels: excludedChannels(),
    game,
    players,
    abilities,
  });

  for (const c of result.perChannel) {
    if (c.error) console.warn(`Skipped #${c.channel}: ${c.error}`);
  }
  console.log(
    `Game "${game.name}" night ${game.current_night_number}: scanned ${result.channels} ` +
      `channel(s), ${result.messages} message(s), inserted ${result.inserted} action(s).`,
  );
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error('Scrape failed:', err); process.exit(1); });
}
