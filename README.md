# 优先级资源加载器

零依赖的浏览器示例，按优先级加载图片、脚本和字体，支持并发限制、超时降级、失败重试和性能观测。

## 运行

```bash
node server.mjs
open http://localhost:3000
```

演示页包含正常资源、慢资源、失败资源和动态资源，可观察占位图、脚本兜底、重试次数、并发数和 PerformanceResourceTiming 指标。

## 测试

```bash
npm test
```

## 关键模块

- `public/js/PriorityResourceLoader.js`：优先级队列、并发槽、重试、超时和异常链路。
- `public/js/resource-worker.js`：Web Worker 中执行 `fetch` 与 `PerformanceObserver` 采集。
- `server.mjs`：静态服务和可用于验收的慢请求、失败请求、抖动请求接口。

## 验收点

- 关键资源先加载：`critical / high / normal / low` 进入同一个最小堆，同级按 FIFO 执行。
- 超时降级占位：每次尝试用 `AbortController` 取消；图片返回 SVG Data URL，脚本执行占位逻辑，字体回退系统字体。
- 并发限制准确：`maxConcurrent` 控制真实进行中的任务数，开始事件和指标里记录峰值并发。
- 失败重试：网络错误、超时和 408/409/425/429/5xx 默认重试，指数退避加随机抖动，并支持 `Retry-After`。
- 异常链路：`ResourceError.cause` 串起每次尝试和降级失败，页面可直接查看完整链路。
- 性能可观测：主线程和 Worker 均使用 `PerformanceObserver`，指标表展示队列耗时、总耗时、尝试次数和 Resource Timing。

## 编程用法

```js
const loader = new PriorityResourceLoader({
  maxConcurrent: 2,
  timeout: 3000,
  retries: 2,
  retryDelay: 200
});

const task = loader.loadImage('/api/image?delay=100', document.querySelector('img'), {
  priority: 'critical',
  fallbackLabel: '图片加载失败'
});

const result = await task.promise;
console.log(result, loader.getMetrics(), loader.getResourceTiming());
```

`load()` 返回的对象本身是 thenable，也可以直接 `await loader.load(...)`；需要读取实时指标时保留返回对象并访问 `task.metric`。
