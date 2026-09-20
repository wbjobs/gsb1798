import { ERROR_CODES, ResourceError } from './errors.js';

export class WorkerTransport {
  constructor(workerUrl = '/js/resource-worker.js', WorkerConstructor = globalThis.Worker) {
    this.workerUrl = workerUrl;
    this.pending = new Map();
    this.timingListener = null;
    this.worker = new WorkerConstructor(workerUrl, { type: 'module' });
    this.worker.addEventListener('message', (event) => this.handleMessage(event.data));
    this.worker.addEventListener('error', (event) => this.rejectAll(event));
    this.worker.addEventListener('messageerror', (event) => this.rejectAll(event));
  }

  setOnTiming(listener) {
    this.timingListener = listener;
  }

  fetch(request, signal) {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    if (signal?.aborted) {
      return Promise.reject(new ResourceError('资源加载已取消', {
        code: ERROR_CODES.ABORT,
        url: request.url
      }));
    }

    return new Promise((resolve, reject) => {
      const abort = () => {
        this.worker.postMessage({
          type: 'abort',
          id,
          reason: signal?.reason?.code ?? ERROR_CODES.ABORT
        });
      };
      this.pending.set(id, { resolve, reject, signal, abort });
      signal?.addEventListener('abort', abort, { once: true });
      this.worker.postMessage({
        type: 'fetch',
        id,
        request: {
          url: request.url,
          method: request.method,
          headers: request.headers,
          credentials: request.credentials,
          cache: request.cache,
          redirect: request.redirect,
          referrerPolicy: request.referrerPolicy,
          integrity: request.integrity
        }
      });
    });
  }

  handleMessage(message) {
    if (message?.type === 'timing') {
      this.timingListener?.(message.timing);
      return;
    }
    const item = this.pending.get(message?.id);
    if (!item) return;
    this.pending.delete(message.id);
    item.signal?.removeEventListener?.('abort', item.abort);

    if (message.type === 'result') {
      item.resolve(new WorkerResponse(message.response, message.startedAt, message.endedAt));
      return;
    }
    const rejectedError = new ResourceError(message.message, {
      code: message.code,
      status: message.status,
      url: message.url
    });
    rejectedError.headers = new Map(Object.entries(message.headers ?? {}));
    item.reject(rejectedError);
  }

  rejectAll(error) {
    for (const [id, item] of this.pending) {
      item.signal?.removeEventListener?.('abort', item.abort);
      item.reject(new ResourceError(error.message || 'Web Worker 不可用', {
        code: ERROR_CODES.NETWORK,
        cause: error
      }));
      this.pending.delete(id);
    }
  }
}

export class WorkerResponse {
  constructor(data, startedAt, endedAt) {
    this.ok = data.ok;
    this.status = data.status;
    this.statusText = data.statusText;
    this.url = data.url;
    this.headers = new Map(Object.entries(data.headers ?? {}));
    this.contentType = data.contentType;
    this.body = data.body;
    this.workerTiming = { startedAt, endedAt, duration: endedAt - startedAt };
  }

  async arrayBuffer() {
    return this.body;
  }

  async text() {
    return new TextDecoder().decode(this.body);
  }

  async json() {
    return JSON.parse(await this.text());
  }

  async blob() {
    return new Blob([this.body], { type: this.contentType });
  }
}

export class FetchTransport {
  fetch(request, signal) {
    return fetch(request.url, { ...request, signal });
  }
}
