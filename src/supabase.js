import { createClient } from '@supabase/supabase-js';

export function createSupabase({ url, serviceRoleKey } = {}) {
  const resolvedUrl = url ?? process.env.SUPABASE_URL;
  const resolvedKey = serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!resolvedUrl || !resolvedKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  return createClient(resolvedUrl, resolvedKey, { auth: { persistSession: false } });
}

export async function getActiveGame(supabase) {
  const { data, error } = await supabase
    .from('games')
    .select('id, name, is_active, current_night_number, created_at')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getRoster(supabase, gameId) {
  const { data, error } = await supabase
    .from('game_players')
    .select('players(id, discord_id, display_name, aliases)')
    .eq('game_id', gameId);
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.players.id,
    discordId: row.players.discord_id,
    displayName: row.players.display_name,
    aliases: row.players.aliases ?? [],
  }));
}

/**
 * Highest Discord message id already recorded for this channel, used as the
 * forward-paging cursor so each scrape only fetches new messages. Returns
 * null on a cold start (nothing recorded yet). Snowflake ids sort by time,
 * so the max id is the most recently processed message.
 */
export async function getLatestMessageId(supabase, channelId) {
  const { data, error } = await supabase
    .from('submissions')
    .select('discord_message_id')
    .eq('discord_channel_id', channelId);
  if (error) throw error;
  if (!data || data.length === 0) return null;
  return data.reduce(
    (max, row) => (BigInt(row.discord_message_id) > BigInt(max) ? row.discord_message_id : max),
    data[0].discord_message_id,
  );
}

export async function insertSubmission(supabase, submission) {
  const { error } = await supabase.from('submissions').insert(submission);
  if (error && error.code !== '23505') {
    // 23505 = unique_violation on discord_message_id; a message already
    // recorded on a previous scrape run is expected, not an error.
    throw error;
  }
  return !error; // false when the row was a duplicate we skipped
}
