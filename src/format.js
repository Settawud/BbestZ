/**
 * Pure formatting helpers shared by the DevTools panel and the exporters.
 * Nothing here touches the DOM or the `chrome.*` APIs, so it is unit-testable
 * under plain Node.
 */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Human-readable byte count. Returns '—' for unknown/invalid sizes. */
export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || Number.isNaN(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 || value >= 100 ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded} ${BYTE_UNITS[unit]}`;
}

/** Human-readable duration in milliseconds. Returns '—' for unknown values. */
export function formatMs(ms) {
  if (typeof ms !== 'number' || Number.isNaN(ms) || ms < 0) return '—';
  if (ms === 0) return '0 ms';
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Bucket an HTTP status code into a CSS/filter class.
 * Status 0 means the request never completed (blocked, CORS, DNS, offline).
 */
export function statusClass(status) {
  if (typeof status !== 'number' || Number.isNaN(status) || status <= 0) return 'failed';
  if (status < 200) return 'info';
  if (status < 300) return 'ok';
  if (status < 400) return 'redirect';
  if (status < 500) return 'client-error';
  return 'server-error';
}

/** A request counts as an error when it failed outright or answered 4xx/5xx. */
export function isError(record) {
  const status = record?.status;
  return !status || status <= 0 || status >= 400;
}

/** Split a URL into display parts, tolerating malformed input. */
export function splitUrl(url) {
  const raw = String(url ?? '');
  try {
    const parsed = new URL(raw);
    return {
      origin: parsed.origin,
      host: parsed.host,
      path: parsed.pathname,
      query: parsed.search,
      display: `${parsed.pathname}${parsed.search}` || '/',
    };
  } catch {
    const [path, query = ''] = raw.split('?');
    return {
      origin: '',
      host: '',
      path,
      query: query ? `?${query}` : '',
      display: raw || '/',
    };
  }
}

/** Local wall-clock time (HH:MM:SS.mmm) for an ISO timestamp. */
export function formatTime(isoString) {
  if (!isoString) return '—';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** Shorten a long string for table cells, keeping the tail visible. */
export function truncateMiddle(text, max = 120) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

/** Percentage string used by the timing bars and endpoint stats. */
export function formatPercent(ratio) {
  if (typeof ratio !== 'number' || Number.isNaN(ratio)) return '—';
  const percent = ratio * 100;
  if (percent > 0 && percent < 1) return '<1%';
  return `${Math.round(percent)}%`;
}
