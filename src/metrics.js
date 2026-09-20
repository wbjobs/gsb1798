// Observability built on PerformanceObserver + performance marks/measures.
//
// The ResourceLoader emits, per resource:
//   mark    `rl:<id>:queued`   at enqueue
//   mark    `rl:<id>:start`    when a transport slot opens
//   mark    `rl:<id>:end`      settled (success / fallback / failure / canceled)
//   measure `rl:<id>:total`    end - queued
//   measure `rl:<id>:fetch`    time spent inside the transport (one measure
//                              covers all retry attempts)
// with PerformanceMeasure.detail = { id, type, status, attempts, ... }.
//
// MetricsCollector observes `measure` entries plus native `resource`
// PerformanceResourceTiming entries and exposes counters/histograms.

export class MetricsCollector {
  constructor({ perf = globalThis.performance, PO = globalThis.PerformanceObserver, namePrefix = 'rl:' } = {}) {
    this._perf = perf;
    this._prefix = namePrefix;
    this._measures = new Map();
    this._nativeResources = [];
    this._counters = {
      loaded: 0,
      fallback: 0,
      failed: 0,
      canceled: 0,
      retries: 0,
    };
    this._observers = [];
    if (PO && perf) {
      // A PerformanceObserver holds only one filter: calling observe() again
      // replaces it. Use one observer per entryType group, so an unsupported
      // type (e.g. 'resource' in some runtimes) cannot blind us to measures.
      this._addObserver(PO, ['measure', 'mark']);
      this._addObserver(PO, ['resource']);
    }
  }

  _addObserver(PO, entryTypes) {
    let observer;
    try {
      observer = new PO((list) => this._ingest(list.getEntries()));
      observer.observe({ entryTypes, buffered: true });
      this._observers.push(observer);
    } catch {
      observer?.disconnect?.();
    }
  }

  _ingest(entries) {
    for (const entry of entries) {
      if (entry.entryType === 'measure' && entry.name.startsWith(this._prefix)) {
        this._recordMeasure(entry);
      } else if (entry.entryType === 'resource') {
        this._nativeResources.push({
          name: entry.name,
          initiatorType: entry.initiatorType,
          duration: entry.duration,
          transferSize: entry.transferSize,
        });
      }
    }
  }

  _recordMeasure(entry) {
    const rest = entry.name.slice(this._prefix.length);
    const colon = rest.indexOf(':');
    const id = colon === -1 ? rest : rest.slice(0, colon);
    const phase = colon === -1 ? '' : rest.slice(colon + 1);
    const record = this._measures.get(id) || { id, phases: {} };
    record.phases[phase] = {
      duration: entry.duration,
      detail: entry.detail || null,
    };
    this._measures.set(id, record);
  }

  incr(name, by = 1) {
    this._counters[name] = (this._counters[name] || 0) + by;
  }

  counters() {
    return { ...this._counters };
  }

  entries() {
    return [...this._measures.values()];
  }

  // Summary across all `rl:*` measures: min/avg/max/p95 for a given phase.
  summary(phase = 'total') {
    const values = [];
    for (const record of this._measures.values()) {
      if (record.phases[phase]) values.push(record.phases[phase].duration);
    }
    if (values.length === 0) return null;
    values.sort((a, b) => a - b);
    const sum = values.reduce((acc, v) => acc + v, 0);
    const p95Index = Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1);
    return {
      count: values.length,
      min: values[0],
      avg: sum / values.length,
      max: values[values.length - 1],
      p95: values[p95Index],
    };
  }

  nativeResources() {
    return [...this._nativeResources];
  }

  disconnect() {
    for (const observer of this._observers) observer.disconnect();
    this._observers = [];
  }
}

// Marks + measures are best-effort: missing Performance API (or a name that
// has already been used) must never break loading.
export function safeMark(perf, name, detail) {
  if (!perf?.mark) return;
  try {
    perf.mark(name, detail !== undefined ? { detail } : undefined);
  } catch { /* duplicate marks / unsupported options are ignored */ }
}

export function safeMeasure(perf, name, start, end, detail) {
  if (!perf?.measure) return;
  try {
    perf.measure(name, { start, end, detail });
  } catch {
    try {
      perf.measure(name, start, end);
    } catch { /* marks missing (e.g. canceled races) */ }
  }
}
