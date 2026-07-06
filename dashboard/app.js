import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const statusEl = document.getElementById('status');
const bodyEl = document.getElementById('submissions-body');
const gateEl = document.getElementById('gate');
const tableWrapEl = document.getElementById('table-wrap');
const gameSelectEl = document.getElementById('game-select');
const pinInputEl = document.getElementById('pin-input');
const unlockBtnEl = document.getElementById('unlock-btn');
const gateErrorEl = document.getElementById('gate-error');

const POLL_INTERVAL_MS = 10000;
let pollTimer = null;

if (SUPABASE_URL.includes('YOUR-PROJECT') || SUPABASE_ANON_KEY.includes('YOUR-ANON-KEY')) {
  statusEl.textContent = 'Not configured yet - fill in dashboard/config.js with your Supabase project details.';
  statusEl.classList.add('needs-review');
  throw new Error('dashboard/config.js is still using placeholder values');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function cell(text, className) {
  const td = document.createElement('td');
  if (className) td.className = className;
  td.textContent = text;
  return td;
}

function renderRow(row) {
  const tr = document.createElement('tr');

  const submitterName = row.submitter_name ?? 'Discord user (unlinked)';
  const roleDisplay = row.role_canonical ?? `${row.role_raw ?? '?'} (unresolved)`;
  const targetDisplay = row.target_name ?? `${row.target_raw ?? '?'} (unresolved)`;

  tr.appendChild(cell(String(row.night_number)));
  tr.appendChild(cell(row.channel_name ? `#${row.channel_name}` : ''));
  tr.appendChild(cell(submitterName));
  tr.appendChild(cell(roleDisplay, row.role_canonical ? '' : 'unresolved'));
  tr.appendChild(cell(targetDisplay, row.target_name ? '' : 'unresolved'));
  tr.appendChild(cell(row.raw_message, 'raw-message'));

  const timeCell = cell(formatTime(row.submitted_at));
  if (row.needs_review) {
    const badge = document.createElement('span');
    badge.className = 'needs-review';
    badge.textContent = ' needs review';
    timeCell.appendChild(badge);
  }
  tr.appendChild(timeCell);

  return tr;
}

function renderAll(rows) {
  bodyEl.innerHTML = '';
  if (rows.length === 0) {
    bodyEl.innerHTML = '<tr><td colspan="7" class="empty">No submissions yet.</td></tr>';
    return;
  }
  for (const row of rows) {
    bodyEl.appendChild(renderRow(row));
  }
}

async function loadGames() {
  const { data, error } = await supabase.rpc('list_games');
  if (error) {
    gateErrorEl.textContent = `Could not load games: ${error.message}`;
    return;
  }
  gameSelectEl.innerHTML = '';
  for (const game of data) {
    const opt = document.createElement('option');
    opt.value = game.id;
    opt.textContent = game.is_active ? `${game.name} (active)` : game.name;
    gameSelectEl.appendChild(opt);
  }
  if (data.length === 0) {
    gateErrorEl.textContent = 'No games created yet.';
    unlockBtnEl.disabled = true;
  }
}

// Fetches submissions for the given game + PIN. Returns the rows, or throws
// on a bad PIN (so the caller can stop and show the gate again).
async function fetchSubmissions(gameId, pin) {
  const { data, error } = await supabase.rpc('dashboard_submissions', {
    p_game_id: gameId,
    p_pin: pin,
  });
  if (error) throw error;
  return data;
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function lockAgain(message) {
  stopPolling();
  tableWrapEl.hidden = true;
  gateEl.hidden = false;
  if (message) gateErrorEl.textContent = message;
}

async function unlock() {
  const gameId = gameSelectEl.value;
  const pin = pinInputEl.value.trim();
  gateErrorEl.textContent = '';

  if (!pin) {
    gateErrorEl.textContent = 'Enter the game PIN.';
    return;
  }

  let rows;
  try {
    rows = await fetchSubmissions(gameId, pin);
  } catch (err) {
    // The function raises on a wrong PIN; treat any error here as "denied"
    // rather than leaking details.
    gateErrorEl.textContent = 'Wrong PIN for this game.';
    return;
  }

  gateEl.hidden = true;
  tableWrapEl.hidden = false;
  renderAll(rows);
  statusEl.textContent = `Unlocked - ${rows.length} submission${rows.length === 1 ? '' : 's'} (updates every ${POLL_INTERVAL_MS / 1000}s)`;

  // Keep refreshing. If the PIN stops working (e.g. it was changed), fall
  // back to the gate instead of silently showing stale data.
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const fresh = await fetchSubmissions(gameId, pin);
      renderAll(fresh);
      statusEl.textContent = `Unlocked - ${fresh.length} submission${fresh.length === 1 ? '' : 's'} (updates every ${POLL_INTERVAL_MS / 1000}s)`;
    } catch (err) {
      lockAgain('Access ended (PIN may have changed). Enter the PIN again.');
    }
  }, POLL_INTERVAL_MS);
}

unlockBtnEl.addEventListener('click', unlock);
pinInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') unlock();
});

loadGames();
