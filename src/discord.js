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
export async function fetchMessagesAfter(channelId, afterId, token = process.env.DISCORD_TOKEN) {
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
export async function fetchRecentSince(channelId, notBefore, token = process.env.DISCORD_TOKEN, cap = 1000) {
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
