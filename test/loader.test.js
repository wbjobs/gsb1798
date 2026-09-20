import test from 'node:test';
import assert from 'node:assert/strict';

import { PriorityResourceLoader } from '../public/js/PriorityResourceLoader.js';
import { ERROR_CODES, ResourceError, formatErrorChain } from '../public/js/errors.js';
import { PriorityQueue } from '../public/js/priority-queue.js';

class FakeResponse {
  constructor(url) {
    this.url = url;
    this.ok = true;
    this.status = 200;
  }

  async arrayBuffer() {
    return new ArrayBuffer(8);
  }
}

class FakeTransport {
  constructor(behaviors = {}) {
    this.behaviors = behaviors;
    this.calls = [];
    this.networkActive = 0;
    this.peakNetworkActive = 0;
  }

  fetch(request, signal) {
    this.calls.push(request.url);
    this.networkActive += 1;
    this.peakNetworkActive = Math.max(this.peakNetworkActive, this.networkActive);

    const behavior = this.behaviors[request.url];
    return new Promise((resolve, reject) => {
      const finish = () => {
        this.networkActive -= 1;
        signal?.removeEventListener?.('abort', onAbort);
      };
      const onAbort = () => {
        finish();
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });

      if (behavior?.delay) {
        setTimeout(() => {
          finish();
          resolve(new FakeResponse(request.url));
        }, behavior.delay);
        return;
      }
      if (behavior?.failures > 0) {
        behavior.failures -= 1;
        finish();
        reject(new ResourceError('临时网络错误', {
          code: behavior.code ?? ERROR_CODES.NETWORK,
          status: behavior.status ?? 0,
          url: request.url
        }));
        return;
      }
      finish();
      resolve(new FakeResponse(request.url));
    });
  }
}

async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createLoader(options = {}) {
  return new PriorityResourceLoader({
    transport: options.transport ?? new FakeTransport(),
    maxConcurrent: options.maxConcurrent ?? 2,
    timeout: options.timeout ?? 50,
    retries: options.retries ?? 0,
    retryDelay: options.retryDelay ?? 1,
    retryJitter: 0,
    fallback: false,
    applyResource: async (_type, response) => ({ url: response.url }),
    ...options
  });
}

test('优先级队列严格按优先级和 FIFO 顺序输出', () => {
  const queue = new PriorityQueue();
  [
    { name: 'low-a', priority: 3, sequence: 0 },
    { name: 'critical', priority: 0, sequence: 1 },
    { name: 'normal', priority: 2, sequence: 2 },
    { name: 'high', priority: 1, sequence: 3 },
    { name: 'low-b', priority: 3, sequence: 4 }
  ].forEach((item) => queue.enqueue(item));

  assert.deepEqual(
    Array.from({ length: 5 }, () => queue.dequeue().name),
    ['critical', 'high', 'normal', 'low-a', 'low-b']
  );
});

test('关键资源先加载，同级保持入队顺序', async () => {
  const started = [];
  const transport = new FakeTransport({
    blocker: { delay: 20 },
    low: {},
    normal: {},
    high: {},
    critical: {}
  });
  const loader = createLoader({ maxConcurrent: 1, transport });
  loader.on('start', ({ request }) => started.push(request.url));

  loader.load({ url: 'blocker', type: 'resource', priority: 'low' });
  await flushMicrotasks();
  loader.load({ url: 'low', type: 'resource', priority: 'low' });
  loader.load({ url: 'normal', type: 'resource', priority: 'normal' });
  loader.load({ url: 'high', type: 'resource', priority: 'high' });
  loader.load({ url: 'critical', type: 'resource', priority: 'critical' });

  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(started[0], 'blocker');
  assert.deepEqual(started.slice(1, 5), ['critical', 'high', 'normal', 'low']);
  loader.destroy();
});

test('并发限制准确且不会超过配置值', async () => {
  const transport = new FakeTransport({
    a: { delay: 10 },
    b: { delay: 15 },
    c: { delay: 20 },
    d: { delay: 10 },
    e: { delay: 15 }
  });
  const loader = createLoader({ maxConcurrent: 2, transport });
  const tasks = ['a', 'b', 'c', 'd', 'e'].map((url) => loader.load({ url }));

  const results = await Promise.all(tasks.map((task) => task.promise.catch((error) => error)));
  assert.equal(transport.peakNetworkActive, 2);
  assert.equal(results.filter((result) => result.url).length, 5);
  assert.ok(loader.getMetrics().every((metric) => metric.peakActive <= 2));
  loader.destroy();
});

test('网络失败按指数重试并保留尝试次数', async () => {
  const transport = new FakeTransport({
    flaky: { failures: 2, code: ERROR_CODES.NETWORK }
  });
  const loader = createLoader({ transport, retries: 2, retryDelay: 1 });
  const task = loader.load({ url: 'flaky' });

  await task;
  assert.deepEqual(transport.calls, ['flaky', 'flaky', 'flaky']);
  assert.equal(task.metric.attempts, 3);
  assert.equal(task.metric.status, 'success');
  loader.destroy();
});

test('400 等非重试状态不重试', async () => {
  const transport = new FakeTransport({
    bad: { failures: 1, code: ERROR_CODES.HTTP_ERROR, status: 400 }
  });
  const loader = createLoader({ transport, retries: 3 });
  const task = loader.load({ url: 'bad', fallback: false });

  await assert.rejects(task.promise, (error) => error.code === ERROR_CODES.HTTP_ERROR && error.status === 400);
  assert.deepEqual(transport.calls, ['bad']);
  loader.destroy();
});

test('超时后触发图片降级占位', async () => {
  const transport = new FakeTransport({ slow: { delay: 50 } });
  const loader = createLoader({
    transport,
    timeout: 5,
    retries: 0,
    fallback: undefined
  });
  const task = loader.load({
    url: 'slow',
    type: 'image',
    fallbackLabel: '图片超时',
    fallback: true
  });

  const result = await task;
  assert.equal(result.degraded, true);
  assert.match(result.src, /data:image\/svg\+xml/);
  assert.match(decodeURIComponent(result.src), /图片超时/);
  assert.equal(task.metric.status, 'degraded');
  assert.equal(task.metric.error.code, ERROR_CODES.TIMEOUT);
  loader.destroy();
});

test('未知资源没有内置占位时仍按失败处理', async () => {
  const transport = new FakeTransport({
    missing: { failures: 1, code: ERROR_CODES.NETWORK }
  });
  const loader = createLoader({ transport, fallback: undefined });
  const task = loader.load({ url: 'missing', type: 'resource', fallback: true });

  await assert.rejects(task.promise, (error) => error.code === ERROR_CODES.NETWORK);
  assert.equal(task.metric.status, 'failed');
  assert.equal(task.metric.degraded, false);
  loader.destroy();
});

test('异常链路保留每次失败原因', async () => {
  const transport = new FakeTransport({
    chain: { failures: 3, code: ERROR_CODES.NETWORK }
  });
  const loader = createLoader({ transport, retries: 2, retryDelay: 1 });
  const task = loader.load({ url: 'chain', fallback: false });

  await assert.rejects(task.promise, (error) => {
    assert.equal(error.code, ERROR_CODES.NETWORK);
    assert.equal(error.attempt, 3);
    assert.equal(error.cause.attempt, 2);
    assert.equal(error.cause.cause.attempt, 1);
    assert.match(formatErrorChain(error), /最终异常.*原因 1.*原因 2/s);
    return true;
  });
  loader.destroy();
});

test('降级失败时追加降级异常而不覆盖原始网络异常', async () => {
  const transport = new FakeTransport({
    fail: { failures: 1, code: ERROR_CODES.NETWORK }
  });
  const loader = createLoader({
    transport,
    fallback: async () => {
      throw new ResourceError('生成占位图失败', { code: 'FALLBACK_FAILED' });
    }
  });
  const task = loader.load({ url: 'fail', type: 'image', fallback: true });

  await assert.rejects(task.promise, (error) => {
    assert.equal(error.message, '资源降级失败');
    assert.equal(error.cause.message, '生成占位图失败');
    assert.equal(error.cause.cause.code, ERROR_CODES.NETWORK);
    return true;
  });
  loader.destroy();
});

test('性能指标包含队列、总耗时和资源时序', async () => {
  class Monitor {
    constructor() {
      this.entry = {
        entryType: 'resource',
        name: 'measured',
        duration: 12.5,
        initiatorType: 'fetch'
      };
    }

    start() { return this; }
    findResourceEntry(url) { return url === this.entry.name ? this.entry : undefined; }
    getEntries() { return [this.entry]; }
    recordWorkerTiming() {}
    stop() {}
  }
  const loader = createLoader({ performanceMonitor: new Monitor() });
  await loader.load({ url: 'measured' });
  const metric = loader.getMetrics()[0];

  assert.equal(metric.status, 'success');
  assert.ok(metric.queueDuration >= 0);
  assert.ok(metric.duration >= 0);
  assert.equal(metric.resourceTiming.initiatorType, 'fetch');
  assert.equal(loader.getResourceTiming()[0].name, 'measured');
  loader.destroy();
});
