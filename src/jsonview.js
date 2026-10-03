/**
 * Collapsible JSON tree built on native <details>, so expand/collapse needs no
 * JavaScript and stays keyboard-accessible. Clicking a key copies its path
 * (`data.items[0].id`), which is the bit you usually want to paste back into
 * code while debugging a response.
 */

import { el } from './dom.js';

/** Render more than this many children of one node behind a "… more" note. */
const MAX_CHILDREN = 500;
/** Truncate string values longer than this in the tree (full text in title). */
const MAX_STRING = 400;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function childPath(parentPath, key) {
  if (typeof key === 'number') return `${parentPath}[${key}]`;
  if (IDENTIFIER.test(key)) return parentPath ? `${parentPath}.${key}` : key;
  return `${parentPath}[${JSON.stringify(key)}]`;
}

function valueKind(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function leafText(value) {
  const kind = valueKind(value);
  if (kind === 'string') {
    const quoted = JSON.stringify(value);
    return quoted.length > MAX_STRING ? `${quoted.slice(0, MAX_STRING)}…"` : quoted;
  }
  if (kind === 'undefined') return 'undefined';
  return String(value);
}

/** `{3 keys}` / `[12]` — a one-glance summary of a collapsed branch. */
function branchSummary(value) {
  if (Array.isArray(value)) return `[${value.length}]`;
  const size = Object.keys(value).length;
  return size === 1 ? '{1 key}' : `{${size} keys}`;
}

function keySpan(key, path) {
  if (key == null) return null;
  return el('span', {
    class: 'jv-key',
    text: typeof key === 'number' ? String(key) : key,
    dataset: { path },
    title: `${path} — click to copy path`,
    role: 'button',
    tabindex: '0',
  });
}

function renderNode(value, key, path, depth, expandDepth) {
  const kind = valueKind(value);

  if (kind !== 'object' && kind !== 'array') {
    const span = el('span', { class: `jv-val jv-${kind}`, text: leafText(value) });
    if (kind === 'string' && String(value).length > MAX_STRING) span.title = String(value);
    return el('div', { class: 'jv-leaf', dataset: { path } }, keySpan(key, path), span);
  }

  const entries = Array.isArray(value)
    ? value.map((item, index) => [index, item])
    : Object.entries(value);

  const kids = el(
    'div',
    { class: 'jv-kids' },
    entries
      .slice(0, MAX_CHILDREN)
      .map(([childKey, childValue]) =>
        renderNode(
          childValue,
          childKey,
          childPath(path, childKey),
          depth + 1,
          expandDepth,
        ),
      ),
    entries.length > MAX_CHILDREN
      ? el('div', {
          class: 'jv-more',
          text: `… ${entries.length - MAX_CHILDREN} more items not rendered`,
        })
      : null,
  );

  return el(
    'details',
    { class: 'jv-branch', open: depth < expandDepth || null },
    el(
      'summary',
      null,
      keySpan(key, path),
      el('span', { class: 'jv-meta', text: branchSummary(value) }),
    ),
    kids,
  );
}

/**
 * @param {unknown} value parsed JSON
 * @param {{ expandDepth?: number, rootKey?: string }} [options]
 * @returns {HTMLElement}
 */
export function renderJson(value, options = {}) {
  const { expandDepth = 2, rootKey = null } = options;
  return el('div', { class: 'jv' }, renderNode(value, rootKey, rootKey ?? '', 0, expandDepth));
}

/** Expand or collapse every branch inside a rendered tree. */
export function setAllExpanded(root, expanded) {
  for (const branch of root.querySelectorAll('details.jv-branch')) branch.open = expanded;
}
