import { PriorityResourceLoader } from './PriorityResourceLoader.js';
import { formatErrorChain } from './errors.js';

const $ = (id) => document.getElementById(id);
const refs = {
  start: $('start'),
  addLow: $('add-low'),
  pending: $('pending'),
  active: $('active'),
  success: $('success'),
  degraded: $('degraded'),
  failed: $('failed'),
  events: $('events'),
  metrics: $('metrics'),
  timing: $('timing'),
  serverConcurrency: $('server-concurrency')
};

const loader = new PriorityResourceLoader({
  maxConcurrent: 2,
  timeout: 3000,
  retries: 2,
  retryDelay: 120,
  retryJitter: 80
});

const tasks = new Map();
const names = {
  criticalImage: '关键图片',
  criticalScript: '关键脚本',
  criticalFont: '关键字体',
  highImage: '高优先级图片',
  flaky: '抖动资源',
  failingScript: '失败脚本',
  timeoutImage: '超时图片',
  lowFont: '低优先级字体'
};

for (const event of ['queue', 'start', 'retry', 'success', 'degraded', 'failure']) {
  loader.on(event, (payload) => {
    logEvent(event, payload);
    renderMetrics();
    renderCounts();
  });
}

loader.on('timing', () => {
  renderTiming();
  renderMetrics();
});

refs.start.addEventListener('click', () => {
  refs.start.disabled = true;
  refs.events.innerHTML = '';
  tasks.clear();
  fetch('/api/reset', { cache: 'no-store' }).catch(() => {});
  startDemo();
});

refs.addLow.addEventListener('click', () => {
  const task = loader.loadImage(
    `/api/image?delay=120&label=${encodeURIComponent('动态低优')}&t=${Date.now()}`,
    $('dynamic-image'),
    {
      id: 'dynamic-low',
      name: '动态低优先级图片',
      priority: 'low',
      timeout: 1000,
      retries: 1,
      fallbackLabel: '动态图片降级'
    }
  );
  track(task);
});

function startDemo() {
  track(loader.loadImage('/api/image?delay=120&label=Critical', $('critical-image'), {
    id: 'criticalImage',
    priority: 'critical',
    timeout: 1000
  }));

  track(loader.load({
    id: 'criticalScript',
    url: '/api/script?delay=80&label=critical',
    type: 'script',
    priority: 'critical',
    timeout: 800,
    target: $('critical-script'),
    placeholder: 'window.__criticalScriptFallback = true;'
  }));

  track(loader.loadFont('/api/font?delay=140', 'CriticalDemoFont', $('critical-font'), {
    id: 'criticalFont',
    priority: 'critical',
    timeout: 1200,
    fallbackFamily: 'ui-monospace, monospace'
  }));

  track(loader.loadImage('/api/image?delay=180&label=High', $('high-image'), {
    id: 'highImage',
    priority: 'high',
    timeout: 1200
  }));

  track(loader.load({
    id: 'flaky',
    url: '/api/flaky',
    type: 'resource',
    priority: 'normal',
    retries: 3,
    timeout: 1000,
    fallback: false,
    apply: async (_type, response) => {
      const data = await response.json();
      $('flaky-resource').textContent = JSON.stringify(data, null, 2);
      return data;
    }
  }));

  track(loader.load({
    id: 'failingScript',
    url: '/api/script?delay=80&status=500',
    type: 'script',
    priority: 'normal',
    retries: 2,
    timeout: 1000,
    target: $('failing-script')
  }));

  track(loader.loadImage('/api/image?delay=900&label=Slow', $('timeout-image'), {
    id: 'timeoutImage',
    priority: 'normal',
    timeout: 500,
    retries: 0,
    fallbackLabel: '超时降级占位'
  }));

  track(loader.loadFont('/api/font?delay=260', 'LowDemoFont', $('low-font'), {
    id: 'lowFont',
    priority: 'low',
    timeout: 1500,
    fallbackFamily: 'serif'
  }));
}

function track(task) {
  tasks.set(task.id, task);
  renderCounts();
  task.promise
    .then((result) => handleResult(task, result))
    .catch((error) => {
      if (task.type === 'script' && task.target) {
        task.target.textContent = '脚本最终失败\n\n' + formatErrorChain(error);
      }
      if (task.type === 'resource' && task.id === 'flaky') {
        $('flaky-resource').textContent = formatErrorChain(error);
      }
    });
}

function handleResult(task, result) {
  if (task.type === 'script' && task.target) {
    task.target.textContent = result.degraded
      ? `已降级\n占位代码：${result.placeholder}\n${formatErrorChain(result.error)}`
      : `脚本执行成功\n执行方式：${result.module ? 'module' : 'classic'}\n代码长度：${result.code}`;
  }
  if (task.type === 'resource' && task.id === 'flaky') {
    $('flaky-resource').textContent = JSON.stringify(result, null, 2);
  }
}

function logEvent(event, { request, error, waitMs }) {
  const li = document.createElement('li');
  li.className = `event-${event}`;
  const time = new Date().toLocaleTimeString();
  const label = {
    queue: '入队',
    start: '开始',
    retry: `准备重试，等待 ${Math.round(waitMs)}ms`,
    success: '成功',
    degraded: '降级',
    failure: '最终失败'
  }[event];
  li.innerHTML = `<time>${time}</time>${label}：${request.name ?? names[request.id] ?? request.url}`;
  if (error) {
    const chain = document.createElement('span');
    chain.className = 'chain';
    chain.textContent = formatErrorChain(error);
    li.appendChild(chain);
  }
  refs.events.prepend(li);
}

function renderCounts() {
  const metrics = loader.getMetrics();
  refs.pending.textContent = loader.pending;
  refs.active.textContent = loader.active;
  refs.success.textContent = metrics.filter((item) => item.status === 'success').length;
  refs.degraded.textContent = metrics.filter((item) => item.status === 'degraded').length;
  refs.failed.textContent = metrics.filter((item) => item.status === 'failed').length;
}

function renderMetrics() {
  refs.metrics.innerHTML = loader.getMetrics().map((metric) => {
    const name = metric.id in names ? names[metric.id] : metric.id;
    const priority = ['critical', 'high', 'normal', 'low'][metric.priority];
    return `<tr>
      <td>${name}</td>
      <td>${priority}</td>
      <td>${metric.status}</td>
      <td>${metric.attempts}</td>
      <td>${metric.queueDuration.toFixed(1)}ms</td>
      <td>${metric.startedAt ? metric.duration.toFixed(1) : '-'}ms</td>
    </tr>`;
  }).join('');
}

function renderTiming() {
  const entries = loader.getResourceTiming({ entryType: 'resource' })
    .filter((entry) => entry.name.includes('/api/'))
    .slice(-12)
    .map((entry) => ({
      name: entry.name.replace(location.origin, ''),
      duration: Math.round(entry.duration * 10) / 10,
      transferSize: entry.transferSize,
      initiatorType: entry.initiatorType ?? 'worker-fetch',
      source: entry.source
    }));
  refs.timing.textContent = JSON.stringify(entries, null, 2);
}

async function pollServerConcurrency() {
  try {
    const response = await fetch('/api/concurrency', { cache: 'no-store' });
    refs.serverConcurrency.textContent = JSON.stringify(await response.json(), null, 2);
  } catch {
    refs.serverConcurrency.textContent = '服务端指标暂不可用';
  }
}

setInterval(pollServerConcurrency, 400);
setInterval(renderCounts, 250);
renderCounts();
renderMetrics();
void pollServerConcurrency();
