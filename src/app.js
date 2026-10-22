import { createServer } from 'node:http';
import { randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createLogReader } from './log-reader.js';
import { createEventPusher, PushEventError, readJsonRequest } from './push-event.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/logs', ['index.html', 'text/html; charset=utf-8']],
  ['/logs/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/logs/reader.js', ['reader.js', 'text/javascript; charset=utf-8']],
  ['/push-event', ['push-event.html', 'text/html; charset=utf-8']],
  ['/push-event/form.js', ['push-event.js', 'text/javascript; charset=utf-8']],
  ['/push-event/style.css', ['push-event.css', 'text/css; charset=utf-8']],
].map(([path, [file, type]]) => [path, { content: readFileSync(new URL(`./public/${file}`, import.meta.url)), type }]));

const pick = (items) => items[randomInt(items.length)];
const routes = {
  '/users': () => ({ id: randomUUID(), name: pick(['Alex', 'Sam', 'Jordan', 'Taylor']), online: Boolean(randomInt(2)) }),
  '/products': () => ({ id: randomUUID(), name: pick(['Keyboard', 'Monitor', 'Headphones']), price: randomInt(1000, 30000) / 100, currency: 'USD', stock: randomInt(100) }),
  '/orders': () => ({ id: randomUUID(), status: pick(['pending', 'shipped', 'delivered']), total: randomInt(1000, 50000) / 100, currency: 'USD', items: randomInt(1, 6) }),
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function createApp({ log = () => {}, readLogs = createLogReader(), sendRequest } = {}) {
  const pusher = createEventPusher({ readLogs, sendRequest });
  return createServer(async (req, res) => {
    const started = performance.now();
    const requestId = randomUUID();
    let path = '/';
    let caughtError;
    let readerRequest = false;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Cache-Control', 'no-store');
    res.once('finish', () => {
      // Watching the reader must not create more application logs.
      if (readerRequest) return;
      log({
        level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
        message: caughtError ? caughtError.message : 'Request completed',
        requestId, method: req.method, path,
        status: res.statusCode,
        durationMs: Number((performance.now() - started).toFixed(3)),
        ...(caughtError && res.statusCode >= 500 ? { error: { name: caughtError.name, message: caughtError.message, stack: caughtError.stack } } : {}),
      });
    });

    try {
      const url = new URL(req.url, 'http://localhost');
      path = url.pathname;
      readerRequest = assets.has(path) || path === '/logs/data' || path === '/push-event/preview';
      if ((path === '/push-event' && req.method === 'POST') || path === '/push-event/preview') {
        readerRequest = true;
        if (path === '/push-event/preview' && req.method !== 'GET') {
          res.setHeader('Allow', 'GET');
          throw new HttpError(405, 'Only GET is supported');
        }
        try {
          res.end(JSON.stringify(path === '/push-event/preview' ? await pusher.preview() : await pusher.send(await readJsonRequest(req))));
        } catch (error) {
          throw new HttpError(error instanceof PushEventError ? error.status : 503, error instanceof PushEventError ? error.message : 'Cannot load recent errors. Check log storage and try again.');
        }
        return;
      }
      if (readerRequest) {
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET');
          throw new HttpError(405, 'Only GET is supported');
        }
        if (path === '/logs/data') {
          try {
            res.end(JSON.stringify(await readLogs(url.searchParams.get('range') || '15m')));
          } catch (error) {
            throw new HttpError(error.status === 400 ? 400 : 503, error.status === 400 ? error.message : 'Cannot reach log storage. Retrying automatically.');
          }
        } else {
          const asset = assets.get(path);
          res.setHeader('Content-Type', asset.type);
          res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.end(asset.content);
        }
        return;
      }
      if (!Object.hasOwn(routes, path)) throw new HttpError(404, 'Endpoint not found');
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        throw new HttpError(405, 'Only GET is supported');
      }
      if (url.searchParams.get('error') === 'true') {
        const status = url.searchParams.get('status') ?? '500';
        if (!['500', '503'].includes(status)) throw new HttpError(400, 'Error status must be 500 or 503');
        // Actually throw: the shared handler returns JSON and records the stack in Loki.
        throw new HttpError(Number(status), status === '503' ? 'Simulated service unavailable' : 'Simulated internal server error');
      }
      res.end(JSON.stringify({ success: true, requestId, timestamp: new Date().toISOString(), data: routes[path]() }));
    } catch (error) {
      caughtError = error;
      res.statusCode = error instanceof HttpError ? error.status : 500;
      res.end(JSON.stringify({ success: false, requestId, error: { status: res.statusCode, message: error instanceof HttpError ? error.message : 'Internal server error' } }));
    }
  });
}
