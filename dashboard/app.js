import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const statusEl = document.getElementById('status');
const bodyEl = document.getElementById('submissions-body');

if (SUPABASE_URL.includes('YOUR-PROJECT') || SUPABASE_ANON_KEY.includes('YOUR-ANON-KEY')) {
  statusEl.textContent = 'Not configured yet - fill in dashboard/config.js with your Supabase project details.';
  statusEl.classList.add('needs-review');
  throw new Error('dashboard/config.js is still using placeholder values');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const SUBMISSION_SELECT = `
  id, night_number, channel_name, raw_message, role_raw, role_canonical,
  target_raw, needs_review, submitted_at,
  submitter:submitter_player_id (display_name),
  target:target_player_id (display_name)
`;

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

  const submitterName = row.submitter?.display_name ?? 'Discord user (unlinked)';
  const roleDisplay = row.role_canonical ?? `${row.role_raw ?? '?'} (unresolved)`;
  const targetDisplay = row.target?.display_name ?? `${row.target_raw ?? '?'} (unresolved)`;

  tr.appendChild(cell(String(row.night_number)));
  tr.appendChild(cell(row.channel_name ? `#${row.channel_name}` : ''));
  tr.appendChild(cell(submitterName));
  tr.appendChild(cell(roleDisplay, row.role_canonical ? '' : 'unresolved'));
  tr.appendChild(cell(targetDisplay, row.target?.display_name ? '' : 'unresolved'));
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

async function loadInitial() {
  const { data, error } = await supabase
    .from('submissions')
    .select(SUBMISSION_SELECT)
    .order('submitted_at', { ascending: false });

  if (error) {
    statusEl.textContent = `Failed to load submissions: ${error.message}`;
    return;
  }
  renderAll(data);
  statusEl.textContent = `Live - ${data.length} submission${data.length === 1 ? '' : 's'}`;
}

function subscribeToChanges() {
  supabase
    .channel('submissions-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'submissions' }, () => {
      loadInitial();
    })
    .subscribe();
}

loadInitial();
subscribeToChanges();
