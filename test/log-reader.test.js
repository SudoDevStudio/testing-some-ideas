import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { createLogReader } from '../src/log-reader.js';

test('reader queries Loki with a bounded time range and merges severity streams newest first', async () => {
  let requested;
  const read = createLogReader({
    lokiUrl: 'http://loki:3100',
    fetchLogs: async (url) => {
      requested = url;
      return Response.json({ status: 'success', data: { resultType: 'streams', result: [
        { values: [['1000000', JSON.stringify({ timestamp: '2026-10-22T10:00:00Z', status: 200 })], ['1000001', 'malformed']] },
        { values: [['2000000', JSON.stringify({ timestamp: '2026-10-22T10:01:00Z', status: 503, error: { stack: 'HttpError: test' } })]] },
      ] } });
    },
  });
  const result = await read('1h');
  assert.equal(requested.pathname, '/loki/api/v1/query_range');
  assert.equal(requested.searchParams.get('query'), '{service_name="node-api"}');
  assert.equal(requested.searchParams.get('limit'), '500');
  assert.equal(Date.parse(requested.searchParams.get('end')) - Date.parse(requested.searchParams.get('start')), 3600000);
  assert.deepEqual(result.entries.map((entry) => entry.status), [503, 200]);
  assert.equal(result.entries[0].error.stack, 'HttpError: test');
  assert.equal(result.persistent, true);
  await assert.rejects(read('unbounded'), { status: 400 });
});

test('local reader limits results to this session and requested time range', async () => {
  const read = createLogReader({ recentLogs: () => [
    { timestamp: new Date().toISOString(), message: 'current' },
    { timestamp: new Date(Date.now() - 3600000).toISOString(), message: 'old' },
  ] });
  const result = await read();
  assert.deepEqual(result.entries.map((entry) => entry.message), ['current']);
  assert.equal(result.persistent, false);
});

test('log reader serves its page, reports storage failure, and never logs its own polling requests', async (t) => {
  const logs = [];
  let unavailable = false;
  const app = createApp({ log: (entry) => logs.push(entry), readLogs: async () => {
    if (unavailable) throw new Error('upstream refused connection');
    return { entries: [{ message: '<script>alert(1)</script>', status: 503 }], persistent: true };
  } });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;
  for (const path of ['/', '/logs', '/logs/style.css', '/logs/reader.js']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.ok((await response.text()).length > 0);
    assert.ok(response.headers.get('content-security-policy').includes("script-src 'self'"));
  }
  const data = await fetch(base + '/logs/data');
  assert.equal(data.status, 200);
  assert.equal((await data.json()).entries[0].status, 503);
  unavailable = true;
  const failed = await fetch(base + '/logs/data');
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).error.message, 'Cannot reach log storage. Retrying automatically.');
  assert.equal(logs.length, 0);
  assert.equal((await fetch(base + '/users')).status, 200);
  assert.equal(logs.length, 1);
});
