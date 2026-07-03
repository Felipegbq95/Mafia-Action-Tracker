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
    .select('id, name, is_active, current_night_number')
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

export async function findPlayerByDiscordId(supabase, discordId) {
  const { data, error } = await supabase
    .from('players')
    .select('id, discord_id, display_name, aliases')
    .eq('discord_id', discordId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function insertSubmission(supabase, submission) {
  const { error } = await supabase.from('submissions').insert(submission);
  if (error && error.code !== '23505') {
    // 23505 = unique_violation on discord_message_id; a message that was
    // already recorded (e.g. reprocessed on bot restart) is not an error.
    throw error;
  }
}
