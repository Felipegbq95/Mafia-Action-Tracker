import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';

const CT_COLOR = {
  kill: '#e0454f', save: '#4caf7d', track: '#eab54e', watch: '#4fd0c0',
  redirect: '#d98c5f', roleblock: '#4f9de0', none: '#6b6f8c',
};
const CT_LABEL = {
  kill: 'Kill', save: 'Save', track: 'Track', watch: 'Watch',
  redirect: 'Redirect', roleblock: 'Roleblock', none: 'Other',
};
const COMPUTABLE_TYPES = ['none', 'kill', 'save', 'track', 'watch', 'redirect', 'roleblock'];

if (SUPABASE_URL.includes('YOUR-PROJECT') || SUPABASE_ANON_KEY.includes('YOUR-ANON-KEY')) {
  $('status').textContent = 'Not configured - set dashboard/config.js.';
  throw new Error('config.js placeholder');
}
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const state = {
  games: [], gameId: null, pin: null, data: null, readOnly: false,
  night: 1, tab: 'board', selectedActionId: null, hoverPlayerId: null, error: '',
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
  await refresh(); render();
}
async function openPublic(gameId) {
  state.gameId = gameId; state.pin = null; state.readOnly = true;
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
const abilities = () => state.data?.abilities ?? [];
const actions = () => state.data?.actions ?? [];
const nightActions = () => actions().filter((a) => a.night_number === state.night);
function nightNumbers() {
  const ns = new Set(actions().map((a) => a.night_number));
  ns.add(state.data?.game?.current_night_number ?? 1);
  return [...ns].sort((a, b) => a - b);
}
const playerName = (id) => players().find((p) => p.id === id)?.display_name;

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
function renderGame() {
  const g = state.data.game;
  $('game-name').textContent = g.name;
  $('ro-badge').hidden = !state.readOnly;
  $('finish-btn').hidden = state.readOnly;

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

  const tabs = state.readOnly ? ['board'] : ['board', 'actions', 'players', 'abilities'];
  const nav = $('tabs'); nav.innerHTML = '';
  for (const t of tabs) {
    nav.appendChild(h('button', { class: 'tab' + (state.tab === t ? ' active' : ''),
      onclick: () => { state.tab = t; render(); } }, t[0].toUpperCase() + t.slice(1)));
  }
  if (state.readOnly) state.tab = 'board';

  const panel = $('panel'); panel.innerHTML = '';
  if (state.tab === 'board') panel.appendChild(renderBoard());
  else if (state.tab === 'actions') panel.appendChild(renderActionsEditor());
  else if (state.tab === 'players') panel.appendChild(renderPlayersEditor());
  else if (state.tab === 'abilities') panel.appendChild(renderAbilitiesEditor());
}

// ---- board (graph + side) -------------------------------------------------
function renderBoard() {
  const wrap = h('div', { class: 'web-view' });
  const graphWrap = h('div', { class: 'graph-wrap' });
  graphWrap.appendChild(drawGraph());
  graphWrap.appendChild(renderLegend());
  wrap.appendChild(graphWrap);
  wrap.appendChild(renderSide());
  return wrap;
}

function drawGraph() {
  const roster = players();
  const na = nightActions();
  const idIndex = new Map(roster.map((p, i) => [p.id, i]));
  const W = 900, H = 600, cx = W / 2, cy = H / 2, nodeR = 8;
  const R = Math.min(240, 140 + roster.length * 8);
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

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'graph' });
  const defs = svgEl('defs');
  const colors = new Set(drawable.map((a) => CT_COLOR[a.computable_type] ?? CT_COLOR.none));
  for (const c of colors) {
    const m = svgEl('marker', { id: `mk-${c.replace('#', '')}`, viewBox: '0 0 10 10', refX: '9', refY: '5',
      markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
    m.appendChild(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: c }));
    defs.appendChild(m);
  }
  svg.appendChild(defs);

  for (const a of drawable) {
    const s = pts[idIndex.get(a.actor_player_id)], t = pts[idIndex.get(a.target_player_id)];
    if (s === t) continue;
    const c = CT_COLOR[a.computable_type] ?? CT_COLOR.none;
    const dimmed = hover && !(a.actor_player_id === hover || a.target_player_id === hover);
    const dx = t.x - s.x, dy = t.y - s.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
    const sx = s.x + ux * (nodeR + 3), sy = s.y + uy * (nodeR + 3);
    const ex = t.x - ux * (nodeR + 11), ey = t.y - uy * (nodeR + 11);
    const mx = (sx + ex) / 2, my = (sy + ey) / 2, kx = mx + (cx - mx) * 0.28, ky = my + (cy - my) * 0.28;
    const path = svgEl('path', {
      d: `M${sx},${sy} Q${kx},${ky} ${ex},${ey}`, fill: 'none', stroke: c,
      'stroke-width': a.id === state.selectedActionId ? 4 : (a.needs_review ? 2 : 2.6),
      'stroke-dasharray': a.needs_review ? '5 5' : 'none',
      opacity: dimmed ? 0.12 : 0.92, 'marker-end': `url(#mk-${c.replace('#', '')})`,
      style: 'cursor:pointer',
    });
    path.addEventListener('click', () => { state.selectedActionId = a.id; render(); });
    svg.appendChild(path);
  }

  roster.forEach((p, i) => {
    const pt = pts[i];
    const acted = actors.has(p.id);
    const dimmed = hover && !incident.has(p.id);
    const g = svgEl('g', { style: 'cursor:pointer' });
    g.appendChild(svgEl('circle', { cx: pt.x, cy: pt.y, r: nodeR,
      fill: acted ? '#e8e9f3' : '#3a3e5c',
      stroke: state.hoverPlayerId === p.id ? '#e0454f' : 'rgba(255,255,255,0.15)',
      'stroke-width': state.hoverPlayerId === p.id ? 2.5 : 1, opacity: dimmed ? 0.3 : 1 }));
    const out = Math.cos(pt.a) >= 0 ? 1 : -1;
    const anchor = Math.abs(Math.cos(pt.a)) < 0.35 ? 'middle' : (out > 0 ? 'start' : 'end');
    const label = svgEl('text', { x: anchor === 'middle' ? pt.x : pt.x + out * 13,
      y: pt.y + (Math.sin(pt.a) > 0.35 ? 22 : Math.sin(pt.a) < -0.35 ? -13 : 4),
      'text-anchor': anchor, class: 'node-label', opacity: dimmed ? 0.3 : 1 });
    label.textContent = p.display_name;
    g.appendChild(label);
    g.addEventListener('mouseenter', () => { state.hoverPlayerId = p.id; render(); });
    g.addEventListener('mouseleave', () => { state.hoverPlayerId = null; render(); });
    svg.appendChild(g);
  });
  return svg;
}

function renderLegend() {
  const types = [...new Set(nightActions().filter((a) => a.actor_player_id && a.target_player_id)
    .map((a) => a.computable_type))];
  const box = h('div', { class: 'graph-legend' });
  for (const t of types) box.appendChild(h('div', {}, h('span', { class: 'sw', style: `background:${CT_COLOR[t] ?? CT_COLOR.none}` }), CT_LABEL[t] ?? t));
  return box;
}

function effectLabel(a) {
  return a.effect_text || a.ability_name || (a.ability_raw ? `${a.ability_raw} (unresolved)` : '?');
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
        h('span', { class: 'dot', style: `background:${CT_COLOR[a.computable_type] ?? CT_COLOR.none}` }),
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
    side.appendChild(h('h3', {}, `Needs an actor (${unassigned.length})`));
    for (const a of unassigned) {
      side.appendChild(h('div', { class: 'mini-action', onclick: () => { state.selectedActionId = a.id; render(); } },
        h('span', { class: 'mono' }, a.raw_text || `${a.ability_name ?? '?'} -> ${a.target_name ?? a.target_raw ?? '?'}`),
        a.source_channel ? h('span', { class: 'chan' }, `#${a.source_channel}`) : null));
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
  if (a.raw_text) box.appendChild(h('div', { class: 'detail-raw mono' }, a.raw_text));

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
  box.appendChild(h('button', { class: 'ghost danger small', onclick: () => mutate(() => {
    state.selectedActionId = null;
    return rpc('delete_action', { p_game_id: state.gameId, p_pin: state.pin, p_action_id: a.id });
  }) }, 'Delete action'));
  return box;
}
function field(label, control) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control);
}

// ---- actions tab ----------------------------------------------------------
function renderActionsEditor() {
  const wrap = h('div', { class: 'stack' });
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
    p_display_name: 'New player', p_channel_name: null, p_aliases: [],
  })) }, '+ Add player'));
  for (const p of players()) {
    const save = (patch) => mutate(() => rpc('upsert_player', {
      p_game_id: state.gameId, p_pin: state.pin, p_player_id: p.id,
      p_display_name: patch.name ?? p.display_name,
      p_channel_name: patch.channel ?? p.channel_name,
      p_aliases: patch.aliases ?? p.aliases,
    }));
    const name = h('input', { value: p.display_name });
    name.addEventListener('change', () => save({ name: name.value }));
    const chan = h('input', { value: p.channel_name ?? '', placeholder: 'channel name' });
    chan.addEventListener('change', () => save({ channel: chan.value }));
    const aliases = h('input', { value: (p.aliases ?? []).join(', '), placeholder: 'aliases, comma-separated' });
    aliases.addEventListener('change', () => save({ aliases: aliases.value.split(',').map((s) => s.trim()).filter(Boolean) }));
    wrap.appendChild(h('div', { class: 'editor row' },
      field('Name', name), field('Channel', chan), field('Aliases', aliases),
      h('button', { class: 'ghost danger small', onclick: () => mutate(() =>
        rpc('delete_player', { p_game_id: state.gameId, p_pin: state.pin, p_player_id: p.id })) }, 'Delete')));
  }
  return wrap;
}

// ---- abilities tab --------------------------------------------------------
function renderAbilitiesEditor() {
  const wrap = h('div', { class: 'stack' });
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
  loadGames().then(render).catch(showErr);
});
$('finish-btn').addEventListener('click', () => {
  if (!confirm('Finish this game? This removes the PIN and makes it public read-only.')) return;
  mutate(() => rpc('archive_game', { p_game_id: state.gameId, p_pin: state.pin })
    .then(() => { state.readOnly = true; }));
});

loadGames().then(render).catch(showErr);
