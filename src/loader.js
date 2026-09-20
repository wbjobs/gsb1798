// ResourceLoader: the main-thread scheduler.
//
//   priority queue (min-heap, FIFO within a level)
//   global concurrency limit (counted synchronously when a slot opens)
//   per-attempt timeout + total deadline (enforced in the fetch runner)
//   automatic degradation to a placeholder/fallback after failure/timeout
//   retry with exponential backoff, jitter and Retry-After
//   Worker transport with main-thread FetchTransport degradation
//   exception chain preserved across the Worker boundary
//   performance marks/measures + MetricsCollector hooks

import { PriorityQueue } from './priority-queue.js';
import { FetchTransport, WorkerTransport } from './transports.js';
import { ResourceError, ERR, errorChainOf } from './errors.js';
import { materializeSuccess, materializeFallback, revokeResource } from './materialize.js';
import { MetricsCollector, safeMark, safeMeasure } from './metrics.js';

export const PRIORITY = Object.freeze({
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
});

let uid = 0;

class DetailEventTarget extends EventTarget {
  emit(type, detail) {
    const event = new Event(type);
    event.detail = detail;
    this.dispatchEvent(event);
  }
}

export class ResourceLoader extends DetailEventTarget {
  constructor(options = {}) {
    super();
    this.concurrency = Math.max(1, options.concurrency ?? 6);
    this.env = options.env ?? globalThis;
    this.defaults = {
      timeout: options.timeout ?? 8000,
      deadline: options.deadline ?? 0,
      retries: options.retries ?? 2,
      retryDelay: options.retryDelay ?? 300,
      retryBackoff: options.retryBackoff ?? 2,
      retryJitter: options.retryJitter ?? 0.2,
    };
    this._queue = new PriorityQueue();
    this._active = new Map();
    this._running = 0;
    this._disposed = false;
    this._pumpScheduled = false;
    this._metrics = options.metrics === undefined ? new MetricsCollector() : options.metrics;
    this._transportReady = options.transport
      ? Promise.resolve(options.transport)
      : this._initTransport(options);
  }

  async _initTransport(options) {
    const useWorker = options.useWorker !== false &&
      typeof this.env.Worker !== 'undefined' &&
      options.workerUrl;
    if (!useWorker) return new FetchTransport();
    try {
      const transport = new WorkerTransport(options.workerUrl, {
        size: options.workerPoolSize ?? 2,
        readyTimeout: options.workerReadyTimeout ?? 3000,
        createWorker: options.createWorker || (this.env.Worker
          ? (url) => new this.env.Worker(url, { type: 'module' })
          : undefined),
      });
      await transport.ready();
      return transport;
    } catch (error) {
      this.emit('degrade', {
        from: 'worker',
        to: 'fetch',
        reason: errorChainOf(error),
      });
      return new FetchTransport();
    }
  }

  // --- public API -------------------------------------------------------

  load(spec) {
    return new Promise((resolve, reject) => {
      const state = this._normalize(spec, resolve, reject);
      if (state instanceof Error) {
        reject(state);
        return;
      }
      this._queue.enqueue(state.id, state.priority, state);
      this._mark(state.id, 'queued', { type: spec.type });
      this.emit('enqueue', { id: state.id, type: state.spec.type, priority: state.priority, url: state.spec.url });
      // Coalesce pumping into a microtask: resources enqueued in the same tick
      // (loadAll / burst) compete by priority, not by declaration order.
      this._schedulePump();
    });
  }

  // All resources resolve to a usable (possibly degraded) value; specs without
  // a fallback reject on hard failure.
  loadAll(specs) {
    return Promise.all(specs.map((spec) => this.load(spec)));
  }

  // Cancel: a queued job is removed immediately; an in-flight job signals its
  // transport (aborts the fetch / posts CANCEL to the worker).
  cancel(id) {
    if (this._active.has(id)) {
      const state = this._active.get(id);
      state.controller.abort(Object.assign(new Error('Canceled'), { name: 'AbortError' }));
      this._transportReady
        .then((transport) => transport.cancel?.(id))
        .catch(() => {});
      return true;
    }
    const removed = this._queue.remove(id);
    if (removed) {
      this._settle(removed.data, null, new ResourceError(`Canceled while queued: ${removed.data.spec.url}`, {
        code: ERR.CANCELED,
      }));
      return true;
    }
    return false;
  }

  stats() {
    return {
      queued: this._queue.size,
      active: this._running,
      concurrency: this.concurrency,
      counters: this._metrics?.counters?.() ?? {},
    };
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const state of this._active.values()) {
      state.controller.abort(Object.assign(new Error('Loader disposed'), { name: 'AbortError' }));
    }
    // Reject everything still queued so no promise can hang.
    const queue = this._queue;
    this._queue = new PriorityQueue();
    while (queue.size > 0) {
      const item = queue.dequeue();
      item.data.reject(new ResourceError(`Loader disposed while queued: ${item.data.spec.url}`, {
        code: ERR.CANCELED,
      }));
    }
    this._transportReady.then((transport) => transport.dispose?.()).catch(() => {});
    this._metrics?.disconnect?.();
  }

  // --- internals --------------------------------------------------------

  _normalize(spec, resolve, reject) {
    if (!spec || typeof spec !== 'object') {
      return new ResourceError('load() expects a resource spec object', { code: ERR.INVALID });
    }
    if (!['image', 'script', 'font'].includes(spec.type)) {
      return new ResourceError(`Unsupported resource type "${spec.type}"`, { code: ERR.INVALID });
    }
    if (!spec.url) {
      return new ResourceError(`Missing url for ${spec.type} resource`, { code: ERR.INVALID });
    }
    const id = spec.id || `res-${++uid}-${Math.random().toString(36).slice(2, 8)}`;
    const priority = typeof spec.priority === 'number'
      ? spec.priority
      : PRIORITY[spec.priority || 'normal'] ?? PRIORITY.normal;
    const controller = new this.env.AbortController();
    return {
      id,
      priority,
      spec,
      resolve,
      reject,
      controller,
      canceled: false,
      startedAt: 0,
      attempts: 0,
    };
  }

  _schedulePump() {
    if (this._pumpScheduled || this._disposed) return;
    this._pumpScheduled = true;
    Promise.resolve().then(() => {
      this._pumpScheduled = false;
      this._pump();
    });
  }

  _pump() {
    // Slot accounting happens synchronously here, so even if transport
    // readiness is still pending the global limit can never be exceeded.
    while (this._running < this.concurrency && this._queue.size > 0) {
      const item = this._queue.dequeue();
      this._running++;
      this._active.set(item.id, item.data);
      this._dispatch(item.data);
    }
  }

  async _dispatch(state) {
    state.startedAt = this._perfNow();
    this._mark(state.id, 'start', { type: state.spec.type });
    let transport;
    try {
      transport = await this._transportReady;
    } catch (error) {
      this._release(state.id);
      this._settle(state, null, error);
      return;
    }
    if (this._disposed || state.controller.signal.aborted) {
      this._release(state.id);
      this._settle(state, null, new ResourceError(`Canceled before dispatch: ${state.spec.url}`, {
        code: ERR.CANCELED,
      }));
      return;
    }

    const job = {
      id: state.id,
      url: state.spec.url,
      method: state.spec.method,
      headers: state.spec.headers,
      credentials: state.spec.credentials,
      mode: state.spec.mode,
      cache: state.spec.cache,
      redirect: state.spec.redirect,
      responseType: state.spec.responseType || 'arraybuffer',
      options: {
        timeout: state.spec.timeout ?? this.defaults.timeout,
        deadline: state.spec.deadline ?? this.defaults.deadline,
        retries: state.spec.retries ?? this.defaults.retries,
        retryDelay: state.spec.retryDelay ?? this.defaults.retryDelay,
        retryBackoff: state.spec.retryBackoff ?? this.defaults.retryBackoff,
        retryJitter: state.spec.retryJitter ?? this.defaults.retryJitter,
      },
    };

    let result;
    try {
      result = await transport.request(job, {
        signal: state.controller.signal,
        onRetry: (info) => {
          state.attempts = info.nextAttempt;
          this._metrics?.incr('retries');
          this.emit('retry', { id: state.id, url: state.spec.url, ...info });
        },
      });
    } catch (error) {
      // Transport-level failure (e.g. worker crash mid-flight).
      this._release(state.id);
      this._settle(state, null, error instanceof Error
        ? error
        : new ResourceError('Transport failed', { code: ERR.WORKER, cause: error }));
      return;
    }

    this._release(state.id);
    if (result.ok) {
      let resource;
      try {
        resource = await materializeSuccess(state.spec, result, this.env);
        if (state.spec.type === 'image' && state.spec.preload !== false) {
          await this._preloadImage(resource.url);
        }
      } catch (error) {
        if (resource) revokeResource(resource, this.env);
        this._settle(state, result, new ResourceError(`Failed to materialize ${state.spec.type}: ${state.spec.url}`, {
          code: ERR.NETWORK,
          cause: error,
        }));
        return;
      }
      this._settle(state, { ...result, resource }, null);
    } else {
      this._settle(state, result, result.error);
    }
  }

  _preloadImage(url) {
    const { Image } = this.env;
    if (typeof Image === 'undefined') return;
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve();
      img.onerror = () => reject(new ResourceError(`Image decode failed: ${url}`, { code: ERR.NETWORK }));
      img.src = url;
    });
  }

  _settle(state, result, error) {
    if (state._settled) return;
    state._settled = true;
    const end = this._perfNow();
    const detail = {
      id: state.id,
      type: state.spec.type,
      url: state.spec.url,
      attempts: result?.attempts ?? state.attempts,
      status: result?.status ?? null,
    };
    this._mark(state.id, 'end', detail);

    const perf = this.env.performance;
    if (perf) {
      safeMeasure(perf, `rl:${state.id}:total`, `rl:${state.id}:queued`, `rl:${state.id}:end`, detail);
      if (state.startedAt) {
        safeMeasure(perf, `rl:${state.id}:fetch`, `rl:${state.id}:start`, `rl:${state.id}:end`, detail);
      }
    }

    if (!error) {
      this._metrics?.incr('loaded');
      this.emit('load', { ...detail, resource: result.resource });
      state.resolve(result.resource);
      this._afterSettle();
      return;
    }

    // Explicit cancellation (cancel()/dispose()) always rejects — the
    // fallback path is reserved for timeout/network/HTTP failures. Timeout
    // errors surface as TIMEOUT/DEADLINE and still degrade below.
    if (error.code === ERR.CANCELED || state.controller.signal.aborted) {
      this._metrics?.incr('canceled');
      this.emit('cancel', { ...detail, error: errorChainOf(error) });
      state.reject(error);
      this._afterSettle();
      return;
    }

    if (state.spec.fallback !== undefined && state.spec.fallback !== null) {
      const resource = materializeFallback(state.spec, error, this.env);
      this._metrics?.incr('fallback');
      this.emit('fallback', {
        ...detail,
        resource,
        error: errorChainOf(error),
      });
      state.resolve(resource);
      this._afterSettle();
      return;
    }

    this._metrics?.incr('failed');
    this.emit('fail', { ...detail, error: errorChainOf(error) });
    state.reject(error);
    this._afterSettle();
  }

  _afterSettle() {
    if (this._running === 0 && this._queue.size === 0) {
      this.emit('drain', { stats: this.stats() });
    }
  }

  _release(id) {
    if (this._active.delete(id)) this._running--;
    this._pump();
  }

  _mark(id, phase, detail) {
    safeMark(this.env.performance, `rl:${id}:${phase}`, { id, ...detail });
  }

  _perfNow() {
    return this.env.performance?.now?.() ?? Date.now();
  }
}
