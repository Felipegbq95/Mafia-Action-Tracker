import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { parseMessage } from './parser.js';
import {
  createSupabase,
  getActiveGame,
  getRoster,
  findPlayerByDiscordId,
  insertSubmission,
} from './supabase.js';

const CHANNEL_ID = process.env.DISCORD_NIGHT_ACTIONS_CHANNEL_ID;
if (!CHANNEL_ID) {
  throw new Error('DISCORD_NIGHT_ACTIONS_CHANNEL_ID must be set');
}

const supabase = createSupabase();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}, watching channel ${CHANNEL_ID}`);
});

client.on('messageCreate', async (message) => {
  if (message.channelId !== CHANNEL_ID) return;
  if (message.author.bot) return;

  try {
    const game = await getActiveGame(supabase);
    if (!game) {
      console.warn('No active game found; ignoring message', message.id);
      return;
    }

    const [roster, submitter] = await Promise.all([
      getRoster(supabase, game.id),
      findPlayerByDiscordId(supabase, message.author.id),
    ]);

    const parsed = parseMessage(message.content, roster);

    for (const action of parsed) {
      await insertSubmission(supabase, {
        game_id: game.id,
        night_number: game.current_night_number,
        discord_message_id: message.id,
        discord_channel_id: message.channelId,
        submitter_player_id: submitter?.id ?? null,
        submitter_discord_id: message.author.id,
        raw_message: message.content,
        role_raw: action.role.raw,
        role_canonical: action.role.canonical,
        target_raw: action.target.raw,
        target_player_id: action.target.player?.id ?? null,
        target_match_score: action.target.score,
        needs_review: action.needsReview,
      });
    }
  } catch (err) {
    console.error('Failed to process night action message', message.id, err);
  }
});

client.login(process.env.DISCORD_TOKEN);
