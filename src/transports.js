// Transports move a prepared fetch job to an executor:
//
//   FetchTransport   — runs the shared runner on the main thread. Used as an
//                      automatic degradation when Workers are unavailable.
//   WorkerTransport  — fans jobs out to a pool of Web Workers. One
//                      MessageChannel per job routes RESULT/RETRY to the exact
//                      caller; CANCEL is routed to the worker running the job.

import { runFetchJob } from './fetch-job.js';
import { ResourceError, ERR, deserializeError } from './errors.js';

export class FetchTransport {
  // fetchImpl is injectable (tests / custom agents); defaults to global fetch.
  constructor({ fetchImpl } = {}) {
    this.inflight = 0;
    this._controllers = new Map();
    this._fetchImpl = fetchImpl || null;
  }

  ready() {
    return Promise.resolve();
  }

  async request(job, { onRetry, signal } = {}) {
    this.inflight++;
    const controller = new AbortController();
    this._controllers.set(job.id, controller);
    const forwardAbort = () => controller.abort(
      Object.assign(new Error('Canceled'), { name: 'AbortError' }),
    );
    if (signal) {
      if (signal.aborted) forwardAbort();
      else signal.addEventListener('abort', forwardAbort, { once: true });
    }
    try {
      const result = await runFetchJob(job, {
        signal: controller.signal,
        onRetry,
        fetchImpl: this._fetchImpl || undefined,
      });
      return normalize(result);
    } finally {
      this._controllers.delete(job.id);
      this.inflight--;
    }
  }

  cancel(id) {
    this._controllers.get(id)?.abort(
      Object.assign(new Error('Canceled'), { name: 'AbortError' }),
    );
  }

  dispose() {
    for (const controller of this._controllers.values()) {
      controller.abort(Object.assign(new Error('Transport disposed'), { name: 'AbortError' }));
    }
    this._controllers.clear();
  }
}

export class WorkerTransport {
  constructor(source, { size = 2, readyTimeout = 3000, createWorker } = {}) {
    // A function source is a worker factory (used for tests/injection).
    // With a URL source either an injected createWorker or the global Worker
    // constructor must exist.
    if (typeof source !== 'function' && !createWorker &&
        (typeof Worker === 'undefined')) {
      throw new ResourceError('Web Worker is not supported in this environment', {
        code: ERR.WORKER,
      });
    }
    this._source = source;
    this._createWorker = createWorker || null;
    this._size = Math.max(1, size);
    this._readyTimeout = readyTimeout;
    this._workers = [];
    this._next = 0;
    this.inflight = 0;
    this._jobs = new Map();
    this._disposed = false;
  }

  // Resolves once the whole pool has booted and posted READY.
  ready() {
    if (!this._readyPromise) {
      this._readyPromise = this._spawnPool();
    }
    return this._readyPromise;
  }

  async _spawnPool() {
    const spawned = [];
    try {
      for (let i = 0; i < this._size; i++) {
        spawned.push(this._spawnOne(i));
      }
      await Promise.all(spawned.map((entry) => entry.ready));
    } catch (err) {
      this.dispose();
      throw new ResourceError('Worker pool failed to start; main-thread fallback required', {
        code: ERR.WORKER,
        cause: err,
      });
    }
  }

  _spawnOne(index) {
    const worker = typeof this._source === 'function'
      ? this._source()
      : this._createWorker
        ? this._createWorker(this._source)
        : new Worker(this._source, { type: 'module' });
    const entry = { worker, ready: null, fail: null };
    entry.ready = new Promise((resolve, reject) => {
      entry.fail = reject;
      const timer = setTimeout(() => {
        reject(new ResourceError(`Worker ${index} did not report READY in ${this._readyTimeout}ms`, {
          code: ERR.WORKER,
        }));
      }, this._readyTimeout);
      worker.addEventListener('message', function onReady(event) {
        if (event.data?.type === 'READY') {
          clearTimeout(timer);
          worker.removeEventListener('message', onReady);
          resolve();
        }
      });
    });
    worker.addEventListener('message', (event) => this._onMessage(entry, event));
    worker.addEventListener('error', (event) => this._onWorkerError(entry, event.error || event.message));
    worker.addEventListener('messageerror', (event) => {
      entry.fail?.(new ResourceError('Worker message error', { code: ERR.WORKER, cause: event }));
    });
    this._workers.push(entry);
    return entry;
  }

  _onMessage(entry, event) {
    const msg = event.data;
    if (!msg || msg.type === 'READY') return;
    // Port-encapsulated replies arrive on their own MessagePort; this global
    // handler only services port-less posts. event.target distinguishes them.
    if (event.target !== entry.worker) return;
    if (msg.type === 'RESULT') {
      const pending = this._jobs.get(msg.result.id);
      if (!pending || pending.port) return;
      this._jobs.delete(msg.result.id);
      this.inflight--;
      pending.resolve(normalize(msg.result));
    } else if (msg.type === 'RETRY') {
      const pending = this._jobs.get(msg.info.id);
      if (!pending || pending.port) return;
      pending.onRetry?.(msg.info);
    }
  }

  _onWorkerError(entry, raw) {
    const error = new ResourceError('Worker crashed or failed to load the worker script', {
      code: ERR.WORKER,
      cause: raw instanceof Error ? raw : new Error(String(raw)),
    });
    entry.fail?.(error);
    for (const [id, pending] of this._jobs) {
      if (pending.entry === entry) {
        this._jobs.delete(id);
        this.inflight--;
        pending.reject(error);
      }
    }
    if (!this._disposed) {
      try { entry.worker.terminate(); } catch { /* noop */ }
    }
  }

  async request(job, { onRetry } = {}) {
    await this.ready();
    if (this._disposed) {
      throw new ResourceError('WorkerTransport disposed', { code: ERR.WORKER });
    }
    const entry = this._select();
    const port = new MessageChannel();
    const pending = new Promise((resolve, reject) => {
      this._jobs.set(job.id, { entry, resolve, reject, onRetry, port });
      port.port1.onmessage = (event) => this._onPortMessage(job.id, event.data);
    });
    this.inflight++;
    entry.worker.postMessage({ type: 'JOB', job }, [port.port2]);
    return pending;
  }

  _onPortMessage(id, msg) {
    const pending = this._jobs.get(id);
    if (!pending) return;
    if (msg.type === 'RETRY') {
      pending.onRetry?.(msg.info);
      return;
    }
    if (msg.type === 'RESULT') {
      this._jobs.delete(id);
      this.inflight--;
      pending.port.port1.close();
      pending.resolve(normalize(msg.result));
    }
  }

  _select() {
    // Prefer the least-loaded worker; ties resolve round-robin.
    let best = this._workers[0];
    let bestLoad = Infinity;
    for (let i = 0; i < this._workers.length; i++) {
      const idx = (this._next + i) % this._workers.length;
      const entry = this._workers[idx];
      let load = 0;
      for (const job of this._jobs.values()) {
        if (job.entry === entry) load++;
      }
      if (load < bestLoad) {
        bestLoad = load;
        best = entry;
        this._next = (idx + 1) % this._workers.length;
      }
    }
    return best;
  }

  cancel(id) {
    const pending = this._jobs.get(id);
    if (pending) {
      pending.entry.worker.postMessage({ type: 'CANCEL', id });
    }
  }

  dispose() {
    this._disposed = true;
    for (const entry of this._workers) {
      try { entry.worker.terminate(); } catch { /* noop */ }
    }
    this._workers = [];
    this._jobs.clear();
    this.inflight = 0;
  }
}

function normalize(result) {
  if (!result.ok && result.error && !(result.error instanceof Error)) {
    result.error = deserializeError(result.error);
  }
  return result;
}
