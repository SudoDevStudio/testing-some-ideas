import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { createEventPusher } from '../src/push-event.js';
import { createLogReader } from '../src/log-reader.js';

async function listen(server, t) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function fixtureLogs() {
  const now = Date.now();
  const record = (age, status, durationMs) => ({ timestamp: new Date(now - age).toISOString(), level: status >= 500 ? 'error' : 'info', status, durationMs, path: '/orders', requestId: `request-${status}`, error: status >= 500 ? { stack: `HttpError: ${status}` } : undefined });
  return { updatedAt: new Date(now).toISOString(), persistent: true, entries: [record(1000, 503, 4), record(2000, 500, 2), record(3000, 200, 1), record(301000, 503, 5)] };
}

test('form previews last-five-minute errors and posts that exact snapshot with custom headers to a real receiver', async (t) => {
  const received = [];
  const receiver = await listen(createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({ method: req.method, headers: req.headers, body: JSON.parse(body) });
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end('{"accepted":true}');
  }), t);
  const appLogs = [];
  let query;
  const base = await listen(createApp({ log: (entry) => appLogs.push(entry), readLogs: async (...args) => { query = args; return fixtureLogs(); } }), t);
  for (const path of ['/push-event', '/push-event/form.js', '/push-event/style.css']) assert.equal((await fetch(base + path)).status, 200);
  const preview = await (await fetch(base + '/push-event/preview')).json();
  assert.deepEqual(query, ['5m', { errorsOnly: true, limit: 1001 }]);
  assert.equal(preview.event.summary.errorCount, 2);
  assert.deepEqual(preview.event.summary.byStatus, { '500': 1, '503': 1 });
  assert.deepEqual(preview.event.summary.byEndpoint, { '/orders': 2 });
  assert.equal(preview.event.summary.averageDurationMs, 3);
  assert.equal(Date.parse(preview.event.window.to) - Date.parse(preview.event.window.from), 300000);
  const input = { url: receiver + '/receive', headers: { Authorization: 'Bearer test-token', 'X-Event-Test': 'yes' }, eventId: preview.event.eventId };
  const result = await fetch(base + '/push-event', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(input) });
  assert.equal(result.status, 200);
  const delivery = await result.json();
  assert.equal(delivery.delivered, true);
  assert.equal(delivery.destinationStatus, 202);
  assert.equal(delivery.response, '{"accepted":true}');
  assert.equal(received[0].headers.authorization, 'Bearer test-token');
  assert.equal(received[0].headers['x-event-test'], 'yes');
  assert.equal(received[0].headers['content-type'], 'application/json');
  assert.equal(received[0].method, 'POST');
  assert.deepEqual(received[0].body, preview.event);
  assert.equal(appLogs.length, 0, 'Destination URL and credentials must not be logged');
  assert.equal((await fetch(base + '/push-event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).status, 409);
  assert.equal(received.length, 1, 'A second click must not redeliver the same preview');
});

test('invalid input, cross-origin submission, oversized headers, and unavailable storage fail without sending', async (t) => {
  let sent = 0;
  const base = await listen(createApp({ readLogs: async () => fixtureLogs(), sendRequest: async () => { sent++; return new Response('ok'); } }), t);
  const { event } = await (await fetch(base + '/push-event/preview')).json();
  const post = (body, extraHeaders = {}) => fetch(base + '/push-event', { method: 'POST', headers: { 'Content-Type': 'application/json', ...extraHeaders }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  for (const input of [
    { url: 'file:///tmp/no', headers: {} },
    { url: 'http://user:password@example.com', headers: {} },
    { url: 'http://example.com', headers: [] },
    { url: 'http://example.com', headers: { 'Content-Length': '2' } },
    { url: 'http://example.com', headers: { Authorization: 'Bearer\ninvalid' } },
    { url: 'http://example.com', headers: { 'X-Number': 123 } },
  ]) assert.equal((await post({ ...input, eventId: event.eventId })).status, 400);
  assert.equal((await post('{')).status, 400);
  assert.equal((await post({ url: 'http://example.com', eventId: event.eventId }, { Origin: 'https://different.example' })).status, 403);
  assert.equal((await post({ url: 'http://example.com', eventId: event.eventId, headers: { Authorization: 'a'.repeat(33000) } })).status, 413);
  assert.equal((await post({}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post({ url: 'http://example.com', eventId: 'expired' })).status, 409);
  assert.equal(sent, 0);
  const offline = await listen(createApp({ readLogs: async () => { throw new Error('offline'); } }), t);
  assert.equal((await fetch(offline + '/push-event/preview')).status, 503);
});

test('event cap, empty windows, session coverage, and expiration are explicit', async () => {
  let clock = Date.now();
  const logs = fixtureLogs();
  logs.entries = Array.from({ length: 1001 }, () => logs.entries[0]);
  const pusher = createEventPusher({ readLogs: async () => logs, now: () => clock });
  const { event } = await pusher.preview();
  assert.equal(event.summary.errorCount, 1000);
  assert.equal(event.coverage.truncated, true);
  clock += 600001;
  await assert.rejects(pusher.send({ url: 'http://example.com', eventId: event.eventId }), { status: 409 });
  const empty = createEventPusher({ readLogs: async () => ({ ...fixtureLogs(), entries: [], persistent: false }) });
  const result = await empty.preview();
  assert.equal(result.event.summary.errorCount, 0);
  assert.equal(result.event.coverage.currentSessionOnly, true);
  assert.equal(result.event.summary.averageDurationMs, null);
});

test('Loki error queries filter before the limit, avoiding a busy successful stream hiding errors', async () => {
  let queried;
  const reader = createLogReader({ lokiUrl: 'http://loki:3100', fetchLogs: async (url) => {
    queried = url;
    return Response.json({ status: 'success', data: { resultType: 'streams', result: [] } });
  } });
  await reader('5m', { errorsOnly: true, limit: 1001 });
  assert.equal(queried.searchParams.get('query'), '{service_name="node-api", level="error"}');
  assert.equal(queried.searchParams.get('limit'), '1001');
  assert.equal(Date.parse(queried.searchParams.get('end')) - Date.parse(queried.searchParams.get('start')), 300000);
});

test('upstream errors are reported, response sizes are bounded, and redirects never forward credentials', async (t) => {
  let redirected = 0;
  const base = await listen(createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/private' }); res.end(); }
    else if (req.url === '/private') { redirected++; res.end('should not be reached'); }
    else { res.writeHead(422); res.end('x'.repeat(20000)); }
  }), t);
  const pusher = createEventPusher({ readLogs: async () => fixtureLogs() });
  const preview = await pusher.preview();
  const result = await pusher.send({ url: base, eventId: preview.event.eventId });
  assert.equal(result.delivered, false);
  assert.equal(result.destinationStatus, 422);
  assert.equal(result.response.length, 4096);
  assert.equal(result.responseTruncated, true);
  const second = await pusher.preview();
  await assert.rejects(pusher.send({ url: base + '/redirect', headers: { Authorization: 'Bearer test' }, eventId: second.event.eventId }), { status: 502 });
  assert.equal(redirected, 0);
});
