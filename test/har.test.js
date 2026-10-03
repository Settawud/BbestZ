import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  cleanHeaders,
  headerValue,
  normalizeEndpoint,
  parseBody,
  redactHeaders,
  toRecord,
} from '../src/har.js';
import { makeHarEntry } from './helpers.js';

describe('cleanHeaders', () => {
  it('drops HTTP/2 pseudo-headers and stringifies values', () => {
    const cleaned = cleanHeaders([
      { name: ':status', value: '200' },
      { name: 'x-count', value: 7 },
    ]);
    assert.deepEqual(cleaned, [{ name: 'x-count', value: '7' }]);
  });

  it('tolerates missing input', () => {
    assert.deepEqual(cleanHeaders(undefined), []);
    assert.deepEqual(cleanHeaders([null]), []);
  });
});

describe('headerValue', () => {
  it('looks up case-insensitively', () => {
    const headers = [{ name: 'Content-Type', value: 'application/json' }];
    assert.equal(headerValue(headers, 'content-type'), 'application/json');
    assert.equal(headerValue(headers, 'missing'), null);
  });
});

describe('redactHeaders', () => {
  it('masks secrets but keeps the header names', () => {
    const redacted = redactHeaders([
      { name: 'Authorization', value: 'Bearer abc' },
      { name: 'Accept', value: '*/*' },
    ]);
    assert.deepEqual(redacted, [
      { name: 'Authorization', value: '[REDACTED]' },
      { name: 'Accept', value: '*/*' },
    ]);
  });

  it('passes everything through when redaction is off', () => {
    const headers = [{ name: 'Cookie', value: 'sid=1' }];
    assert.deepEqual(redactHeaders(headers, false), headers);
  });
});

describe('toRecord', () => {
  it('flattens a HAR entry into a panel record', () => {
    const record = toRecord(makeHarEntry(), 9);
    assert.equal(record.id, 9);
    assert.equal(record.method, 'POST', 'method is upper-cased');
    assert.equal(record.status, 201);
    assert.equal(record.resourceType, 'fetch');
    assert.equal(record.time, 135.5);
    assert.equal(record.responseSize, 31);
    assert.equal(record.transferSize, 410);
    assert.equal(record.requestBody.text, '{"sku":"A1"}');
    assert.equal(record.serverIP, '10.0.0.1');
    assert.equal(record.bodyPending, true, 'body arrives later via getContent');
    assert.equal(record.responseBody, null);
  });

  it('strips pseudo-headers from the captured headers', () => {
    const record = toRecord(makeHarEntry(), 1);
    assert.deepEqual(
      record.requestHeaders.map((header) => header.name),
      ['content-type', 'authorization'],
    );
  });

  it('marks a zero-transfer response as served from cache', () => {
    const entry = makeHarEntry();
    entry.response._transferSize = 0;
    assert.equal(toRecord(entry, 1).fromCache, true);
  });

  it('survives a request that never completed', () => {
    const record = toRecord({ request: { url: 'https://x.test/a' }, response: { status: 0 } }, 1);
    assert.equal(record.method, 'GET');
    assert.equal(record.status, 0);
    assert.equal(record.time, null);
    assert.equal(record.fromCache, false);
    assert.deepEqual(record.requestHeaders, []);
  });

  it('guesses a resource type when the browser does not supply one', () => {
    const entry = makeHarEntry({ _resourceType: undefined });
    assert.equal(toRecord(entry, 1).resourceType, 'xhr', 'JSON content implies an API call');

    const image = makeHarEntry({ _resourceType: undefined });
    image.response.content.mimeType = 'image/png';
    assert.equal(toRecord(image, 1).resourceType, 'image');
  });
});

describe('parseBody', () => {
  it('parses JSON by MIME type', () => {
    const parsed = parseBody('{"a":1}', 'application/json; charset=utf-8');
    assert.equal(parsed.kind, 'json');
    assert.deepEqual(parsed.value, { a: 1 });
  });

  it('sniffs JSON when no MIME type is given', () => {
    assert.equal(parseBody('[1,2]').kind, 'json');
    assert.equal(parseBody('hello').kind, 'text');
  });

  it('falls back to text and reports the parse error on malformed JSON', () => {
    const parsed = parseBody('{"a":', 'application/json');
    assert.equal(parsed.kind, 'text');
    assert.ok(parsed.parseError, 'the reason is surfaced to the panel');
  });

  it('expands urlencoded form bodies', () => {
    const parsed = parseBody('a=1&b=two', 'application/x-www-form-urlencoded');
    assert.equal(parsed.kind, 'form');
    assert.deepEqual(parsed.value, [
      { name: 'a', value: '1' },
      { name: 'b', value: 'two' },
    ]);
  });

  it('classifies empty and binary bodies', () => {
    assert.equal(parseBody('').kind, 'empty');
    assert.equal(parseBody(null).kind, 'empty');
    assert.equal(parseBody('\u0000\u0001', 'image/png').kind, 'binary');
  });
});

describe('normalizeEndpoint', () => {
  it('collapses numeric, uuid and object-id segments', () => {
    assert.equal(
      normalizeEndpoint('https://api.test/v1/users/42/posts'),
      'https://api.test/v1/users/:id/posts',
    );
    assert.equal(
      normalizeEndpoint('https://api.test/u/3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071'),
      'https://api.test/u/:id',
    );
    assert.equal(
      normalizeEndpoint('https://api.test/doc/507f1f77bcf86cd799439011'),
      'https://api.test/doc/:id',
    );
  });

  it('drops the query string and keeps real path segments', () => {
    assert.equal(normalizeEndpoint('https://api.test/v1/users?page=2'), 'https://api.test/v1/users');
  });

  it('falls back to the path for malformed URLs', () => {
    assert.equal(normalizeEndpoint('junk/path?x=1'), 'junk/path');
  });
});
