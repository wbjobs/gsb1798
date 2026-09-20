import test from 'node:test';
import assert from 'node:assert/strict';

const observerCalls = [];

class FakePerformanceObserver {
  constructor(callback) {
    this.callback = callback;
    observerCalls.push(this);
  }

  observe(options) {
    this.options = options;
  }

  disconnect() {
    this.disconnected = true;
  }

  emit(entries) {
    this.callback({ getEntries: () => entries });
  }
}

globalThis.PerformanceObserver = FakePerformanceObserver;
const { PerformanceMonitor } = await import('../public/js/performance-monitor.js');

test('PerformanceMonitor 缓存 resource entry 并支持筛选', () => {
  const monitor = new PerformanceMonitor({ entryTypes: ['resource', 'longtask'] }).start();
  const entry = {
    entryType: 'resource',
    name: '/api/image',
    duration: 12.5,
    initiatorType: 'fetch',
    transferSize: 42,
    toJSON() {
      return {
        entryType: this.entryType,
        name: this.name,
        duration: this.duration,
        initiatorType: this.initiatorType
      };
    }
  };
  observerCalls[0].emit([entry]);

  assert.equal(monitor.getEntries({ entryType: 'resource' }).length, 1);
  assert.equal(monitor.findResourceEntry('/api/image').transferSize, 42);
  assert.equal(monitor.findResourceEntry('/missing'), undefined);

  monitor.recordWorkerTiming({ entryType: 'resource', name: '/api/font', duration: 8 });
  assert.equal(monitor.getEntries({ source: 'worker-performance-observer' })[0].name, '/api/font');

  monitor.stop();
  assert.ok(observerCalls.every((call) => call.disconnected));
});
