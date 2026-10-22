import { randomUUID } from 'node:crypto';

const snapshotLifetime = 10 * 60_000;
const errorLimit = 1000;

export class PushEventError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function readJsonRequest(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new PushEventError(415, 'Send application/json');
  if (req.headers.origin) {
    let origin;
    try { origin = new URL(req.headers.origin); } catch { throw new PushEventError(403, 'Invalid request origin'); }
    if (origin.host !== req.headers.host) throw new PushEventError(403, 'Send events from this application');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= 32768) chunks.push(chunk);
  }
  if (size > 32768) throw new PushEventError(413, 'URL and headers must fit within 32 KiB');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new PushEventError(400, 'Request body must be valid JSON'); }
}

function destination(input) {
  let url;
  try { url = new URL(input.url); } catch { throw new PushEventError(400, 'Enter a valid destination URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new PushEventError(400, 'Use an HTTP or HTTPS URL, with credentials in headers');
  if (input.headers === null || typeof input.headers !== 'object' || Array.isArray(input.headers)) throw new PushEventError(400, 'Headers must be a JSON object of string values');
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const blocked = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'trailer', 'expect']);
  try {
    for (const [key, value] of Object.entries(input.headers)) {
      if (blocked.has(key.toLowerCase())) throw new Error();
      if (typeof value !== 'string') throw new Error();
      headers.set(key, value);
    }
  } catch { throw new PushEventError(400, 'Use valid header names and string values; transport headers are managed automatically'); }
  return { url, headers };
}

async function responseExcerpt(response) {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size <= 4096) {
      const { value, done } = await reader.read();
      if (done) return { text: Buffer.concat(chunks).toString('utf8'), truncated: false };
      const remaining = 4096 - size;
      chunks.push(Buffer.from(value.slice(0, remaining)));
      size += value.length;
    }
    return { text: Buffer.concat(chunks).toString('utf8'), truncated: true };
  } finally { await reader.cancel().catch(() => {}); }
}

export function createEventPusher({ readLogs, sendRequest = fetch, now = Date.now } = {}) {
  const snapshots = new Map();
  const clean = () => {
    for (const [id, snapshot] of snapshots) if (snapshot.expires <= now()) snapshots.delete(id);
  };
  return {
    async preview() {
      const logs = await readLogs('5m', { errorsOnly: true, limit: errorLimit + 1 });
      const end = Date.parse(logs.updatedAt);
      const start = end - 5 * 60_000;
      const matching = logs.entries.filter((entry) => Date.parse(entry.timestamp) >= start && Date.parse(entry.timestamp) <= end && (entry.level === 'error' || Number(entry.status) >= 500));
      const errors = matching.slice(0, errorLimit);
      const byStatus = {};
      const byEndpoint = {};
      for (const entry of errors) {
        const status = String(entry.status ?? 'unknown');
        const endpoint = entry.path || 'unknown';
        byStatus[status] = (byStatus[status] || 0) + 1;
        byEndpoint[endpoint] = (byEndpoint[endpoint] || 0) + 1;
      }
      const durations = errors.map((entry) => entry.durationMs).filter((value) => typeof value === 'number' && Number.isFinite(value));
      const event = {
        eventId: randomUUID(), type: 'application.errors', service: 'node-api',
        createdAt: logs.updatedAt,
        window: { from: new Date(start).toISOString(), to: new Date(end).toISOString(), minutes: 5 },
        summary: { errorCount: errors.length, byStatus, byEndpoint, averageDurationMs: durations.length ? Number((durations.reduce((sum, value) => sum + value, 0) / durations.length).toFixed(3)) : null },
        coverage: { source: logs.persistent ? 'loki' : 'current-session', limit: errorLimit, truncated: matching.length > errorLimit, currentSessionOnly: !logs.persistent },
        errors,
      };
      clean();
      while (snapshots.size >= 50) snapshots.delete(snapshots.keys().next().value);
      const expires = now() + snapshotLifetime;
      snapshots.set(event.eventId, { event, expires, sending: false });
      return { event, expiresAt: new Date(expires).toISOString() };
    },
    async send(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PushEventError(400, 'Provide a destination, headers, and preview eventId');
      const { url, headers } = destination({ ...input, headers: input.headers ?? {} });
      clean();
      const snapshot = snapshots.get(input.eventId);
      if (!snapshot) throw new PushEventError(409, 'Preview expired or missing. Load a fresh preview before sending.');
      if (snapshot.sending) throw new PushEventError(409, 'This event is already being sent');
      snapshot.sending = true;
      try {
        const response = await sendRequest(url, {
          method: 'POST', headers, body: JSON.stringify(snapshot.event),
          redirect: 'error', signal: AbortSignal.timeout(15000),
        });
        // Once a destination responds, a second click must not send this snapshot again.
        snapshots.delete(input.eventId);
        const excerpt = await responseExcerpt(response).catch(() => ({ text: 'Response body could not be read', truncated: true }));
        return { delivered: response.ok, destinationStatus: response.status, eventId: input.eventId, errorCount: snapshot.event.summary.errorCount, response: excerpt.text, responseTruncated: excerpt.truncated };
      } catch {
        // A timeout can happen after delivery. Never automatically retry an ambiguous send.
        snapshots.delete(input.eventId);
        throw new PushEventError(502, 'Could not confirm delivery. The destination may have received the event. Check it before loading a new preview and retrying. Redirects are not followed.');
      }
    },
  };
}
