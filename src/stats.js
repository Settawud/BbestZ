/**
 * Aggregations behind the summary bar and the "Endpoints" view — the part a
 * plain Network tab will not give you: which endpoint is slow, which one is
 * quietly erroring, and how often each gets called.
 */

import { isError } from './format.js';
import { normalizeEndpoint } from './har.js';

/** Totals for the status bar. */
export function summarize(records) {
  const list = records ?? [];
  let errors = 0;
  let bytes = 0;
  let totalTime = 0;
  let timed = 0;

  for (const record of list) {
    if (isError(record)) errors += 1;
    bytes += record.responseSize || 0;
    if (typeof record.time === 'number') {
      totalTime += record.time;
      timed += 1;
    }
  }

  return {
    count: list.length,
    errors,
    bytes,
    avgTime: timed ? totalTime / timed : null,
    slowest: list.reduce(
      (worst, record) =>
        typeof record.time === 'number' && (!worst || record.time > worst.time) ? record : worst,
      null,
    ),
  };
}

/**
 * Group records by `METHOD + normalized endpoint`, sorted by call count then
 * error count so the noisiest and most broken endpoints float to the top.
 */
export function endpointStats(records) {
  const groups = new Map();

  for (const record of records ?? []) {
    const endpoint = normalizeEndpoint(record.url);
    const key = `${record.method} ${endpoint}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        method: record.method,
        endpoint,
        count: 0,
        errors: 0,
        bytes: 0,
        totalTime: 0,
        timed: 0,
        minTime: null,
        maxTime: null,
        lastStatus: 0,
        lastId: null,
      };
      groups.set(key, group);
    }

    group.count += 1;
    if (isError(record)) group.errors += 1;
    group.bytes += record.responseSize || 0;
    group.lastStatus = record.status;
    group.lastId = record.id;

    if (typeof record.time === 'number') {
      group.totalTime += record.time;
      group.timed += 1;
      group.minTime = group.minTime == null ? record.time : Math.min(group.minTime, record.time);
      group.maxTime = group.maxTime == null ? record.time : Math.max(group.maxTime, record.time);
    }
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      avgTime: group.timed ? group.totalTime / group.timed : null,
      errorRate: group.count ? group.errors / group.count : 0,
    }))
    .sort((a, b) => b.count - a.count || b.errors - a.errors || a.key.localeCompare(b.key));
}
