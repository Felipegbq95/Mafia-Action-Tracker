// Night Action Tracker - "scrape" Edge Function, SINGLE-FILE build.
//
// This is the copy-paste version of supabase/functions/scrape/ for deploying
// through the Supabase dashboard's in-browser editor (no CLI needed):
//   Dashboard -> Edge Functions -> Deploy a new function -> via Editor,
//   name it exactly:  scrape
//   replace the editor's contents with this entire file -> Deploy.
// Then set DISCORD_TOKEN and DISCORD_GUILD_ID under Edge Functions -> Secrets.
//
// GENERATED from _shared/{cors,parser,discord,scraper-core}.js + scrape/index.ts
// by concatenation (imports removed, exports inlined). Regenerate after editing
// any of those files; do not hand-edit this one.

import { createClient } from 'npm:@supabase/supabase-js@2';

// ===== cors =====
// The dashboard on GitHub Pages calls this function from a different origin,
// so it needs CORS headers on every response, including the preflight OPTIONS
// request the browser sends first.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ===== parser =====
// Parses a Discord message's bolded text into an ability + target. The ability
// catalog and the player roster (with channels + aliases) are passed in - both
// come from the game's Supabase rows, so parsing is fully data-driven per game.
//
// Note: the ACTOR is NOT determined here. Actor attribution is by channel (the
// scraper knows which channel a message came from); this module only extracts
// "what ability, on whom" from the message text.

const SEPARATOR_RE = /^(.+?)\s*[:\-–—]\s*(.+)$/s;
const BOLD_RE = /\*\*(.+?)\*\*/gs;
const TARGET_MATCH_THRESHOLD = 0.72;

function normalize(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCompact(text) {
  return normalize(text).replace(/\s+/g, '');
}

function levenshtein(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist = Array.from({ length: rows }, (_, i) => [i, ...Array(cols - 1).fill(0)]);
  for (let j = 0; j < cols; j += 1) dist[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dist[i][j] = Math.min(dist[i - 1][j] + 1, dist[i][j - 1] + 1, dist[i - 1][j - 1] + cost);
    }
  }
  return dist[rows - 1][cols - 1];
}

function similarity(a, b) {
  if (!a.length && !b.length) return 1;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

// Maps every ability name/alias (normalized) to its ability object.
function buildAbilityIndex(abilities = []) {
  const map = new Map();
  for (const ability of abilities) {
    for (const key of [ability.name, ...(ability.aliases ?? [])]) {
      const nk = normalizeCompact(key);
      if (nk) map.set(nk, ability);
    }
  }
  return map;
}

// Resolves a phrase to an ability, trying the whole phrase then leading words
// (abilities are sometimes followed by the target or filler text).
function resolveAbility(phrase, index) {
  const trimmed = String(phrase).trim();
  const whole = normalizeCompact(trimmed);
  if (index.has(whole)) return { ability: index.get(whole), raw: trimmed, remainder: '' };

  const words = trimmed.split(/\s+/).filter(Boolean);
  for (let take = Math.min(3, words.length); take >= 1; take -= 1) {
    const candidate = normalizeCompact(words.slice(0, take).join(''));
    if (index.has(candidate)) {
      return {
        ability: index.get(candidate),
        raw: words.slice(0, take).join(' '),
        remainder: words.slice(take).join(' '),
      };
    }
  }
  return null;
}

/**
 * Fuzzy-matches a raw target string against the roster. Each player is matched
 * on display_name, channel_name, and aliases - so "joe" (an alias) resolves to
 * the player whose channel is "axatar".
 * players: [{ id, display_name, channel_name, aliases }]
 */
function matchPlayer(rawTarget, players = []) {
  const norm = normalizeCompact(rawTarget);
  if (!norm) return null;

  let best = null;
  let bestScore = 0;
  for (const player of players) {
    const candidates = [player.display_name, player.channel_name, ...(player.aliases ?? [])];
    for (const candidate of candidates) {
      const cn = normalizeCompact(candidate);
      if (!cn) continue;
      let score;
      if (cn === norm) score = 1;
      else if (norm.includes(cn) || cn.includes(norm)) {
        score = 0.85 + 0.15 * (Math.min(cn.length, norm.length) / Math.max(cn.length, norm.length));
      } else score = similarity(cn, norm);
      if (score > bestScore) { bestScore = score; best = player; }
    }
  }
  return best && bestScore >= TARGET_MATCH_THRESHOLD ? { player: best, score: bestScore } : null;
}

function splitAbilityAndTarget(span, index) {
  const trimmed = String(span).trim();

  const sep = trimmed.match(SEPARATOR_RE);
  if (sep) {
    const [, left, right] = sep;
    const resolved = resolveAbility(left, index);
    if (resolved) {
      const targetRaw = resolved.remainder ? `${resolved.remainder} ${right}`.trim() : right.trim();
      return { abilityRaw: left.trim(), ability: resolved.ability, targetRaw, hadSeparator: true };
    }
    return { abilityRaw: left.trim(), ability: null, targetRaw: right.trim(), hadSeparator: true };
  }

  const resolved = resolveAbility(trimmed, index);
  if (resolved) {
    return {
      abilityRaw: resolved.raw,
      ability: resolved.ability,
      targetRaw: resolved.remainder,
      hadSeparator: false,
    };
  }
  return { abilityRaw: null, ability: null, targetRaw: trimmed, hadSeparator: false };
}

/**
 * Extracts every **bold** span. A single bold block can carry several actions
 * on separate lines (e.g. the mafia channel posting the faction's whole night
 * in one bolded message), so each non-empty line inside a span becomes its own
 * candidate action. Falls back to the whole message (flagged) when nothing is
 * bolded, so a forgotten-bold action still surfaces rather than vanishing.
 */
function extractActionSpans(content) {
  const spans = [...String(content).matchAll(BOLD_RE)]
    .flatMap((m) => m[1].split(/\n+/))
    .map((s) => s.trim())
    .filter(Boolean);
  if (spans.length > 0) return { spans, fellBackToFullMessage: false };
  return { spans: [String(content)], fellBackToFullMessage: true };
}

/**
 * Parses a message into candidate actions.
 * players: [{ id, display_name, channel_name, aliases }]
 * abilities: [{ id, name, aliases, effect_text, computable_type, splash_text }]
 */
function parseMessage(content, players = [], abilities = []) {
  const index = buildAbilityIndex(abilities);
  const { spans, fellBackToFullMessage } = extractActionSpans(content);

  return spans.map((span) => {
    const { abilityRaw, ability, targetRaw, hadSeparator } = splitAbilityAndTarget(span, index);
    const targetMatch = targetRaw ? matchPlayer(targetRaw, players) : null;
    const looksLikeAction = Boolean(ability) || Boolean(targetMatch) || hadSeparator;

    return {
      raw: span,
      ability: { id: ability?.id ?? null, name: ability?.name ?? null, raw: abilityRaw },
      target: { raw: targetRaw || null, player: targetMatch?.player ?? null, score: targetMatch?.score ?? null },
      fromBold: !fellBackToFullMessage,
      hadSeparator,
      looksLikeAction,
      needsReview: fellBackToFullMessage || !ability || !targetMatch,
    };
  });
}

/**
 * Whether to persist a parsed action. Mixed-use channels carry chatter, so only
 * a bolded, action-shaped message counts (resolves an ability, matches a player,
 * or has a separator). Non-bolded chatter and stray emphasis are dropped.
 */
function isRecordableAction(action) {
  return action.fromBold && action.looksLikeAction;
}

// ===== discord REST =====
// Reads channel history over Discord's REST API. No Gateway/websocket, so
// nothing needs to run continuously - this is called on demand by the
// scraper. Still requires a *bot* token (created once in the Developer
// Portal); reading a channel with your own user account token is a
// self-bot, which is against Discord's ToS.
const API_BASE = 'https://discord.com/api/v10';
const PAGE_LIMIT = 100; // Discord's max per request.

function requireToken(token) {
  if (!token) throw new Error('DISCORD_TOKEN must be set');
}

function maxId(messages) {
  return messages.reduce(
    (max, m) => (BigInt(m.id) > BigInt(max) ? m.id : max),
    messages[0].id,
  );
}

function minId(messages) {
  return messages.reduce(
    (min, m) => (BigInt(m.id) < BigInt(min) ? m.id : min),
    messages[0].id,
  );
}

function bySnowflakeAsc(a, b) {
  return BigInt(a.id) < BigInt(b.id) ? -1 : 1;
}

const GUILD_TEXT = 0; // Discord channel type for a normal text channel.

/**
 * Lists the guild's text channels. Group/private channels are included as
 * long as the bot can see them (grant it Administrator on a per-game server
 * so it sees the private action channels). Returns { id, name }.
 */
async function listTextChannels(guildId, token = process.env.DISCORD_TOKEN) {
  requireToken(token);
  const url = new URL(`${API_BASE}/guilds/${guildId}/channels`);
  const res = await fetch(url, { headers: { Authorization: `Bot ${token}` } });
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after') ?? '1');
    await new Promise((resolve) => setTimeout(resolve, (retryAfter + 0.5) * 1000));
    return listTextChannels(guildId, token);
  }
  if (!res.ok) {
    throw new Error(`Discord API ${res.status}: ${await res.text()}`);
  }
  const channels = await res.json();
  return channels
    .filter((c) => c.type === GUILD_TEXT)
    .map((c) => ({ id: c.id, name: c.name }));
}

async function getPage(channelId, params, token) {
  const url = new URL(`${API_BASE}/channels/${channelId}/messages`);
  url.searchParams.set('limit', String(PAGE_LIMIT));
  for (const [key, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(key, value);
  }

  const res = await fetch(url, { headers: { Authorization: `Bot ${token}` } });

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after') ?? '1');
    await new Promise((resolve) => setTimeout(resolve, (retryAfter + 0.5) * 1000));
    return getPage(channelId, params, token);
  }
  if (!res.ok) {
    throw new Error(`Discord API ${res.status}: ${await res.text()}`);
  }
  return res.json(); // array, newest-first
}

/**
 * Fetches every message strictly newer than afterId, paging forward until
 * caught up. Returned oldest-first so submissions are processed in order.
 */
async function fetchMessagesAfter(channelId, afterId, token = process.env.DISCORD_TOKEN) {
  requireToken(token);
  const all = [];
  let cursor = afterId;
  for (;;) {
    const batch = await getPage(channelId, { after: cursor }, token);
    if (batch.length === 0) break;
    all.push(...batch);
    cursor = maxId(batch);
    if (batch.length < PAGE_LIMIT) break;
  }
  return all.sort(bySnowflakeAsc);
}

/**
 * Cold-start path (nothing recorded yet): pages backward from the most
 * recent message, collecting until it reaches messages older than
 * `notBefore` (the active game's start) or hits a safety cap, so it does
 * not scrape the channel's entire pre-game history. Returned oldest-first.
 */
async function fetchRecentSince(channelId, notBefore, token = process.env.DISCORD_TOKEN, cap = 1000) {
  requireToken(token);
  const all = [];
  let cursor; // `before` id; undefined means start from the newest message.
  while (all.length < cap) {
    const batch = await getPage(channelId, { before: cursor }, token);
    if (batch.length === 0) break;

    let reachedOlderThanGame = false;
    for (const message of batch) {
      if (notBefore && new Date(message.timestamp) < notBefore) {
        reachedOlderThanGame = true;
        break;
      }
      all.push(message);
    }
    if (reachedOlderThanGame || batch.length < PAGE_LIMIT) break;
    cursor = minId(batch);
  }
  return all.sort(bySnowflakeAsc);
}

// ===== scraper core =====
// Scraper logic shared between the Node cron script (src/scrape.js, runs via
// GitHub Actions) and the Supabase Edge Function
// (supabase/functions/scrape/index.js, runs on-demand from the dashboard
// button). Keep this file free of runtime-specific APIs - no `process`, no
// `Deno`, no `node:`/`npm:` imports - so it works unchanged in both. It is
// duplicated (not imported across) into supabase/functions/_shared/ because
// the two deploy pipelines don't share a module graph; keep the two copies in
// sync when editing.


const channelNorm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Finds the player a channel belongs to. A channel is a player's personal
 * channel if its name matches that player's channel_name, display_name, or any
 * alias (normalized, so "joe-smith" matches "Joe Smith"). Channels that match
 * nobody are group channels (mafia, duos) - this returns null for them and the
 * scraper leaves those actions' actor for the host to assign.
 */
function channelActor(channelName, players) {
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
function isIgnoredAuthor(author, mods = []) {
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

/**
 * Assigns a message timestamp to a night using the host-defined windows
 * (nights: [{ night_number, started_at, ends_at }]). Rules:
 *  - no windows defined (or no usable timestamp) -> fallback night, keep.
 *  - timestamp inside a window (ends_at null = still open) -> that night.
 *  - windows defined but timestamp outside all of them -> skip (day-phase
 *    chatter is not a night action).
 */
function nightForTimestamp(ts, nights = [], fallback = 1) {
  const windows = (nights ?? []).filter((n) => n.started_at);
  const t = ts ? new Date(ts).getTime() : NaN;
  if (windows.length === 0 || Number.isNaN(t)) return { night: fallback, skip: false };
  let best = null;
  for (const w of windows) {
    const start = new Date(w.started_at).getTime();
    const end = w.ends_at ? new Date(w.ends_at).getTime() : Infinity;
    if (t >= start && t <= end && (!best || start > best.start)) {
      best = { start, night: w.night_number };
    }
  }
  return best ? { night: best.night, skip: false } : { night: null, skip: true };
}

// Every recordable action in a message, in order. A single message can carry
// several bolded actions (e.g. the mafia channel posting the whole faction's
// night in one message) - each becomes its own row, keyed by span index.
function recordableActions(content, players, abilities) {
  return parseMessage(content, players, abilities).filter(isRecordableAction);
}

// Kept for compatibility; prefer recordableActions.
function firstAction(content, players, abilities) {
  return recordableActions(content, players, abilities)[0] ?? null;
}

/**
 * Pure mapping from fetched Discord messages to `actions` rows for one channel.
 * `actor` is the channel's owning player (null for shared channels). One row
 * per recordable bolded span (unique key: game + message id + span_index).
 */
function buildActionRows(messages, { game, channel, actor, players, abilities, mods = [], nights = [] }) {
  const rows = [];
  for (const message of messages) {
    if (isIgnoredAuthor(message.author, mods)) continue;
    const { night, skip } = nightForTimestamp(message.timestamp, nights, game.current_night_number);
    if (skip) continue;
    const actions = recordableActions(message.content, players, abilities);
    actions.forEach((action, spanIndex) => {
      rows.push({
        game_id: game.id,
        night_number: night,
        actor_player_id: actor?.id ?? null,
        ability_id: action.ability.id,
        target_player_id: action.target.player?.id ?? null,
        result: null,
        source: 'scraped',
        source_channel: channel.name,
        discord_message_id: message.id,
        span_index: spanIndex,
        posted_at: message.timestamp ?? null,
        raw_text: message.content,
        actor_raw: message.author?.global_name ?? message.author?.username ?? null,
        ability_raw: action.ability.raw,
        target_raw: action.target.raw,
        // A shared channel (no personal-channel owner) needs the host to assign
        // the actor, so it always needs review.
        needs_review: !actor || action.needsReview,
      });
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
async function scrapeGame({ discord, db, guildId, excludedChannels, game, players, abilities, mods = [], nights = [] }) {
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

      const rows = buildActionRows(messages, { game, channel, actor, players, abilities, mods, nights });
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

// ===== handler =====
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

  const [{ data: players, error: pErr }, { data: abilities, error: aErr }, { data: nights, error: nErr }] = await Promise.all([
    supabase.from('players').select('id, display_name, channel_name, aliases').eq('game_id', gameId),
    supabase.from('abilities').select('id, name, aliases, effect_text, computable_type, splash_text').eq('game_id', gameId),
    supabase.from('nights').select('night_number, started_at, ends_at').eq('game_id', gameId),
  ]);
  if (pErr) return json({ error: pErr.message }, 500);
  if (aErr) return json({ error: aErr.message }, 500);
  if (nErr) return json({ error: nErr.message }, 500);

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
      nights: nights ?? [],
    });
    return json({ ok: true, game: game.name, ...result });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
