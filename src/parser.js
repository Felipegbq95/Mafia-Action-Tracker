import { ALIAS_TO_ROLE } from './roleAliases.js';

const SEPARATOR_RE = /^(.+?)\s*[:\-–—]\s*(.+)$/s;
const BOLD_RE = /\*\*(.+?)\*\*/gs;

function normalize(text) {
  return text
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
      dist[i][j] = Math.min(
        dist[i - 1][j] + 1,
        dist[i][j - 1] + 1,
        dist[i - 1][j - 1] + cost,
      );
    }
  }
  return dist[rows - 1][cols - 1];
}

function similarity(a, b) {
  if (!a.length && !b.length) return 1;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

/**
 * Resolves a role/ability phrase to a canonical role name.
 * Tries the whole phrase first (covers multi-word aliases later),
 * then falls back to just the leading word(s), since "role" phrases
 * are sometimes followed by extra text (e.g. an ability name plus filler).
 */
function resolveRole(phrase) {
  const trimmed = phrase.trim();
  const wholeCompact = normalizeCompact(trimmed);
  if (ALIAS_TO_ROLE[wholeCompact]) {
    return { canonical: ALIAS_TO_ROLE[wholeCompact], raw: trimmed, remainder: '' };
  }

  const originalWords = trimmed.split(/\s+/).filter(Boolean);
  for (let take = Math.min(3, originalWords.length); take >= 1; take -= 1) {
    const candidate = normalizeCompact(originalWords.slice(0, take).join(''));
    if (ALIAS_TO_ROLE[candidate]) {
      return {
        canonical: ALIAS_TO_ROLE[candidate],
        raw: originalWords.slice(0, take).join(' '),
        remainder: originalWords.slice(take).join(' '),
      };
    }
  }
  return null;
}

const TARGET_MATCH_THRESHOLD = 0.72;

/**
 * Fuzzy-matches a raw target string against a player roster.
 * roster entries: { id, displayName, aliases?: string[] }
 */
export function matchPlayer(rawTarget, roster = []) {
  const norm = normalizeCompact(rawTarget);
  if (!norm) return null;

  let best = null;
  let bestScore = 0;
  for (const player of roster) {
    const candidates = [player.displayName, ...(player.aliases ?? [])];
    for (const candidate of candidates) {
      const candNorm = normalizeCompact(candidate);
      if (!candNorm) continue;

      let score;
      if (candNorm === norm) {
        score = 1;
      } else if (norm.includes(candNorm) || candNorm.includes(norm)) {
        score = 0.85 + 0.15 * (Math.min(candNorm.length, norm.length) / Math.max(candNorm.length, norm.length));
      } else {
        score = similarity(candNorm, norm);
      }

      if (score > bestScore) {
        bestScore = score;
        best = player;
      }
    }
  }

  if (best && bestScore >= TARGET_MATCH_THRESHOLD) {
    return { player: best, score: bestScore };
  }
  return null;
}

/**
 * Parses a single "action span" of text (the bolded submission, or the
 * whole message as a fallback) into a role phrase and a target phrase.
 * Handles both "Role: Target" (any of : - -- as separator) and
 * "ability target" with no separator at all (e.g. "investigate Axatar").
 */
function splitRoleAndTarget(spanText) {
  const trimmed = spanText.trim();

  const sepMatch = trimmed.match(SEPARATOR_RE);
  if (sepMatch) {
    const [, rolePhrase, targetPhrase] = sepMatch;
    const roleResolved = resolveRole(rolePhrase);
    if (roleResolved) {
      const targetRaw = roleResolved.remainder
        ? `${roleResolved.remainder} ${targetPhrase}`.trim()
        : targetPhrase.trim();
      return { roleRaw: rolePhrase.trim(), roleCanonical: roleResolved.canonical, targetRaw };
    }
    // Separator present but the left side isn't a known role/ability -
    // still report it, just unresolved, so it surfaces for manual review
    // instead of disappearing.
    return { roleRaw: rolePhrase.trim(), roleCanonical: null, targetRaw: targetPhrase.trim() };
  }

  const roleResolved = resolveRole(trimmed);
  if (roleResolved) {
    return {
      roleRaw: roleResolved.raw,
      roleCanonical: roleResolved.canonical,
      targetRaw: roleResolved.remainder,
    };
  }

  return { roleRaw: null, roleCanonical: null, targetRaw: trimmed };
}

/**
 * Extracts every **bold** span from a Discord message. Falls back to the
 * full message text (flagged low-confidence) if nothing is bolded, so a
 * player who forgets to bold their action still shows up for review
 * rather than being silently dropped.
 */
export function extractActionSpans(content) {
  const spans = [...content.matchAll(BOLD_RE)].map((m) => m[1]);
  if (spans.length > 0) return { spans, fellBackToFullMessage: false };
  return { spans: [content], fellBackToFullMessage: true };
}

/**
 * Parses a raw Discord message into one or more candidate submissions.
 * roster: array of { id, displayName, aliases? } used for fuzzy target matching.
 */
export function parseMessage(content, roster = []) {
  const { spans, fellBackToFullMessage } = extractActionSpans(content);

  return spans.map((span) => {
    const { roleRaw, roleCanonical, targetRaw } = splitRoleAndTarget(span);
    const targetMatch = targetRaw ? matchPlayer(targetRaw, roster) : null;

    return {
      raw: span,
      role: { raw: roleRaw, canonical: roleCanonical },
      target: {
        raw: targetRaw || null,
        player: targetMatch?.player ?? null,
        score: targetMatch?.score ?? null,
      },
      needsReview: fellBackToFullMessage || !roleCanonical || !targetMatch,
    };
  });
}
