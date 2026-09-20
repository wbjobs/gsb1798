// Zero-dependency demo server:
//   /              demo/index.html
//   /src/*         library source (ESM)
//   /demo/assets/* demo assets
//   /font/...      copies of system TTF fonts (so the font demo works offline)
//
// Chaos endpoints used to prove timeout/retry/degradation:
//   /api/slow/*           responds after ?delay=ms
//   /api/flaky/*          fails the first ?fail=N calls (status ?status=),
//                         honors Retry-After: ?retryAfter=ms
//   /api/missing/*        always 404

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT || 8123);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.css': 'text/css',
};

function sendFile(res, absPath) {
  const type = MIME[extname(absPath)] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  createReadStream(absPath).pipe(res);
}

async function sendFont(res, fontName) {
  const candidates = [
    `/usr/share/fonts/truetype/dejavu/${fontName}`,
  ];
  for (const candidate of candidates) {
    try {
      await stat(candidate);
      res.writeHead(200, { 'content-type': 'font/ttf', 'cache-control': 'no-store' });
      createReadStream(candidate).pipe(res);
      return;
    } catch { /* try next */ }
  }
  res.writeHead(404).end('font not found');
}

const flakyState = new Map();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname, searchParams } = url;
  try {
    if (pathname === '/api/slow/' || pathname.startsWith('/api/slow/')) {
      const delayMs = Math.min(Number(searchParams.get('delay') || 3000), 30000);
      res.socket.on('close', () => clearTimeout(timer));
      const timer = setTimeout(() => {
        res.writeHead(200, { 'content-type': 'image/svg+xml' });
        res.end('<svg xmlns="http://www.w3.org/2000/svg"/>');
      }, delayMs);
      return;
    }

    if (pathname.startsWith('/api/flaky/')) {
      const fail = Number(searchParams.get('fail') || 2);
      const status = Number(searchParams.get('status') || 503);
      const retryAfter = Number(searchParams.get('retryAfter') || 200);
      const seen = (flakyState.get(pathname) || 0) + 1;
      flakyState.set(pathname, seen);
      if (seen <= fail) {
        res.writeHead(status, { 'retry-after': (retryAfter / 1000).toFixed(3) });
        res.end(`failure ${seen}/${fail}`);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(`window.__flakyLoadedAt = ${Date.now()};`);
      return;
    }

    if (pathname.startsWith('/api/missing/')) {
      res.writeHead(404).end('not found');
      return;
    }

    if (pathname.startsWith('/font/')) {
      return sendFont(res, decodeURIComponent(pathname.slice('/font/'.length)));
    }

    let rel;
    if (pathname === '/') rel = 'demo/index.html';
    else if (pathname.startsWith('/src/')) rel = normalize(pathname.slice(1));
    else if (pathname.startsWith('/demo/')) rel = normalize(pathname.slice(1));
    else rel = null;

    if (!rel || rel.includes('..')) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const absPath = join(root, rel);
    await stat(absPath);
    sendFile(res, absPath);
  } catch (error) {
    if (error.code === 'ENOENT') res.writeHead(404).end('not found');
    else {
      res.writeHead(500).end(String(error));
    }
  }
});

server.listen(PORT, () => {
  console.log(`\n  Priority resource loader demo:  http://127.0.0.1:${PORT}/\n`);
});
