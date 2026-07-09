// Supabase Edge Function: on-demand scrape, triggered by the "Scrape now"
// button in the dashboard (via supabase.functions.invoke('scrape', { body:
// { game_id, pin } })). Runs server-side so the Discord bot token and the
// Supabase service role key never reach the browser - only the caller's PIN
// does, and this function verifies it before doing anything.
//
// Deploy (one-time): see GO-LIVE.md. Short version:
//   supabase functions deploy scrape
//   supabase secrets set DISCORD_TOKEN=... DISCORD_GUILD_ID=...
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected by the
// platform into every Edge Function; they do not need to be set manually.
//
// This file is plain JS (no TypeScript-specific syntax) so it stays in sync
// by inspection with src/scrape.js. The shared logic in ../_shared/ is a
// duplicate of the same files under src/ - see the note there.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { listTextChannels, fetchMessagesAfter, fetchRecentSince } from '../_shared/discord.js';
import { scrapeGame } from '../_shared/scraper-core.js';
import { corsHeaders } from '../_shared/cors.js';

const EXCLUDED_DEFAULT = 'general,dead-chat,dead,graveyard,spectators';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body: { game_id?: string; pin?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const gameId = body?.game_id;
  const pin = body?.pin;
  if (!gameId || !pin) return json({ error: 'game_id and pin are required' }, 400);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const DISCORD_TOKEN = Deno.env.get('DISCORD_TOKEN');
  const DISCORD_GUILD_ID = Deno.env.get('DISCORD_GUILD_ID');
  const excludedChannels = (Deno.env.get('DISCORD_EXCLUDE_CHANNELS') ?? EXCLUDED_DEFAULT)
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return json({ error: 'Server misconfigured: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing.' }, 500);
  }
  if (!DISCORD_TOKEN || !DISCORD_GUILD_ID) {
    return json({
      error: 'Server misconfigured: set DISCORD_TOKEN and DISCORD_GUILD_ID with '
        + '`supabase secrets set DISCORD_TOKEN=... DISCORD_GUILD_ID=...`.',
    }, 500);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: game, error: gameErr } = await supabase
    .from('games')
    .select('id, name, status, current_night_number, created_at, mod_accounts')
    .eq('id', gameId)
    .maybeSingle();
  if (gameErr) return json({ error: gameErr.message }, 500);
  if (!game) return json({ error: 'Game not found' }, 404);
  if (game.status !== 'active') return json({ error: 'Game is archived and cannot be scraped' }, 400);

  const { data: pinOk, error: pinErr } = await supabase.rpc('verify_game_pin', { p_game_id: gameId, p_pin: pin });
  if (pinErr) return json({ error: pinErr.message }, 500);
  if (!pinOk) return json({ error: 'Invalid PIN' }, 403);

  const [{ data: players, error: pErr }, { data: abilities, error: aErr }] = await Promise.all([
    supabase.from('players').select('id, display_name, channel_name, aliases').eq('game_id', gameId),
    supabase.from('abilities').select('id, name, aliases, effect_text, computable_type, splash_text').eq('game_id', gameId),
  ]);
  if (pErr) return json({ error: pErr.message }, 500);
  if (aErr) return json({ error: aErr.message }, 500);

  async function getLatestMessageId(gid: string, channelName: string) {
    const { data, error } = await supabase
      .from('actions')
      .select('discord_message_id')
      .eq('game_id', gid)
      .eq('source_channel', channelName)
      .not('discord_message_id', 'is', null);
    if (error) throw error;
    if (!data || data.length === 0) return null;
    return data.reduce(
      (max: string, row: { discord_message_id: string }) =>
        (BigInt(row.discord_message_id) > BigInt(max) ? row.discord_message_id : max),
      data[0].discord_message_id,
    );
  }

  async function insertAction(row: Record<string, unknown>) {
    const { error } = await supabase.from('actions').insert(row);
    if (error && error.code !== '23505') throw error;
    return !error;
  }

  try {
    const result = await scrapeGame({
      discord: {
        listTextChannels: (guildId: string) => listTextChannels(guildId, DISCORD_TOKEN),
        fetchMessagesAfter: (channelId: string, afterId: string) =>
          fetchMessagesAfter(channelId, afterId, DISCORD_TOKEN),
        fetchRecentSince: (channelId: string, notBefore: Date) =>
          fetchRecentSince(channelId, notBefore, DISCORD_TOKEN),
      },
      db: { getLatestMessageId, insertAction },
      guildId: DISCORD_GUILD_ID,
      excludedChannels,
      game,
      players: players ?? [],
      abilities: abilities ?? [],
      mods: game.mod_accounts ?? [],
    });
    return json({ ok: true, game: game.name, ...result });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
