const $ = (id) => document.getElementById(id);
let entries = [];
let live = true;
let level = 'all';
let loading = false;
let revision = 0;
const durations = { '15m': 900000, '1h': 3600000, '24h': 86400000 };
const isError = (entry) => entry.level === 'error' || Number(entry.status) >= 500;
const formatTime = (timestamp) => new Date(timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
const cell = (className, value) => {
  const td = document.createElement('td');
  td.className = className;
  td.textContent = value;
  return td;
};

function showDetails(entry) {
  $('detail-title').textContent = `${entry.method || 'Log'} ${entry.path || entry.service || 'node-api'}`;
  $('detail-summary').textContent = entry.message || '';
  $('attributes').replaceChildren();
  for (const key of ['timestamp', 'level', 'service', 'status', 'method', 'path', 'durationMs', 'requestId']) {
    if (entry[key] === undefined) continue;
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = String(entry[key]);
    $('attributes').append(dt, dd);
  }
  $('stack-section').hidden = !entry.error?.stack;
  $('stack').textContent = entry.error?.stack || '';
  $('raw').textContent = JSON.stringify(entry, null, 2);
  $('details').showModal();
}

function render() {
  const search = $('search').value.trim().toLowerCase();
  const endpoint = $('endpoint').value;
  const matched = entries.filter((entry) => (endpoint === 'all' || entry.path === endpoint) && (!search || JSON.stringify(entry).toLowerCase().includes(search)));
  const errors = matched.filter(isError).length;
  $('all-count').textContent = matched.length;
  $('error-count').textContent = errors;
  $('info-count').textContent = matched.filter((entry) => entry.level === 'info').length;
  const visible = matched.filter((entry) => level === 'all' || (level === 'error' ? isError(entry) : entry.level === 'info'));
  $('total').textContent = visible.length;
  $('errors').textContent = visible.filter(isError).length;
  $('rows').replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const entry of visible) {
    const tr = document.createElement('tr');
    tr.className = 'log-row';
    const badge = document.createElement('span');
    const severity = isError(entry) ? 'error' : entry.level === 'warn' ? 'warn' : 'info';
    badge.className = `badge ${severity}`;
    badge.textContent = entry.level || 'info';
    const levelCell = cell('', '');
    levelCell.append(badge);
    const message = cell('message', '');
    const open = document.createElement('button');
    open.className = 'log-open';
    open.textContent = entry.message || '(No message)';
    open.title = 'Inspect this log';
    open.addEventListener('click', () => showDetails(entry));
    message.append(open);
    tr.append(cell('time', formatTime(entry.timestamp)), levelCell, cell(isError(entry) ? 'status-error' : 'status-success', entry.status ?? '—'), cell('endpoint', `${entry.method || ''} ${entry.path || '—'}`.trim()), message, cell('duration', entry.durationMs !== undefined ? `${Number(entry.durationMs).toFixed(2)} ms` : '—'));
    fragment.append(tr);
  }
  $('rows').append(fragment);
  $('empty').hidden = visible.length > 0;
  $('empty-title').textContent = entries.length ? 'No matching logs' : 'Waiting for logs';
  $('empty-message').textContent = entries.length ? 'Try another search or filter.' : 'Send an API request or generate test logs to get started.';
  $('result-count').textContent = `${visible.length} shown · latest ${entries.length} of up to 500 logs`;
  const buckets = Array.from({ length: 40 }, () => ({ count: 0, errors: 0 }));
  const now = Date.now();
  const duration = durations[$('range').value];
  for (const entry of visible) {
    const index = Math.max(0, Math.min(39, Math.floor((Date.parse(entry.timestamp) - now + duration) / duration * 40)));
    buckets[index].count++;
    if (isError(entry)) buckets[index].errors++;
  }
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  $('histogram').replaceChildren();
  for (const bucket of buckets) {
    const bar = document.createElement('div');
    bar.className = `bar${bucket.errors ? ' has-errors' : ''}`;
    bar.style.height = `${Math.max(3, bucket.count / max * 100)}%`;
    bar.title = `${bucket.count} logs, ${bucket.errors} errors`;
    $('histogram').append(bar);
  }
}

async function refresh() {
  if (loading) return;
  loading = true;
  const current = revision;
  try {
    const response = await fetch(`/logs/data?range=${encodeURIComponent($('range').value)}`, { signal: AbortSignal.timeout(8000) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || 'Unable to load logs');
    if (current !== revision) return;
    entries = body.entries;
    $('connection-error').hidden = true;
    $('session-note').hidden = body.persistent;
    $('updated').textContent = `${live ? 'Live · ' : 'Paused · '}updated ${new Date(body.updatedAt).toLocaleTimeString()}`;
    // Freeze the table while inspecting a log so focus doesn't jump on refresh.
    if (!$('details').open) render();
  } catch (error) {
    $('connection-error').hidden = false;
    $('connection-error').textContent = error.message === 'The operation was aborted due to timeout' ? 'Log storage is taking too long. Retrying automatically.' : error.message;
  } finally {
    loading = false;
    if (current !== revision) refresh();
  }
}

$('search').addEventListener('input', render);
$('endpoint').addEventListener('change', render);
$('range').addEventListener('change', () => { revision++; $('period').textContent = $('range').selectedOptions[0].textContent; refresh(); });
$('refresh').addEventListener('click', refresh);
$('live').addEventListener('click', () => {
  live = !live;
  $('live').setAttribute('aria-pressed', String(live));
  $('live-label').textContent = live ? 'Live' : 'Paused';
  $('updated').textContent = live ? 'Resuming live updates…' : 'Paused · click Live to resume';
  if (live) refresh();
});
for (const button of document.querySelectorAll('[data-level]')) {
  button.addEventListener('click', () => {
    level = button.dataset.level;
    for (const tab of document.querySelectorAll('[data-level]')) {
      tab.classList.toggle('selected', tab === button);
      tab.setAttribute('aria-pressed', String(tab === button));
    }
    render();
  });
}
$('close-details').addEventListener('click', () => $('details').close());
$('details').addEventListener('close', render);
document.addEventListener('keydown', (event) => {
  if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !$('details').open) {
    event.preventDefault(); $('search').focus();
  }
});
$('sample').addEventListener('click', async () => {
  $('sample').disabled = true;
  try {
    const results = await Promise.all(['/users', '/products?error=true', '/orders?error=true&status=503'].map((path) => fetch(path)));
    if (results.map((response) => response.status).join(',') !== '200,500,503') throw new Error('Test requests failed');
    $('notice').textContent = 'Sent 3 test requests: 200, 500, and 503. Logs should appear within a few seconds.';
    $('notice').hidden = false;
    await refresh();
  } catch (error) {
    $('notice').textContent = `Could not generate test logs: ${error.message}`;
    $('notice').hidden = false;
  } finally { $('sample').disabled = false; }
});
refresh();
setInterval(() => { if (live && !document.hidden) refresh(); }, 2000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && live) refresh(); });
