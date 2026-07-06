// Starting guess at role/ability aliases, built before seeing any real
// night-phase messages. Mafia rulesets vary a lot between games, so treat
// this as a first draft to edit once real submissions come in (or move to
// a Supabase table if per-game customization turns out to matter) rather
// than a finished mapping.
export const ROLE_ALIASES = {
  cop: ['cop', 'investigator', 'investigate', 'check', 'inspect'],
  doctor: ['doctor', 'doc', 'protect', 'save', 'heal'],
  mafia: ['mafia', 'godfather', 'kill', 'murder', 'hit'],
  roleblocker: ['roleblocker', 'escort', 'consort', 'block', 'distract'],
  vigilante: ['vigilante', 'vig', 'shoot'],
  bodyguard: ['bodyguard', 'bg', 'guard'],
  jailkeeper: ['jailkeeper', 'jailor', 'jail', 'roleblock'],
};

// Reverse index: normalized alias -> canonical role name.
export const ALIAS_TO_ROLE = Object.entries(ROLE_ALIASES).reduce(
  (acc, [role, aliases]) => {
    for (const alias of aliases) {
      acc[alias.toLowerCase()] = role;
    }
    return acc;
  },
  {},
);
