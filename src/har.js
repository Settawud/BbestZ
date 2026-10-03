/**
 * Translation layer between Chrome's HAR entries (what
 * `chrome.devtools.network.onRequestFinished` hands us) and the flat record
 * shape the panel renders.
 */

/** Header names curl must not receive verbatim — it computes them itself. */
export const HOP_BY_HOP_HEADERS = new Set([
  'content-length',
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'http2-settings',
]);

/** Headers worth masking before a log leaves the machine. */
export const SECRET_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
]);

/** Resource types that represent an API call rather than a page asset. */
export const API_RESOURCE_TYPES = new Set(['xhr', 'fetch', 'eventsource', 'websocket']);

const ID_SEGMENT =
  /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24}|[0-9a-f]{32,})$/i;

/**
 * HTTP/2 exposes pseudo-headers (`:method`, `:path`) that are not real headers.
 * Drop those and normalize everything else to `{ name, value }`.
 */
export function cleanHeaders(headers) {
  if (!Array.isArray(headers)) return [];
  return headers
    .filter((header) => header && typeof header.name === 'string' && !header.name.startsWith(':'))
    .map((header) => ({ name: header.name, value: String(header.value ?? '') }));
}

/** Case-insensitive header lookup. */
export function headerValue(headers, name) {
  const wanted = String(name).toLowerCase();
  const hit = (headers ?? []).find((header) => header.name.toLowerCase() === wanted);
  return hit ? hit.value : null;
}

/** Replace secret header values with a placeholder. */
export function redactHeaders(headers, redact = true) {
  if (!redact) return cleanHeaders(headers);
  return cleanHeaders(headers).map((header) =>
    SECRET_HEADERS.has(header.name.toLowerCase())
      ? { name: header.name, value: '[REDACTED]' }
      : header,
  );
}

function pickResponseSize(response) {
  const content = response?.content ?? {};
  if (typeof content.size === 'number' && content.size >= 0) return content.size;
  if (typeof response?.bodySize === 'number' && response.bodySize >= 0) return response.bodySize;
  return 0;
}

function numberOrNull(value) {
  return typeof value === 'number' && !Number.isNaN(value) && value >= 0 ? value : null;
}

/**
 * Chrome sets `_resourceType`; other browsers may not. Fall back to the MIME
 * type so the "API only" filter still behaves sensibly.
 */
function guessResourceType(mimeType) {
  const mime = String(mimeType ?? '').toLowerCase();
  if (!mime) return 'other';
  if (mime.includes('json') || mime.includes('graphql')) return 'xhr';
  if (mime.includes('html')) return 'document';
  if (mime.includes('css')) return 'stylesheet';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('font/') || mime.includes('woff')) return 'font';
  if (mime.startsWith('audio/') || mime.startsWith('video/')) return 'media';
  if (mime.includes('javascript')) return 'script';
  if (mime.includes('event-stream')) return 'eventsource';
  return 'other';
}

/** Build a panel record from a HAR entry. `responseBody` is filled in later. */
export function toRecord(entry, id) {
  const request = entry?.request ?? {};
  const response = entry?.response ?? {};
  const postData = request.postData;
  const transferSize = numberOrNull(response._transferSize);
  const status = typeof response.status === 'number' ? response.status : 0;

  return {
    id,
    startedAt: entry?.startedDateTime ?? null,
    time: numberOrNull(entry?.time),
    method: String(request.method ?? 'GET').toUpperCase(),
    url: String(request.url ?? ''),
    resourceType: entry?._resourceType ?? guessResourceType(response?.content?.mimeType),
    status,
    statusText: String(response.statusText ?? ''),
    httpVersion: String(response.httpVersion ?? ''),
    requestHeaders: cleanHeaders(request.headers),
    responseHeaders: cleanHeaders(response.headers),
    queryString: Array.isArray(request.queryString) ? request.queryString : [],
    requestBody: postData
      ? {
          mimeType: String(postData.mimeType ?? ''),
          text: String(postData.text ?? ''),
          params: Array.isArray(postData.params) ? postData.params : [],
        }
      : null,
    responseMimeType: String(response?.content?.mimeType ?? ''),
    responseSize: pickResponseSize(response),
    transferSize,
    responseBody: null,
    responseEncoding: null,
    bodyPending: true,
    fromCache: transferSize === 0 && status > 0,
    timings: entry?.timings ?? null,
    serverIP: String(entry?.serverIPAddress ?? ''),
    error: response._error ?? null,
  };
}

function looksLikeJsonMime(mime) {
  return mime.includes('json') || mime.endsWith('+json') || mime.includes('graphql');
}

function looksLikeJsonText(text) {
  const head = text.trimStart().charAt(0);
  return head === '{' || head === '[';
}

function isTextualMime(mime) {
  if (!mime) return true;
  return (
    mime.startsWith('text/') ||
    looksLikeJsonMime(mime) ||
    mime.includes('xml') ||
    mime.includes('javascript') ||
    mime.includes('urlencoded') ||
    mime.includes('event-stream')
  );
}

/**
 * Classify and (where possible) parse a body.
 * Returns `{ kind, text, value, parseError? }` where kind is one of
 * `empty` | `json` | `form` | `text` | `binary`.
 */
export function parseBody(text, mimeType = '') {
  if (text == null || text === '') return { kind: 'empty', text: '', value: null };
  const body = String(text);
  const mime = String(mimeType ?? '')
    .toLowerCase()
    .split(';')[0]
    .trim();

  if (looksLikeJsonMime(mime) || (!mime && looksLikeJsonText(body))) {
    try {
      return { kind: 'json', text: body, value: JSON.parse(body) };
    } catch (error) {
      return { kind: 'text', text: body, value: null, parseError: error.message };
    }
  }

  if (mime.includes('urlencoded')) {
    return {
      kind: 'form',
      text: body,
      value: [...new URLSearchParams(body)].map(([name, value]) => ({ name, value })),
    };
  }

  if (isTextualMime(mime)) return { kind: 'text', text: body, value: null };
  return { kind: 'binary', text: body, value: null };
}

/**
 * Collapse volatile path segments (ids, uuids, object ids) so repeated calls to
 * the same endpoint group together: `/users/42/posts` → `/users/:id/posts`.
 */
export function normalizeEndpoint(url) {
  const raw = String(url ?? '');
  try {
    const parsed = new URL(raw);
    const path = parsed.pathname
      .split('/')
      .map((segment) => (ID_SEGMENT.test(segment) ? ':id' : segment))
      .join('/');
    return `${parsed.origin}${path || '/'}`;
  } catch {
    return raw.split('?')[0];
  }
}
