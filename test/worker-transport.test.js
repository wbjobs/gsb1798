import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker as NodeWorker, MessageChannel } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { WorkerTransport } from '../src/transports.js';
import { ResourceLoader } from '../src/loader.js';
import { ERR } from '../src/errors.js';

// worker_threads is not available in every sandbox; skip cleanly if blocked.
const adapterUrl = new URL('./fixtures/worker-adapter.js', import.meta.url);

function createWebLikeWorker(routes) {
  const thread = new NodeWorker(fileURLToPath(adapterUrl), { workerData: { routes } });
  const listeners = { message: new Set(), error: new Set(), messageerror: new Set() };
  const dispatch = (type, event) => {
    for (const listener of [...listeners[type]]) {
      listener(event);
      if (listener._once) listeners[type].delete(listener);
    }
  };
  thread.on('message', (data) => dispatch('message', { data, target: web }));
  thread.on('error', (error) => dispatch('error', { error, message: error.message, target: web }));
  thread.on('messageerror', (error) => dispatch('messageerror', { error, target: web }));
  const web = {
    postMessage(message, transfer = []) {
      // Web transfers ports via event.ports; embed it so the thread can
      // reconstruct `event.ports` from worker_threads message data.
      if (transfer[0]) message = { ...message, port: transfer[0] };
      thread.postMessage(message, transfer);
    },
    addEventListener(type, listener, options = {}) {
      if (options.once) listener._once = true;
      listeners[type]?.add(listener);
    },
    removeEventListener(type, listener) {
      listeners[type]?.delete(listener);
    },
    terminate() { return thread.terminate(); },
  };
  return { thread, web };
}

test('WorkerTransport: worker fetch, retry stream, deserialized error chain, cancel', { timeout: 20000 }, async (t) => {
  globalThis.MessageChannel ??= MessageChannel;
  const routes = {
    '/logo.png': { status: 200, contentType: 'image/png', body: 'PNGDATA' },
    '/flaky.js': { kind: 'flaky', succeedAfter: 3, failStatus: 503, retryAfter: '0.01', contentType: 'text/javascript', body: 'var x=1' },
    '/missing.woff2': { status: 404 },
    '/slow.png': 'slow',
  };
  const { thread, web } = createWebLikeWorker(routes);
  t.after(async () => { await thread.terminate(); });

  const transport = new WorkerTransport(() => web, { size: 1 });
  await transport.ready();

  // 1. success crosses the structured-clone boundary with an ArrayBuffer.
  const ok = await transport.request({
    id: 'logo', url: 'https://cdn.test/logo.png', options: { retries: 0 },
  });
  assert.equal(ok.ok, true);
  assert.ok(ok.buffer instanceof ArrayBuffer);
  assert.equal(new TextDecoder().decode(ok.buffer), 'PNGDATA');

  // 2. retry events stream back while the job is in flight.
  const retries = [];
  const flaky = await transport.request(
    { id: 'flaky', url: 'https://cdn.test/flaky.js', options: { retries: 2, retryDelay: 5 } },
    { onRetry: (info) => retries.push(info) },
  );
  assert.equal(flaky.ok, true);
  assert.equal(flaky.attempts, 3);
  assert.equal(retries.length, 2);
  assert.equal(retries[0].error.status, 503);

  // 3. the structured error is rebuilt into a ResourceError chain.
  const missing = await transport.request({
    id: 'missing', url: 'https://cdn.test/missing.woff2', options: { retries: 0 },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, ERR.HTTP);
  assert.equal(missing.error.status, 404);

  // 4. cancel aborts an in-flight job across the boundary.
  const slowPromise = transport.request({
    id: 'slow', url: 'https://cdn.test/slow.png', options: { timeout: 5000, retries: 0 },
  });
  setImmediate(() => transport.cancel('slow'));
  const slow = await slowPromise;
  assert.equal(slow.ok, false);
  assert.equal(slow.error.code, ERR.CANCELED);

  transport.dispose();
});

test('ResourceLoader degrades to FetchTransport when workers fail READY', { timeout: 10000 }, async () => {
  globalThis.MessageChannel ??= MessageChannel;
  const degradeReasons = [];
  const loader = new ResourceLoader({
    workerUrl: 'ignored-by-factory',
    workerPoolSize: 1,
    workerReadyTimeout: 200,
    useWorker: true,
    env: {
      ...globalThis,
      Worker: class {
        constructor() { /* never posts READY */ }
        postMessage() {}
        addEventListener() {}
        terminate() {}
      },
    },
  });
  loader.addEventListener('degrade', (e) => degradeReasons.push(e.detail));
  // Drain microtasks + ready timeout.
  await new Promise((r) => setTimeout(r, 260));
  assert.equal(degradeReasons.length, 1);
  assert.equal(degradeReasons[0].from, 'worker');
  assert.equal(degradeReasons[0].to, 'fetch');
  assert.equal(degradeReasons[0].reason[0].code, ERR.WORKER);
  loader.dispose();
});
