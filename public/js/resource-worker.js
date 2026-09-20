import { ERROR_CODES } from './errors.js';

const activeRequests = new Map();

function serializeHeaders(headers) {
  const result = {};
  headers?.forEach?.((value, key) => {
    result[key] = value;
  });
  return result;
}

function failure(id, error, overrides = {}) {
  self.postMessage({
    type: 'failure',
    id,
    message: error?.message ?? String(error),
    name: error?.name ?? 'Error',
    code: ERROR_CODES.UNKNOWN,
    ...overrides
  });
}

async function performFetch(id, request) {
  if (activeRequests.has(id)) return;
  const controller = new AbortController();
  activeRequests.set(id, { controller, reason: '' });
  const startedAt = performance.now();
  try {
    const response = await fetch(request.url, {
      method: request.method ?? 'GET',
      headers: request.headers,
      credentials: request.credentials ?? 'same-origin',
      cache: request.cache,
      redirect: request.redirect,
      referrerPolicy: request.referrerPolicy,
      integrity: request.integrity,
      signal: controller.signal
    });

    const headers = serializeHeaders(response.headers);
    if (!response.ok) {
      await response.body?.cancel?.().catch?.(() => {});
      failure(id, new Error(`HTTP ${response.status} ${response.statusText}`), {
        code: ERROR_CODES.HTTP_ERROR,
        status: response.status,
        url: response.url || request.url,
        headers
      });
      return;
    }

    const buffer = await response.arrayBuffer();
    const endedAt = performance.now();
    self.postMessage(
      {
        type: 'result',
        id,
        startedAt,
        endedAt,
        response: {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          url: response.url || request.url,
          headers,
          contentType: headers['content-type'] ?? '',
          body: buffer
        }
      },
      [buffer]
    );
  } catch (error) {
    const state = activeRequests.get(id);
    const isAbort = error?.name === 'AbortError';
    failure(id, error, {
      code: isAbort && state?.reason === ERROR_CODES.TIMEOUT
        ? ERROR_CODES.TIMEOUT
        : isAbort
          ? ERROR_CODES.ABORT
          : ERROR_CODES.NETWORK,
      url: request.url
    });
  } finally {
    activeRequests.delete(id);
  }
}

self.addEventListener('message', (event) => {
  const message = event.data;
  if (message?.type === 'fetch') {
    void performFetch(message.id, message.request);
  }
  if (message?.type === 'abort') {
    const state = activeRequests.get(message.id);
    if (state) {
      state.reason = message.reason ?? ERROR_CODES.ABORT;
      state.controller.abort();
    }
  }
});

if (typeof PerformanceObserver !== 'undefined') {
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      self.postMessage({
        type: 'timing',
        timing: {
          entryType: entry.entryType,
          name: entry.name,
          startTime: entry.startTime,
          duration: entry.duration,
          initiatorType: entry.initiatorType,
          nextHopProtocol: entry.nextHopProtocol,
          transferSize: entry.transferSize ?? 0,
          encodedBodySize: entry.encodedBodySize ?? 0,
          decodedBodySize: entry.decodedBodySize ?? 0
        }
      });
    }
  });
  try {
    observer.observe({ type: 'resource', buffered: true });
  } catch {
    observer.disconnect();
  }
}
