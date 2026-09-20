// Node-side adapter: makes worker_threads look like a Web Worker global
// (`self.postMessage` / `self.onmessage`) and installs a configurable mock
// fetch (routes arrive via workerData), then loads the production worker.
import { parentPort, workerData, MessageChannel } from 'node:worker_threads';

const selfShim = {
  postMessage(message, transfer = []) {
    parentPort.postMessage(message, transfer);
  },
  onmessage: null,
};
globalThis.self = selfShim;
globalThis.MessageChannel = MessageChannel;

const routes = workerData?.routes || {};

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
    async text() { return typeof body === 'string' ? body : ''; },
  };
}

const counters = {};
globalThis.fetch = async (url, init) => {
  const path = new URL(url).pathname;
  counters[path] = (counters[path] || 0) + 1;
  const route = routes[path];
  if (!route) return respond(404, 'text/plain', 'no route');
  if (route === 'slow') {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (init.signal.aborted) onAbort();
      else init.signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  if (route.kind === 'flaky') {
    return counters[path] < route.succeedAfter
      ? respond(route.failStatus, 'text/plain', '', { 'retry-after': route.retryAfter || '0' })
      : respond(200, route.contentType || 'application/octet-stream', route.body || 'ok');
  }
  return respond(route.status || 200, route.contentType || 'application/octet-stream', route.body || 'ok');
};

parentPort.on('message', (message) => {
  // Emulate the Web event: transferred ports ride along in event.ports.
  const ports = message.port ? [message.port] : [];
  selfShim.onmessage?.({ data: message, ports });
});

await import('../../src/worker.js');
