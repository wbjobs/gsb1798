export class PerformanceMonitor {
  constructor(options = {}) {
    this.entryTypes = options.entryTypes ?? ['resource'];
    this.entries = [];
    this.observers = [];
    this.supported = typeof PerformanceObserver !== 'undefined';
  }

  start() {
    if (!this.supported || this.observers.length > 0) return this;
    for (const entryType of this.entryTypes) {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.entries.push(this.serializeEntry(entry));
        }
      });
      try {
        observer.observe({ type: entryType, buffered: true });
        this.observers.push(observer);
      } catch {
        observer.disconnect();
      }
    }
    return this;
  }

  recordWorkerTiming(timing) {
    this.entries.push({ ...timing, source: 'worker-performance-observer' });
  }

  getEntries(filter = {}) {
    return this.entries.filter((entry) => {
      return Object.entries(filter).every(([key, value]) => entry[key] === value);
    });
  }

  findResourceEntry(url) {
    return this.entries.find((entry) => entry.name === url && entry.entryType === 'resource');
  }

  stop() {
    for (const observer of this.observers) observer.disconnect();
    this.observers = [];
  }

  serializeEntry(entry) {
    const data = entry.toJSON?.() ?? {};
    return {
      ...data,
      source: 'performance-observer',
      transferSize: entry.transferSize ?? 0,
      encodedBodySize: entry.encodedBodySize ?? 0,
      decodedBodySize: entry.decodedBodySize ?? 0
    };
  }
}
