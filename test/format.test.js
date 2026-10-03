import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatBytes,
  formatMs,
  formatPercent,
  formatTime,
  isError,
  splitUrl,
  statusClass,
  truncateMiddle,
} from '../src/format.js';

describe('formatBytes', () => {
  it('scales through the units', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1024), '1 KB');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(5 * 1024 * 1024), '5 MB');
  });

  it('returns a dash for unknown sizes', () => {
    assert.equal(formatBytes(null), '—');
    assert.equal(formatBytes(-1), '—');
    assert.equal(formatBytes(Number.NaN), '—');
  });
});

describe('formatMs', () => {
  it('switches to seconds above 1000ms', () => {
    assert.equal(formatMs(0), '0 ms');
    assert.equal(formatMs(0.4), '<1 ms');
    assert.equal(formatMs(87.6), '88 ms');
    assert.equal(formatMs(1500), '1.50 s');
  });

  it('returns a dash for unknown durations', () => {
    assert.equal(formatMs(undefined), '—');
    assert.equal(formatMs(-1), '—');
  });
});

describe('statusClass', () => {
  it('buckets by status family', () => {
    assert.equal(statusClass(200), 'ok');
    assert.equal(statusClass(204), 'ok');
    assert.equal(statusClass(302), 'redirect');
    assert.equal(statusClass(404), 'client-error');
    assert.equal(statusClass(503), 'server-error');
    assert.equal(statusClass(101), 'info');
  });

  it('treats a missing status as a failed request', () => {
    assert.equal(statusClass(0), 'failed');
    assert.equal(statusClass(undefined), 'failed');
  });
});

describe('isError', () => {
  it('counts failures and 4xx/5xx', () => {
    assert.equal(isError({ status: 200 }), false);
    assert.equal(isError({ status: 304 }), false);
    assert.equal(isError({ status: 401 }), true);
    assert.equal(isError({ status: 500 }), true);
    assert.equal(isError({ status: 0 }), true);
    assert.equal(isError({}), true);
  });
});

describe('splitUrl', () => {
  it('splits a well-formed URL', () => {
    const parts = splitUrl('https://api.example.com/v1/users?page=2');
    assert.equal(parts.host, 'api.example.com');
    assert.equal(parts.path, '/v1/users');
    assert.equal(parts.query, '?page=2');
    assert.equal(parts.display, '/v1/users?page=2');
  });

  it('degrades gracefully on malformed input', () => {
    const parts = splitUrl('not a url?x=1');
    assert.equal(parts.host, '');
    assert.equal(parts.path, 'not a url');
    assert.equal(parts.query, '?x=1');
  });
});

describe('formatTime', () => {
  it('returns a dash for unparseable timestamps', () => {
    assert.equal(formatTime(null), '—');
    assert.equal(formatTime('nope'), '—');
  });

  it('renders millisecond precision', () => {
    assert.match(formatTime('2026-01-03T10:00:00.007Z'), /^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  });
});

describe('truncateMiddle', () => {
  it('leaves short strings alone', () => {
    assert.equal(truncateMiddle('/v1/users', 20), '/v1/users');
  });

  it('keeps the head and tail of long strings', () => {
    const result = truncateMiddle('a'.repeat(50) + 'TAIL', 11);
    assert.equal(result.length, 11);
    assert.ok(result.includes('…'));
    assert.ok(result.endsWith('TAIL'));
  });
});

describe('formatPercent', () => {
  it('rounds, and floors tiny non-zero ratios', () => {
    assert.equal(formatPercent(0), '0%');
    assert.equal(formatPercent(0.5), '50%');
    assert.equal(formatPercent(0.002), '<1%');
    assert.equal(formatPercent(Number.NaN), '—');
  });
});
