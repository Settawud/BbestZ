/**
 * API Log — DevTools panel controller.
 *
 * Capture comes from `chrome.devtools.network.onRequestFinished`, which hands
 * us a HAR entry plus an async `getContent()` for the response body. That is
 * the only capture path that sees real response bodies without injecting code
 * into the page or asking for host permissions — the trade-off being that it
 * only records while DevTools is open on the inspected tab.
 */

import { $, el, kvTable, defList } from '../src/dom.js';
import {
  formatBytes,
  formatMs,
  formatPercent,
  formatTime,
  splitUrl,
  statusClass,
  truncateMiddle,
} from '../src/format.js';
import { parseBody, toRecord } from '../src/har.js';
import { toCurl } from '../src/curl.js';
import { METHODS, STATUS_CLASSES, applyFilters, defaultFilters } from '../src/filter.js';
import { endpointStats, summarize } from '../src/stats.js';
import { exportFilename, toHar, toJsonLog } from '../src/exporters.js';
import { renderJson, setAllExpanded } from '../src/jsonview.js';

const api = globalThis.browser ?? globalThis.chrome;

/** Ring-buffer cap, so a chatty page cannot grow the panel without bound. */
const MAX_RECORDS = 3000;
/** Rows rendered at once; older ones stay in memory and in exports. */
const MAX_ROWS = 1000;
const PREFS_KEY = 'apiLogPrefs';

const STATUS_LABELS = {
  ok: '2xx',
  redirect: '3xx',
  'client-error': '4xx',
  'server-error': '5xx',
  failed: 'failed',
};

const DETAIL_TABS = [
  ['overview', 'Overview'],
  ['headers', 'Headers'],
  ['request', 'Request'],
  ['response', 'Response'],
  ['timing', 'Timing'],
  ['curl', 'cURL'],
];

const TIMING_PHASES = [
  ['blocked', 'Stalled'],
  ['dns', 'DNS'],
  ['connect', 'Connect'],
  ['ssl', 'TLS'],
  ['send', 'Send'],
  ['wait', 'Waiting (TTFB)'],
  ['receive', 'Receive'],
];

const state = {
  records: [],
  nextId: 1,
  selectedId: null,
  visibleIds: [],
  recording: true,
  preserveLog: false,
  view: 'list',
  detailTab: 'response',
  showRaw: false,
  redactExport: true,
  /** Last width the detail pane was dragged to; null until set or restored. */
  detailWidth: null,
  filters: defaultFilters(),
};

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

async function loadPrefs() {
  try {
    const stored = await api.storage.local.get(PREFS_KEY);
    const prefs = stored?.[PREFS_KEY];
    if (!prefs) return;
    state.preserveLog = Boolean(prefs.preserveLog);
    state.redactExport = prefs.redactExport !== false;
    state.filters.apiOnly = prefs.apiOnly !== false;
    state.filters.onlyErrors = Boolean(prefs.onlyErrors);
    state.filters.text = String(prefs.filterText ?? '');
    if (typeof prefs.detailWidth === 'number' && prefs.detailWidth > 200) {
      state.detailWidth = prefs.detailWidth;
      $('#detail-pane').style.width = `${prefs.detailWidth}px`;
    }
  } catch {
    // No storage permission or private mode — defaults are fine.
  }
}

function savePrefs() {
  const prefs = {
    preserveLog: state.preserveLog,
    redactExport: state.redactExport,
    apiOnly: state.filters.apiOnly,
    onlyErrors: state.filters.onlyErrors,
    filterText: state.filters.text,
    detailWidth: state.detailWidth,
  };
  try {
    api.storage.local.set({ [PREFS_KEY]: prefs });
  } catch {
    // Non-fatal: preferences just will not survive a reopen.
  }
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Chrome hands back base64 for anything it considers binary — but that includes
 * perfectly readable text with an unhelpful Content-Type. Decode strictly, so
 * genuinely binary payloads throw and stay flagged as binary.
 */
function decodeBase64(text) {
  try {
    const binary = atob(text);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Real byte size of a string, which is what "12 KB" should mean. */
function byteLength(text) {
  return new TextEncoder().encode(text ?? '').length;
}

function attachResponseBody(record, entry) {
  if (typeof entry.getContent !== 'function') {
    record.bodyPending = false;
    return;
  }
  entry.getContent((content, encoding) => {
    record.bodyPending = false;
    record.responseEncoding = encoding || null;
    if (content == null) {
      record.responseBody = '';
    } else if (encoding === 'base64') {
      const decoded = decodeBase64(content);
      record.responseBody = decoded ?? content;
      // Keep the flag only when the bytes were not valid UTF-8 text.
      record.responseEncoding = decoded == null ? 'base64' : null;
    } else {
      record.responseBody = content;
    }
    if (state.selectedId === record.id) renderDetail();
    scheduleRender();
  });
}

function pushRecord(record) {
  state.records.push(record);
  if (state.records.length > MAX_RECORDS) {
    const dropped = state.records.splice(0, state.records.length - MAX_RECORDS);
    if (dropped.some((item) => item.id === state.selectedId)) {
      state.selectedId = null;
      renderDetail();
    }
  }
}

function onRequestFinished(entry) {
  if (!state.recording) return;
  const record = toRecord(entry, state.nextId);
  state.nextId += 1;
  pushRecord(record);
  attachResponseBody(record, entry);
  scheduleRender();
}

function onNavigated() {
  if (state.preserveLog) return;
  state.records = [];
  state.selectedId = null;
  renderDetail();
  scheduleRender();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

let renderQueued = false;

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function currentRecord() {
  return state.records.find((record) => record.id === state.selectedId) ?? null;
}

function visibleRecords() {
  return applyFilters(state.records, state.filters);
}

function render() {
  const visible = visibleRecords();
  state.visibleIds = visible.map((record) => record.id);

  const showEndpoints = state.view === 'endpoints';
  const empty = visible.length === 0;

  $('#list-table').hidden = showEndpoints || empty;
  $('#endpoint-table').hidden = !showEndpoints || empty;
  $('#empty-state').hidden = !empty;

  // Whichever table is not on screen gets emptied rather than left holding
  // stale rows — hidden rows would still be in the DOM and in the way.
  if (empty) {
    renderEmptyState();
    $('#list-body').replaceChildren();
    $('#endpoint-body').replaceChildren();
  } else if (showEndpoints) {
    renderEndpoints(visible);
    $('#list-body').replaceChildren();
  } else {
    renderList(visible);
    $('#endpoint-body').replaceChildren();
  }

  renderStatusbar(visible);
}

function renderEmptyState() {
  const total = state.records.length;
  const heading = $('#empty-state h2');
  heading.textContent =
    total === 0 ? 'No requests captured yet' : `${total} captured, none match the filters`;
}

function statusCell(record) {
  const cls = statusClass(record.status);
  const label = record.status > 0 ? String(record.status) : 'ERR';
  return el('span', {
    class: `code ${cls}`,
    text: label,
    title: record.status > 0 ? `${record.status} ${record.statusText}` : (record.error ?? 'Failed'),
  });
}

function pathCell(record, maxTime) {
  const { display, host } = splitUrl(record.url);
  const children = [
    el('span', { class: 'path', text: truncateMiddle(display, 160) }),
    host ? el('span', { class: 'host', text: host }) : null,
    record.fromCache ? el('span', { class: 'badge', text: 'cache' }) : null,
    record.responseEncoding === 'base64' ? el('span', { class: 'badge', text: 'binary' }) : null,
  ];
  // A proportional bar makes the slow call in a burst obvious at a glance.
  if (typeof record.time === 'number' && maxTime > 0) {
    const bar = el('span', { class: 'bar' });
    bar.style.width = `${Math.max(1, (record.time / maxTime) * 100)}%`;
    children.push(bar);
  }
  return children;
}

function renderList(visible) {
  const rows = visible.slice(-MAX_ROWS);
  const maxTime = rows.reduce(
    (max, record) => (typeof record.time === 'number' ? Math.max(max, record.time) : max),
    0,
  );

  const body = $('#list-body');
  body.replaceChildren(
    ...rows.map((record) =>
      el(
        'tr',
        {
          dataset: { id: String(record.id) },
          tabindex: '0',
          'aria-selected': record.id === state.selectedId ? 'true' : 'false',
        },
        el('td', null, el('span', { class: `dot ${statusClass(record.status)}` })),
        el('td', null, el('span', { class: 'method', text: record.method })),
        el('td', null, statusCell(record)),
        el('td', { class: 'col-path', title: record.url }, pathCell(record, maxTime)),
        el('td', { text: record.resourceType }),
        el('td', { class: 'num', text: formatBytes(record.responseSize) }),
        el('td', { class: 'num', text: formatMs(record.time) }),
        el('td', { class: 'num', text: formatTime(record.startedAt) }),
      ),
    ),
  );
}

/** Keep only the leading literal part of an endpoint, for drill-down filtering. */
function endpointFilterText(endpoint) {
  const { path } = splitUrl(endpoint);
  const literal = path.split('/:id')[0];
  return literal && literal !== '/' ? literal : endpoint;
}

function renderEndpoints(visible) {
  const groups = endpointStats(visible);
  const body = $('#endpoint-body');
  body.replaceChildren(
    ...groups.map((group) =>
      el(
        'tr',
        { dataset: { filter: endpointFilterText(group.endpoint) }, tabindex: '0' },
        el('td', null, el('span', { class: 'method', text: group.method })),
        el('td', { class: 'col-path', title: group.endpoint }, [
          el('span', { class: 'path', text: truncateMiddle(splitUrl(group.endpoint).path, 160) }),
          el('span', { class: 'host', text: splitUrl(group.endpoint).host }),
        ]),
        el('td', { class: 'num', text: String(group.count) }),
        el('td', {
          class: `num ${group.errors ? 'code server-error' : ''}`,
          text: group.errors ? `${group.errors} (${formatPercent(group.errorRate)})` : '0',
        }),
        el('td', { class: 'num', text: formatMs(group.avgTime) }),
        el('td', { class: 'num', text: formatMs(group.minTime) }),
        el('td', { class: 'num', text: formatMs(group.maxTime) }),
        el('td', { class: 'num', text: formatBytes(group.bytes) }),
      ),
    ),
  );
}

function renderStatusbar(visible) {
  const stats = summarize(visible);
  const bar = $('#statusbar');
  const parts = [
    el('span', {
      text: `${stats.count} shown / ${state.records.length} captured`,
    }),
    el('span', {
      class: stats.errors ? 'err' : '',
      text: `${stats.errors} ${stats.errors === 1 ? 'error' : 'errors'}`,
    }),
    el('span', { text: `${formatBytes(stats.bytes)} transferred` }),
    el('span', { text: `avg ${formatMs(stats.avgTime)}` }),
  ];
  if (stats.slowest) {
    parts.push(
      el('span', {
        text: `slowest ${formatMs(stats.slowest.time)} — ${splitUrl(stats.slowest.url).path}`,
        title: stats.slowest.url,
      }),
    );
  }
  if (!state.recording) parts.push(el('span', { class: 'err', text: 'paused' }));
  bar.replaceChildren(...parts);
}

// ---------------------------------------------------------------------------
// Detail pane
// ---------------------------------------------------------------------------

function renderDetail() {
  const record = currentRecord();
  const pane = $('#detail-pane');

  if (!record) {
    pane.hidden = true;
    return;
  }
  pane.hidden = false;

  const cls = statusClass(record.status);
  const statusPill = $('#detail-status');
  statusPill.className = `status-pill ${cls}`;
  statusPill.textContent = record.status > 0 ? String(record.status) : 'ERR';
  $('#detail-method').textContent = record.method;
  const url = $('#detail-url');
  url.textContent = truncateMiddle(record.url, 220);
  url.title = record.url;

  renderDetailTabs();
  renderDetailBody(record);
}

function renderDetailTabs() {
  $('#detail-tabs').replaceChildren(
    ...DETAIL_TABS.map(([id, label]) =>
      el('button', {
        type: 'button',
        role: 'tab',
        text: label,
        dataset: { tab: id },
        'aria-selected': state.detailTab === id ? 'true' : 'false',
      }),
    ),
  );
}

function renderDetailBody(record) {
  const renderers = {
    overview: overviewTab,
    headers: headersTab,
    request: requestTab,
    response: responseTab,
    timing: timingTab,
    curl: curlTab,
  };
  const renderer = renderers[state.detailTab] ?? overviewTab;
  $('#detail-body').replaceChildren(renderer(record));
}

function overviewTab(record) {
  const { origin, path, query } = splitUrl(record.url);
  const rows = [
    ['URL', record.url],
    ['Origin', origin],
    ['Path', path],
    ['Method', record.method],
    ['Status', record.status > 0 ? `${record.status} ${record.statusText}`.trim() : 'Failed'],
    ['Error', record.error],
    ['Resource type', record.resourceType],
    ['Content type', record.responseMimeType],
    ['Protocol', record.httpVersion],
    ['Server IP', record.serverIP],
    ['From cache', record.fromCache ? 'yes' : null],
    ['Response size', formatBytes(record.responseSize)],
    ['Transferred', record.transferSize == null ? null : formatBytes(record.transferSize)],
    ['Duration', formatMs(record.time)],
    ['Started', record.startedAt ? `${formatTime(record.startedAt)} (${record.startedAt})` : null],
  ];

  return el(
    'div',
    null,
    defList(rows),
    el('h3', { class: 'section-title', text: `Query parameters (${record.queryString.length})` }),
    kvTable(record.queryString, { emptyText: query ? query : 'None' }),
  );
}

function headersTab(record) {
  return el(
    'div',
    null,
    el(
      'h3',
      { class: 'section-title' },
      `Request headers (${record.requestHeaders.length})`,
      copyButton('Copy', () => headerText(record.requestHeaders), 'Request headers copied'),
    ),
    kvTable(record.requestHeaders),
    el(
      'h3',
      { class: 'section-title' },
      `Response headers (${record.responseHeaders.length})`,
      copyButton('Copy', () => headerText(record.responseHeaders), 'Response headers copied'),
    ),
    kvTable(record.responseHeaders),
  );
}

function headerText(headers) {
  return headers.map((header) => `${header.name}: ${header.value}`).join('\n');
}

function requestTab(record) {
  const children = [];

  if (record.queryString.length) {
    children.push(
      el('h3', { class: 'section-title', text: `Query parameters (${record.queryString.length})` }),
      kvTable(record.queryString),
    );
  }

  children.push(el('h3', { class: 'section-title', text: 'Payload' }));
  if (!record.requestBody?.text) {
    children.push(
      el('p', {
        class: 'empty-note',
        text:
          record.method === 'GET'
            ? 'No request body (GET).'
            : 'No request body was captured for this request.',
      }),
    );
  } else {
    children.push(
      bodyView(parseBody(record.requestBody.text, record.requestBody.mimeType), {
        mimeType: record.requestBody.mimeType,
      }),
    );
  }

  return el('div', null, children);
}

function responseTab(record) {
  if (record.bodyPending) {
    return el('p', { class: 'empty-note', text: 'Loading response body…' });
  }
  if (record.responseEncoding === 'base64') {
    return el(
      'div',
      null,
      el('p', {
        class: 'empty-note',
        text: `Binary response (${record.responseMimeType || 'unknown type'}, ${formatBytes(
          record.responseSize,
        )}). Not shown as text.`,
      }),
    );
  }
  const parsed = parseBody(record.responseBody, record.responseMimeType);
  if (parsed.kind === 'empty') {
    return el('p', { class: 'empty-note', text: 'Empty response body.' });
  }
  return bodyView(parsed, { mimeType: record.responseMimeType });
}

/**
 * Shared renderer for request and response payloads: a JSON tree when the body
 * parses, a raw <pre> otherwise, with a Pretty/Raw switch either way.
 */
function bodyView(parsed, { mimeType = '' } = {}) {
  const container = el('div');
  const tools = el('div', { class: 'body-tools' });
  const content = el('div');

  const draw = () => {
    if (parsed.kind === 'json' && !state.showRaw) {
      content.replaceChildren(renderJson(parsed.value));
    } else if (parsed.kind === 'form' && !state.showRaw) {
      content.replaceChildren(kvTable(parsed.value));
    } else {
      content.replaceChildren(el('pre', { class: 'raw', text: parsed.text }));
    }
  };

  if (parsed.kind === 'json' || parsed.kind === 'form') {
    tools.append(
      el('button', {
        class: 'btn small',
        type: 'button',
        text: state.showRaw ? 'Pretty' : 'Raw',
        onclick: () => {
          state.showRaw = !state.showRaw;
          const record = currentRecord();
          if (record) renderDetailBody(record);
        },
      }),
    );
  }

  if (parsed.kind === 'json' && !state.showRaw) {
    tools.append(
      el('button', {
        class: 'btn small',
        type: 'button',
        text: 'Expand all',
        onclick: () => setAllExpanded(content, true),
      }),
      el('button', {
        class: 'btn small',
        type: 'button',
        text: 'Collapse all',
        onclick: () => setAllExpanded(content, false),
      }),
    );
  }

  tools.append(
    copyButton(
      'Copy body',
      () => (parsed.kind === 'json' ? JSON.stringify(parsed.value, null, 2) : parsed.text),
      'Body copied',
    ),
    el('span', {
      class: 'empty-note',
      text: `${mimeType || parsed.kind} · ${formatBytes(byteLength(parsed.text))}`,
    }),
  );

  container.append(tools);
  if (parsed.parseError) {
    container.append(
      el('p', { class: 'warn-note', text: `Not valid JSON: ${parsed.parseError}` }),
    );
  }
  draw();
  container.append(content);
  return container;
}

function timingTab(record) {
  const timings = record.timings;
  if (!timings) return el('p', { class: 'empty-note', text: 'No timing data for this request.' });

  const phases = TIMING_PHASES.map(([key, label]) => [label, timings[key], key]).filter(
    ([, value]) => typeof value === 'number' && value >= 0,
  );
  if (!phases.length) {
    return el('p', { class: 'empty-note', text: 'No timing data for this request.' });
  }

  const total = phases.reduce((sum, [, value]) => sum + value, 0) || 1;
  const grid = el('div', { class: 'timing' });

  for (const [label, value, key] of phases) {
    const fill = el('div', { class: `timing-fill ${key === 'wait' ? 'wait' : ''}` });
    fill.style.width = `${(value / total) * 100}%`;
    grid.append(
      el('div', { class: 'timing-label', text: label }),
      el('div', { class: 'timing-track' }, fill),
      el('div', { class: 'timing-value', text: formatMs(value) }),
    );
  }

  grid.append(
    el('div', { class: 'timing-label', text: 'Total' }),
    el('div'),
    el('div', { class: 'timing-value', text: formatMs(record.time ?? total) }),
  );

  return el('div', null, grid);
}

function curlTab(record) {
  const command = toCurl(record, { multiline: true, redact: false });
  return el(
    'div',
    null,
    el(
      'div',
      { class: 'body-tools' },
      copyButton('Copy command', () => command, 'cURL command copied'),
      el('span', {
        class: 'empty-note',
        text: 'Includes real auth headers so the call can be replayed as-is.',
      }),
    ),
    el('pre', { class: 'raw', text: command }),
  );
}

// ---------------------------------------------------------------------------
// Clipboard, downloads, toast
// ---------------------------------------------------------------------------

let toastTimer = null;

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 1800);
}

async function copyText(text, successMessage = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(successMessage);
    return;
  } catch {
    // Clipboard API can be unavailable when the panel is not focused.
  }
  const scratch = el('textarea', { style: 'position:fixed;top:-1000px;opacity:0' });
  scratch.value = text;
  document.body.append(scratch);
  scratch.select();
  const copied = document.execCommand?.('copy');
  scratch.remove();
  toast(copied ? successMessage : 'Copy failed — select the text manually');
}

function copyButton(label, getText, successMessage) {
  return el('button', {
    class: 'btn small',
    type: 'button',
    text: label,
    onclick: () => copyText(getText(), successMessage),
  });
}

function download(filename, text, mimeType) {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const link = el('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  toast(`Saved ${filename}`);
}

function inspectedHost() {
  const record = state.records.at(-1);
  return record ? splitUrl(record.url).host : '';
}

function runExportAction(action) {
  const record = currentRecord();
  const visible = visibleRecords();

  if (action === 'copy-curl') {
    if (!record) return toast('Select a request first');
    return copyText(toCurl(record, { redact: state.redactExport }), 'cURL command copied');
  }

  if (action === 'copy-response') {
    if (!record) return toast('Select a request first');
    const parsed = parseBody(record.responseBody, record.responseMimeType);
    if (parsed.kind === 'empty') return toast('That response has no body');
    const text = parsed.kind === 'json' ? JSON.stringify(parsed.value, null, 2) : parsed.text;
    return copyText(text, 'Response copied');
  }

  if (!visible.length) return toast('Nothing to export');

  if (action === 'download-har') {
    return download(
      exportFilename('har', inspectedHost()),
      JSON.stringify(toHar(visible, { redact: state.redactExport }), null, 2),
      'application/json',
    );
  }

  if (action === 'download-json') {
    return download(
      exportFilename('json', inspectedHost()),
      JSON.stringify(toJsonLog(visible, { redact: state.redactExport }), null, 2),
      'application/json',
    );
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Toolbar wiring
// ---------------------------------------------------------------------------

function buildChips() {
  $('#status-chips').replaceChildren(
    ...STATUS_CLASSES.map((cls) =>
      el('button', {
        type: 'button',
        text: STATUS_LABELS[cls],
        dataset: { status: cls },
        'aria-pressed': 'false',
        title: `Show only ${STATUS_LABELS[cls]} responses`,
      }),
    ),
  );
  $('#method-chips').replaceChildren(
    ...METHODS.map((method) =>
      el('button', {
        type: 'button',
        text: method,
        dataset: { method },
        'aria-pressed': 'false',
        title: `Show only ${method} requests`,
      }),
    ),
  );
}

/** Chips are multi-select: clicking toggles membership of the filter set. */
function toggleChip(button, set, value) {
  if (set.has(value)) set.delete(value);
  else set.add(value);
  button.setAttribute('aria-pressed', set.has(value) ? 'true' : 'false');
  scheduleRender();
}

function setRecording(recording) {
  state.recording = recording;
  const button = $('#record');
  button.setAttribute('aria-pressed', recording ? 'true' : 'false');
  button.title = recording ? 'Pause capture' : 'Resume capture';
  $('#record-label').textContent = recording ? 'Recording' : 'Paused';
  scheduleRender();
}

function clearLog() {
  state.records = [];
  state.selectedId = null;
  renderDetail();
  scheduleRender();
}

function selectRecord(id) {
  state.selectedId = id;
  state.showRaw = false;
  renderDetail();
  scheduleRender();
}

/** Arrow-key navigation over whatever the filters currently show. */
function moveSelection(delta) {
  const ids = state.visibleIds.slice(-MAX_ROWS);
  if (!ids.length) return;
  const index = ids.indexOf(state.selectedId);
  const next = index === -1 ? (delta > 0 ? 0 : ids.length - 1) : index + delta;
  if (next < 0 || next >= ids.length) return;
  selectRecord(ids[next]);
  const row = $(`#list-body tr[data-id="${ids[next]}"]`);
  row?.scrollIntoView({ block: 'nearest' });
}

function setExportMenuOpen(open) {
  $('#export-menu').hidden = !open;
  $('#export').setAttribute('aria-expanded', open ? 'true' : 'false');
}

function wireToolbar() {
  $('#record').addEventListener('click', () => setRecording(!state.recording));
  $('#clear').addEventListener('click', clearLog);

  $('#filter').addEventListener('input', (event) => {
    state.filters.text = event.target.value;
    savePrefs();
    scheduleRender();
  });
  $('#body-search').addEventListener('input', (event) => {
    state.filters.bodySearch = event.target.value;
    scheduleRender();
  });

  $('#status-chips').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-status]');
    if (button) toggleChip(button, state.filters.statusClasses, button.dataset.status);
  });
  $('#method-chips').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-method]');
    if (button) toggleChip(button, state.filters.methods, button.dataset.method);
  });

  $('#api-only').addEventListener('change', (event) => {
    state.filters.apiOnly = event.target.checked;
    savePrefs();
    scheduleRender();
  });
  $('#only-errors').addEventListener('change', (event) => {
    state.filters.onlyErrors = event.target.checked;
    savePrefs();
    scheduleRender();
  });
  $('#preserve-log').addEventListener('change', (event) => {
    state.preserveLog = event.target.checked;
    savePrefs();
  });
  $('#redact-export').addEventListener('change', (event) => {
    state.redactExport = event.target.checked;
    savePrefs();
  });

  $('#view-toggle').addEventListener('click', (event) => {
    state.view = state.view === 'list' ? 'endpoints' : 'list';
    event.currentTarget.textContent = state.view === 'list' ? 'Endpoints' : 'Requests';
    event.currentTarget.setAttribute('aria-pressed', state.view === 'endpoints' ? 'true' : 'false');
    scheduleRender();
  });

  $('#export').addEventListener('click', (event) => {
    event.stopPropagation();
    setExportMenuOpen($('#export-menu').hidden);
  });
  $('#export-menu').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    setExportMenuOpen(false);
    runExportAction(button.dataset.action);
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.menu-wrap')) setExportMenuOpen(false);
  });
}

function wireList() {
  $('#list-body').addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-id]');
    if (row) selectRecord(Number(row.dataset.id));
  });
  $('#list-body').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('tr[data-id]');
    if (!row) return;
    event.preventDefault();
    selectRecord(Number(row.dataset.id));
  });

  // Clicking an endpoint drills into its requests in the list view.
  const drillDown = (row) => {
    state.view = 'list';
    state.filters.text = row.dataset.filter;
    $('#filter').value = row.dataset.filter;
    $('#view-toggle').textContent = 'Endpoints';
    $('#view-toggle').setAttribute('aria-pressed', 'false');
    savePrefs();
    scheduleRender();
  };
  $('#endpoint-body').addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-filter]');
    if (row) drillDown(row);
  });
  $('#endpoint-body').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('tr[data-filter]');
    if (!row) return;
    event.preventDefault();
    drillDown(row);
  });
}

function wireDetail() {
  $('#close-detail').addEventListener('click', () => {
    state.selectedId = null;
    renderDetail();
    scheduleRender();
  });
  $('#copy-url').addEventListener('click', () => {
    const record = currentRecord();
    if (record) copyText(record.url, 'URL copied');
  });
  $('#detail-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-tab]');
    if (!button) return;
    state.detailTab = button.dataset.tab;
    renderDetail();
  });
  // Clicking a key in the JSON tree copies its path — the value you usually
  // want to paste back into code.
  $('#detail-body').addEventListener('click', (event) => {
    const key = event.target.closest('.jv-key[data-path]');
    if (!key?.dataset.path) return;
    event.preventDefault();
    copyText(key.dataset.path, `Copied path: ${key.dataset.path}`);
  });
}

function wireSplitter() {
  const splitter = $('#splitter');
  const pane = $('#detail-pane');

  const setDetailWidth = (width) => {
    const max = Math.max(window.innerWidth - 220, 240);
    state.detailWidth = Math.min(Math.max(width, 240), max);
    pane.style.width = `${state.detailWidth}px`;
  };

  splitter.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    splitter.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = pane.getBoundingClientRect().width;

    const onMove = (move) => setDetailWidth(startWidth - (move.clientX - startX));
    const onUp = () => {
      splitter.removeEventListener('pointermove', onMove);
      splitter.removeEventListener('pointerup', onUp);
      splitter.releasePointerCapture?.(event.pointerId);
      savePrefs();
    };
    splitter.addEventListener('pointermove', onMove);
    splitter.addEventListener('pointerup', onUp);
  });

  // Keyboard resize, since a drag handle alone is not reachable by keyboard.
  splitter.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = (event.shiftKey ? 60 : 20) * (event.key === 'ArrowLeft' ? 1 : -1);
    setDetailWidth(pane.getBoundingClientRect().width + step);
    savePrefs();
  });
}

function wireKeyboard() {
  document.addEventListener('keydown', (event) => {
    const inField = ['INPUT', 'TEXTAREA'].includes(event.target.tagName);

    if (event.key === 'Escape') {
      if (!$('#export-menu').hidden) return setExportMenuOpen(false);
      if (inField) return event.target.blur();
      if (state.selectedId != null) {
        state.selectedId = null;
        renderDetail();
        scheduleRender();
      }
      return undefined;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      return clearLog();
    }

    if (inField) return undefined;

    if (event.key === '/') {
      event.preventDefault();
      return $('#filter').focus();
    }
    if (event.key === 'ArrowDown' || event.key === 'j') {
      event.preventDefault();
      return moveSelection(1);
    }
    if (event.key === 'ArrowUp' || event.key === 'k') {
      event.preventDefault();
      return moveSelection(-1);
    }
    return undefined;
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function applyTheme() {
  const theme = api?.devtools?.panels?.themeName;
  if (theme === 'dark') document.documentElement.dataset.theme = 'dark';
  else if (theme === 'default') document.documentElement.dataset.theme = 'light';
  // Anything else: leave it to prefers-color-scheme.
}

/** Push loaded preferences into the toolbar controls. */
function syncControls() {
  $('#filter').value = state.filters.text;
  $('#api-only').checked = state.filters.apiOnly;
  $('#only-errors').checked = state.filters.onlyErrors;
  $('#preserve-log').checked = state.preserveLog;
  $('#redact-export').checked = state.redactExport;
}

async function init() {
  applyTheme();
  buildChips();
  wireToolbar();
  wireList();
  wireDetail();
  wireSplitter();
  wireKeyboard();

  await loadPrefs();
  syncControls();

  api.devtools.network.onRequestFinished.addListener(onRequestFinished);
  api.devtools.network.onNavigated.addListener(onNavigated);

  render();
}

init();
