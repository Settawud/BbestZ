/**
 * Browser smoke test for the panel itself.
 *
 * `npm test` covers the pure modules under Node; this script covers the part
 * that only exists in a browser — the panel page loading its ES modules,
 * subscribing to the DevTools network API and rendering real records.
 *
 * It serves the repo over HTTP (ES modules will not load from file://), stubs
 * `chrome.devtools` before panel.js runs, then feeds it fake HAR entries and
 * asserts what ends up in the DOM.
 *
 *   npm run test:panel
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

// Playwright lives in a global tool directory; ESM resolution ignores NODE_PATH.
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = new URL('..', import.meta.url).pathname;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

function startServer() {
  const server = createServer(async (request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url, 'http://x').pathname));
    if (path.includes('..')) {
      response.writeHead(403).end();
      return;
    }
    // Chromium asks for this unprompted; a 404 would show up as a page error.
    if (path === '/favicon.ico') {
      response.writeHead(204).end();
      return;
    }
    try {
      const body = await readFile(join(ROOT, path));
      response.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/**
 * Runs in the page before any panel code: stands in for the DevTools APIs and
 * exposes a HAR-entry factory. The factory has to live here rather than in the
 * test, because `getContent` is a function and functions cannot be serialized
 * into `page.evaluate`.
 */
const pageHarness = () => {
  const listeners = { request: [], navigated: [] };

  globalThis.__emit = {
    request: (entry) => listeners.request.forEach((fn) => fn(entry)),
    navigated: () => listeners.navigated.forEach((fn) => fn()),
  };

  /** A HAR entry shaped the way Chrome hands them over. */
  globalThis.__entry = ({
    url = 'https://api.example.com/v1/users/42',
    method = 'GET',
    status = 200,
    type = 'xhr',
    mime = 'application/json',
    body = '{"id":42,"name":"Ada","roles":["admin","dev"]}',
    encoding = '',
    time = 120,
    requestBody = null,
  } = {}) => ({
    startedDateTime: new Date().toISOString(),
    time,
    _resourceType: type,
    request: {
      method,
      url,
      headers: [
        { name: ':method', value: method },
        { name: 'accept', value: 'application/json' },
        { name: 'authorization', value: 'Bearer secret-token' },
      ],
      queryString: [],
      ...(requestBody ? { postData: { mimeType: 'application/json', text: requestBody } } : {}),
    },
    response: {
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      httpVersion: 'http/2.0',
      headers: [{ name: 'content-type', value: mime }],
      content: { size: body.length, mimeType: mime },
      _transferSize: body.length + 180,
    },
    timings: { blocked: 1, dns: -1, connect: -1, send: 2, wait: time - 8, receive: 5, ssl: -1 },
    getContent: (callback) => callback(body, encoding),
  });

  globalThis.chrome = {
    devtools: {
      panels: { themeName: 'default', create: () => {} },
      network: {
        onRequestFinished: { addListener: (fn) => listeners.request.push(fn) },
        onNavigated: { addListener: (fn) => listeners.navigated.push(fn) },
      },
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  };
};

const checks = [];

async function check(name, fn) {
  try {
    await fn();
    checks.push([true, name]);
    console.log(`  ok   ${name}`);
  } catch (error) {
    checks.push([false, name]);
    const detail = error.message
      .split('\n')
      .filter((line) => line.trim())
      .slice(0, 4)
      .map((line) => `       ${line}`)
      .join('\n');
    console.log(`  FAIL ${name}\n${detail}`);
  }
}

async function main() {
  const { server, port } = await startServer();
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    args: [
      // Required when the test runs as root, e.g. inside a container.
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // Everything this test needs is on localhost; keep Chromium from dialling
      // out to Google services through a proxy that may not allow it.
      '--no-proxy-server',
      '--disable-background-networking',
      '--disable-component-update',
      '--no-first-run',
    ],
    timeout: 60_000,
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(10_000);

    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text());
    });

    /** Feed one fake request into the panel. */
    const emit = (options = {}) =>
      page.evaluate((opts) => globalThis.__emit.request(globalThis.__entry(opts)), options);

    /** The panel batches renders onto requestAnimationFrame; let one flush. */
    const settle = () =>
      page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );

    const count = async (selector, options) => {
      await settle();
      return page.locator(selector, options).count();
    };
    const rows = () => count('#list-body tr');

    await page.addInitScript(pageHarness);
    await page.goto(`http://127.0.0.1:${port}/devtools/panel.html`);
    // init() is async; wait until the panel has subscribed and drawn once.
    await page.waitForSelector('#statusbar span');

    await check('starts with the empty state', async () => {
      assert.equal(await page.isVisible('#empty-state'), true);
      assert.match(await page.textContent('#empty-state h2'), /No requests captured yet/);
    });

    await emit();
    await emit({
      url: 'https://api.example.com/v1/orders',
      method: 'POST',
      status: 201,
      time: 310,
      requestBody: '{"sku":"A1"}',
    });
    await emit({
      url: 'https://api.example.com/v1/orders/9',
      status: 500,
      body: '{"error":"boom"}',
      time: 80,
    });
    await emit({
      url: 'https://cdn.example.com/app.css',
      type: 'stylesheet',
      mime: 'text/css',
      body: 'body{}',
    });

    await check('renders one row per API request and hides page assets', async () => {
      assert.equal(await rows(), 3, 'the stylesheet is filtered out');
    });

    await check('shows method, status code and duration in the row', async () => {
      const text = await page.locator('#list-body tr').first().textContent();
      assert.match(text, /GET/);
      assert.match(text, /200/);
      assert.match(text, /120 ms/);
    });

    await check('summarises the log in the status bar', async () => {
      const text = await page.textContent('#statusbar');
      assert.match(text, /3 shown \/ 4 captured/);
      assert.match(text, /1 error/);
      assert.match(text, /slowest 310 ms/);
    });

    await check('"API only" off reveals the stylesheet', async () => {
      await page.uncheck('#api-only');
      assert.equal(await rows(), 4);
      await page.check('#api-only');
      assert.equal(await rows(), 3);
    });

    await check('filters by URL, and excludes with a leading dash', async () => {
      await page.fill('#filter', 'orders');
      assert.equal(await rows(), 2);
      await page.fill('#filter', '-orders');
      assert.equal(await rows(), 1);
      await page.fill('#filter', '');
      assert.equal(await rows(), 3);
    });

    await check('searches inside response bodies', async () => {
      await page.fill('#body-search', 'boom');
      assert.equal(await rows(), 1);
      await page.fill('#body-search', '');
      assert.equal(await rows(), 3);
    });

    await check('the Errors toggle keeps only the 500', async () => {
      await page.check('#only-errors');
      assert.equal(await rows(), 1);
      assert.match(await page.textContent('#list-body tr'), /500/);
      await page.uncheck('#only-errors');
      assert.equal(await rows(), 3);
    });

    await check('status chips filter by family', async () => {
      await page.click('#status-chips button[data-status="server-error"]');
      assert.equal(await rows(), 1);
      await page.click('#status-chips button[data-status="server-error"]');
      assert.equal(await rows(), 3);
    });

    await check('clicking a row opens the detail pane on the Response tab', async () => {
      await settle();
      await page.click('#list-body tr:first-child');
      assert.equal(await page.isVisible('#detail-pane'), true);
      assert.equal(await page.textContent('#detail-status'), '200');
      assert.match(await page.textContent('#detail-url'), /\/v1\/users\/42$/);
      assert.equal(
        await page.getAttribute('#detail-tabs button[data-tab="response"]', 'aria-selected'),
        'true',
      );
    });

    await check('the response body renders as a JSON tree with copyable paths', async () => {
      const keys = await page.locator('#detail-body .jv-key').allTextContents();
      assert.ok(keys.includes('name'), `expected a "name" key, got ${JSON.stringify(keys)}`);
      assert.equal(await page.locator('#detail-body .jv-key[data-path="roles"]').count(), 1);
      assert.match(await page.textContent('#detail-body'), /"Ada"/);
    });

    await check('Raw swaps the tree for the raw payload', async () => {
      await page.click('#detail-body .body-tools button:has-text("Raw")');
      assert.equal(await page.locator('#detail-body pre.raw').count(), 1);
      await page.click('#detail-body .body-tools button:has-text("Pretty")');
      assert.equal(await page.locator('#detail-body .jv').count(), 1);
    });

    await check('the Headers tab lists both directions', async () => {
      await page.click('#detail-tabs button[data-tab="headers"]');
      const text = await page.textContent('#detail-body');
      assert.match(text, /Request headers \(2\)/, 'the :method pseudo-header is dropped');
      assert.match(text, /authorization/);
      assert.match(text, /Response headers \(1\)/);
    });

    await check('the Overview tab reports status, protocol and duration', async () => {
      await page.click('#detail-tabs button[data-tab="overview"]');
      const text = await page.textContent('#detail-body');
      assert.match(text, /200 OK/);
      assert.match(text, /http\/2\.0/);
      assert.match(text, /120 ms/);
    });

    await check('the Timing tab draws only the phases it has data for', async () => {
      await page.click('#detail-tabs button[data-tab="timing"]');
      const labels = await page.locator('#detail-body .timing-label').allTextContents();
      assert.deepEqual(labels, ['Stalled', 'Send', 'Waiting (TTFB)', 'Receive', 'Total']);
    });

    await check('the cURL tab rebuilds a replayable command', async () => {
      await page.click('#detail-tabs button[data-tab="curl"]');
      const command = await page.textContent('#detail-body pre.raw');
      assert.ok(command.startsWith("curl 'https://api.example.com/v1/users/42'"));
      assert.ok(command.includes("-H 'accept: application/json'"));
      assert.ok(!command.includes(':method'), 'pseudo-headers stay out of the command');
      assert.ok(command.includes('Bearer secret-token'), 'replayable, so the token is kept');
    });

    await check('the Request tab shows a POST payload and says so for a GET', async () => {
      await page.click('#detail-tabs button[data-tab="request"]');
      assert.match(await page.textContent('#detail-body'), /No request body \(GET\)/);
      await page.click('#list-body tr:nth-child(2)');
      assert.match(await page.textContent('#detail-body'), /"A1"/);
    });

    await check('Esc closes the detail pane', async () => {
      await page.keyboard.press('Escape');
      assert.equal(await page.isVisible('#detail-pane'), false);
    });

    await check('arrow keys walk the list', async () => {
      await page.keyboard.press('ArrowDown');
      assert.match(await page.textContent('#detail-url'), /\/v1\/users\/42$/);
      await page.keyboard.press('ArrowDown');
      assert.match(await page.textContent('#detail-url'), /\/v1\/orders$/);
      await page.keyboard.press('ArrowUp');
      assert.match(await page.textContent('#detail-url'), /\/v1\/users\/42$/);
    });

    await check('the Endpoints view groups repeated calls and collapses ids', async () => {
      await emit({ url: 'https://api.example.com/v1/users/77', time: 200 });
      assert.equal(await rows(), 4);
      await page.click('#view-toggle');
      assert.equal(await count('#endpoint-body tr'), 3, 'the two /users/:id calls collapse');
      const users = page.locator('#endpoint-body tr').filter({ hasText: '/v1/users/:id' }).first();
      assert.match(await users.textContent(), /160 ms/, 'average of 120 ms and 200 ms');
    });

    await check('clicking an endpoint drills back into the filtered list', async () => {
      await page.locator('#endpoint-body tr').filter({ hasText: '/v1/users/:id' }).first().click();
      assert.equal(await page.inputValue('#filter'), '/v1/users');
      assert.equal(await rows(), 2);
      await page.fill('#filter', '');
      assert.equal(await rows(), 4);
    });

    await check('pausing capture drops new requests', async () => {
      await page.click('#record');
      assert.equal(await page.textContent('#record-label'), 'Paused');
      await emit({ url: 'https://api.example.com/v1/ignored' });
      assert.equal(await count('#list-body tr', { hasText: 'ignored' }), 0);
      assert.equal(await rows(), 4);
      await page.click('#record');
    });

    await check('navigating clears the log unless Preserve log is set', async () => {
      await page.check('#preserve-log');
      await page.evaluate(() => globalThis.__emit.navigated());
      assert.equal(await rows(), 4, 'the log survives with the box ticked');
      await page.uncheck('#preserve-log');
      await page.evaluate(() => globalThis.__emit.navigated());
      assert.equal(await rows(), 0);
      assert.equal(await page.isVisible('#empty-state'), true);
    });

    await check('Clear empties the log and closes the detail pane', async () => {
      await emit();
      assert.equal(await rows(), 1);
      await page.click('#list-body tr:first-child');
      await page.click('#clear');
      assert.equal(await rows(), 0);
      assert.equal(await page.isVisible('#detail-pane'), false);
    });

    await check('the export menu opens and closes', async () => {
      await page.click('#export');
      assert.equal(await page.isVisible('#export-menu'), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.isVisible('#export-menu'), false);
    });

    await check('a binary response is reported rather than dumped as text', async () => {
      // 0x89 'P' 'N' 'G' — not valid UTF-8, so it must stay flagged as binary.
      await emit({
        url: 'https://api.example.com/v1/avatar',
        mime: 'image/png',
        type: 'fetch',
        body: 'iVBORw==',
        encoding: 'base64',
      });
      assert.equal(await rows(), 1);
      await page.click('#list-body tr:first-child');
      await page.click('#detail-tabs button[data-tab="response"]');
      assert.match(await page.textContent('#detail-body'), /Binary response/);
      assert.match(await page.textContent('#list-body tr:first-child'), /binary/);
    });

    await check('base64 content that is really text is decoded and shown', async () => {
      await page.click('#clear');
      await emit({
        url: 'https://api.example.com/v1/note',
        mime: 'application/octet-stream',
        body: Buffer.from('{"ok":true}').toString('base64'),
        encoding: 'base64',
      });
      assert.equal(await rows(), 1);
      await page.click('#list-body tr:first-child');
      await page.click('#detail-tabs button[data-tab="response"]');
      assert.match(await page.textContent('#detail-body'), /"ok"/);
    });

    await check('the page raised no console or runtime errors', () => {
      assert.deepEqual(pageErrors, []);
    });
  } finally {
    await browser.close();
    server.close();
  }

  const failed = checks.filter(([ok]) => !ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
