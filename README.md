# Priority Resource Loader

A browser resource loader for **images, scripts and fonts** with first-class
support for priority scheduling, global concurrency limiting, per-request
timeouts + total deadlines, automatic degradation to placeholders, bounded
retry with backoff, Web Worker based fetching (with main-thread fallback),
and end-to-end performance observability.

No dependencies. Native ESM. ~700 lines of library code.

## Quick start

```js
import { ResourceLoader } from './src/index.js';

const loader = new ResourceLoader({
  workerUrl: './src/worker.js', // omit to fetch on the main thread
  workerPoolSize: 2,
  concurrency: 6,               // global in-flight cap (across all workers)
  timeout: 8000,                // per-attempt timeout
  retries: 2,                   // attempts = retries + 1
  retryDelay: 300,              // base backoff, doubles per attempt
});

// The hero image goes first even if it is declared after low-priority items.
const [hero, font, trackingPixel, thumb] = await loader.loadAll([
  { id: 'hero',    type: 'image', url: '/a.svg', priority: 'critical' },
  { id: 'display', type: 'font',  family: 'Display', url: '/f.ttf', priority: 'critical' },
  { id: 'px',      type: 'script', url: '/p.js', priority: 'low' },
  {
    id: 'thumb', type: 'image', url: '/t.png', priority: 'low',
    timeout: 2000, retries: 1,
    // Function or static value; used after timeout/failure:
    fallback: (spec, error) => '/placeholders/thumb.svg',
  },
]);
```

Returned resources:

- **image** → `{ kind: 'image', url }` (`blob:` URL, pre-decoded)
- **script** → `{ kind: 'script', url, execute(el?) }` (inline `<script>` by
  default; pass `{ inline: false }` to just get the blob URL/text)
- **font** → `{ kind: 'font', family, face }` (registered in
  `document.fonts`), or `{ kind: 'font', family, stack, degraded: true }`

A resource with a `fallback` **always resolves** (possibly degraded); a
resource without one rejects with a `ResourceError`. Explicit
`loader.cancel(id)` always rejects with code `CANCELED`.

Priorities: `'critical' | 'high' | 'normal' | 'low'` (or numbers `0..3`).

## Events

```js
loader.addEventListener('retry',    (e) => console.log(e.detail));
loader.addEventListener('fallback', (e) => console.log(e.detail.error)); // chain
loader.addEventListener('fail',     (e) => {}); // only when no fallback
loader.addEventListener('degrade',  (e) => {}); // worker -> main-thread fetch
// also: enqueue, load, cancel, drain
```

`detail.error` is an **exception chain** array:
`[{ name, code, status, message }, …cause]`, e.g.

```
RETRIES_EXHAUSTED: Retries exhausted after 3 attempts
  → HTTP_ERROR(503): HTTP 503: /p.js
  → HTTP_ERROR(503): HTTP 503: /p.js
  → TIMEOUT: Request timeout after 2000ms: /p.js
```

## Architecture

```
ResourceLoader (main thread)                         src/loader.js
  │  priority min-heap (FIFO within level)           src/priority-queue.js
  │  global semaphore: synchronous slot accounting
  │  marks/measures (rl:<id>:queued|start|end)
  ├─ WorkerTransport ── MessageChannel/job ─▶ src/worker.js (fetch pool)
  │     pool, least-loaded selection, READY health probe
  │     structured-clone result incl. transferred ArrayBuffer
  └─ FetchTransport (automatic degradation)         src/transports.js
        └─ runFetchJob: abort + timeout + deadline  src/fetch-job.js
             retry: exp. backoff · jitter · Retry-After
             ResourceError cause chain              src/errors.js
  materializeSuccess / materializeFallback          src/materialize.js
  MetricsCollector (PerformanceObserver)            src/metrics.js
```

- **Priority queue.** Binary min-heap keyed by `(priority, seq)`; equal
  priorities are FIFO. Resources enqueued in the same tick
  (`loadAll`/bursts) compete by priority because the scheduler pumps from a
  coalesced microtask rather than at call time.
- **Concurrency limit.** Slots are decremented/incremented synchronously
  around `transport.request()` while awaiting worker readiness, so the cap
  (`loader.stats().active`) is exact regardless of Worker boot timing.
- **Timeout / deadline.** Every attempt gets an `AbortController`; the
  per-attempt timeout is capped by the remaining total deadline. Aborts are
  forwarded main thread → transport → Worker (`CANCEL` postMessage) → fetch.
- **Retry.** Network errors, timeouts and 408/409/425/429/5xx are retried
  (404 is not); exponential backoff with ±jitter and HTTP `Retry-After`
  support; every failed attempt is linked on the `cause` chain and reported
  through the `retry` event.
- **Degradation.** After hard failure or timeout, `fallback` (value or
  function receiving `(spec, error)`) produces an image placeholder, a
  system-font stack, or inline/URL script fallback. Worker boot failure emits
  `degrade` and transparently switches to `FetchTransport`.
- **Exception chain.** `ResourceError` carries `code`, `status`, `details`
  and `cause`; `toJSON()`/`deserializeError()` preserve the whole chain
  across the Worker structured-clone boundary.
- **Observability.** Per resource: `rl:<id>:queued|start|end` marks and
  `rl:<id>:total` / `rl:<id>:fetch` measures (with detail).
  `MetricsCollector` uses separate `PerformanceObserver`s for
  `measure/mark` and `resource` timing (a second `observe()` would replace
  the first filter), plus counters (`loaded/fallback/failed/canceled/retries`)
  and min/avg/max/p95 summaries.

## API surface

```js
new ResourceLoader({
  workerUrl, workerPoolSize = 2, workerReadyTimeout = 3000,
  useWorker = true,                 // requires workerUrl
  concurrency = 6,
  timeout = 8000, deadline = 0,     // deadline 0 = disabled
  retries = 2, retryDelay = 300, retryBackoff = 2, retryJitter = 0.2,
  metrics,                          // default: new MetricsCollector(); null disables
})
loader.load(spec)          // Promise<resource>
loader.loadAll(specs)
loader.cancel(id)          // true if queued or in-flight
loader.stats()             // { queued, active, concurrency, counters }
loader.dispose()
metrics.summary('total' | 'fetch')
metrics.entries()          // per-id phase measures with detail
metrics.nativeResources()  // PerformanceResourceTiming snapshot
```

## Tests

```bash
npm test
```

Six suites (Node's built-in test runner, zero dependencies):

| Suite | Covers |
| --- | --- |
| `priority-queue.test.js` | heap ordering, FIFO within level, remove, 500-item stress |
| `fetch-job.test.js` | success, 503 retry chain, 404 no-retry, 429/`Retry-After`, timeout, deadline, network retry, error JSON round-trip |
| `loader.test.js` | burst priority dispatch, exact concurrency peak, placeholder fallback, exception-chain rejection, retry events/counter, queued + in-flight cancel, custom fallback fn, worker-crash error |
| `metrics.test.js` | marks/measures observed, counters, p95 summary, no-`PerformanceObserver` degradation |
| `e2e-fetch.test.js` | real `runFetchJob` path via `FetchTransport`: 200, flaky→success, 404 font fallback, abort-on-timeout fallback |
| `worker-transport.test.js` | real `src/worker.js` on `worker_threads` behind a Web-Worker shim: transferred `ArrayBuffer`, streamed retries, deserialized error chain, cross-boundary cancel, boot-fail degradation |

## Demo

```bash
npm run demo          # http://127.0.0.1:8123
```

- "Load burst of 8": critical hero + webfont jump the queue in front of
  low-priority thumbnails; the slow banner times out and shows a placeholder;
  a 404 image shows the built-in SVG placeholder; a flaky script recovers
  through retries.
- "Chaos": 503×2 + `Retry-After`, 5s endpoint behind a 500ms timeout with
  2 retries, and a 404 font with a system-font fallback.
- The event log shows every transition with the full exception chain; the
  stats card shows live counters and `PerformanceObserver`-derived p95.

## Acceptance criteria mapping

| Criterion | Where |
| --- | --- |
| Critical resources load first | `PriorityQueue` heap + microtask pump; `loader.test.js` burst test |
| Timeout → degraded placeholder | timeout abort in `fetch-job.js`, `materializeFallback`; e2e + loader tests |
| Accurate concurrency limit | synchronous semaphore in `ResourceLoader._pump`; peak==limit test |
| Failure retry | backoff/jitter/`Retry-After`, 404 excluded; fetch-job + worker tests |
| Performance observability | marks/measures + `MetricsCollector`/`PerformanceObserver`; metrics test |
| Exception chain | `ResourceError` cause chain, serialized through Workers; chain assertions |
