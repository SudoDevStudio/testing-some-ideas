import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';

test('three endpoints return random JSON, simulate errors, and recover', async (t) => {
  const logs = [];
  const server = createApp({ log: (entry) => logs.push(entry) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  for (const path of ['/users', '/products', '/orders']) {
    const success = await fetch(base + path);
    assert.equal(success.status, 200);
    const body = await success.json();
    assert.equal(body.success, true);
    assert.ok(body.data.id);
    assert.equal(success.headers.get('x-request-id'), body.requestId);
    assert.notEqual((await (await fetch(base + path)).json()).data.id, body.data.id);

    for (const status of [500, 503]) {
      const response = await fetch(`${base}${path}?error=true${status === 503 ? '&status=503' : ''}`);
      assert.equal(response.status, status);
      const error = await response.json();
      assert.equal(error.success, false);
      assert.equal(error.error.status, status);
      assert.equal('stack' in error.error, false);
      const log = logs.find((entry) => entry.requestId === error.requestId);
      assert.equal(log.level, 'error');
      assert.equal(log.status, status);
      assert.equal(log.path, path);
      assert.ok(log.error.stack.includes('HttpError'));
      assert.ok(log.durationMs >= 0);
    }
    assert.equal((await fetch(base + path)).status, 200);
    assert.equal((await fetch(`${base}${path}?error=false`)).status, 200);
    assert.equal((await fetch(`${base}${path}?error=true&status=401`)).status, 400);
  }

  assert.equal((await fetch(`${base}/missing`)).status, 404);
  assert.equal((await fetch(`${base}/__proto__`)).status, 404);
  const post = await fetch(`${base}/users`, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET');
});

test('logger emits JSON to stdout and bounds the file with rotation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lan-loki-test-'));
  try {
    const file = join(directory, 'app.log');
    const output = [];
    const log = createLogger({ file, maxBytes: 150, output: { write: (line) => output.push(line) } });
    for (let i = 0; i < 5; i++) log({ level: 'info', message: `Request ${i}` });
    assert.equal(output.length, 5);
    assert.equal(JSON.parse(output[0]).service, 'node-api');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).message, 'Request 4');
    assert.equal(JSON.parse(readFileSync(`${file}.1`, 'utf8')).message, 'Request 3');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
