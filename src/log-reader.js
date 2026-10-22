const ranges = { '5m': 5 * 60_000, '15m': 15 * 60_000, '1h': 60 * 60_000, '24h': 24 * 60 * 60_000 };

export function createLogReader({ lokiUrl, recentLogs = () => [], fetchLogs = fetch } = {}) {
  return async (range = '15m', { errorsOnly = false, limit = 500 } = {}) => {
    const duration = ranges[range];
    if (!duration) {
      const error = new Error('Choose 5m, 15m, 1h, or 24h');
      error.status = 400;
      throw error;
    }
    const now = Date.now();
    let entries;
    if (lokiUrl) {
      const url = new URL('/loki/api/v1/query_range', lokiUrl);
      url.search = new URLSearchParams({
        query: errorsOnly ? '{service_name="node-api", level="error"}' : '{service_name="node-api"}',
        start: new Date(now - duration).toISOString(),
        end: new Date(now).toISOString(),
        limit: String(limit), direction: 'backward',
      });
      const response = await fetchLogs(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Log storage is unavailable');
      const body = await response.json();
      if (body.status !== 'success' || body.data?.resultType !== 'streams') throw new Error('Invalid log storage response');
      entries = body.data.result.flatMap((stream) => stream.values.flatMap(([timestamp, line]) => {
        try {
          const entry = JSON.parse(line);
          return entry && typeof entry === 'object' && !Array.isArray(entry) ? [{ ...entry, timestamp: entry.timestamp || new Date(Number(BigInt(timestamp) / 1000000n)).toISOString() }] : [];
        } catch { return []; }
      }));
    } else {
      entries = recentLogs().filter((entry) => Date.parse(entry.timestamp) >= now - duration && Date.parse(entry.timestamp) <= now);
    }
    if (errorsOnly) entries = entries.filter((entry) => entry.level === 'error' || Number(entry.status) >= 500);
    entries.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    return { entries: entries.slice(0, limit), limit, updatedAt: new Date(now).toISOString(), persistent: Boolean(lokiUrl) };
  };
}
