import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';

const { server, concurrency } = await import('../server.mjs');

let origin;

test.before(async (context) => {
  origin = await new Promise((resolve, reject) => {
    server.once('error', (error) => {
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        context.skip('当前沙箱禁止 TCP 监听，已跳过真实 HTTP 服务端测试');
        resolve(null);
        return;
      }
      reject(error);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
});

test('静态资源、模块 Worker 和字体使用正确 MIME', async (context) => {
  if (!origin) return context.skip();
  const cases = [
    ['/index.html', 'text/html'],
    ['/js/resource-worker.js', 'text/javascript'],
    ['/fonts/dejavu-sans.ttf', 'font/ttf']
  ];
  for (const [path, expected] of cases) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), new RegExp(expected));
  }
});

test('503 抖动接口前两次失败第三次成功', async (context) => {
  if (!origin) return context.skip();
  await fetch(`${origin}/api/reset`, { cache: 'no-store' });
  const statuses = [];
  for (let index = 0; index < 3; index += 1) {
    const response = await fetch(`${origin}/api/flaky?delay=0`, { cache: 'no-store' });
    statuses.push(response.status);
    await response.arrayBuffer();
  }
  assert.deepEqual(statuses, [503, 503, 200]);
});

test('客户端超时中断后服务端立即释放并发', async (context) => {
  if (!origin) return context.skip();
  concurrency.clear();
  const controller = new AbortController();
  const request = fetch(`${origin}/api/image?delay=300`, { signal: controller.signal });
  await wait(60);
  assert.equal(concurrency.get('image').active, 1);
  controller.abort();
  await assert.rejects(request, /aborted/);
  await wait(20);
  assert.equal(concurrency.get('image').active, 0);
  assert.ok(concurrency.get('image').peak >= 1);
});

test('慢资源并发峰值不超过同时发起的请求数', async (context) => {
  if (!origin) return context.skip();
  concurrency.clear();
  const responses = await Promise.all([
    fetch(`${origin}/api/image?delay=80&label=a`, { cache: 'no-store' }),
    fetch(`${origin}/api/image?delay=80&label=b`, { cache: 'no-store' }),
    fetch(`${origin}/api/image?delay=80&label=c`, { cache: 'no-store' })
  ]);
  await Promise.all(responses.map((response) => response.arrayBuffer()));
  assert.equal(concurrency.get('image').peak, 3);
  assert.equal(concurrency.get('image').active, 0);
  assert.equal(concurrency.get('image').completed, 3);
});

test.after(() => {
  if (server.listening) server.close();
});
