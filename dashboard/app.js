import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const gateEl = $('gate');
const boardEl = $('board');
const gameSelectEl = $('game-select');
const pinInputEl = $('pin-input');
const unlockBtnEl = $('unlock-btn');
const gateErrorEl = $('gate-error');
const nightTabsEl = $('night-tabs');
const viewToggleEl = $('view-toggle');
const webViewEl = $('web-view');
const listViewEl = $('list-view');
const graphEl = $('graph');
const legendEl = $('legend');
const detailsEl = $('details');
const bodyEl = $('submissions-body');

const POLL_INTERVAL_MS = 10000;
const SVG_NS = 'http://www.w3.org/2000/svg';

// role_canonical -> edge color. Unknown/unresolved roles fall back to gray.
const ROLE_COLORS = {
  cop: '#eab54e', doctor: '#4caf7d', mafia: '#e0454f', roleblocker: '#4f9de0',
  vigilante: '#9b8cff', bodyguard: '#4fd0c0', jailkeeper: '#d98c5f',
};
const ROLE_LABEL = {
  cop: 'Investigate', doctor: 'Protect', mafia: 'Kill', roleblocker: 'Roleblock',
  vigilante: 'Shoot', bodyguard: 'Guard', jailkeeper: 'Jail',
};
const UNRESOLVED_COLOR = '#6b6f8c';
const roleColor = (r) => ROLE_COLORS[r] ?? UNRESOLVED_COLOR;

if (SUPABASE_URL.includes('YOUR-PROJECT') || SUPABASE_ANON_KEY.includes('YOUR-ANON-KEY')) {
  statusEl.textContent = 'Not configured yet - fill in dashboard/config.js with your Supabase project details.';
  statusEl.classList.add('needs-review');
  throw new Error('dashboard/config.js is still using placeholder values');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const state = {
  gameId: null, pin: null,
  roster: [], subs: [],
  night: null, hoverId: null, listMode: false,
};
let pollTimer = null;

// ---- data ----------------------------------------------------------------

async function loadGames() {
  const { data, error } = await supabase.rpc('list_games');
  if (error) { gateErrorEl.textContent = `Could not load games: ${error.message}`; return; }
  gameSelectEl.innerHTML = '';
  for (const g of data) {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = g.is_active ? `${g.name} (active)` : g.name;
    gameSelectEl.appendChild(opt);
  }
  if (data.length === 0) { gateErrorEl.textContent = 'No games created yet.'; unlockBtnEl.disabled = true; }
}

async function fetchData(gameId, pin) {
  const [subsRes, rosterRes] = await Promise.all([
    supabase.rpc('dashboard_submissions', { p_game_id: gameId, p_pin: pin }),
    supabase.rpc('dashboard_roster', { p_game_id: gameId, p_pin: pin }),
  ]);
  if (subsRes.error) throw subsRes.error;
  if (rosterRes.error) throw rosterRes.error;
  return { subs: subsRes.data ?? [], roster: rosterRes.data ?? [] };
}

// ---- geometry helpers ----------------------------------------------------

function ringPositions(n, cx, cy, r) {
  const pts = [];
  for (let i = 0; i < n; i += 1) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), a });
  }
  return pts;
}

function el(name, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

// ---- rendering -----------------------------------------------------------

function nightsFromSubs(subs) {
  return [...new Set(subs.map((s) => s.night_number))].sort((a, b) => a - b);
}

function renderNightTabs() {
  const nights = nightsFromSubs(state.subs);
  nightTabsEl.innerHTML = '';
  if (nights.length === 0) return;
  for (const n of nights) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'night-tab' + (n === state.night ? ' active' : '');
    b.textContent = `Night ${n}`;
    b.addEventListener('click', () => { state.night = n; state.hoverId = null; draw(); });
    nightTabsEl.appendChild(b);
  }
}

function drawGraph() {
  const nightSubs = state.subs.filter((s) => s.night_number === state.night);
  const roster = state.roster;
  const idIndex = new Map(roster.map((p, i) => [p.id, i]));

  const W = 900, H = 640, cx = W / 2, cy = H / 2, nodeR = 8;
  const R = Math.min(250, 150 + roster.length * 8);
  const pts = ringPositions(roster.length, cx, cy, R);

  // which players acted this night, and who is touched by the hovered player
  const actorIds = new Set(nightSubs.map((s) => s.submitter_player_id).filter(Boolean));
  const drawable = nightSubs.filter((s) => s.submitter_player_id && s.target_player_id
    && idIndex.has(s.submitter_player_id) && idIndex.has(s.target_player_id));
  const unresolved = nightSubs.filter((s) => !drawable.includes(s));

  const hoverActive = state.hoverId != null;
  const incident = new Set();
  if (hoverActive) {
    incident.add(state.hoverId);
    for (const s of drawable) {
      if (s.submitter_player_id === state.hoverId) incident.add(s.target_player_id);
      if (s.target_player_id === state.hoverId) incident.add(s.submitter_player_id);
    }
  }

  graphEl.innerHTML = '';
  const defs = el('defs');
  const usedColors = new Set(drawable.map((s) => roleColor(s.role_canonical)));
  usedColors.add(UNRESOLVED_COLOR);
  for (const c of usedColors) {
    const m = el('marker', {
      id: `arw-${c.replace('#', '')}`, viewBox: '0 0 10 10', refX: '9', refY: '5',
      markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse',
    });
    m.appendChild(el('path', { d: 'M0,0 L10,5 L0,10 z', fill: c }));
    defs.appendChild(m);
  }
  graphEl.appendChild(defs);

  // edges
  for (const s of drawable) {
    const si = idIndex.get(s.submitter_player_id), ti = idIndex.get(s.target_player_id);
    const spt = pts[si], tpt = pts[ti];
    const c = s.role_canonical ? roleColor(s.role_canonical) : UNRESOLVED_COLOR;
    const dimmed = hoverActive && !(s.submitter_player_id === state.hoverId || s.target_player_id === state.hoverId);
    if (si === ti) continue; // self-target handled below
    const dx = tpt.x - spt.x, dy = tpt.y - spt.y, len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const sx = spt.x + ux * (nodeR + 3), sy = spt.y + uy * (nodeR + 3);
    const ex = tpt.x - ux * (nodeR + 11), ey = tpt.y - uy * (nodeR + 11);
    const mx = (sx + ex) / 2, my = (sy + ey) / 2;
    const kx = mx + (cx - mx) * 0.28, ky = my + (cy - my) * 0.28;
    graphEl.appendChild(el('path', {
      d: `M${sx},${sy} Q${kx},${ky} ${ex},${ey}`,
      fill: 'none', stroke: c, 'stroke-width': s.needs_review ? 2 : 2.5,
      'stroke-dasharray': s.needs_review ? '5 5' : 'none',
      opacity: dimmed ? 0.12 : 0.92,
      'marker-end': `url(#arw-${c.replace('#', '')})`,
    }));
  }

  // nodes
  roster.forEach((p, i) => {
    const pt = pts[i];
    const acted = actorIds.has(p.id);
    const dimmed = hoverActive && !incident.has(p.id);
    const g = el('g', { class: 'node', 'data-id': p.id, style: 'cursor:pointer' });
    g.appendChild(el('circle', {
      cx: pt.x, cy: pt.y, r: nodeR,
      fill: acted ? '#e8e9f3' : '#3a3e5c',
      stroke: state.hoverId === p.id ? '#e0454f' : 'rgba(255,255,255,0.15)',
      'stroke-width': state.hoverId === p.id ? 2.5 : 1,
      opacity: dimmed ? 0.3 : 1,
    }));
    const out = Math.cos(pt.a) >= 0 ? 1 : -1;
    const anchor = Math.abs(Math.cos(pt.a)) < 0.35 ? 'middle' : (out > 0 ? 'start' : 'end');
    const tx = anchor === 'middle' ? pt.x : pt.x + out * 13;
    const ty = pt.y + (Math.sin(pt.a) > 0.35 ? 22 : Math.sin(pt.a) < -0.35 ? -13 : 4);
    g.appendChild(el('text', {
      x: tx, y: ty, 'text-anchor': anchor, class: 'node-label',
      opacity: dimmed ? 0.3 : 1,
    }, p.display_name));
    g.addEventListener('mouseenter', () => { state.hoverId = p.id; draw(); });
    g.addEventListener('mouseleave', () => { state.hoverId = null; draw(); });
    graphEl.appendChild(g);
  });

  renderLegend(drawable);
  renderDetails(nightSubs, unresolved);
}

function renderLegend(drawable) {
  const roles = [...new Set(drawable.map((s) => s.role_canonical).filter(Boolean))];
  legendEl.innerHTML = '';
  for (const r of roles) {
    const d = document.createElement('div');
    d.innerHTML = `<span class="sw" style="background:${roleColor(r)}"></span>${ROLE_LABEL[r] ?? r}`;
    legendEl.appendChild(d);
  }
  if (drawable.some((s) => s.needs_review) || roles.length !== new Set(drawable.map((s) => s.role_canonical)).size) {
    const d = document.createElement('div');
    d.innerHTML = `<span class="sw dashed"></span>Needs review`;
    legendEl.appendChild(d);
  }
}

function renderDetails(nightSubs, unresolved) {
  detailsEl.innerHTML = '';
  if (state.hoverId != null) {
    const player = state.roster.find((p) => p.id === state.hoverId);
    const outgoing = nightSubs.filter((s) => s.submitter_player_id === state.hoverId);
    const incoming = nightSubs.filter((s) => s.target_player_id === state.hoverId);
    const h = document.createElement('div');
    h.innerHTML = `<h3>${player ? escapeHtml(player.display_name) : 'Player'}</h3>`;
    detailsEl.appendChild(h);
    detailsEl.appendChild(detailBlock('Did', outgoing, true));
    detailsEl.appendChild(detailBlock('Targeted by', incoming, false));
    return;
  }
  const counts = document.createElement('div');
  const acted = new Set(nightSubs.map((s) => s.submitter_player_id).filter(Boolean)).size;
  counts.className = 'details-summary';
  counts.innerHTML = `<div><span class="big">${acted}/${state.roster.length}</span><span class="lbl">submitted</span></div>`;
  detailsEl.appendChild(counts);
  if (unresolved.length) {
    const u = document.createElement('div');
    u.className = 'needs-attention';
    u.innerHTML = `<h4>Needs attention (${unresolved.length})</h4>` + unresolved.map((s) =>
      `<div class="na-item">${escapeHtml(s.submitter_name ?? 'unlinked')} - <span class="mono">${escapeHtml(s.raw_message)}</span></div>`).join('');
    detailsEl.appendChild(u);
  } else {
    const p = document.createElement('p');
    p.className = 'details-hint';
    p.textContent = 'Hover a player to see their action.';
    detailsEl.appendChild(p);
  }
}

function detailBlock(title, subs, outgoing) {
  const wrap = document.createElement('div');
  wrap.className = 'detail-block';
  if (subs.length === 0) {
    wrap.innerHTML = `<h4>${title}</h4><p class="muted">-</p>`;
    return wrap;
  }
  wrap.innerHTML = `<h4>${title}</h4>` + subs.map((s) => {
    const other = outgoing ? (s.target_name ?? s.target_raw ?? '?') : (s.submitter_name ?? '?');
    const role = s.role_canonical ?? s.role_raw ?? '?';
    const c = roleColor(s.role_canonical);
    return `<div class="detail-row"><span class="dot" style="background:${c}"></span>` +
      `<span>${escapeHtml(ROLE_LABEL[s.role_canonical] ?? role)} <b>${escapeHtml(other)}</b>` +
      `${s.needs_review ? ' <span class="review-tag">review</span>' : ''}</span></div>` +
      `<div class="detail-raw mono">${escapeHtml(s.raw_message)}</div>`;
  }).join('');
  return wrap;
}

function renderList() {
  bodyEl.innerHTML = '';
  const rows = [...state.subs].sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));
  if (rows.length === 0) {
    bodyEl.innerHTML = '<tr><td colspan="7" class="empty">No submissions yet.</td></tr>';
    return;
  }
  for (const s of rows) {
    const tr = document.createElement('tr');
    const add = (t, cls) => { const td = document.createElement('td'); if (cls) td.className = cls; td.textContent = t; tr.appendChild(td); };
    add(String(s.night_number));
    add(s.channel_name ? `#${s.channel_name}` : '');
    add(s.submitter_name ?? 'unlinked');
    add(s.role_canonical ?? `${s.role_raw ?? '?'} (unresolved)`, s.role_canonical ? '' : 'unresolved');
    add(s.target_name ?? `${s.target_raw ?? '?'} (unresolved)`, s.target_name ? '' : 'unresolved');
    add(s.raw_message, 'raw-message');
    const time = new Date(s.submitted_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    add(s.needs_review ? `${time} (review)` : time);
    bodyEl.appendChild(tr);
  }
}

function draw() {
  renderNightTabs();
  if (state.listMode) {
    webViewEl.hidden = true; listViewEl.hidden = false;
    viewToggleEl.textContent = 'Graph view';
    renderList();
  } else {
    webViewEl.hidden = false; listViewEl.hidden = true;
    viewToggleEl.textContent = 'List view';
    drawGraph();
  }
  const acted = new Set(state.subs.filter((s) => s.night_number === state.night).map((s) => s.submitter_player_id).filter(Boolean)).size;
  statusEl.textContent = `Unlocked - Night ${state.night ?? '-'} - ${acted}/${state.roster.length} submitted (updates every ${POLL_INTERVAL_MS / 1000}s)`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- lifecycle -----------------------------------------------------------

function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

function lockAgain(message) {
  stopPolling();
  boardEl.hidden = true;
  gateEl.hidden = false;
  if (message) gateErrorEl.textContent = message;
}

function applyData(data) {
  state.roster = data.roster;
  state.subs = data.subs;
  const nights = nightsFromSubs(state.subs);
  if (state.night == null || !nights.includes(state.night)) {
    state.night = nights.length ? nights[nights.length - 1] : 1;
  }
  draw();
}

async function unlock() {
  const gameId = gameSelectEl.value;
  const pin = pinInputEl.value.trim();
  gateErrorEl.textContent = '';
  if (!pin) { gateErrorEl.textContent = 'Enter the game PIN.'; return; }

  let data;
  try { data = await fetchData(gameId, pin); }
  catch { gateErrorEl.textContent = 'Wrong PIN for this game.'; return; }

  state.gameId = gameId; state.pin = pin;
  gateEl.hidden = true; boardEl.hidden = false;
  applyData(data);

  stopPolling();
  pollTimer = setInterval(async () => {
    try { applyData(await fetchData(gameId, pin)); }
    catch { lockAgain('Access ended (PIN may have changed). Enter the PIN again.'); }
  }, POLL_INTERVAL_MS);
}

unlockBtnEl.addEventListener('click', unlock);
pinInputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });
viewToggleEl.addEventListener('click', () => { state.listMode = !state.listMode; draw(); });

loadGames();
