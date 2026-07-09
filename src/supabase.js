import { createClient } from '@supabase/supabase-js';

export function createSupabase({ url, serviceRoleKey } = {}) {
  const resolvedUrl = url ?? process.env.SUPABASE_URL;
  const resolvedKey = serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!resolvedUrl || !resolvedKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  return createClient(resolvedUrl, resolvedKey, { auth: { persistSession: false } });
}

// The one game the scraper writes to: the most recent still-active game.
export async function getActiveGame(supabase) {
  const { data, error } = await supabase
    .from('games')
    .select('id, name, current_night_number, created_at, mod_accounts')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getPlayers(supabase, gameId) {
  const { data, error } = await supabase
    .from('players')
    .select('id, display_name, channel_name, aliases')
    .eq('game_id', gameId);
  if (error) throw error;
  return data ?? [];
}

export async function getAbilities(supabase, gameId) {
  const { data, error } = await supabase
    .from('abilities')
    .select('id, name, aliases, effect_text, computable_type, splash_text')
    .eq('game_id', gameId);
  if (error) throw error;
  return data ?? [];
}

// Highest Discord message id already recorded for a channel in this game - the
// forward-paging cursor so each scrape only fetches new messages.
export async function getLatestMessageId(supabase, gameId, channelName) {
  const { data, error } = await supabase
    .from('actions')
    .select('discord_message_id')
    .eq('game_id', gameId)
    .eq('source_channel', channelName)
    .not('discord_message_id', 'is', null);
  if (error) throw error;
  if (!data || data.length === 0) return null;
  return data.reduce(
    (max, row) => (BigInt(row.discord_message_id) > BigInt(max) ? row.discord_message_id : max),
    data[0].discord_message_id,
  );
}

export async function insertAction(supabase, action) {
  const { error } = await supabase.from('actions').insert(action);
  if (error && error.code !== '23505') {
    // 23505 = unique_violation on (game_id, discord_message_id); a message
    // already recorded on a previous scrape is expected, not an error.
    throw error;
  }
  return !error;
}
