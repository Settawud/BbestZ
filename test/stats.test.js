import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { endpointStats, summarize } from '../src/stats.js';
import { makeRecord } from './helpers.js';

describe('summarize', () => {
  it('totals count, errors, bytes and the average duration', () => {
    const stats = summarize([
      makeRecord({ id: 1, time: 100, responseSize: 100, status: 200 }),
      makeRecord({ id: 2, time: 300, responseSize: 200, status: 500 }),
      makeRecord({ id: 3, time: null, responseSize: 0, status: 200 }),
    ]);
    assert.equal(stats.count, 3);
    assert.equal(stats.errors, 1);
    assert.equal(stats.bytes, 300);
    assert.equal(stats.avgTime, 200, 'untimed requests are excluded from the average');
    assert.equal(stats.slowest.id, 2);
  });

  it('returns a null average and no slowest entry for an empty log', () => {
    const stats = summarize([]);
    assert.equal(stats.count, 0);
    assert.equal(stats.avgTime, null);
    assert.equal(stats.slowest, null);
  });
});

describe('endpointStats', () => {
  it('groups by method plus normalized path', () => {
    const groups = endpointStats([
      makeRecord({ id: 1, url: 'https://api.test/v1/users/1', time: 100 }),
      makeRecord({ id: 2, url: 'https://api.test/v1/users/2', time: 300, status: 500 }),
      makeRecord({ id: 3, url: 'https://api.test/v1/users/3', time: 200 }),
      makeRecord({ id: 4, url: 'https://api.test/v1/orders', method: 'POST', time: 50 }),
    ]);

    assert.equal(groups.length, 2);

    const [users, orders] = groups;
    assert.equal(users.key, 'GET https://api.test/v1/users/:id');
    assert.equal(users.count, 3);
    assert.equal(users.errors, 1);
    assert.equal(users.avgTime, 200);
    assert.equal(users.minTime, 100);
    assert.equal(users.maxTime, 300);
    assert.equal(users.errorRate, 1 / 3);
    assert.equal(users.lastId, 3, 'the most recent call in the group');

    assert.equal(orders.method, 'POST');
    assert.equal(orders.count, 1);
    assert.equal(orders.errorRate, 0);
  });

  it('keeps the same path under different methods apart', () => {
    const groups = endpointStats([
      makeRecord({ url: 'https://api.test/v1/items' }),
      makeRecord({ url: 'https://api.test/v1/items', method: 'POST' }),
    ]);
    assert.equal(groups.length, 2);
  });

  it('sorts by call count, then by error count', () => {
    const groups = endpointStats([
      makeRecord({ url: 'https://api.test/a', status: 500 }),
      makeRecord({ url: 'https://api.test/b' }),
      makeRecord({ url: 'https://api.test/b' }),
    ]);
    assert.equal(groups[0].endpoint, 'https://api.test/b');
  });

  it('leaves min/max null when nothing was timed', () => {
    const [group] = endpointStats([makeRecord({ time: null })]);
    assert.equal(group.avgTime, null);
    assert.equal(group.minTime, null);
    assert.equal(group.maxTime, null);
  });

  it('returns an empty list for no input', () => {
    assert.deepEqual(endpointStats(undefined), []);
  });
});
