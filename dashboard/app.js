import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js?v=20260713k';
import { parseMessage, isRecordableAction } from './parser.js?v=20260713k';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';

// Auto-parsable computable types get a fixed color, used to color-code the
// Sheet tab's Action/Target cells: kill = purple, roleblock/redirect =
// yellow (paired, like the board's roleblock-or-redirect X marker), save =
// green. Types with no agreed color stay neutral (no accent applied).
const CT_COLOR = {
  kill: '#a855f7', save: '#4caf7d', track: '#6b6f8c', watch: '#6b6f8c',
  redirect: '#eab308', roleblock: '#eab308', none: '#6b6f8c',
};
const CT_LABEL = {
  kill: 'Kill', save: 'Save', track: 'Track', watch: 'Watch',
  redirect: 'Redirect', roleblock: 'Roleblock', none: 'Other',
};
const COMPUTABLE_TYPES = ['none', 'kill', 'save', 'track', 'watch', 'redirect', 'roleblock'];
const UNRESOLVED_COLOR = '#6b6f8c';
// Distinct stable hues (golden-angle walk) for players and abilities.
const hueColor = (i, sat = 70, lig = 62) => `hsl(${Math.round(i * 137.508) % 360} ${sat}% ${lig}%)`;
const abilityColor = (abilityId) => {
  if (!abilityId) return UNRESOLVED_COLOR;
  const i = abilities().findIndex((ab) => ab.id === abilityId);
  return i < 0 ? UNRESOLVED_COLOR : hueColor(i);
};
const playerColor = (playerId) => {
  const i = players().findIndex((p) => p.id === playerId);
  return i < 0 ? '#3a3e5c' : hueColor(i, 60, 66);
};

// Alignment coloring. When the host tags players with a faction, the board
// colors nodes and arrows by the ACTOR's alignment instead of by ability:
// mafia = tints of red/purple, town = tints of green/blue, third party =
// yellow. Players sharing an alignment get spread across their family's hue
// range so they stay individually distinguishable.
const ALIGN_LABEL = { mafia: 'Mafia', town: 'Town', third: '3rd party' };
const ALIGN_ORDER = ['mafia', 'town', 'third'];
// Sheet tab grouping order: town first, then mafia, then 3rd party.
const SHEET_ALIGN_ORDER = ['town', 'mafia', 'third'];
const ALIGN_HUE = { mafia: [357, 272], town: [96, 218], third: [34, 66] };
// Lightness/saturation alternate across each family alongside hue, so
// neighbors stay visually distinct even where the hue step alone is small -
// this matters most for 3rd party, whose whole family has to stay "yellow"
// and so can't spread hue very far without drifting into orange/green.
const ALIGN_LIG = [64, 46, 74, 38];
const ALIGN_SAT = [75, 55, 88, 62];
const alignmentOn = () => players().some((p) => p.alignment);
function alignmentColor(playerId) {
  const p = players().find((x) => x.id === playerId);
  const range = p?.alignment && ALIGN_HUE[p.alignment];
  if (!range) return null;
  const group = players().filter((x) => x.alignment === p.alignment);
  const idx = Math.max(0, group.findIndex((x) => x.id === playerId));
  const t = group.length > 1 ? idx / (group.length - 1) : 0.5;
  const hue = Math.round(range[0] + (range[1] - range[0]) * t);
  const lig = ALIGN_LIG[idx % ALIGN_LIG.length];
  const sat = ALIGN_SAT[idx % ALIGN_SAT.length];
  return `hsl(${hue} ${sat}% ${lig}%)`;
}
const alignKeyColor = (al) => `hsl(${Math.round((ALIGN_HUE[al][0] + ALIGN_HUE[al][1]) / 2)} 72% 62%)`;
// Node color: alignment when tagged, else the per-player hue.
const nodeColor = (playerId) => (alignmentOn()
  ? (alignmentColor(playerId) ?? '#3a3e5c') : playerColor(playerId));
// Arrow color: the actor's alignment when tagging is in use, else the ability
// hue (so the ability legend stays meaningful when no alignments are set).
const edgeColor = (a) => (alignmentOn()
  ? (alignmentColor(a.actor_player_id) ?? UNRESOLVED_COLOR) : abilityColor(a.ability_id));
// A blocked/redirected action gets an X on its arrow. Opt-in on the host's
// result text so it stays zero-noise until a result is actually recorded.
const isBlockedResult = (a) => /block|redirect/i.test(a.result ?? '');

if (SUPABASE_URL.includes('YOUR-PROJECT') || SUPABASE_ANON_KEY.includes('YOUR-ANON-KEY')) {
  $('status').textContent = 'Not configured - set dashboard/config.js.';
  throw new Error('config.js placeholder');
}
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const state = {
  games: [], gameId: null, pin: null, data: null, readOnly: false,
  night: 1, tab: 'board', selectedActionId: null, hoverPlayerId: null, error: '',
  // legend multi-select: ability ids ('' = unresolved) isolated on the board
  abilitySel: new Set(),
  // day-start timestamps posted up by the embedded vote counter (Votes app),
  // used to offer auto-filling night windows; see the message listener below.
  dayStarts: [],
  // 'tracker' (Board/Sheet/Actions/Players/Abilities/Settings) or 'votes' -
  // two separate apps sharing one game/PIN, not sub-tabs of one app.
  section: 'tracker',
};

// ---- dom helpers ----------------------------------------------------------
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }
  return e;
}
function svgEl(name, attrs = {}) {
  const n = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  return n;
}
function selectEl(options, value, onChange, opts = {}) {
  const s = h('select', { onchange: (e) => onChange(e.target.value), disabled: opts.disabled });
  if (opts.placeholder != null) s.appendChild(h('option', { value: '' }, opts.placeholder));
  for (const o of options) {
    const opt = h('option', { value: o.value }, o.label);
    if (String(o.value) === String(value ?? '')) opt.selected = true;
    s.appendChild(opt);
  }
  return s;
}

// ---- data layer -----------------------------------------------------------
async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data;
}
async function loadGames() { state.games = await rpc('list_games'); }
async function refresh() {
  state.data = state.readOnly
    ? await rpc('public_game_data', { p_game_id: state.gameId })
    : await rpc('game_data', { p_game_id: state.gameId, p_pin: state.pin });
  const nights = nightNumbers();
  if (!nights.includes(state.night)) state.night = nights[nights.length - 1] ?? state.data.game.current_night_number ?? 1;
}
async function openGame(gameId, pin) {
  state.gameId = gameId; state.pin = pin; state.readOnly = false;
  state.abilitySel = new Set(); state.dayStarts = []; state.section = 'tracker';
  $('scrape-status').hidden = true;
  await refresh(); render();
}
async function openPublic(gameId) {
  state.gameId = gameId; state.pin = null; state.readOnly = true;
  state.abilitySel = new Set(); state.dayStarts = []; state.section = 'tracker';
  $('scrape-status').hidden = true;
  await refresh(); render();
}
// wrap a mutation: run, refresh, re-render; surface errors
async function mutate(fn) {
  try { await fn(); await refresh(); state.error = ''; }
  catch (e) { state.error = e.message || String(e); }
  render();
}

// ---- helpers on current data ----------------------------------------------
const players = () => state.data?.players ?? [];

// Does the parsed alive roster (short in-game names) contain this player?
// Matches the roster name against the player's display name AND aliases with
// the same bidirectional prefix test the Votes app uses to line up forum
// usernames with roster names, so the two apps agree on who's alive.
function rosterHasPlayer(roster, p) {
  const cands = [p.display_name, ...(p.aliases ?? [])]
    .map((s) => (s ?? '').trim().toLowerCase())
    .filter(Boolean);
  return roster.some((rn) => {
    const r = (rn ?? '').trim().toLowerCase();
    if (!r) return false;
    return cands.some((c) => c === r || c.startsWith(r) || r.startsWith(c));
  });
}

// The alive roster in effect for a given night. The Votes app saves the
// maintained top-of-thread alive list to the night the print is current at;
// since players don't revive, it applies to that night and every night after,
// until a newer print overrides from a later night. So the roster for night n
// is the one saved at the greatest night <= n (forward-fill). Empty = no
// print parsed yet at or before this night -> nobody auto-hidden.
const nightRoster = (n = state.night) => {
  let best = null;
  for (const x of nights()) {
    if ((x.alive_names?.length ?? 0) && x.night_number <= n
      && (!best || x.night_number > best.night_number)) best = x;
  }
  return best ? best.alive_names : [];
};

// A player is dead (for a given night) when their manual override says so, or -
// with no override - when that night has a saved roster and they aren't on it.
// No override and no roster for the night => everyone reads alive.
function isPlayerDead(p, n = state.night) {
  if (p.life_override === 'dead') return true;
  if (p.life_override === 'alive') return false;
  const roster = nightRoster(n);
  if (!roster.length) return false;
  return !rosterHasPlayer(roster, p);
}
const alivePlayers = (n = state.night) => players().filter((p) => !isPlayerDead(p, n));
const abilities = () => state.data?.abilities ?? [];
const actions = () => state.data?.actions ?? [];
const nightActions = () => actions().filter((a) => a.night_number === state.night);
function nightNumbers() {
  const ns = new Set(actions().map((a) => a.night_number));
  for (const n of nights()) ns.add(n.night_number);
  ns.add(state.data?.game?.current_night_number ?? 1);
  return [...ns].sort((a, b) => a - b);
}
const nights = () => state.data?.nights ?? [];
const playerName = (id) => players().find((p) => p.id === id)?.display_name;
const nightNotes = () => state.data?.night_notes ?? [];
const nightNoteFor = (playerId) =>
  nightNotes().find((n) => n.night_number === state.night && n.player_id === playerId)?.note ?? '';

// ---- render root ----------------------------------------------------------
function render() {
  const inGame = !!state.data;
  $('landing').hidden = inGame;
  $('game').hidden = !inGame;
  $('status').textContent = state.error ? `Error: ${state.error}` : '';
  $('status').className = state.error ? 'status needs-review' : 'status';
  if (inGame) renderGame(); else renderLanding();
}

// ---- landing --------------------------------------------------------------
function renderLanding() {
  const list = $('game-list');
  list.innerHTML = '';
  if (state.games.length === 0) list.appendChild(h('p', { class: 'muted' }, 'No games yet. Create one below.'));
  for (const g of state.games) {
    const row = h('div', { class: 'game-row' },
      h('div', {},
        h('span', { class: 'game-title' }, g.name),
        h('span', { class: `pill ${g.status}` }, g.status)),
    );
    if (g.status === 'archived') {
      row.appendChild(h('button', { class: 'ghost', onclick: () => openPublic(g.id).catch(showErr) }, 'View'));
    } else {
      const pin = h('input', { type: 'password', placeholder: 'PIN', autocomplete: 'off' });
      const open = h('button', { class: 'primary',
        onclick: () => openGame(g.id, pin.value.trim()).catch(() => { state.error = 'Wrong PIN.'; render(); }) }, 'Open');
      pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') open.click(); });
      row.appendChild(h('div', { class: 'open-row' }, pin, open));
    }
    list.appendChild(row);
  }
  $('landing-error').textContent = state.error;
}
function showErr(e) { state.error = e.message || String(e); render(); }

async function createGame() {
  const name = $('new-name').value.trim();
  const pin = $('new-pin').value.trim();
  state.error = '';
  if (pin.length < 6) { state.error = 'PIN must be at least 6 characters.'; render(); return; }
  try {
    const id = await rpc('create_game', { p_name: name || 'Untitled game', p_pin: pin });
    await loadGames();
    await openGame(id, pin);
  } catch (e) { showErr(e); }
}

// ---- game shell -----------------------------------------------------------
// Two apps share one game/PIN: the night Tracker (Board/Sheet/Actions/
// Players/Abilities/Settings, all keyed by night number) and the Votes app
// (the ported vote counter, keyed by day - see renderVotes). The switcher
// below picks between them; each keeps its own furniture (night selector +
// sub-tabs for the tracker, nothing but its own iframe for votes) rather
// than living inside a shared tab row, so they read as separate apps.
const SECTIONS = [
  { id: 'tracker', label: 'Night Tracker' },
  { id: 'votes', label: 'Vote Counter' },
];

function renderGame() {
  const g = state.data.game;
  $('game-name').textContent = g.name;
  $('ro-badge').hidden = !state.readOnly;
  $('finish-btn').hidden = state.readOnly;

  const switcher = $('app-switcher'); switcher.innerHTML = '';
  for (const s of SECTIONS) {
    switcher.appendChild(h('button', { class: 'app-switch' + (state.section === s.id ? ' active' : ''),
      onclick: () => { state.section = s.id; render(); } }, s.label));
  }

  const inTracker = state.section === 'tracker';
  $('scrape-btn').hidden = state.readOnly || !inTracker;
  $('night-tabs').hidden = !inTracker;
  $('tabs').hidden = !inTracker;
  // Transient scrape/re-match status: force-hidden while away from the
  // tracker; left alone (not resurrected) on return, same as any toast
  // naturally going stale once you've navigated elsewhere.
  if (!inTracker) $('scrape-status').hidden = true;

  const panel = $('panel'); panel.innerHTML = '';
  if (!inTracker) {
    panel.appendChild(renderVotes());
    updateVotesPreview();
    return;
  }

  const nt = $('night-tabs'); nt.innerHTML = '';
  for (const n of nightNumbers()) {
    nt.appendChild(h('button', { class: 'night-tab' + (n === state.night ? ' active' : ''),
      onclick: () => { state.night = n; state.selectedActionId = null; render(); } }, `Night ${n}`));
  }
  if (!state.readOnly) {
    nt.appendChild(h('button', { class: 'night-tab add', title: 'Add night',
      onclick: () => mutate(() => rpc('set_current_night',
        { p_game_id: state.gameId, p_pin: state.pin, p_night: Math.max(...nightNumbers()) + 1 })
        .then(() => { state.night = Math.max(...nightNumbers()) + 1; })) }, '+'));
  }

  const tabs = state.readOnly
    ? ['board', 'sheet']
    : ['board', 'sheet', 'actions', 'players', 'abilities', 'settings'];
  if (!tabs.includes(state.tab)) state.tab = 'board';
  const nav = $('tabs'); nav.innerHTML = '';
  for (const t of tabs) {
    nav.appendChild(h('button', { class: 'tab' + (state.tab === t ? ' active' : ''),
      onclick: () => { state.tab = t; render(); } }, t[0].toUpperCase() + t.slice(1)));
  }

  if (state.tab === 'board') panel.appendChild(renderBoard());
  else if (state.tab === 'sheet') panel.appendChild(renderSheet());
  else if (state.tab === 'actions') panel.appendChild(renderActionsEditor());
  else if (state.tab === 'players') panel.appendChild(renderPlayersEditor());
  else if (state.tab === 'abilities') panel.appendChild(renderAbilitiesEditor());
  else if (state.tab === 'settings') panel.appendChild(renderSettings());
}

// ---- settings tab ---------------------------------------------------------
function renderSettings() {
  const wrap = h('div', { class: 'stack' });
  const g = state.data.game;

  const box = h('div', { class: 'editor' });
  box.appendChild(h('h3', {}, 'Mod accounts to ignore'));
  box.appendChild(h('p', { class: 'muted small' },
    'Up to 5. Messages from these accounts are skipped entirely when scraping - '
    + 'use this for mods who post bolded results into player channels. '
    + 'One per line: a Discord username, display name, or user id.'));
  const ta = h('textarea', { rows: '5', placeholder: 'ModMike\nAnotherMod' });
  ta.value = (g.mod_accounts ?? []).join('\n');
  box.appendChild(ta);
  const status = h('span', { class: 'muted small' });
  box.appendChild(h('div', { style: 'display:flex;gap:10px;align-items:center;margin-top:10px' },
    h('button', { class: 'primary', onclick: async () => {
      const accounts = ta.value.split('\n').map((s) => s.trim()).filter(Boolean);
      status.textContent = 'Saving...';
      try {
        await rpc('set_mod_accounts', { p_game_id: state.gameId, p_pin: state.pin, p_accounts: accounts });
        await refresh();
        state.error = '';
        render();
      } catch (e) { state.error = e.message || String(e); render(); }
    } }, 'Save mods'),
    status));
  wrap.appendChild(box);
  wrap.appendChild(renderNightWindows());
  return wrap;
}

// Night time windows: when each night started/ended, in YOUR local time.
// The scraper uses these to put every action in the right night from its
// Discord timestamp, and to skip messages sent outside any night (day talk).
function renderNightWindows() {
  const box = h('div', { class: 'editor' });
  box.appendChild(h('h3', {}, 'Night times'));
  box.appendChild(h('p', { class: 'muted small' },
    'When each night started and ended (your local time). Actions are assigned '
    + 'to nights by when the message was posted; messages outside every window '
    + 'are ignored as day talk. Leave the end empty while a night is ongoing. '
    + 'After changing these, run a scrape and Re-match.'));
  const toLocal = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const byNum = new Map(nights().map((n) => [n.night_number, n]));
  for (const num of nightNumbers()) {
    const rec = byNum.get(num) ?? { night_number: num, started_at: null, ends_at: null };
    const start = h('input', { type: 'datetime-local', value: toLocal(rec.started_at) });
    const end = h('input', { type: 'datetime-local', value: toLocal(rec.ends_at) });
    const save = () => mutate(() => rpc('upsert_night', {
      p_game_id: state.gameId, p_pin: state.pin, p_night: num,
      p_started_at: start.value ? new Date(start.value).toISOString() : null,
      p_ends_at: end.value ? new Date(end.value).toISOString() : null,
    }));
    box.appendChild(h('div', { class: 'night-row' },
      h('b', {}, `Night ${num}`),
      field('Started', start), field('Ended', end),
      h('button', { class: 'ghost small', onclick: save }, 'Save')));
  }
  return box;
}

// ---- votes tab --------------------------------------------------------------
// The vote counter (dashboard/votes/) is a separate, self-contained, static
// app - ported in unchanged and run in its own iframe rather than merged
// into this file, so its behavior stays exactly what it was standalone (and
// its own test suite keeps covering it). The one addition on its side is a
// postMessage of the day-start timestamps it already detects from the
// pasted forum print; this listens for that and offers to turn them into
// night windows. Night N's window is [Day N's timestamp, Day N+1's
// timestamp) - Discord's private night channels never see day-phase
// content, so that span is safe to use even though it also covers day N's
// daytime hours.
function deriveNightWindows(dayStarts) {
  const byDay = new Map();
  for (const d of dayStarts ?? []) {
    if (!byDay.has(d.day)) byDay.set(d.day, d); // keep the first occurrence
  }
  const days = [...byDay.values()].sort((a, b) => a.day - b.day);
  const windows = [];
  for (let i = 0; i < days.length; i += 1) {
    const startMs = new Date(days[i].timestamp).getTime();
    if (Number.isNaN(startMs)) continue; // unparseable timestamp - skip rather than guess
    const next = days[i + 1];
    const endMs = next ? new Date(next.timestamp).getTime() : null;
    windows.push({
      night_number: days[i].day,
      started_at: new Date(startMs).toISOString(),
      ends_at: endMs != null && !Number.isNaN(endMs) ? new Date(endMs).toISOString() : null,
    });
  }
  return windows;
}

// The preview box is updated in place (see updateVotesPreview below) rather
// than through the normal render() rebuild-everything pipeline, because the
// vote counter posts an update on every "Count Votes" click - if that
// triggered a full render(), it would recreate the iframe each time and
// reload the vote counter out from under the host's pasted-in thread.
function renderVotes() {
  const wrap = h('div', { class: 'stack' });
  const iframe = h('iframe', { class: 'votes-frame', src: 'votes/index.html', title: 'Vote counter' });
  // No card/border around it and no fixed height with its own scrollbar -
  // same-origin (it's served from this same site, just a subfolder), so the
  // height can track its real content and the page scrolls naturally, same
  // as visiting the standalone app directly instead of it feeling embedded.
  const syncHeight = () => {
    const doc = iframe.contentDocument;
    if (doc?.documentElement) iframe.style.height = `${doc.documentElement.scrollHeight}px`;
  };
  iframe.addEventListener('load', () => {
    syncHeight();
    new iframe.contentWindow.ResizeObserver(syncHeight).observe(iframe.contentDocument.documentElement);
  });
  wrap.appendChild(iframe);
  wrap.appendChild(h('div', { class: 'editor', id: 'votes-night-preview', hidden: true }));
  return wrap;
}

function updateVotesPreview() {
  const box = document.getElementById('votes-night-preview');
  if (!box) return; // Votes tab isn't mounted right now
  box.innerHTML = '';
  const windows = deriveNightWindows(state.dayStarts);
  if (!windows.length) { box.hidden = true; return; }
  box.hidden = false;
  box.appendChild(h('h3', {}, 'Night windows detected from the print'));
  box.appendChild(h('p', { class: 'muted small' },
    'From the "Day N Start" posts in what you pasted above (read in your browser\'s local '
    + 'timezone). Saving overwrites any existing windows for these nights.'));
  for (const w of windows) {
    const start = new Date(w.started_at).toLocaleString();
    const end = w.ends_at ? new Date(w.ends_at).toLocaleString() : 'ongoing';
    box.appendChild(h('div', { class: 'detail-row' }, h('b', {}, `Night ${w.night_number}`), `: ${start} -> ${end}`));
  }
  if (!state.readOnly) {
    box.appendChild(h('button', { class: 'primary', style: 'margin-top:10px', onclick: () => mutate(async () => {
      for (const w of windows) {
        await rpc('upsert_night', {
          p_game_id: state.gameId, p_pin: state.pin, p_night: w.night_number,
          p_started_at: w.started_at, p_ends_at: w.ends_at,
        });
      }
      state.dayStarts = [];
    }) }, `Save ${windows.length} night window${windows.length === 1 ? '' : 's'}`));
  }
}

// ---- board (graph + side) -------------------------------------------------
function renderBoard() {
  const wrap = h('div', { class: 'web-view' });
  wrap.appendChild(renderLegend());
  const graphWrap = h('div', { class: 'graph-wrap' });
  graphWrap.appendChild(drawGraph());
  graphWrap.appendChild(h('div', { class: 'graph-tip' }));
  wrap.appendChild(graphWrap);
  wrap.appendChild(renderSide());
  return wrap;
}

function drawGraph() {
  // Dead players drop off the ring entirely; actions to/from them then fall
  // out of `drawable` below via the idIndex.has() guard, so nothing dangles.
  const roster = alivePlayers();
  const na = nightActions();
  const idIndex = new Map(roster.map((p, i) => [p.id, i]));
  const W = 1400, H = 1000, cx = W / 2, cy = H / 2, nodeR = 13;
  const R = Math.min(440, 220 + roster.length * 12);
  const pts = roster.map((_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, roster.length);
    return { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a), a };
  });
  const drawable = na.filter((a) => a.actor_player_id && a.target_player_id
    && idIndex.has(a.actor_player_id) && idIndex.has(a.target_player_id));
  const actors = new Set(na.map((a) => a.actor_player_id).filter(Boolean));

  const hover = state.hoverPlayerId;
  const incident = new Set();
  if (hover) {
    incident.add(hover);
    for (const a of drawable) {
      if (a.actor_player_id === hover) incident.add(a.target_player_id);
      if (a.target_player_id === hover) incident.add(a.actor_player_id);
    }
  }

  // legend multi-select: only selected abilities' edges (and the players they
  // touch) stay lit; everything else dims, like actor hover
  const filterOn = state.abilitySel.size > 0;
  const inFilter = (a) => !filterOn || state.abilitySel.has(a.ability_id ?? '');
  const touched = new Set();
  if (filterOn) {
    for (const a of drawable) {
      if (inFilter(a)) { touched.add(a.actor_player_id); touched.add(a.target_player_id); }
    }
  }

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'graph' });
  const defs = svgEl('defs');
  const colors = new Set(drawable.map((a) => edgeColor(a)));
  for (const c of colors) {
    const m = svgEl('marker', { id: `mk-${c.replace(/[^a-z0-9]/gi, '')}`, viewBox: '0 0 10 10', refX: '9', refY: '5',
      markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
    m.appendChild(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: c }));
    defs.appendChild(m);
  }
  svg.appendChild(defs);

  const overlays = []; // X marks for blocked/redirected arrows, drawn atop edges
  for (const a of drawable) {
    const s = pts[idIndex.get(a.actor_player_id)], t = pts[idIndex.get(a.target_player_id)];
    if (s === t) continue;
    const c = edgeColor(a);
    const dimmed = !inFilter(a)
      || (hover && !(a.actor_player_id === hover || a.target_player_id === hover));
    const dx = t.x - s.x, dy = t.y - s.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
    const sx = s.x + ux * (nodeR + 3), sy = s.y + uy * (nodeR + 3);
    const ex = t.x - ux * (nodeR + 16), ey = t.y - uy * (nodeR + 16);
    const mx = (sx + ex) / 2, my = (sy + ey) / 2, kx = mx + (cx - mx) * 0.28, ky = my + (cy - my) * 0.28;
    const d = `M${sx},${sy} Q${kx},${ky} ${ex},${ey}`;
    const path = svgEl('path', {
      d, fill: 'none', stroke: c,
      'stroke-width': a.id === state.selectedActionId ? 6 : (a.needs_review ? 3 : 4),
      'stroke-dasharray': a.needs_review ? '8 8' : 'none',
      opacity: dimmed ? 0.12 : 0.92, 'marker-end': `url(#mk-${c.replace(/[^a-z0-9]/gi, '')})`,
    });
    svg.appendChild(path);
    // invisible fat twin: easy hover target for the tooltip and easy clicking
    const hit = svgEl('path', {
      d, fill: 'none', stroke: 'rgba(0,0,0,0)', 'stroke-width': 22,
      'data-action': a.id, style: 'cursor:pointer', 'pointer-events': 'stroke',
    });
    hit.addEventListener('click', () => { state.selectedActionId = a.id; render(); });
    svg.appendChild(hit);
    if (isBlockedResult(a)) {
      // midpoint of the quadratic curve (t = 0.5)
      const bx = 0.25 * sx + 0.5 * kx + 0.25 * ex;
      const by = 0.25 * sy + 0.5 * ky + 0.25 * ey;
      overlays.push({ bx, by, c, dimmed });
    }
  }
  for (const { bx, by, c, dimmed } of overlays) {
    const xg = svgEl('g', { 'pointer-events': 'none', opacity: dimmed ? 0.2 : 1 });
    xg.appendChild(svgEl('circle', { cx: bx, cy: by, r: 10,
      fill: 'rgba(10,12,22,0.92)', stroke: c, 'stroke-width': 1.5 }));
    for (const dir of [[1, 1], [1, -1]]) {
      xg.appendChild(svgEl('line', { x1: bx - 6 * dir[0], y1: by - 6 * dir[1],
        x2: bx + 6 * dir[0], y2: by + 6 * dir[1],
        stroke: '#ff6b6b', 'stroke-width': 2.8, 'stroke-linecap': 'round' }));
    }
    svg.appendChild(xg);
  }

  roster.forEach((p, i) => {
    const pt = pts[i];
    const acted = actors.has(p.id);
    const dimmed = (filterOn && !touched.has(p.id)) || (hover && !incident.has(p.id));
    const g = svgEl('g', { style: 'cursor:pointer', 'data-player': p.id });
    g.appendChild(svgEl('circle', { cx: pt.x, cy: pt.y, r: nodeR,
      fill: nodeColor(p.id),
      'fill-opacity': acted ? 1 : 0.35,
      stroke: state.hoverPlayerId === p.id ? '#ffffff' : 'rgba(255,255,255,0.25)',
      'stroke-width': state.hoverPlayerId === p.id ? 3 : 1.5, opacity: dimmed ? 0.3 : 1 }));
    const out = Math.cos(pt.a) >= 0 ? 1 : -1;
    const anchor = Math.abs(Math.cos(pt.a)) < 0.35 ? 'middle' : (out > 0 ? 'start' : 'end');
    const label = svgEl('text', { x: anchor === 'middle' ? pt.x : pt.x + out * 20,
      y: pt.y + (Math.sin(pt.a) > 0.35 ? 34 : Math.sin(pt.a) < -0.35 ? -20 : 6),
      'text-anchor': anchor, class: 'node-label', opacity: dimmed ? 0.3 : 1 });
    label.textContent = p.display_name;
    g.appendChild(label);
    svg.appendChild(g);
  });

  // Hover via pointer tracking on the svg itself, not per-node enter/leave
  // listeners: the graph re-renders on hover change, and a node re-created
  // under a stationary cursor never fires mouseleave, leaving the view stuck
  // in the hovered state. pointermove re-derives hover from whatever is under
  // the cursor each time, so it always self-corrects.
  svg.addEventListener('pointermove', (e) => {
    const node = e.target.closest?.('g[data-player]');
    const id = node ? node.getAttribute('data-player') : null;
    if (id !== state.hoverPlayerId) { state.hoverPlayerId = id; render(); return; }
    updateEdgeTip(svg, e);
  });
  svg.addEventListener('pointerleave', () => {
    hideEdgeTip(svg);
    if (state.hoverPlayerId !== null) { state.hoverPlayerId = null; render(); }
  });
  return svg;
}

// Tooltip shown while hovering an arrow: the ability's EFFECT plus who did
// what to whom. Managed imperatively (no re-render) so it can follow the
// pointer smoothly.
function hideEdgeTip(svg) {
  const tip = svg.parentElement?.querySelector('.graph-tip');
  if (tip) tip.style.display = 'none';
}
function updateEdgeTip(svg, e) {
  const wrap = svg.parentElement;
  const tip = wrap?.querySelector('.graph-tip');
  if (!tip) return;
  const hitPath = e.target.closest?.('path[data-action]');
  const a = hitPath ? actions().find((x) => x.id === hitPath.getAttribute('data-action')) : null;
  if (!a) { tip.style.display = 'none'; return; }
  tip.innerHTML = '';
  // the EFFECT is the headline (colored, bold); the ability name is the
  // small print underneath
  const abilityName = a.ability_name ?? a.ability_raw ?? 'Unknown ability';
  const headline = a.effect_text ?? abilityName;
  tip.appendChild(h('div', { class: 'tip-name', style: `color:${abilityColor(a.ability_id)}` }, headline));
  if (a.effect_text) tip.appendChild(h('div', { class: 'tip-effect' }, abilityName));
  tip.appendChild(h('div', { class: 'tip-line' },
    `${a.actor_name ?? a.actor_raw ?? '?'} → ${a.target_name ?? a.target_raw ?? '?'}`));
  if (a.result) tip.appendChild(h('div', { class: 'tip-line tip-result' }, `Result: ${a.result}`));
  if (a.needs_review) tip.appendChild(h('div', { class: 'tip-line muted' }, 'needs review'));
  const r = wrap.getBoundingClientRect();
  tip.style.left = `${Math.min(e.clientX - r.left + 16, r.width - 240)}px`;
  tip.style.top = `${e.clientY - r.top + 16}px`;
  tip.style.display = 'block';
}

function renderLegend() {
  const ids = [...new Set(nightActions().filter((a) => a.actor_player_id && a.target_player_id)
    .map((a) => a.ability_id))];
  const box = h('div', { class: 'graph-legend' });
  if (ids.length) box.appendChild(h('div', { class: 'leg-head' }, 'Abilities · click to isolate'));
  for (const id of ids) {
    const key = id ?? '';
    const active = state.abilitySel.has(key);
    const name = id ? (abilities().find((ab) => ab.id === id)?.name ?? '?') : 'Unresolved';
    box.appendChild(h('div', {
      class: 'leg' + (active ? ' active' : ''),
      title: 'Click to isolate this ability; click more to compare several',
      onclick: () => {
        if (state.abilitySel.has(key)) state.abilitySel.delete(key);
        else state.abilitySel.add(key);
        render();
      },
    }, h('span', { class: 'sw', style: `background:${abilityColor(id)}` }), name));
  }
  if (state.abilitySel.size > 0) {
    box.appendChild(h('div', { class: 'leg clear',
      onclick: () => { state.abilitySel = new Set(); render(); } }, 'Clear selection'));
  }
  // Alignment key: when players are tagged with a faction, nodes and arrows are
  // colored by the actor's alignment, so show what the color families mean.
  if (alignmentOn()) {
    const present = ALIGN_ORDER.filter((al) => players().some((p) => p.alignment === al));
    box.appendChild(h('div', { class: 'leg-divider' }));
    box.appendChild(h('div', { class: 'leg-head' }, 'Colored by alignment'));
    for (const al of present) {
      box.appendChild(h('div', {},
        h('span', { class: 'sw sw-dot', style: `background:${alignKeyColor(al)}` }),
        ALIGN_LABEL[al]));
    }
  }
  return box;
}

function effectLabel(a) {
  return a.effect_text || a.ability_name || (a.ability_raw ? `${a.ability_raw} (unresolved)` : '?');
}

// A group-chat message that carries several actions (the mafia channel
// posting the whole faction's night at once) gets split into one row per
// action, but every row's `raw_text` column is intentionally the FULL
// original message - that's what lets re-match/split re-derive all the
// siblings later. Shown to the host as-is, that means every split-off action
// displays the same giant multi-line blob instead of just its own line. This
// re-parses raw_text and picks out only this row's own span for display.
// The other rows split out of the same multi-action message (mafia channel
// posting the whole faction's night at once): same raw_text, channel, night.
function spanSiblings(a) {
  return actions().filter((x) =>
    x.raw_text === a.raw_text && x.source_channel === a.source_channel
    && x.night_number === a.night_number);
}
// Which line/span of the message this row represents, by its position among
// its siblings in creation order. Robust even when the stored span_index is
// stale - old rows split via upsert_action all got span_index 0, which made
// every sibling display (and re-resolve as) the FIRST action. Siblings are
// always created in span order (both the scraper and the split button), so
// created_at order == span order; span_index and id only break ties.
function spanOrdinal(a) {
  const sibs = spanSiblings(a);
  if (sibs.length <= 1) return 0;
  sibs.sort((x, y) =>
    (new Date(x.created_at ?? 0) - new Date(y.created_at ?? 0))
    || ((x.span_index ?? 0) - (y.span_index ?? 0))
    || String(x.id).localeCompare(String(y.id)));
  const idx = sibs.findIndex((x) => x.id === a.id);
  return idx >= 0 ? idx : (a.span_index ?? 0);
}

function spanRawText(a) {
  if (!a.raw_text) return a.raw_text;
  const spans = parseMessage(a.raw_text, players(), abilities()).filter(isRecordableAction);
  return spans[spanOrdinal(a)]?.raw ?? a.raw_text;
}

function renderPlayerDetails(pid) {
  const box = h('div', {});
  box.appendChild(h('h3', {}, playerName(pid) ?? 'Player'));
  const did = nightActions().filter((a) => a.actor_player_id === pid);
  const hit = nightActions().filter((a) => a.target_player_id === pid);

  const block = (title, list, outgoing) => {
    const b = h('div', { class: 'detail-block' }, h('h4', {}, title));
    if (!list.length) { b.appendChild(h('p', { class: 'muted' }, '-')); return b; }
    for (const a of list) {
      const other = outgoing ? (a.target_name ?? a.target_raw ?? '?') : (a.actor_name ?? a.actor_raw ?? 'unassigned');
      b.appendChild(h('div', { class: 'detail-row' },
        h('span', { class: 'dot', style: `background:${abilityColor(a.ability_id)}` }),
        h('span', {}, h('b', {}, effectLabel(a)), ` ${outgoing ? '->' : 'from'} `, h('b', {}, other),
          a.result ? h('span', { class: 'result-tag' }, ` = ${a.result}`) : null)));
      if (a.splash_text && !outgoing) b.appendChild(h('div', { class: 'detail-raw' }, `splash: ${a.splash_text}`));
    }
    return b;
  };
  box.appendChild(block('Did', did, true));
  box.appendChild(block('Targeted by', hit, false));
  return box;
}

function renderSide() {
  const side = h('aside', { class: 'details' });
  const selected = actions().find((a) => a.id === state.selectedActionId);
  if (selected && !state.readOnly) { side.appendChild(actionEditor(selected, true)); return side; }
  if (state.hoverPlayerId) { side.appendChild(renderPlayerDetails(state.hoverPlayerId)); return side; }

  // unassigned (shared-channel) actions this night
  const unassigned = nightActions().filter((a) => !a.actor_player_id);
  if (unassigned.length && !state.readOnly) {
    side.appendChild(h('div', { class: 'editor-head' },
      h('h3', {}, `Needs an actor (${unassigned.length})`),
      rematchButton()));
    for (const a of unassigned) {
      const assign = selectEl(players().map((p) => ({ value: p.id, label: p.display_name })), null,
        (v) => mutate(() => rpc('upsert_action', {
          p_game_id: state.gameId, p_pin: state.pin, p_action_id: a.id, p_night_number: a.night_number,
          p_actor_player_id: v || null, p_ability_id: a.ability_id, p_target_player_id: a.target_player_id,
          p_result: a.result, p_raw_text: a.raw_text, p_needs_review: !(v && a.ability_id && a.target_player_id),
        })), { placeholder: 'assign actor' });
      assign.className = 'mini-assign';
      assign.addEventListener('click', (e) => e.stopPropagation());
      side.appendChild(h('div', { class: 'mini-action' },
        h('div', { class: 'mini-top' },
          h('span', { class: 'mono mini-text', onclick: () => { state.selectedActionId = a.id; render(); } },
            spanRawText(a) || `${a.ability_name ?? '?'} -> ${a.target_name ?? a.target_raw ?? '?'}`),
          a.source_channel ? h('span', { class: 'chan' }, `#${a.source_channel}`) : null),
        assign));
    }
  }
  // splashes for this night's targets
  const splashes = nightActions().filter((a) => a.splash_text && a.target_name);
  if (splashes.length) {
    side.appendChild(h('h3', {}, 'Splashes to send'));
    for (const a of splashes) side.appendChild(splashRow(a));
  }
  if (!unassigned.length && !splashes.length) {
    side.appendChild(h('p', { class: 'details-hint' },
      state.readOnly ? 'Final board.' : 'Hover a player; click an arrow to edit it.'));
  }
  return side;
}

// ---- re-match: re-run attribution/resolution on unresolved scraped actions -
// Scraped actions are only matched once, at scrape time; if players, aliases,
// abilities, or mod accounts were added afterwards, existing rows stay
// unresolved forever (re-scraping skips them as duplicates). This re-derives
// them from raw_text using the CURRENT config: fills missing actors from the
// source channel, resolves abilities/targets, and deletes rows authored by a
// listed mod account. Host edits are safe - only needs_review rows are touched,
// and non-null fields are never overwritten.
const channelNorm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
function playerForChannel(channelName) {
  const cn = channelNorm(channelName);
  if (!cn) return null;
  for (const p of players()) {
    for (const key of [p.channel_name, p.display_name, ...(p.aliases ?? [])]) {
      if (key && channelNorm(key) === cn) return p;
    }
  }
  return null;
}

async function rematchAll() {
  const mods = (state.data.game.mod_accounts ?? [])
    .map((m) => String(m).trim().toLowerCase()).filter(Boolean);
  let updated = 0; let deleted = 0; let remaining = 0; let split = 0;
  const splitDone = new Set();
  const targets = actions().filter((a) => a.source === 'scraped' && a.needs_review);
  for (const a of targets) {
    if (a.actor_raw && mods.includes(String(a.actor_raw).trim().toLowerCase())) {
      await rpc('delete_action', { p_game_id: state.gameId, p_pin: state.pin, p_action_id: a.id });
      deleted += 1;
      continue;
    }
    const actor = a.actor_player_id ?? playerForChannel(a.source_channel)?.id ?? null;
    const spans = parseMessage(a.raw_text ?? '', players(), abilities()).filter(isRecordableAction);
    // A message scraped before multi-action support holds several actions in
    // one row; create the missing sibling rows (ability/target prefilled,
    // actor left for the host) - once per message.
    const msgKey = `${a.source_channel}||${a.night_number}||${a.raw_text}`;
    if (spans.length > 1 && !splitDone.has(msgKey)) {
      splitDone.add(msgKey);
      const existing = actions().filter((x) => x.raw_text === a.raw_text
        && x.source_channel === a.source_channel && x.night_number === a.night_number).length;
      for (let i = existing; i < spans.length; i += 1) {
        await rpc('upsert_action', {
          p_game_id: state.gameId, p_pin: state.pin, p_action_id: null,
          p_night_number: a.night_number, p_actor_player_id: null,
          p_ability_id: spans[i].ability.id, p_target_player_id: spans[i].target.player?.id ?? null,
          p_result: null, p_raw_text: a.raw_text, p_needs_review: true,
        });
        split += 1;
      }
    }
    const span = spans[spanOrdinal(a)] ?? spans[0] ?? null;
    const ability = a.ability_id ?? span?.ability.id ?? null;
    const target = a.target_player_id ?? span?.target.player?.id ?? null;
    // if night windows are set and we know when the message was posted,
    // put the action in the right night
    let night = a.night_number;
    if (a.posted_at) {
      const t = new Date(a.posted_at).getTime();
      for (const w of nights()) {
        if (!w.started_at) continue;
        const ws = new Date(w.started_at).getTime();
        const we = w.ends_at ? new Date(w.ends_at).getTime() : Infinity;
        if (t >= ws && t <= we) { night = w.night_number; break; }
      }
    }
    const needsReview = !(actor && ability && target);
    if (needsReview) remaining += 1;
    const changed = actor !== a.actor_player_id || ability !== a.ability_id
      || target !== a.target_player_id || needsReview !== a.needs_review
      || night !== a.night_number;
    if (!changed) continue;
    await rpc('upsert_action', {
      p_game_id: state.gameId, p_pin: state.pin, p_action_id: a.id,
      p_night_number: night, p_actor_player_id: actor,
      p_ability_id: ability, p_target_player_id: target,
      p_result: a.result, p_raw_text: a.raw_text, p_needs_review: needsReview,
    });
    updated += 1;
  }
  // Now that actors/abilities are resolved, drop re-submitted duplicates
  // (latest per actor+ability+night wins).
  let superseded = 0;
  try { superseded = await rpc('supersede_actions', { p_game_id: state.gameId, p_pin: state.pin }); } catch { /* non-fatal */ }
  return { scanned: targets.length, updated, deleted, remaining, split, superseded };
}

function rematchButton() {
  return h('button', { class: 'ghost small', title: 'Re-run matching on unresolved actions using the current players/abilities/mods',
    onclick: async (e) => {
      const btn = e.target;
      btn.disabled = true; btn.textContent = 'Re-matching...';
      try {
        const r = await rematchAll();
        await refresh();
        state.error = '';
        const st = $('scrape-status');
        st.hidden = false; st.className = 'scrape-status';
        st.textContent = `Re-match: ${r.scanned} unresolved scanned, ${r.updated} updated, `
          + `${r.split} split out of multi-action messages, `
          + `${r.deleted} mod message(s) removed, ${r.superseded} re-submitted superseded, `
          + `${r.remaining} still need review.`;
      } catch (err) { state.error = err.message || String(err); }
      render();
    } }, 'Re-match');
}

function splashRow(a) {
  const row = h('div', { class: 'splash' },
    h('div', { class: 'splash-head' }, h('b', {}, a.target_name), ` - ${a.ability_name ?? ''}`),
    h('div', { class: 'splash-body' }, a.splash_text));
  row.appendChild(h('button', { class: 'ghost small', onclick: (e) => {
    navigator.clipboard?.writeText(a.splash_text); e.target.textContent = 'Copied'; } }, 'Copy'));
  return row;
}

// ---- action editor (shared by board + actions tab) ------------------------
function actionEditor(a, withClose) {
  const box = h('div', { class: 'editor' });
  if (withClose) box.appendChild(h('div', { class: 'editor-head' },
    h('h3', {}, 'Edit action'),
    h('button', { class: 'ghost small', onclick: () => { state.selectedActionId = null; render(); } }, 'Close')));
  if (a.raw_text) box.appendChild(h('div', { class: 'detail-raw mono' }, spanRawText(a)));

  const playerOpts = players().map((p) => ({ value: p.id, label: p.display_name }));
  const abilityOpts = abilities().map((ab) => ({ value: ab.id, label: ab.name }));
  const save = (patch) => mutate(() => rpc('upsert_action', {
    p_game_id: state.gameId, p_pin: state.pin, p_action_id: a.id,
    p_night_number: a.night_number,
    p_actor_player_id: patch.actor ?? a.actor_player_id,
    p_ability_id: patch.ability ?? a.ability_id,
    p_target_player_id: patch.target ?? a.target_player_id,
    p_result: patch.result ?? a.result,
    p_raw_text: a.raw_text, p_needs_review: false,
  }));
  box.appendChild(field('Actor', selectEl(playerOpts, a.actor_player_id, (v) => save({ actor: v || null }), { placeholder: 'unassigned' })));
  box.appendChild(field('Ability', selectEl(abilityOpts, a.ability_id, (v) => save({ ability: v || null }), { placeholder: 'unresolved' })));
  box.appendChild(field('Target', selectEl(playerOpts, a.target_player_id, (v) => save({ target: v || null }), { placeholder: 'unresolved' })));
  const result = h('input', { value: a.result ?? '', placeholder: 'e.g. non-town' });
  result.addEventListener('change', () => save({ result: result.value || null }));
  box.appendChild(field('Result', result));
  const controls = h('div', { style: 'display:flex;gap:8px;margin-top:12px' });
  // A message can hold several actions (the mafia channel posts the whole
  // faction's night in one message) but old scrapes stored just one row for
  // it. If the raw text parses into more actions than we have rows for this
  // message, offer to split it into one editable row per action.
  const spansHere = a.raw_text
    ? parseMessage(a.raw_text, players(), abilities()).filter(isRecordableAction)
    : [];
  const siblings = actions().filter((x) =>
    x.raw_text === a.raw_text && x.source_channel === a.source_channel
    && x.night_number === a.night_number);
  if (spansHere.length > 1 && siblings.length < spansHere.length) {
    controls.appendChild(h('button', { class: 'ghost small', onclick: async () => {
      try {
        for (let i = siblings.length; i < spansHere.length; i += 1) {
          const span = spansHere[i];
          await rpc('upsert_action', {
            p_game_id: state.gameId, p_pin: state.pin, p_action_id: null,
            p_night_number: a.night_number, p_actor_player_id: null,
            p_ability_id: span.ability.id, p_target_player_id: span.target.player?.id ?? null,
            p_result: null, p_raw_text: a.raw_text, p_needs_review: true,
          });
        }
        await refresh(); state.error = '';
      } catch (e) { state.error = e.message || String(e); }
      render();
    } }, `Split into ${spansHere.length} actions`));
  }
  controls.appendChild(h('button', { class: 'ghost danger small', onclick: () => mutate(() => {
    state.selectedActionId = null;
    return rpc('delete_action', { p_game_id: state.gameId, p_pin: state.pin, p_action_id: a.id });
  }) }, 'Delete action'));
  box.appendChild(controls);
  return box;
}
function field(label, control) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control);
}

// ---- sheet tab (spreadsheet view) ------------------------------------------
// One row per player for the selected night: what they did, who they hit,
// who hit them, and a free-text "night results" note. Grouped by alignment
// (town, then mafia, then 3rd party, unaligned players last) and alphabetical
// within each group. The Action/Target cells are directly editable (they
// write back to the same `actions` rows as the Board/Actions tab); "Targeted
// by" and its ability are derived from other players' actions, so they're
// read-only here - click one to jump to that actor's own row.
// Computable types with an agreed color, used to color-code the Sheet tab's
// Action/Target cells (both, so a roleblock's target - and its 2nd target,
// if the ability fanned into several rows - both pick up the accent too).
const CT_ACCENT_TYPES = new Set(['kill', 'save', 'roleblock', 'redirect']);
const ctAccent = (a) => (CT_ACCENT_TYPES.has(a.computable_type) ? CT_COLOR[a.computable_type] : null);

function renderSheet() {
  const editable = !state.readOnly;
  const wrap = h('div', { class: 'stack' });
  const table = h('table', { class: 'sheet-table' });
  const headCells = [
    h('th', {}, 'Actor'), h('th', {}, 'Action'), h('th', {}, 'Target'),
    h('th', {}, 'Targeted by'), h('th', {}, 'Action that targeted them'), h('th', {}, 'Night results'),
  ];
  if (editable) headCells.push(h('th', { class: 'sheet-add-col' }, ''));
  table.appendChild(h('thead', {}, h('tr', {}, ...headCells)));
  const tbody = h('tbody', {});
  const groups = [...SHEET_ALIGN_ORDER, null]; // null = unaligned, shown last
  const colspan = editable ? '7' : '6';
  for (const al of groups) {
    const group = alivePlayers()
      .filter((p) => (al === null ? !p.alignment : p.alignment === al))
      .sort((a, b) => a.display_name.localeCompare(b.display_name));
    if (!group.length) continue;
    const swatch = al ? alignKeyColor(al) : '#5a5f7c';
    tbody.appendChild(h('tr', { class: 'sheet-group' },
      h('td', { colspan },
        h('span', { class: 'sw sw-dot', style: `background:${swatch}` }), al ? ALIGN_LABEL[al] : 'Unaligned')));
    for (const p of group) tbody.appendChild(sheetRow(p, editable));
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  if (!players().length) {
    wrap.appendChild(h('p', { class: 'muted' }, 'No players yet - add some in the Players tab.'));
  } else if (!alivePlayers().length) {
    wrap.appendChild(h('p', { class: 'muted' },
      'Every player is marked dead. Parse a current print in the Votes tab, or clear a player\'s status in the Players tab.'));
  }
  return wrap;
}

function sheetRow(p, editable) {
  // Actions whose other end is a dead player are hidden from the sheet, the
  // same way the board drops them - so a killed player's name never shows up
  // in a living player's "Targeted by" cell. A null endpoint (unresolved /
  // unassigned) isn't a hidden player, so it stays. The Actions tab keeps the
  // full unfiltered list for editing.
  const aliveIds = new Set(alivePlayers().map((x) => x.id));
  const shownEndpoint = (id) => id == null || aliveIds.has(id);
  const outgoing = nightActions().filter((a) => a.actor_player_id === p.id && shownEndpoint(a.target_player_id));
  const incoming = nightActions().filter((a) => a.target_player_id === p.id && shownEndpoint(a.actor_player_id));
  const playerOpts = players().map((x) => ({ value: x.id, label: x.display_name }));
  // Option labels favor the ability's EFFECT over its raw name, same as the
  // board's tooltips - "action", not "ability name".
  const abilityOpts = abilities().map((ab) => ({ value: ab.id, label: ab.effect_text || ab.name }));

  const lineStyle = (a) => {
    const accent = ctAccent(a);
    return accent ? `border-left:3px solid ${accent}; padding-left:6px;` : '';
  };
  // If someone redirected or roleblocked THIS player tonight, their own
  // target stays exactly what they submitted (never overwritten/inferred) -
  // a small badge flags that the real outcome may differ. Doesn't say what
  // it changed to; see the "Targeted by" columns for that.
  const redirected = incoming.some((a) => a.computable_type === 'redirect');
  const roleblocked = incoming.some((a) => a.computable_type === 'roleblock');

  const actionCell = h('td', { class: 'sheet-cell' });
  const targetCell = h('td', { class: 'sheet-cell' });
  for (const a of outgoing) {
    const save = (patch) => mutate(() => rpc('upsert_action', {
      p_game_id: state.gameId, p_pin: state.pin, p_action_id: a.id,
      p_night_number: a.night_number, p_actor_player_id: a.actor_player_id,
      p_ability_id: patch.ability ?? a.ability_id, p_target_player_id: patch.target ?? a.target_player_id,
      p_result: a.result, p_raw_text: a.raw_text, p_needs_review: false,
    }));
    actionCell.appendChild(h('div', { class: 'sheet-line', style: lineStyle(a) },
      selectEl(abilityOpts, a.ability_id, (v) => save({ ability: v || null }), { placeholder: 'unresolved', disabled: editable ? null : true }),
      editable ? h('button', { class: 'ghost small sheet-x', title: 'Delete this action', onclick: () => mutate(() =>
        rpc('delete_action', { p_game_id: state.gameId, p_pin: state.pin, p_action_id: a.id })) }, '×') : null));
    targetCell.appendChild(h('div', { class: 'sheet-line', style: lineStyle(a) },
      selectEl(playerOpts, a.target_player_id, (v) => save({ target: v || null }), { placeholder: 'unresolved', disabled: editable ? null : true })));
  }
  if (!outgoing.length) {
    actionCell.appendChild(h('span', { class: 'muted small' }, '-'));
    targetCell.appendChild(h('span', { class: 'muted small' }, '-'));
  } else if (redirected || roleblocked) {
    targetCell.appendChild(h('div', { class: 'sheet-badges' },
      redirected ? h('span', { class: 'ct-pill', title: 'Someone redirected this player tonight' }, '↻ redirected') : null,
      roleblocked ? h('span', { class: 'ct-pill', title: 'Someone roleblocked this player tonight' }, '✕ roleblocked') : null));
  }

  const byCell = h('td', { class: 'sheet-cell' });
  const abilityInCell = h('td', { class: 'sheet-cell' });
  if (!incoming.length) {
    byCell.appendChild(h('span', { class: 'muted small' }, '-'));
    abilityInCell.appendChild(h('span', { class: 'muted small' }, '-'));
  }
  for (const a of incoming) {
    const who = a.actor_name ?? a.actor_raw ?? 'unassigned';
    const dot = a.actor_player_id
      ? h('span', { class: 'sw sw-dot', style: `background:${nodeColor(a.actor_player_id)}` }) : null;
    byCell.appendChild(h('div', { class: 'sheet-line sheet-readonly', onclick: () => jumpToSheetRow(a.actor_player_id) }, dot, who));
    abilityInCell.appendChild(h('div',
      { class: 'sheet-line sheet-readonly', style: lineStyle(a), onclick: () => jumpToSheetRow(a.actor_player_id) },
      effectLabel(a)));
  }

  const resultCell = h('td', { class: 'sheet-cell' });
  const note = h('input', { value: nightNoteFor(p.id), placeholder: editable ? 'e.g. survived the night' : '', disabled: editable ? null : true });
  note.addEventListener('change', () => mutate(() => rpc('upsert_night_note', {
    p_game_id: state.gameId, p_pin: state.pin, p_night: state.night, p_player_id: p.id, p_note: note.value || null,
  })));
  resultCell.appendChild(note);

  const nameCell = h('td', { class: 'sheet-actor' },
    h('span', { class: 'sw sw-dot', style: `background:${nodeColor(p.id)}` }), p.display_name);

  // "+ action" lives in its own slim column at the end of the row, not
  // stacked inside the Action cell, so it doesn't widen/crowd that column.
  const addCell = editable ? h('td', { class: 'sheet-add-col' },
    h('button', { class: 'ghost small', title: 'Add an action for this player', onclick: () => mutate(() => rpc('upsert_action', {
      p_game_id: state.gameId, p_pin: state.pin, p_action_id: null, p_night_number: state.night,
      p_actor_player_id: p.id, p_ability_id: null, p_target_player_id: null,
      p_result: null, p_raw_text: null, p_needs_review: true,
    })) }, '+')) : null;

  return h('tr', { id: `sheet-row-${p.id}` }, nameCell, actionCell, targetCell, byCell, abilityInCell, resultCell, addCell);
}

function jumpToSheetRow(playerId) {
  if (!playerId) return;
  const el = document.getElementById(`sheet-row-${playerId}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('sheet-flash');
  setTimeout(() => el.classList.remove('sheet-flash'), 900);
}

// ---- actions tab ----------------------------------------------------------
function renderActionsEditor() {
  const wrap = h('div', { class: 'stack' });
  wrap.appendChild(h('div', { style: 'display:flex;gap:10px;align-items:center' },
    rematchButton(),
    h('span', { class: 'muted small' }, 'Re-run matching on unresolved actions after editing players, aliases, abilities, or mods.')));
  wrap.appendChild(h('button', { class: 'primary', onclick: () => mutate(() => rpc('upsert_action', {
    p_game_id: state.gameId, p_pin: state.pin, p_action_id: null, p_night_number: state.night,
    p_actor_player_id: null, p_ability_id: null, p_target_player_id: null,
    p_result: null, p_raw_text: null, p_needs_review: true,
  })) }, '+ Add action'));
  const na = nightActions();
  if (!na.length) wrap.appendChild(h('p', { class: 'muted' }, 'No actions this night yet.'));
  for (const a of na) wrap.appendChild(actionEditor(a, false));
  return wrap;
}

// ---- players tab ----------------------------------------------------------
async function addPlayersBulk(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  try {
    for (const line of lines) {
      const parts = line.split(',').map((s) => s.trim()).filter(Boolean);
      const name = parts[0];
      if (!name) continue;
      await rpc('upsert_player', {
        p_game_id: state.gameId, p_pin: state.pin, p_player_id: null,
        p_display_name: name, p_channel_name: null, p_aliases: parts.slice(1),
        p_alignment: null,
      });
    }
    await refresh(); state.error = '';
  } catch (e) { state.error = e.message || String(e); }
  render();
}

function renderPlayersEditor() {
  const wrap = h('div', { class: 'stack' });

  const ta = h('textarea', { rows: '5',
    placeholder: 'Paste one player per line:\nJoe, joe-smith, axatar\nPeyton, pey\n(first item is the name, the rest are aliases)' });
  const paste = h('details', { class: 'paste-box' },
    h('summary', {}, 'Paste a list of players'),
    ta,
    h('button', { class: 'primary', onclick: () => { const t = ta.value; ta.value = ''; addPlayersBulk(t); } }, 'Add these'),
    h('p', { class: 'muted small' }, 'Channels auto-match a player\'s name or aliases, so you usually don\'t need to set a channel. Unmatched channels (mafia, duos) become group channels you assign by hand.'));
  wrap.appendChild(paste);

  wrap.appendChild(h('button', { class: 'primary', onclick: () => mutate(() => rpc('upsert_player', {
    p_game_id: state.gameId, p_pin: state.pin, p_player_id: null,
    p_display_name: 'New player', p_channel_name: null, p_aliases: [], p_alignment: null,
  })) }, '+ Add player'));
  if (nightRoster().length) {
    wrap.appendChild(h('p', { class: 'muted small' },
      `Night ${state.night}: auto-hiding players not on the alive list from the latest print at or before this night (${nightRoster().length} alive). `
      + 'Status "auto" follows the print; set "alive"/"dead" to override it everywhere.'));
  }
  for (const p of players()) {
    const save = (patch) => mutate(() => rpc('upsert_player', {
      p_game_id: state.gameId, p_pin: state.pin, p_player_id: p.id,
      p_display_name: patch.name ?? p.display_name,
      p_channel_name: patch.channel ?? p.channel_name,
      p_aliases: patch.aliases ?? p.aliases,
      p_alignment: 'alignment' in patch ? patch.alignment : (p.alignment ?? null),
      p_life_override: 'life_override' in patch ? patch.life_override : (p.life_override ?? null),
    }));
    const name = h('input', { value: p.display_name });
    name.addEventListener('change', () => save({ name: name.value }));
    const chan = h('input', { value: p.channel_name ?? '', placeholder: 'channel name' });
    chan.addEventListener('change', () => save({ channel: chan.value }));
    const aliases = h('input', { value: (p.aliases ?? []).join(', '), placeholder: 'aliases, comma-separated' });
    aliases.addEventListener('change', () => save({ aliases: aliases.value.split(',').map((s) => s.trim()).filter(Boolean) }));
    const align = selectEl(ALIGN_ORDER.map((a) => ({ value: a, label: ALIGN_LABEL[a] })),
      p.alignment, (v) => save({ alignment: v || null }), { placeholder: 'no alignment' });
    // Status: '' = follow the print (auto), 'alive'/'dead' = force it. When on
    // auto, a tag shows what the print currently resolves to so a hidden
    // player is still visible-and-explained here in the Players tab.
    const status = selectEl(
      [{ value: 'alive', label: 'alive' }, { value: 'dead', label: 'dead' }],
      p.life_override, (v) => save({ life_override: v || null }), { placeholder: 'auto' });
    const dead = isPlayerDead(p);
    const autoTag = (!p.life_override && nightRoster().length)
      ? h('span', { class: `life-tag ${dead ? 'dead' : 'alive'}` }, dead ? 'auto: dead' : 'auto: alive')
      : null;
    const row = h('div', { class: 'editor row players-row' + (dead ? ' player-dead' : '') },
      field('Name', name), field('Channel', chan), field('Aliases', aliases),
      field('Alignment', align),
      field('Status', h('div', { class: 'life-field' }, status, autoTag)),
      h('button', { class: 'ghost danger small', onclick: () => mutate(() =>
        rpc('delete_player', { p_game_id: state.gameId, p_pin: state.pin, p_player_id: p.id })) }, 'Delete'));
    wrap.appendChild(row);
  }
  return wrap;
}

// ---- abilities tab --------------------------------------------------------
// Bulk-add abilities from a table copied out of Sheets/Excel. Spreadsheet
// clipboard data is tab-separated: name TAB effect TAB aliases (aliases
// comma-separated inside their cell). A header row like "name  effect ..."
// is skipped automatically.
async function addAbilitiesBulk(text) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim());
  try {
    for (const [i, line] of lines.entries()) {
      const cells = line.split('\t').map((s) => s.trim());
      const name = cells[0];
      if (!name) continue;
      if (i === 0 && /^(name|ability)$/i.test(name)) continue; // header row
      const effect = cells[1] || null;
      const aliases = (cells[2] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      await rpc('upsert_ability', {
        p_game_id: state.gameId, p_pin: state.pin, p_ability_id: null,
        p_name: name, p_aliases: aliases, p_effect_text: effect,
        p_computable_type: 'none', p_splash_text: null,
      });
    }
    await refresh(); state.error = '';
  } catch (e) { state.error = e.message || String(e); }
  render();
}

function renderAbilitiesEditor() {
  const wrap = h('div', { class: 'stack' });

  const ta = h('textarea', { rows: '6',
    placeholder: 'Paste straight from Sheets/Excel - three columns, one ability per row:\n'
      + 'Name | Effect | Aliases (comma-separated)\n'
      + 'Sprint\tVisits a player at high speed\tsprint, run\n'
      + 'Faction Kill\tEliminates the target\tkill, fk' });
  const paste = h('details', { class: 'paste-box' },
    h('summary', {}, 'Paste a table of abilities (from Sheets/Excel)'),
    ta,
    h('button', { class: 'primary', onclick: () => { const t = ta.value; ta.value = ''; addAbilitiesBulk(t); } }, 'Add these'),
    h('p', { class: 'muted small' },
      'Copy the three columns Name, Effect, Aliases in your sheet and paste here - '
      + 'the column breaks come along automatically. The ability name itself always '
      + 'matches too; aliases are the other things players type. Set types and '
      + 'splashes afterwards on the rows below.'));
  wrap.appendChild(paste);

  wrap.appendChild(h('button', { class: 'primary', onclick: () => mutate(() => rpc('upsert_ability', {
    p_game_id: state.gameId, p_pin: state.pin, p_ability_id: null, p_name: 'New ability',
    p_aliases: [], p_effect_text: null, p_computable_type: 'none', p_splash_text: null,
  })) }, '+ Add ability'));
  for (const ab of abilities()) {
    const save = (patch) => mutate(() => rpc('upsert_ability', {
      p_game_id: state.gameId, p_pin: state.pin, p_ability_id: ab.id,
      p_name: patch.name ?? ab.name, p_aliases: patch.aliases ?? ab.aliases,
      p_effect_text: patch.effect ?? ab.effect_text,
      p_computable_type: patch.ct ?? ab.computable_type,
      p_splash_text: patch.splash ?? ab.splash_text,
    }));
    const name = h('input', { value: ab.name });
    name.addEventListener('change', () => save({ name: name.value }));
    const aliases = h('input', { value: (ab.aliases ?? []).join(', '), placeholder: 'what players type' });
    aliases.addEventListener('change', () => save({ aliases: aliases.value.split(',').map((s) => s.trim()).filter(Boolean) }));
    const effect = h('input', { value: ab.effect_text ?? '', placeholder: 'effect shown on the web' });
    effect.addEventListener('change', () => save({ effect: effect.value || null }));
    const splash = h('input', { value: ab.splash_text ?? '', placeholder: 'splash sent to target (optional)' });
    splash.addEventListener('change', () => save({ splash: splash.value || null }));
    wrap.appendChild(h('div', { class: 'editor row' },
      field('Name', name), field('Aliases', aliases), field('Effect', effect),
      field('Type', selectEl(COMPUTABLE_TYPES.map((t) => ({ value: t, label: CT_LABEL[t] })), ab.computable_type, (v) => save({ ct: v }))),
      field('Splash', splash),
      h('button', { class: 'ghost danger small', onclick: () => mutate(() =>
        rpc('delete_ability', { p_game_id: state.gameId, p_pin: state.pin, p_ability_id: ab.id })) }, 'Delete')));
  }
  return wrap;
}

// ---- wire up static controls ----------------------------------------------
$('create-btn').addEventListener('click', createGame);
$('back-btn').addEventListener('click', () => {
  state.data = null; state.gameId = null; state.pin = null; state.selectedActionId = null; state.error = '';
  $('scrape-status').hidden = true;
  loadGames().then(render).catch(showErr);
});
$('finish-btn').addEventListener('click', () => {
  if (!confirm('Finish this game? This removes the PIN and makes it public read-only.')) return;
  mutate(() => rpc('archive_game', { p_game_id: state.gameId, p_pin: state.pin })
    .then(() => { state.readOnly = true; }));
});

const scrapeStatusEl = $('scrape-status');
$('scrape-btn').addEventListener('click', async () => {
  const btn = $('scrape-btn');
  btn.disabled = true;
  scrapeStatusEl.hidden = false;
  scrapeStatusEl.className = 'scrape-status';
  scrapeStatusEl.textContent = 'Scraping...';
  try {
    const { data, error } = await supabase.functions.invoke('scrape', {
      body: { game_id: state.gameId, pin: state.pin },
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    // Drop actions a player overrode by re-submitting the same ability (keeps
    // the latest per actor+ability+night); resolved personal-channel actions
    // supersede immediately, shared-channel ones once their actor is assigned.
    let superseded = 0;
    try { superseded = await rpc('supersede_actions', { p_game_id: state.gameId, p_pin: state.pin }); } catch { /* non-fatal */ }
    scrapeStatusEl.textContent =
      `Scraped ${data.channels} channel(s), ${data.messages} message(s), inserted ${data.inserted} action(s)`
      + `${superseded ? `, superseded ${superseded} re-submitted` : ''}.`;
    await refresh();
    render();
  } catch (e) {
    // FunctionsHttpError carries the response; surface the function's own
    // error text instead of the generic "non-2xx status code" message.
    let msg = e.message || String(e);
    try {
      if (e.context && typeof e.context.json === 'function') {
        const body = await e.context.json();
        if (body?.error) msg = body.error;
      }
    } catch { /* keep the generic message */ }
    if (/Failed to send a request|Failed to fetch/i.test(msg)) {
      msg += ' - is the "scrape" Edge Function deployed to this Supabase project? (See GO-LIVE.md 3a.)';
    }
    scrapeStatusEl.className = 'scrape-status needs-review';
    scrapeStatusEl.textContent = `Scrape failed: ${msg}`;
  } finally {
    btn.disabled = false;
  }
});

// Vote counter (Votes tab) posts up the day-start timestamps it detects from
// the pasted forum print, once per "Count Votes" click - updated in place
// (not via the full render() pipeline) so the iframe itself is never
// recreated/reloaded out from under the host's pasted-in thread.
window.addEventListener('message', async (e) => {
  if (e.data?.source !== 'mafia-vote-parser' || e.data?.type !== 'day-starts') return;
  if (!state.data) return;
  state.dayStarts = e.data.dayStarts ?? [];
  updateVotesPreview();
  // Persist the current alive roster to the night the print is current at, so
  // dead players stay hidden across reloads. nightRoster() forward-fills it to
  // later nights. Editor only: a read-only viewer has no PIN to write with.
  // refresh() pulls the saved roster back into state.data without re-rendering
  // (so the Votes iframe the user is looking at is left intact).
  const currentRoster = Array.isArray(e.data.currentRoster) ? e.data.currentRoster : [];
  const currentNight = Number.isFinite(e.data.currentNight) ? e.data.currentNight : null;
  if (!state.readOnly && currentRoster.length && currentNight != null) {
    try {
      await rpc('upsert_night_roster', {
        p_game_id: state.gameId, p_pin: state.pin, p_night: currentNight, p_alive_names: currentRoster,
      });
      await refresh();
      state.error = '';
    } catch (err) {
      state.error = err.message || String(err);
    }
  }
  // This message fires while the user is on the Votes tab (they just clicked
  // Count Votes), where a full render() would recreate the iframe and wipe
  // their pasted thread - so only re-render if somehow already on the tracker.
  // Otherwise the Board/Sheet pick up the saved rosters on the next navigation
  // to the tracker, which itself calls render().
  if (state.section === 'tracker') render();
});

loadGames().then(render).catch(showErr);
