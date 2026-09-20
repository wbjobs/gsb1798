import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResourceLoader } from '../src/loader.js';
import { MetricsCollector } from '../src/metrics.js';
import { ResourceError, ERR } from '../src/errors.js';

// --- fakes -----------------------------------------------------------------

class FakeTransport {
  constructor(routes) {
    this.routes = routes;
    this.cancelled = new Set();
    this.calls = new Map();
  }
  ready() { return Promise.resolve(); }
  request(job, { signal } = {}) {
    const count = (this.calls.get(job.id) || 0) + 1;
    this.calls.set(job.id, count);
    const route = this.routes[job.url] || { kind: 'ok', delay: 5 };
    return new Promise((resolve, reject) => {
      const finishCanceled = () => resolve(fail(job.id, job.url, canceled()));
      if (signal?.aborted) return finishCanceled();
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        if (this.cancelled.has(job.id)) return resolve(fail(job.id, job.url, canceled()));
        if (route.kind === 'error') {
          const status = typeof route.status === 'function' ? route.status(count) : route.status;
          if (status) {
            return resolve(fail(job.id, job.url, httpError(job.url, status, count)));
          }
          return reject(new ResourceError(route.message || 'transport down', { code: route.code || ERR.WORKER }));
        }
        resolve({
          ok: true,
          id: job.id,
          url: job.url,
          status: 200,
          contentType: route.contentType || null,
          headers: {},
          buffer: new TextEncoder().encode(route.body || 'body').buffer,
          text: route.body || 'body',
          attempts: count,
          duration: route.delay,
        });
      }, route.delay ?? 5);
      const onAbort = () => {
        clearTimeout(timer);
        finishCanceled();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  cancel(id) { this.cancelled.add(id); }
  dispose() {}
}

function httpError(url, status, attempt) {
  return new ResourceError(`HTTP ${status}: ${url}`, {
    code: ERR.HTTP,
    status,
    details: { url, attempt },
  });
}
function canceled() {
  return new ResourceError('Canceled', { code: ERR.CANCELED });
}
function fail(id, url, error) {
  return { ok: false, id, url, attempts: 1, duration: 0, error };
}

function fakeEnv(extra = {}) {
  const store = new Map();
  return {
    performance,
    AbortController,
    EventTarget,
    Event,
    Blob: class {
      constructor(parts, options) { this.parts = parts; this.type = options.type; this.size = parts[0]?.byteLength || 0; }
    },
    URL: {
      createObjectURL(blob) {
        const url = `blob:fake/${store.size}-${blob.size}`;
        store.set(url, blob);
        return url;
      },
      revokeObjectURL(url) { store.delete(url); },
    },
    Image: class {
      set src(v) { setTimeout(() => this.onload?.(), 0); }
    },
    ...extra,
  };
}

function makeLoader(routes, options = {}) {
  const transport = new FakeTransport(routes);
  const loader = new ResourceLoader({
    transport,
    env: fakeEnv(options.env),
    concurrency: options.concurrency ?? 3,
    retries: options.retries ?? 0,
    timeout: options.timeout ?? 5000,
    metrics: options.metrics,
  });
  return { loader, transport };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// --- tests -----------------------------------------------------------------

test('critical resources are dispatched before low-priority ones in a burst', async () => {
  const order = [];
  const { loader } = makeLoader({}, { concurrency: 2 });
  loader.addEventListener('enqueue', (e) => {});
  const mk = (url, priority) => ({
    id: url,
    type: 'image',
    url,
    priority,
    fallback: 'placeholder',
    retries: 0,
  });
  // Wait for both slots to be in flight before recording order.
  const barrier = new Promise((resolve) => {
    let n = 0;
    loader.addEventListener('enqueue', () => { if (++n === 6) resolve(); });
  });
  const started = [];
  const specs = [
    mk('low-1', 'low'), mk('normal-1', 'normal'), mk('high-1', 'high'),
    mk('crit-1', 'critical'), mk('crit-2', 'critical'), mk('low-2', 'low'),
  ];
  const promises = specs.map((spec) => loader.load(spec).then((r) => started.push(spec.id), () => started.push(`${spec.id}!`)));
  await barrier;
  await tick();
  // Pump is a microtask after the 6th enqueue; the two open slots take criticals.
  await Promise.resolve();
  await Promise.all(promises);
  assert.deepEqual(started.slice(0, 2).sort(), ['crit-1', 'crit-2']);
  assert.ok(started.indexOf('high-1') < started.indexOf('normal-1'));
  assert.ok(started.indexOf('normal-1') < started.indexOf('low-1'));
  assert.ok(started.indexOf('low-1') < started.indexOf('low-2'));
  assert.equal(loader.stats().queued, 0);
});

test('concurrency limit is never exceeded and stats reflect in-flight count', async () => {
  let active = 0;
  let peak = 0;
  let resolveGate;
  const gate = new Promise((r) => { resolveGate = r; });
  const { loader, transport } = makeLoader({});
  const original = transport.request.bind(transport);
  transport.request = async (job, hooks) => {
    active++;
    peak = Math.max(peak, active);
    const p = original(job, hooks);
    await gate;
    active--;
    return p;
  };
  const all = [];
  for (let i = 0; i < 10; i++) {
    all.push(loader.load({ id: `r${i}`, type: 'image', url: `u${i}`, fallback: 'ph' }));
  }
  await delay(20);
  assert.equal(loader.stats().active, 3);
  assert.equal(peak, 3);
  resolveGate();
  await Promise.all(all);
  assert.equal(peak, 3);
});

test('timeout/failure on a 404 resolves with the placeholder and a fallback event', async () => {
  const events = [];
  const { loader } = makeLoader({ 'https://cdn.test/missing.png': { kind: 'error', status: 404 } });
  loader.addEventListener('fallback', (e) => events.push(e.detail));
  loader.addEventListener('fail', () => assert.fail('should not fail when fallback is provided'));
  const resource = await loader.load({
    id: 'img1',
    type: 'image',
    url: 'https://cdn.test/missing.png',
    priority: 'critical',
    fallback: 'data:image/svg+xml,fallback',
    retries: 0,
  });
  assert.equal(resource.kind, 'image');
  assert.equal(resource.degraded, true);
  assert.equal(resource.url, 'data:image/svg+xml,fallback');
  assert.equal(events.length, 1);
  assert.equal(events[0].id, 'img1');
  assert.equal(events[0].error[0].code, ERR.HTTP);
  assert.equal(events[0].error[0].status, 404);
});

test('without a fallback the rejection carries the exception chain', async () => {
  const { loader } = makeLoader({ 'https://cdn.test/boom.js': { kind: 'error', status: 500 } });
  await assert.rejects(
    loader.load({ id: 's1', type: 'script', url: 'https://cdn.test/boom.js', retries: 0 }),
    (err) => err.code === ERR.HTTP && err.status === 500,
  );
});

test('retry events fire per attempt and the metrics retry counter increments', async () => {
  const metrics = new MetricsCollector();
  const { loader, transport } = makeLoader({}, { retries: 2, metrics });
  let attempt = 0;
  transport.request = (job, hooks) => {
    attempt++;
    // Simulate two retried attempts within one transport request.
    hooks.onRetry({ id: job.id, attempt: 0, nextAttempt: 1, delay: 0, error: { code: ERR.NETWORK } });
    hooks.onRetry({ id: job.id, attempt: 1, nextAttempt: 2, delay: 0, error: { code: ERR.NETWORK } });
    return Promise.resolve({
      ok: true, id: job.id, url: job.url, status: 200, contentType: null,
      headers: {}, buffer: new TextEncoder().encode('x').buffer, attempts: attempt, duration: 1,
    });
  };
  const retries = [];
  loader.addEventListener('retry', (e) => retries.push(e.detail));
  const resource = await loader.load({ id: 'rtry', type: 'image', url: 'u', fallback: 'ph' });
  assert.equal(resource.degraded, undefined);
  assert.equal(retries.length, 2);
  assert.equal(retries[1].nextAttempt, 2);
  assert.equal(metrics.counters().retries, 2);
});

test('cancel queued job settles CANCELED and keeps the slot for others', async () => {
  const { loader } = makeLoader({});
  const canceled = loader.load({ id: 'c1', type: 'image', url: 'uc', priority: 'low', fallback: 'ph' });
  // Fill all 3 slots with higher priority first.
  const holders = ['h1', 'h2', 'h3'].map((id) => loader.load({ id, type: 'image', url: id, priority: 'high', fallback: 'ph' }));
  await tick();
  assert.equal(loader.stats().queued, 1);
  assert.equal(loader.cancel('c1'), true);
  await assert.rejects(canceled, (err) => err.code === ERR.CANCELED);
  await Promise.all(holders);
  assert.equal(loader.stats().active, 0);
});

test('cancel in-flight job aborts the fetch and rejects with CANCELED', async () => {
  const { loader, transport } = makeLoader({ 'https://cdn.test/slow.png': { kind: 'ok', delay: 100 } });
  const p = loader.load({ id: 'slow', type: 'image', url: 'https://cdn.test/slow.png', fallback: 'ph' });
  await delay(10);
  assert.equal(loader.cancel('slow'), true);
  await assert.rejects(p, (err) => err.code === ERR.CANCELED);
  assert.ok(transport.cancelled.has('slow'));
});

test('fallback supports custom functions receiving the error', async () => {
  const { loader } = makeLoader({ 'https://cdn.test/font.woff2': { kind: 'error', status: 404 } });
  const resource = await loader.load({
    id: 'font1',
    type: 'font',
    family: 'MyFont',
    url: 'https://cdn.test/font.woff2',
    fallback: (spec, error) => `${spec.family}, sans-serif`,
  });
  assert.equal(resource.kind, 'font');
  assert.equal(resource.degraded, true);
  assert.equal(resource.stack, 'MyFont, sans-serif');
});

test('transport-level failure with no fallback rejects as WORKER_ERROR', async () => {
  const { loader } = makeLoader({ 'https://cdn.test/x.png': { kind: 'error', message: 'worker crashed' } });
  await assert.rejects(
    loader.load({ id: 'w1', type: 'image', url: 'https://cdn.test/x.png' }),
    (err) => err.code === ERR.WORKER && /worker crashed/.test(err.message),
  );
});

test('invalid specs reject with INVALID and do not consume a slot', async () => {
  const { loader } = makeLoader({});
  await assert.rejects(loader.load(null), (err) => err.code === ERR.INVALID);
  await assert.rejects(loader.load({ type: 'video', url: 'x' }), (err) => err.code === ERR.INVALID);
  await assert.rejects(loader.load({ type: 'image' }), (err) => err.code === ERR.INVALID);
  await delay(10);
  assert.equal(loader.stats().active, 0);
  assert.equal(loader.stats().queued, 0);
});

test('duplicate ids on the queue reject the second enqueue', async () => {
  const { loader } = makeLoader({});
  const first = loader.load({ id: 'dup', type: 'image', url: 'u1', fallback: 'ph' });
  await assert.rejects(
    loader.load({ id: 'dup', type: 'image', url: 'u2', fallback: 'ph' }),
    /duplicate id/,
  );
  await first;
});

test('dispose rejects pending promises and aborts in-flight jobs', async () => {
  const { loader } = makeLoader(
    { us: { kind: 'ok', delay: 500 } },
    { concurrency: 1 },
  );
  const slow = loader.load({ id: 's', type: 'image', url: 'us', fallback: 'ph' });
  const queued = loader.load({ id: 'q', type: 'image', url: 'uq', priority: 'low', fallback: 'ph' });
  await tick();
  assert.equal(loader.stats().active, 1);
  assert.equal(loader.stats().queued, 1);
  loader.dispose();
  await assert.rejects(slow, (err) => err.code === ERR.CANCELED);
  await assert.rejects(queued, (err) => err.code === ERR.CANCELED);
});

test('drain event fires after the final resource settles', async () => {
  const { loader } = makeLoader({});
  let drained = null;
  loader.addEventListener('drain', (e) => { drained = e.detail.stats; });
  await Promise.all([
    loader.load({ id: 'd1', type: 'image', url: 'a', fallback: 'ph' }),
    loader.load({ id: 'd2', type: 'image', url: 'b', fallback: 'ph' }),
  ]);
  assert.ok(drained);
  assert.equal(drained.queued, 0);
  assert.equal(drained.active, 0);
});
