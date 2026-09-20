// Environment-agnostic fetch job runner shared by:
//   - FetchTransport  (runs on the main thread when no Worker is available)
//   - src/worker.js   (runs inside a Web Worker)
//
// Responsibilities per job: fetch with AbortSignal, per-attempt timeout,
// total deadline, retry with backoff / Retry-After / jitter, and a structured
// error chain. Timing is reported as relative durations (no cross-context
// clock dependence).

import { ResourceError, ERR } from './errors.js';

const DEFAULT_RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export function defaultOptions() {
  return {
    timeout: 8000,
    deadline: 0,
    retries: 2,
    retryDelay: 300,
    retryBackoff: 2,
    retryJitter: 0.2,
    retryStatuses: DEFAULT_RETRYABLE_STATUS,
  };
}

export function resolveOptions(options = {}) {
  return { ...defaultOptions(), ...options };
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(toAbortError(signal.reason));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(toAbortError(signal.reason));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function toAbortError(reason) {
  if (reason instanceof Error) return reason;
  const err = new ResourceError('Aborted', { code: ERR.CANCELED });
  err.name = 'AbortError';
  return err;
}

function isCanceled(err) {
  return err?.name === 'AbortError' || err?.code === ERR.CANCELED;
}

function parseRetryAfterValue(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

// Accept a live Headers instance, a flattened {name: value} object, or a
// pre-extracted millisecond value.
function parseRetryAfter(headers) {
  if (!headers) return null;
  if (typeof headers === 'number') return headers;
  if (typeof headers.get === 'function') return parseRetryAfterValue(headers.get('Retry-After'));
  return parseRetryAfterValue(
    headers['retry-after'] ?? headers['Retry-After'] ?? null,
  );
}

function computeDelay(attempt, options, headers) {
  const retryAfter = parseRetryAfter(headers);
  if (retryAfter != null) return retryAfter;
  const base = options.retryDelay * options.retryBackoff ** attempt;
  const spread = base * options.retryJitter;
  const jitter = spread ? Math.random() * spread * 2 - spread : 0;
  return Math.max(0, base + jitter);
}

function mapError(raw, { url, attempt, timedOut }) {
  if (raw instanceof ResourceError) return raw;
  if (timedOut) {
    return new ResourceError(`Request timeout after ${timedOut}ms: ${url}`, {
      code: ERR.TIMEOUT,
      details: { url, attempt },
    });
  }
  if (raw?.name === 'AbortError' || raw?.code === ERR.CANCELED) {
    return new ResourceError(`Request canceled: ${url}`, {
      code: ERR.CANCELED,
      cause: raw,
      details: { url, attempt },
    });
  }
  return new ResourceError(`Network error: ${raw?.message || 'fetch failed'}`, {
    code: ERR.NETWORK,
    cause: raw,
    details: { url, attempt },
  });
}

/**
 * Run a fetch job to completion (including retries).
 * Never throws for ordinary failure — resolves { ok, ... } so the result can
 * cross the structured-clone boundary from a Worker. Throws only for invalid
 * job descriptors.
 *
 * @param {object} job  { id, url, options }
 * @param {object} deps { fetchImpl, Response, signal }
 */
export async function runFetchJob(job, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const signal = deps.signal || null;
  const options = resolveOptions(job.options);
  const startedAt = (deps.now || Date.now)();
  const retries = Math.max(0, options.retries | 0);
  let attemptError = null;

  if (typeof fetchImpl !== 'function') {
    throw new ResourceError('No fetch implementation available', { code: ERR.NETWORK });
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) {
      return {
        ok: false,
        id: job.id,
        error: new ResourceError(`Canceled before attempt: ${job.url}`, {
          code: ERR.CANCELED,
        }),
      };
    }
    if (options.deadline > 0 && Date.now() - startedAt >= options.deadline) {
      return {
        ok: false,
        id: job.id,
        error: new ResourceError(
          `Deadline ${options.deadline}ms exceeded before attempt: ${job.url}`,
          { code: ERR.DEADLINE, cause: attemptError, details: { url: job.url, attempt } },
        ),
      };
    }

    deps.onAttemptStart?.({ id: job.id, attempt });
    const attemptStart = (deps.performance || globalThis.performance)?.now?.() ?? 0;
    let controller;
    let timeoutId = null;
    let timedOut = null;

    if (AbortController) {
      controller = new AbortController();
      const onAbort = () => controller.abort(signal?.reason);
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      const remaining = options.deadline > 0
        ? Math.max(0, options.deadline - (Date.now() - startedAt))
        : Infinity;
      const perAttempt = Math.min(options.timeout, remaining);
      if (perAttempt < Infinity) {
        timeoutId = setTimeout(() => {
          timedOut = perAttempt;
          controller.abort(new ResourceError(`Timeout after ${perAttempt}ms`, { code: ERR.TIMEOUT }));
        }, perAttempt);
      }
    }

    let response = null;
    let error = null;
    try {
      response = await fetchImpl(job.url, {
        method: job.method || 'GET',
        headers: job.headers || undefined,
        credentials: job.credentials,
        mode: job.mode,
        cache: job.cache,
        redirect: job.redirect,
        signal: controller ? controller.signal : signal,
      });
    } catch (raw) {
      error = mapError(raw, { url: job.url, attempt, timedOut });
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
    }

    if (!error && !response.ok) {
      const flatHeaders = extractHeaders(response.headers);
      error = new ResourceError(`HTTP ${response.status} ${response.statusText}: ${job.url}`, {
        code: ERR.HTTP,
        status: response.status,
        details: {
          url: job.url,
          attempt,
          headers: flatHeaders,
          retryAfterMs: parseRetryAfter(response.headers) ?? parseRetryAfter(flatHeaders),
        },
      });
    }

    if (error) {
      attemptError = attemptError
        ? new ResourceError(error.message, { code: error.code, status: error.status, cause: attemptError, details: error.details })
        : error;
      const shouldRetry =
        attempt < retries &&
        !isCanceled(error) &&
        (error.code === ERR.TIMEOUT ||
          error.code === ERR.NETWORK ||
          (error.code === ERR.HTTP && options.retryStatuses.has(error.status)));
      if (!shouldRetry) {
        return fail(job, finalizeError(attemptError, { retries, attempt }), { attempt, attemptStart, deps });
      }
      const retryHint = error.details?.retryAfterMs != null
        ? error.details.retryAfterMs
        : error.details?.headers;
      const delay = error.code === ERR.HTTP
        ? computeDelay(attempt, options, retryHint)
        : computeDelay(attempt, options, null);
      deps.onRetry?.({
        id: job.id,
        attempt,
        nextAttempt: attempt + 1,
        delay,
        error: error.toJSON ? error.toJSON() : { message: error.message },
      });
      try {
        await abortableSleep(delay, signal);
      } catch (cancelErr) {
        return fail(job, new ResourceError(`Canceled during retry wait: ${job.url}`, {
          code: ERR.CANCELED,
          cause: cancelErr,
        }), { attempt, attemptStart, deps });
      }
      continue;
    }

    let buffer = null;
    let text = null;
    try {
      const responseType = job.responseType || 'arraybuffer';
      if (responseType === 'text') {
        text = await response.text();
      } else {
        buffer = await response.arrayBuffer();
      }
    } catch (raw) {
      const bodyError = new ResourceError(`Failed to read response body: ${job.url}`, {
        code: ERR.NETWORK,
        cause: raw,
        details: { url: job.url, attempt },
      });
      attemptError = new ResourceError(bodyError.message, {
        code: bodyError.code,
        cause: attemptError,
        details: bodyError.details,
      });
      if (attempt >= retries) {
        return fail(job, finalizeError(attemptError, { retries, attempt }), { attempt, attemptStart, deps });
      }
      const delay = computeDelay(attempt, options, null);
      deps.onRetry?.({ id: job.id, attempt, nextAttempt: attempt + 1, delay, error: bodyError.toJSON() });
      await abortableSleep(delay, signal);
      continue;
    }

    const attemptEnd = (deps.performance || globalThis.performance)?.now?.() ?? 0;
    return {
      ok: true,
      id: job.id,
      url: response.url || job.url,
      status: response.status,
      contentType: response.headers?.get?.('content-type') || null,
      headers: extractHeaders(response.headers),
      buffer,
      text,
      attempts: attempt + 1,
      startedAt,
      duration: Math.round(attemptEnd - attemptStart),
    };
  }

  return fail(job, finalizeError(attemptError, { retries, attempt: retries }), { attempt: retries, deps });
}

function extractHeaders(headers) {
  const out = {};
  if (headers?.forEach) headers.forEach((value, key) => { out[key] = value; });
  return out;
}

function finalizeError(error, { retries, attempt }) {
  if (retries > 0 && attempt >= retries && error?.code !== ERR.CANCELED) {
    return new ResourceError(`Retries exhausted after ${retries + 1} attempts`, {
      code: ERR.RETRIES_EXHAUSTED,
      cause: error,
    });
  }
  return error;
}

function fail(job, error, { attempt, attemptStart = 0, deps }) {
  const end = (deps.performance || globalThis.performance)?.now?.() ?? 0;
  return {
    ok: false,
    id: job.id,
    url: job.url,
    attempts: attempt + 1,
    startedAt: undefined,
    duration: Math.max(0, Math.round(end - attemptStart)),
    error,
  };
}
