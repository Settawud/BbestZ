import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { exportFilename, toHar, toJsonLog } from '../src/exporters.js';
import { makeRecord } from './helpers.js';

const postRecord = () =>
  makeRecord({
    method: 'POST',
    url: 'https://api.example.com/v1/orders?dry=1',
    status: 201,
    statusText: 'Created',
    queryString: [{ name: 'dry', value: '1' }],
    requestHeaders: [
      { name: 'content-type', value: 'application/json' },
      { name: 'authorization', value: 'Bearer secret-token' },
    ],
    requestBody: { mimeType: 'application/json', text: '{"sku":"A1"}', params: [] },
    responseBody: '{"id":7}',
    timings: { blocked: 1, send: 2, wait: 100, receive: 5 },
  });

describe('toHar', () => {
  it('produces a HAR 1.2 log with one entry per record', () => {
    const har = toHar([postRecord()]);
    assert.equal(har.log.version, '1.2');
    assert.equal(har.log.entries.length, 1);

    const entry = har.log.entries[0];
    assert.equal(entry.request.method, 'POST');
    assert.equal(entry.request.url, 'https://api.example.com/v1/orders?dry=1');
    assert.equal(entry.request.postData.text, '{"sku":"A1"}');
    assert.deepEqual(entry.request.queryString, [{ name: 'dry', value: '1' }]);
    assert.equal(entry.response.status, 201);
    assert.equal(entry.response.content.text, '{"id":7}');
  });

  it('redacts auth headers by default and keeps them when told not to', () => {
    const header = (har) =>
      har.log.entries[0].request.headers.find((h) => h.name === 'authorization').value;
    assert.equal(header(toHar([postRecord()])), '[REDACTED]');
    assert.equal(header(toHar([postRecord()], { redact: false })), 'Bearer secret-token');
  });

  it('fills every timing phase, defaulting unknown ones to -1 as the spec requires', () => {
    const { timings } = toHar([postRecord()]).log.entries[0];
    assert.equal(timings.wait, 100);
    assert.equal(timings.dns, -1);
    assert.equal(timings.ssl, -1);
    assert.equal(timings.connect, -1);
  });

  it('omits postData for a request without a body', () => {
    const entry = toHar([makeRecord()]).log.entries[0];
    assert.equal('postData' in entry.request, false);
    assert.equal(entry.request.bodySize, 0);
  });

  it('uses -1 for an unknown duration', () => {
    assert.equal(toHar([makeRecord({ time: null })]).log.entries[0].time, -1);
  });

  it('handles an empty log', () => {
    assert.deepEqual(toHar([]).log.entries, []);
    assert.deepEqual(toHar(undefined).log.entries, []);
  });
});

describe('toJsonLog', () => {
  it('parses bodies and flattens headers into objects', () => {
    const log = toJsonLog([postRecord()], { redact: false });
    assert.equal(log.count, 1);
    assert.equal(log.redacted, false);

    const [request] = log.requests;
    assert.deepEqual(request.requestBody, { sku: 'A1' });
    assert.deepEqual(request.responseBody, { id: 7 });
    assert.equal(request.requestHeaders.authorization, 'Bearer secret-token');
    assert.equal(request.responseHeaders['content-type'], 'application/json');
  });

  it('redacts by default', () => {
    const log = toJsonLog([postRecord()]);
    assert.equal(log.redacted, true);
    assert.equal(log.requests[0].requestHeaders.authorization, '[REDACTED]');
  });

  it('keeps a non-JSON body as text and a missing body as null', () => {
    const log = toJsonLog([
      makeRecord({ responseBody: 'plain text', responseMimeType: 'text/plain' }),
      makeRecord({ responseBody: '' }),
    ]);
    assert.equal(log.requests[0].responseBody, 'plain text');
    assert.equal(log.requests[1].responseBody, null);
    assert.equal(log.requests[0].requestBody, null);
  });

  it('includes a capture error when one was recorded', () => {
    const log = toJsonLog([makeRecord({ status: 0, error: 'net::ERR_FAILED' })]);
    assert.equal(log.requests[0].error, 'net::ERR_FAILED');
  });
});

describe('exportFilename', () => {
  it('builds a timestamped name from the host', () => {
    assert.match(exportFilename('har', 'api.example.com'), /^api-log-api\.example\.com-\d{8}-\d{6}\.har$/);
  });

  it('strips characters that are unsafe in a filename', () => {
    assert.match(exportFilename('json', 'host:8080/x'), /^api-log-host8080x-/);
  });

  it('falls back to a placeholder when the host is unknown', () => {
    assert.match(exportFilename('har', ''), /^api-log-log-/);
  });
});
