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
export function buildAbilityIndex(abilities = []) {
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
export function matchPlayer(rawTarget, players = []) {
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
 * Extracts every **bold** span. Falls back to the whole message (flagged) when
 * nothing is bolded, so a forgotten-bold action still surfaces rather than
 * vanishing.
 */
export function extractActionSpans(content) {
  const spans = [...String(content).matchAll(BOLD_RE)].map((m) => m[1]);
  if (spans.length > 0) return { spans, fellBackToFullMessage: false };
  return { spans: [String(content)], fellBackToFullMessage: true };
}

/**
 * Parses a message into candidate actions.
 * players: [{ id, display_name, channel_name, aliases }]
 * abilities: [{ id, name, aliases, effect_text, computable_type, splash_text }]
 */
export function parseMessage(content, players = [], abilities = []) {
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
export function isRecordableAction(action) {
  return action.fromBold && action.looksLikeAction;
}
