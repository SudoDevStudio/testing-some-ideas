import { createServer } from 'node:http';
import { randomInt, randomUUID } from 'node:crypto';

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

export function createApp({ log = () => {} } = {}) {
  return createServer((req, res) => {
    const started = performance.now();
    const requestId = randomUUID();
    let path = '/';
    let caughtError;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Cache-Control', 'no-store');
    res.once('finish', () => {
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
