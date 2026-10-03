/**
 * Filtering rules for the request list. Kept pure so the behaviour of the
 * toolbar can be pinned down by tests instead of by clicking around.
 */

import { isError, statusClass } from './format.js';
import { API_RESOURCE_TYPES } from './har.js';

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
export const STATUS_CLASSES = ['ok', 'redirect', 'client-error', 'server-error', 'failed'];

/** A fresh, everything-visible filter set (bar the "API only" default). */
export function defaultFilters() {
  return {
    text: '',
    bodySearch: '',
    methods: new Set(),
    statusClasses: new Set(),
    onlyErrors: false,
    apiOnly: true,
  };
}

/** Everything a text search should look through, lower-cased once per call. */
function searchableText(record) {
  const headers = [...(record.requestHeaders ?? []), ...(record.responseHeaders ?? [])]
    .map((header) => `${header.name}: ${header.value}`)
    .join('\n');
  return [record.url, headers, record.requestBody?.text ?? '', record.responseBody ?? '']
    .join('\n')
    .toLowerCase();
}

/**
 * URL filter supporting a leading `-` for exclusion, mirroring the DevTools
 * Network tab: `-analytics` hides anything matching "analytics".
 */
function matchesUrlQuery(url, query) {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;
  const negated = trimmed.startsWith('-');
  const needle = negated ? trimmed.slice(1) : trimmed;
  if (!needle) return true;
  const hit = url.toLowerCase().includes(needle);
  return negated ? !hit : hit;
}

/** Does a single record survive the given filters? */
export function matchRecord(record, filters) {
  if (!record) return false;
  const f = filters ?? defaultFilters();

  if (f.apiOnly && !API_RESOURCE_TYPES.has(record.resourceType)) return false;
  if (f.methods?.size && !f.methods.has(record.method)) return false;
  if (f.statusClasses?.size && !f.statusClasses.has(statusClass(record.status))) return false;
  if (f.onlyErrors && !isError(record)) return false;
  if (f.text && !matchesUrlQuery(record.url ?? '', f.text)) return false;
  if (f.bodySearch?.trim() && !searchableText(record).includes(f.bodySearch.trim().toLowerCase())) {
    return false;
  }
  return true;
}

export function applyFilters(records, filters) {
  return (records ?? []).filter((record) => matchRecord(record, filters));
}

/** True when the filters would hide something — drives the "clear filters" hint. */
export function hasActiveFilters(filters) {
  const f = filters ?? {};
  return Boolean(
    f.text ||
      f.bodySearch?.trim() ||
      f.methods?.size ||
      f.statusClasses?.size ||
      f.onlyErrors ||
      f.apiOnly,
  );
}
