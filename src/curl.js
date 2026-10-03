/**
 * Rebuild a replayable `curl` command from a captured record.
 * The whole point is being able to paste it into a terminal and re-run the
 * exact call that just failed, so quoting correctness matters here.
 */

import { HOP_BY_HOP_HEADERS, SECRET_HEADERS } from './har.js';

/** POSIX single-quote a value: close the quote, escape, reopen. */
export function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {object} record  a panel record
 * @param {object} [options]
 * @param {boolean} [options.multiline=true]   break the command over lines
 * @param {boolean} [options.redact=false]     mask Authorization/Cookie/etc.
 * @param {boolean} [options.compressed=true]  add --compressed
 * @returns {string}
 */
export function toCurl(record, options = {}) {
  const { multiline = true, redact = false, compressed = true } = options;
  const method = String(record?.method ?? 'GET').toUpperCase();
  const body = record?.requestBody?.text ?? '';
  const parts = [`curl ${shellQuote(record?.url ?? '')}`];

  // curl implies POST once a body is attached, so GET-with-body needs -X too.
  if (method !== 'GET' || body) parts.push(`-X ${method}`);

  for (const header of record?.requestHeaders ?? []) {
    const name = header.name.toLowerCase();
    if (name.startsWith(':') || HOP_BY_HOP_HEADERS.has(name)) continue;
    const value = redact && SECRET_HEADERS.has(name) ? '[REDACTED]' : header.value;
    parts.push(`-H ${shellQuote(`${header.name}: ${value}`)}`);
  }

  if (body) parts.push(`--data-raw ${shellQuote(body)}`);
  if (compressed) parts.push('--compressed');

  return multiline ? parts.join(' \\\n  ') : parts.join(' ');
}
