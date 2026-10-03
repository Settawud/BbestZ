import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { shellQuote, toCurl } from '../src/curl.js';
import { makeRecord } from './helpers.js';

describe('shellQuote', () => {
  it('wraps values in single quotes', () => {
    assert.equal(shellQuote('plain'), "'plain'");
  });

  it('escapes embedded single quotes the POSIX way', () => {
    // 'it'\''s' is what a shell needs to produce: it's
    assert.equal(shellQuote("it's"), "'it'\\''s'");
  });
});

describe('toCurl', () => {
  const options = { multiline: false };

  it('builds a GET command without an explicit method', () => {
    const command = toCurl(makeRecord(), options);
    assert.ok(command.startsWith("curl 'https://api.example.com/v1/users/42'"));
    assert.ok(!command.includes('-X GET'));
    assert.ok(command.includes("-H 'accept: application/json'"));
    assert.ok(command.endsWith('--compressed'));
  });

  it('adds the method and body for a POST', () => {
    const command = toCurl(
      makeRecord({
        method: 'POST',
        requestBody: { mimeType: 'application/json', text: '{"sku":"A1"}', params: [] },
      }),
      options,
    );
    assert.ok(command.includes('-X POST'));
    assert.ok(command.includes(`--data-raw '{"sku":"A1"}'`));
  });

  it('keeps -X GET when a GET carries a body, which curl would otherwise turn into a POST', () => {
    const command = toCurl(
      makeRecord({ requestBody: { mimeType: 'application/json', text: '{}', params: [] } }),
      options,
    );
    assert.ok(command.includes('-X GET'));
  });

  it('drops headers curl computes itself, and HTTP/2 pseudo-headers', () => {
    const command = toCurl(
      makeRecord({
        requestHeaders: [
          { name: ':authority', value: 'api.example.com' },
          { name: 'content-length', value: '12' },
          { name: 'host', value: 'api.example.com' },
          { name: 'x-trace', value: 'abc' },
        ],
      }),
      options,
    );
    assert.ok(!command.includes(':authority'));
    assert.ok(!command.includes('content-length'));
    assert.ok(!command.includes('host:'));
    assert.ok(command.includes("-H 'x-trace: abc'"));
  });

  it('masks secrets only when asked', () => {
    const record = makeRecord({
      requestHeaders: [{ name: 'Authorization', value: 'Bearer real-token' }],
    });
    assert.ok(toCurl(record, options).includes('Bearer real-token'));
    assert.ok(toCurl(record, { ...options, redact: true }).includes('[REDACTED]'));
    assert.ok(!toCurl(record, { ...options, redact: true }).includes('real-token'));
  });

  it('breaks the command over lines by default', () => {
    assert.ok(toCurl(makeRecord()).includes(' \\\n  '));
  });
});
