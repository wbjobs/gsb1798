import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), 'public');
const port = Number(process.env.PORT ?? 3000);
const concurrency = new Map();

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

let retryFailures = 2;

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  try {
    if (url.pathname === '/api/reset') {
      retryFailures = 2;
      writeJson(response, 200, { ok: true, retryFailures });
      return;
    }
    if (url.pathname === '/api/concurrency') {
      const data = Object.fromEntries(
        [...concurrency.entries()].map(([key, value]) => [key, value])
      );
      writeJson(response, 200, data);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      await handleApi(url, response);
      return;
    }
    await serveStatic(url, response);
  } catch (error) {
    writeJson(response, 500, { error: error.message });
  }
});

async function handleApi(url, response) {
  const delay = Number(url.searchParams.get('delay') ?? 200);
  const status = Number(url.searchParams.get('status') ?? 200);

  if (url.pathname === '/api/image') {
    const label = url.searchParams.get('label') ?? '图片';
    await trackedRequest('image', delay, response);
    if (!response.destroyed && !response.writableEnded) {
      response.writeHead(status, { 'content-type': 'image/svg+xml; charset=utf-8' });
      response.end(renderSvg(label, delay));
    }
    return;
  }

  if (url.pathname === '/api/script') {
    await trackedRequest('script', delay, response);
    if (!response.destroyed && !response.writableEnded) {
      response.writeHead(status, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end(`window.__demoScripts ||= [];window.__demoScripts.push(${JSON.stringify(labelForScript(delay))});`);
    }
    return;
  }

  if (url.pathname === '/api/font') {
    await trackedRequest('font', delay, response);
    if (!response.destroyed && !response.writableEnded) {
      const body = await readFile(join(root, 'fonts/dejavu-sans.ttf'));
      response.writeHead(status, { 'content-type': 'font/ttf', 'content-length': body.length });
      response.end(body);
    }
    return;
  }

  if (url.pathname === '/api/flaky') {
    await trackedRequest('flaky', delay, response);
    if (response.destroyed || response.writableEnded) return;
    if (retryFailures > 0) {
      retryFailures -= 1;
      response.writeHead(503, {
        'content-type': 'application/json; charset=utf-8',
        'retry-after': '0'
      });
      response.end(JSON.stringify({ error: '临时不可用', remainingFailures: retryFailures }));
    } else {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: true, attemptsRemaining: retryFailures }));
    }
    return;
  }

  writeJson(response, 404, { error: 'Unknown API' });
}

async function trackedRequest(key, delayMs, response) {
  const current = concurrency.get(key) ?? { active: 0, peak: 0, completed: 0 };
  current.active += 1;
  current.peak = Math.max(current.peak, current.active);
  concurrency.set(key, current);
  setConcurrencyHeaders(response, current);

  let released = false;
  const release = (completed) => {
    if (released) return;
    released = true;
    const latest = concurrency.get(key);
    latest.active = Math.max(0, latest.active - 1);
    if (completed) latest.completed += 1;
    setConcurrencyHeaders(response, latest);
  };
  response.on('close', () => release(response.writableEnded));

  await new Promise((resolve) => setTimeout(resolve, delayMs));
  release(true);
}

function setConcurrencyHeaders(response, current) {
  response.setHeader('X-Active-Requests', String(current.active));
  response.setHeader('X-Peak-Requests', String(current.peak));
}

function renderSvg(label, delay) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
  <defs><linearGradient id="g" x1="0" x2="1"><stop stop-color="#38bdf8"/><stop offset="1" stop-color="#6366f1"/></linearGradient></defs>
  <rect width="320" height="180" fill="url(#g)"/>
  <circle cx="70" cy="72" r="28" fill="rgba(255,255,255,.35)"/>
  <text x="160" y="92" text-anchor="middle" font-family="sans-serif" font-size="24" font-weight="700" fill="white">${label}</text>
  <text x="160" y="122" text-anchor="middle" font-family="sans-serif" font-size="14" fill="rgba(255,255,255,.82)">${delay}ms</text>
</svg>`;
}

function labelForScript(delay) {
  return `loaded after ${delay}ms at ${new Date().toISOString()}`;
}

async function serveStatic(url, response) {
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const decoded = decodeURIComponent(pathname);
  const safePath = normalize(decoded).replace(/^[/\\]+/, '');
  const filePath = resolve(root, safePath);
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    writeJson(response, 403, { error: 'Forbidden' });
    return;
  }
  let info;
  try {
    info = await stat(filePath);
  } catch {
    writeJson(response, 404, { error: 'Not found' });
    return;
  }
  if (info.isDirectory()) {
    writeJson(response, 404, { error: 'Not found' });
    return;
  }
  const body = await readFile(filePath);
  response.writeHead(200, {
    'content-type': mimeTypes[extname(filePath)] ?? 'application/octet-stream',
    'content-length': body.length
  });
  response.end(body);
}

function writeJson(response, status, data) {
  const body = JSON.stringify(data, null, 2);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(body);
}

if (process.env.NODE_ENV !== 'test') {
  server.listen(port, '127.0.0.1', () => {
    console.log(`Priority resource loader running at http://localhost:${port}`);
  });
}

export { server, concurrency };
