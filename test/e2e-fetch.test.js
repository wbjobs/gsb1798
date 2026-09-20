import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResourceLoader } from '../src/loader.js';
import { FetchTransport } from '../src/transports.js';
import { ERR } from '../src/errors.js';

// In-process "server": exercises the same production code path (real fetch
// runner with retries/timeouts) without binding sockets.
function createMockServer() {
  let flakyCalls = 0;
  const pendingTimeouts = new Set();
  const routes = {
    '/logo.png': () => respond(200, 'image/png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer),
    '/flaky.js': () => {
      flakyCalls++;
      return flakyCalls < 3
        ? respond(503, 'text/plain', '', { 'retry-after': '0.02' })
        : respond(200, 'text/javascript', 'window.__loaded = true', { 'x-attempt': String(flakyCalls) });
    },
    '/missing.woff2': () => respond(404, 'text/plain', 'not found'),
    '/slow.png': (init) => new Promise((resolve, reject) => {
      // Hangs past the client timeout; the AbortSignal must reject the fetch,
      // exactly as a real network request would.
      const timer = setTimeout(() => resolve(respond(200, 'image/png', '')), 5000);
      pendingTimeouts.add(timer);
      const onAbort = () => {
        clearTimeout(timer);
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (init.signal.aborted) onAbort();
      else init.signal.addEventListener('abort', onAbort, { once: true });
    }),
  };
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    const route = routes[path];
    if (!route) return respond(404, 'text/plain', 'no route');
    return route(init);
  };
  return {
    fetchImpl,
    flakyCalls: () => flakyCalls,
    close() {
      for (const timer of pendingTimeouts) clearTimeout(timer);
      pendingTimeouts.clear();
    },
  };
}

function respond(status, contentType, body, extraHeaders = {}) {
  const headers = { 'content-type': contentType, ...extraHeaders };
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    url: '',
    headers: {
      get(name) { return headers[String(name).toLowerCase()] ?? null; },
      forEach(cb) { for (const [k, v] of Object.entries(headers)) cb(v, k); },
    },
    async arrayBuffer() {
      return typeof body === 'string' ? new TextEncoder().encode(body).buffer : body;
    },
    async text() {
      return typeof body === 'string' ? body : new TextDecoder().decode(body);
    },
  };
}

function nodeEnv(fetchImpl) {
  return {
    performance,
    AbortController,
    fetch: fetchImpl,
    Blob: class { constructor(parts, options) { this.parts = parts; this.type = options?.type; } },
    URL: { createObjectURL: (b) => `blob:${b.type}`, revokeObjectURL() {} },
  };
}

test('end-to-end via FetchTransport: success, retry-then-success, 404 fallback, timeout fallback', async () => {
  const server = createMockServer();
  const retries = [];
  const fallbacks = [];

  const loader = new ResourceLoader({
    transport: new FetchTransport({ fetchImpl: server.fetchImpl }),
    env: nodeEnv(server.fetchImpl),
    concurrency: 2,
    timeout: 60,
    retries: 2,
    retryDelay: 5,
  });
  loader.addEventListener('retry', (e) => retries.push(e.detail));
  loader.addEventListener('fallback', (e) => fallbacks.push(e.detail));

  const base = 'https://cdn.test';
  const [logo, flaky, missing, slow] = await Promise.all([
    loader.load({ id: 'logo', type: 'image', url: `${base}/logo.png`, priority: 'critical' }),
    loader.load({ id: 'flaky', type: 'script', url: `${base}/flaky.js`, priority: 'high', inline: false }),
    loader.load({
      id: 'missing', type: 'font', family: 'Display', url: `${base}/missing.woff2`,
      fallback: 'Georgia, serif', retries: 0,
    }),
    loader.load({
      id: 'slow', type: 'image', url: `${base}/slow.png`,
      fallback: 'data:image/svg+xml,slow-placeholder', retries: 1, retryDelay: 5,
    }),
  ]);

  assert.equal(logo.kind, 'image');
  assert.match(logo.url, /^blob:image/);

  assert.equal(flaky.kind, 'script');
  assert.match(flaky.url, /^blob:text\/javascript/);
  assert.equal(server.flakyCalls(), 3);
  assert.ok(retries.some((r) => r.id === 'flaky' && r.attempt === 0));

  assert.equal(missing.kind, 'font');
  assert.equal(missing.degraded, true);
  assert.equal(missing.stack, 'Georgia, serif');
  const missingEvent = fallbacks.find((f) => f.id === 'missing');
  assert.equal(missingEvent.error[0].code, ERR.HTTP);
  assert.equal(missingEvent.error[0].status, 404);

  assert.equal(slow.kind, 'image');
  assert.equal(slow.degraded, true);
  assert.match(slow.url, /slow-placeholder/);
  const slowEvent = fallbacks.find((f) => f.id === 'slow');
  const codes = slowEvent.error.map((link) => link.code);
  assert.ok(
    codes.includes(ERR.RETRIES_EXHAUSTED) || codes.includes(ERR.TIMEOUT),
    `expected timeout chain, got ${codes.join(' -> ')}`,
  );
  assert.ok(codes.includes(ERR.TIMEOUT), `timeout missing from chain: ${codes.join(' -> ')}`);

  const counters = loader.stats().counters;
  assert.equal(counters.loaded, 2);
  assert.equal(counters.fallback, 2);
  assert.equal(counters.retries, 3); // 2 from flaky + 1 from slow

  loader.dispose();
  server.close();
});
