import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyFilters, defaultFilters, hasActiveFilters, matchRecord } from '../src/filter.js';
import { makeRecord } from './helpers.js';

const filters = (overrides = {}) => ({ ...defaultFilters(), apiOnly: false, ...overrides });

describe('matchRecord', () => {
  it('passes everything through an empty filter set', () => {
    assert.equal(matchRecord(makeRecord(), filters()), true);
  });

  it('hides page assets when "API only" is on', () => {
    const image = makeRecord({ resourceType: 'image' });
    assert.equal(matchRecord(image, filters({ apiOnly: true })), false);
    assert.equal(matchRecord(makeRecord({ resourceType: 'fetch' }), filters({ apiOnly: true })), true);
    assert.equal(
      matchRecord(makeRecord({ resourceType: 'websocket' }), filters({ apiOnly: true })),
      true,
    );
  });

  it('filters by method', () => {
    const record = makeRecord({ method: 'POST' });
    assert.equal(matchRecord(record, filters({ methods: new Set(['POST']) })), true);
    assert.equal(matchRecord(record, filters({ methods: new Set(['GET']) })), false);
  });

  it('filters by status family', () => {
    const record = makeRecord({ status: 404 });
    assert.equal(matchRecord(record, filters({ statusClasses: new Set(['client-error']) })), true);
    assert.equal(matchRecord(record, filters({ statusClasses: new Set(['ok']) })), false);
  });

  it('matches a failed request under the "failed" status family', () => {
    const record = makeRecord({ status: 0 });
    assert.equal(matchRecord(record, filters({ statusClasses: new Set(['failed']) })), true);
  });

  it('keeps only errors when asked', () => {
    const onlyErrors = filters({ onlyErrors: true });
    assert.equal(matchRecord(makeRecord({ status: 200 }), onlyErrors), false);
    assert.equal(matchRecord(makeRecord({ status: 500 }), onlyErrors), true);
    assert.equal(matchRecord(makeRecord({ status: 0 }), onlyErrors), true);
  });

  it('matches the URL case-insensitively', () => {
    assert.equal(matchRecord(makeRecord(), filters({ text: 'USERS' })), true);
    assert.equal(matchRecord(makeRecord(), filters({ text: 'orders' })), false);
  });

  it('treats a leading dash as an exclusion, like the Network tab', () => {
    assert.equal(matchRecord(makeRecord(), filters({ text: '-users' })), false);
    assert.equal(matchRecord(makeRecord(), filters({ text: '-orders' })), true);
  });

  it('ignores a filter that is only whitespace or a bare dash', () => {
    assert.equal(matchRecord(makeRecord(), filters({ text: '   ' })), true);
    assert.equal(matchRecord(makeRecord(), filters({ text: '-' })), true);
  });

  it('searches headers and both bodies', () => {
    const record = makeRecord({
      requestBody: { mimeType: 'application/json', text: '{"needle":1}', params: [] },
      responseBody: '{"other":2}',
      responseHeaders: [{ name: 'x-request-id', value: 'trace-xyz' }],
    });
    assert.equal(matchRecord(record, filters({ bodySearch: 'needle' })), true);
    assert.equal(matchRecord(record, filters({ bodySearch: 'other' })), true);
    assert.equal(matchRecord(record, filters({ bodySearch: 'trace-xyz' })), true);
    assert.equal(matchRecord(record, filters({ bodySearch: 'nothing-here' })), false);
  });

  it('combines filters with AND', () => {
    const record = makeRecord({ method: 'POST', status: 500 });
    assert.equal(
      matchRecord(record, filters({ methods: new Set(['POST']), onlyErrors: true })),
      true,
    );
    assert.equal(
      matchRecord(record, filters({ methods: new Set(['GET']), onlyErrors: true })),
      false,
    );
  });

  it('rejects a missing record instead of throwing', () => {
    assert.equal(matchRecord(null, filters()), false);
  });
});

describe('applyFilters', () => {
  it('preserves capture order', () => {
    const records = [
      makeRecord({ id: 1, status: 200 }),
      makeRecord({ id: 2, status: 404 }),
      makeRecord({ id: 3, status: 500 }),
    ];
    const kept = applyFilters(records, filters({ onlyErrors: true }));
    assert.deepEqual(
      kept.map((record) => record.id),
      [2, 3],
    );
  });

  it('tolerates a missing list', () => {
    assert.deepEqual(applyFilters(undefined, filters()), []);
  });
});

describe('hasActiveFilters', () => {
  it('reports the default "API only" state as active', () => {
    assert.equal(hasActiveFilters(defaultFilters()), true);
  });

  it('is false once everything is cleared', () => {
    assert.equal(hasActiveFilters(filters()), false);
  });

  it('notices each kind of filter', () => {
    assert.equal(hasActiveFilters(filters({ text: 'a' })), true);
    assert.equal(hasActiveFilters(filters({ bodySearch: ' x ' })), true);
    assert.equal(hasActiveFilters(filters({ methods: new Set(['GET']) })), true);
    assert.equal(hasActiveFilters(filters({ onlyErrors: true })), true);
  });
});
