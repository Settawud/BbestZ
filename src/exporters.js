/**
 * Serializers for taking a captured log off the panel: HAR 1.2 (importable
 * back into DevTools, Insomnia, Postman…) and a flatter JSON shape that is
 * nicer to read in a diff or paste into a bug report.
 */

import { redactHeaders } from './har.js';
import { parseBody } from './har.js';

export const EXPORT_VERSION = '1.0.0';

function exportBody(text, mimeType) {
  const parsed = parseBody(text, mimeType);
  if (parsed.kind === 'empty') return null;
  if (parsed.kind === 'json') return parsed.value;
  if (parsed.kind === 'form') return Object.fromEntries(parsed.value.map((p) => [p.name, p.value]));
  return parsed.text;
}

/**
 * HAR 1.2 log. Timings default to -1 ("not available") as the spec requires,
 * and `headersSize`/`bodySize` are -1 because we never saw the raw bytes.
 */
export function toHar(records, options = {}) {
  const { redact = true, creatorName = 'API Log', creatorVersion = EXPORT_VERSION } = options;

  return {
    log: {
      version: '1.2',
      creator: { name: creatorName, version: creatorVersion },
      pages: [],
      entries: (records ?? []).map((record) => ({
        startedDateTime: record.startedAt ?? new Date(0).toISOString(),
        time: typeof record.time === 'number' ? record.time : -1,
        request: {
          method: record.method,
          url: record.url,
          httpVersion: record.httpVersion || 'HTTP/1.1',
          cookies: [],
          headers: redactHeaders(record.requestHeaders, redact),
          queryString: record.queryString ?? [],
          headersSize: -1,
          bodySize: record.requestBody?.text ? record.requestBody.text.length : 0,
          ...(record.requestBody
            ? {
                postData: {
                  mimeType: record.requestBody.mimeType || 'application/octet-stream',
                  text: record.requestBody.text,
                  ...(record.requestBody.params?.length
                    ? { params: record.requestBody.params }
                    : {}),
                },
              }
            : {}),
        },
        response: {
          status: record.status,
          statusText: record.statusText,
          httpVersion: record.httpVersion || 'HTTP/1.1',
          cookies: [],
          headers: redactHeaders(record.responseHeaders, redact),
          content: {
            size: record.responseSize ?? 0,
            mimeType: record.responseMimeType || 'application/octet-stream',
            ...(record.responseBody != null ? { text: record.responseBody } : {}),
            ...(record.responseEncoding ? { encoding: record.responseEncoding } : {}),
          },
          redirectURL: '',
          headersSize: -1,
          bodySize: record.responseSize ?? -1,
        },
        cache: {},
        timings: {
          blocked: -1,
          dns: -1,
          connect: -1,
          send: -1,
          wait: -1,
          receive: -1,
          ssl: -1,
          ...(record.timings ?? {}),
        },
        ...(record.serverIP ? { serverIPAddress: record.serverIP } : {}),
        _resourceType: record.resourceType,
      })),
    },
  };
}

/** Compact, human-first JSON: parsed bodies, headers as objects. */
export function toJsonLog(records, options = {}) {
  const { redact = true } = options;
  const headersObject = (headers) =>
    Object.fromEntries(redactHeaders(headers, redact).map((h) => [h.name, h.value]));

  return {
    exportedAt: new Date().toISOString(),
    exporter: `API Log ${EXPORT_VERSION}`,
    redacted: redact,
    count: (records ?? []).length,
    requests: (records ?? []).map((record) => ({
      startedAt: record.startedAt,
      durationMs: record.time,
      method: record.method,
      url: record.url,
      status: record.status,
      statusText: record.statusText,
      resourceType: record.resourceType,
      responseSize: record.responseSize,
      requestHeaders: headersObject(record.requestHeaders),
      requestBody: record.requestBody
        ? exportBody(record.requestBody.text, record.requestBody.mimeType)
        : null,
      responseHeaders: headersObject(record.responseHeaders),
      responseBody: exportBody(record.responseBody, record.responseMimeType),
      ...(record.error ? { error: record.error } : {}),
    })),
  };
}

/** `api-log-example.com-20260103-141530.har` */
export function exportFilename(extension, host = '') {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const safeHost = String(host).replace(/[^a-zA-Z0-9._-]/g, '') || 'log';
  return `api-log-${safeHost}-${stamp}.${extension}`;
}
