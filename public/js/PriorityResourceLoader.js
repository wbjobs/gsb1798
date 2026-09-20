import { ERROR_CODES, ResourceError } from './errors.js';
import { PriorityQueue, normalizePriority } from './priority-queue.js';
import { PerformanceMonitor } from './performance-monitor.js';
import { applyResource, defaultFallback } from './resource-handlers.js';
import { WorkerTransport } from './worker-transport.js';

const DEFAULT_RETRIABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class PriorityResourceLoader {
  constructor(options = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 3;
    this.defaultTimeout = options.timeout ?? 8000;
    this.defaultRetries = options.retries ?? 2;
    this.defaultRetryDelay = options.retryDelay ?? 300;
    this.retryJitter = options.retryJitter ?? 120;
    this.retriableStatuses = new Set(options.retriableStatuses ?? DEFAULT_RETRIABLE_STATUSES);
    this.transport = options.transport ?? new WorkerTransport();
    this.applyResource = options.applyResource ?? applyResource;
    this.fallback = options.fallback ?? defaultFallback;
    this.performanceMonitor = options.performanceMonitor ?? new PerformanceMonitor().start();
    this.queue = new PriorityQueue();
    this.activeCount = 0;
    this.activeByType = new Map();
    this.metricsById = new Map();
    this.listeners = new Map();
    this.sequence = 0;
    this.running = true;
    this.transport?.setOnTiming?.((timing) => {
      this.performanceMonitor.recordWorkerTiming(timing);
      for (const metric of this.metricsById.values()) {
        if (metric.url === timing.name) metric.resourceTiming = timing;
      }
      this.emit('timing', timing);
    });
  }

  load(request) {
    const normalized = this.normalizeRequest(request);
    const metric = {
      id: normalized.id,
      url: normalized.url,
      type: normalized.type,
      priority: normalized.priority,
      queuedAt: performance.now(),
      startedAt: 0,
      finishedAt: 0,
      queueDuration: 0,
      duration: 0,
      attempts: 0,
      status: 'queued',
      active: 0,
      peakActive: 0,
      degraded: false,
      fallback: false,
      error: null,
      resourceTiming: null,
      workerTiming: null
    };
    this.metricsById.set(normalized.id, metric);
    let resolveTask;
    let rejectTask;
    const promise = new Promise((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    const queued = { ...normalized, resolve: resolveTask, reject: rejectTask };
    this.queue.enqueue(queued);
    this.emit('queue', { request: normalized, metric });
    queueMicrotask(() => this.pump());
    return {
      ...normalized,
      metric,
      promise,
      then(onFulfilled, onRejected) {
        return promise.then(onFulfilled, onRejected);
      }
    };
  }

  loadImage(url, target, options = {}) {
    return this.load({ ...options, url, type: 'image', target });
  }

  loadScript(url, options = {}) {
    return this.load({ ...options, url, type: 'script' });
  }

  loadFont(url, family, target, options = {}) {
    return this.load({ ...options, url, type: 'font', family, target });
  }

  normalizeRequest(request) {
    const id = request.id ?? `resource-${this.sequence + 1}`;
    return {
      ...request,
      id,
      priority: normalizePriority(request.priority),
      type: request.type ?? 'resource',
      timeout: request.timeout ?? this.defaultTimeout,
      retries: request.retries ?? this.defaultRetries,
      retryDelay: request.retryDelay ?? this.defaultRetryDelay,
      fallback: request.fallback !== false,
      sequence: this.sequence++,
      signal: request.signal ?? null
    };
  }

  pump() {
    if (!this.running) return;
    while (this.queue.size > 0 && this.activeCount < this.maxConcurrent) {
      const request = this.queue.dequeue();
      const metric = this.metricsById.get(request.id);
      this.setActive(request.type, 1);
      metric.status = 'running';
      metric.active = this.activeCount;
      metric.peakActive = Math.max(metric.peakActive, this.activeCount);
      this.emit('start', { request, metric, active: this.activeCount });
      void this.execute(request).catch(() => {}).finally(() => {
        this.setActive(request.type, -1);
        this.emit('slot', { active: this.activeCount });
        this.pump();
      });
    }
  }

  setActive(type, delta) {
    this.activeCount = Math.max(0, this.activeCount + delta);
    const next = (this.activeByType.get(type) ?? 0) + delta;
    if (next <= 0) this.activeByType.delete(type);
    else this.activeByType.set(type, next);
  }

  async execute(request) {
    const metric = this.metricsById.get(request.id);
    metric.startedAt ||= performance.now();
    metric.queueDuration = metric.startedAt - metric.queuedAt;
    const parentController = new AbortController();
    const abortParent = () => parentController.abort(request.signal?.reason ?? undefined);
    if (request.signal?.aborted) abortParent();
    request.signal?.addEventListener?.('abort', abortParent, { once: true });

    let lastError = null;
    for (let attempt = 1; attempt <= request.retries + 1; attempt += 1) {
      metric.attempts = attempt;
      const attemptController = new AbortController();
      const abortAttempt = () => attemptController.abort(parentController.signal.reason);
      if (parentController.signal.aborted) abortAttempt();
      parentController.signal.addEventListener('abort', abortAttempt, { once: true });
      let timeoutId = setTimeout(() => {
        attemptController.abort(new ResourceError(`资源加载超时（${request.timeout}ms）`, {
          code: ERROR_CODES.TIMEOUT,
          url: request.url,
          resourceType: request.type,
          attempt
        }));
      }, request.timeout);
      try {
        const response = await this.transport.fetch(request, attemptController.signal);
        metric.workerTiming = response.workerTiming ?? null;
        const result = request.apply
          ? await request.apply(request.type, response, request)
          : await this.applyResource(request.type, response, request);
        clearTimeout(timeoutId);
        parentController.signal.removeEventListener?.('abort', abortParent);
        parentController.signal.removeEventListener?.('abort', abortAttempt);
        this.finishMetric(metric, 'success');
        this.emit('success', { request, result, metric });
        request.resolve(result);
        return result;
      } catch (error) {
        clearTimeout(timeoutId);
        parentController.signal.removeEventListener?.('abort', abortAttempt);
        const abortReason = attemptController.signal.aborted
          ? attemptController.signal.reason
          : null;
        const effectiveError = abortReason instanceof ResourceError ? abortReason : error;
        lastError = this.wrapError(effectiveError, request, attempt, lastError);
        this.emit('attemptError', { request, error: lastError, attempt, metric });
        if (parentController.signal.aborted || !this.shouldRetry(lastError, request, attempt)) break;
        const waitMs = this.nextDelay(request, attempt, lastError);
        metric.status = `retrying:${attempt + 1}`;
        this.emit('retry', { request, error: lastError, attempt, waitMs, metric });
        try {
          await delay(waitMs, parentController.signal);
        } catch (abortError) {
          lastError = this.wrapError(abortError, request, attempt, lastError);
          break;
        }
      }
    }

    parentController.signal.removeEventListener?.('abort', abortParent);
    return this.handleFailure(request, metric, lastError);
  }

  wrapError(error, request, attempt, cause) {
    if (error instanceof ResourceError) {
      if (!error.url) error.url = request.url;
      error.resourceType = request.type;
      error.attempt = attempt;
      if (cause && !error.cause) error.cause = cause;
      return error;
    }
    const aborted = error?.name === 'AbortError' || attemptControllerAborted(error);
    return new ResourceError(error?.message ?? '资源加载失败', {
      code: error?.code ?? (aborted ? ERROR_CODES.ABORT : ERROR_CODES.UNKNOWN),
      status: error?.status ?? 0,
      url: request.url,
      resourceType: request.type,
      attempt,
      cause: cause ?? error
    });
  }

  shouldRetry(error, request, attempt) {
    if (attempt > request.retries) return false;
    if (error.code === ERROR_CODES.ABORT) return false;
    if (request.retryOn) return Boolean(request.retryOn(error, attempt));
    if (error.code === ERROR_CODES.HTTP_ERROR) return this.retriableStatuses.has(error.status);
    return error.code === ERROR_CODES.TIMEOUT || error.code === ERROR_CODES.NETWORK;
  }

  nextDelay(request, attempt, error) {
    const retryAfter = Number(error?.headers?.get?.('retry-after'));
    const base = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : request.retryDelay * (2 ** (attempt - 1));
    return Math.max(0, base + Math.random() * this.retryJitter);
  }

  async handleFailure(request, metric, error) {
    metric.error = error.toJSON?.() ?? error;
    if (!request.fallback) {
      this.finishMetric(metric, 'failed');
      this.emit('failure', { request, error, metric });
      request.reject(error);
      throw error;
    }
    let result;
    try {
      result = await this.fallback(request.type, error, request);
    } catch (fallbackError) {
      fallbackError.cause ??= error;
      const linked = new ResourceError('资源降级失败', {
        code: fallbackError.code ?? ERROR_CODES.UNKNOWN,
        url: request.url,
        resourceType: request.type,
        attempt: metric.attempts,
        cause: fallbackError
      });
      metric.error = linked.toJSON?.() ?? linked;
      this.finishMetric(metric, 'failed');
      this.emit('failure', { request, error: linked, metric });
      request.reject(linked);
      throw linked;
    }
    if (result == null) {
      this.finishMetric(metric, 'failed');
      this.emit('failure', { request, error, metric });
      request.reject(error);
      throw error;
    }
    metric.degraded = true;
    metric.fallback = true;
    this.finishMetric(metric, 'degraded');
    this.emit('degraded', { request, error, result, metric });
    request.resolve(result);
    return result;
  }

  finishMetric(metric, status) {
    metric.finishedAt = performance.now();
    metric.duration = metric.finishedAt - metric.startedAt;
    metric.status = status;
    const entry = this.performanceMonitor.findResourceEntry(metric.url);
    if (entry) metric.resourceTiming = entry;
  }

  getMetrics() {
    return [...this.metricsById.values()].map((metric) => ({ ...metric }));
  }

  getResourceTiming(filter) {
    return this.performanceMonitor.getEntries(filter);
  }

  get pending() {
    return this.queue.size;
  }

  get active() {
    return this.activeCount;
  }

  on(event, listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(listener);
    return () => this.off(event, listener);
  }

  off(event, listener) {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event, payload) {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload);
    }
  }

  destroy() {
    this.running = false;
    this.performanceMonitor.stop?.();
    this.listeners.clear();
  }
}

function attemptControllerAborted(error) {
  return error?.name === 'AbortError';
}
