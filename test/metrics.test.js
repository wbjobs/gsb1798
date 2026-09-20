import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResourceLoader } from '../src/loader.js';
import { MetricsCollector } from '../src/metrics.js';
import { ERR } from '../src/errors.js';

class ImmediateTransport {
  async ready() {}
  request(job) {
    if (job.url.endsWith('/missing.png')) {
      return Promise.resolve({
        ok: false, id: job.id, url: job.url, attempts: 1, duration: 1,
        error: new ErrorClass(`HTTP 404: ${job.url}`, { code: ERR.HTTP, status: 404 }),
      });
    }
    return Promise.resolve({
      ok: true, id: job.id, url: job.url, status: 200, contentType: 'image/png',
      headers: {}, buffer: new TextEncoder().encode('PNG').buffer, attempts: 1, duration: 2,
    });
  }
  cancel() {}
  dispose() {}
}

import { ResourceError as ErrorClass } from '../src/errors.js';

function fakeEnv() {
  return {
    performance,
    AbortController,
    Blob: class { constructor(parts) { this.parts = parts; } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    Image: class { set src(v) { setTimeout(() => this.onload?.(), 0); } },
  };
}

test('marks/measures are observed and counters/histograms are correct', async () => {
  const metrics = new MetricsCollector();
  const loader = new ResourceLoader({
    transport: new ImmediateTransport(),
    env: fakeEnv(),
    concurrency: 4,
    retries: 0,
    metrics,
  });

  const ok = loader.load({ id: 'a', type: 'image', url: 'https://cdn.test/a.png', priority: 'critical' });
  const degraded = loader.load({
    id: 'b', type: 'image', url: 'https://cdn.test/missing.png',
    fallback: 'data:image/svg+xml,ph',
  });
  const failed = loader.load({ id: 'c', type: 'image', url: 'https://cdn.test/missing.png' });
  await Promise.all([ok, degraded, failed.catch(() => null)]);

  // Let the PerformanceObserver microtask flush.
  await new Promise((r) => setTimeout(r, 0));

  const counters = metrics.counters();
  assert.equal(counters.loaded, 1);
  assert.equal(counters.fallback, 1);
  assert.equal(counters.failed, 1);

  const ids = metrics.entries().map((e) => e.id).sort();
  assert.deepEqual(ids, ['a', 'b', 'c']);
  const entryA = metrics.entries().find((e) => e.id === 'a');
  assert.ok(entryA.phases.total, 'total measure observed');
  assert.ok(entryA.phases.fetch, 'fetch measure observed');
  assert.equal(entryA.phases.total.detail.type, 'image');

  const total = metrics.summary('total');
  assert.equal(total.count, 3);
  assert.ok(total.min <= total.avg && total.avg <= total.max);
  assert.ok(total.p95 >= total.avg - 1);

  const directMeasures = performance.getEntriesByType('measure').filter((m) => m.name.startsWith('rl:'));
  assert.ok(directMeasures.some((m) => m.name === 'rl:a:total'));
  assert.ok(directMeasures.some((m) => m.name === 'rl:b:fetch'));

  metrics.disconnect();
  loader.dispose();
});

test('collector degrades gracefully without a PerformanceObserver', () => {
  const metrics = new MetricsCollector({ PO: undefined, perf: undefined });
  metrics.incr('loaded');
  assert.equal(metrics.counters().loaded, 1);
  assert.equal(metrics.summary('total'), null);
  metrics.disconnect();
});
