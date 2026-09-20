import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFetchJob } from '../src/fetch-job.js';
import { ERR } from '../src/errors.js';

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERR',
    url: undefined,
    headers: {
      get(name) { return headers[name.toLowerCase()] ?? null; },
      forEach() {},
    },
    async arrayBuffer() {
      return new TextEncoder().encode(JSON.stringify(body)).buffer;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

test('success on first attempt returns the buffer and attempts=1', async () => {
  let calls = 0;
  const result = await runFetchJob(
    { id: 'r1', url: 'https://example.test/ok', options: { retries: 0 } },
    { fetchImpl: async () => { calls++; return jsonResponse(200, { ok: true }); } },
  );
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  assert.equal(result.attempts, 1);
  assert.ok(result.buffer instanceof ArrayBuffer);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(result.buffer)), { ok: true });
});

test('retries 503 then succeeds; error chain links both attempts', async () => {
  let calls = 0;
  const retries = [];
  const result = await runFetchJob(
    { id: 'r2', url: 'https://example.test/flaky', options: { retries: 2, retryDelay: 1 } },
    {
      fetchImpl: async () => {
        calls++;
        return calls < 3 ? jsonResponse(503, {}) : jsonResponse(200, { ok: true });
      },
      onRetry: (info) => retries.push(info),
    },
  );
  assert.equal(result.ok, true);
  assert.equal(calls, 3);
  assert.equal(result.attempts, 3);
  assert.equal(retries.length, 2);
  assert.equal(retries[0].error.code, ERR.HTTP);
  assert.equal(retries[0].error.status, 503);
});

test('404 is not retried', async () => {
  let calls = 0;
  const result = await runFetchJob(
    { id: 'r3', url: 'https://example.test/missing', options: { retries: 3, retryDelay: 1 } },
    { fetchImpl: async () => { calls++; return jsonResponse(404, {}); } },
  );
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
  assert.equal(result.error.code, ERR.HTTP);
  assert.equal(result.error.status, 404);
});

test('429 honored twice then fails with RETRIES_EXHAUSTED carrying full cause chain', async () => {
  let calls = 0;
  const result = await runFetchJob(
    { id: 'r4', url: 'https://example.test/rate', options: { retries: 2, retryDelay: 1 } },
    {
      fetchImpl: async () => {
        calls++;
        return jsonResponse(429, {}, { 'retry-after': '0' });
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(calls, 3);
  assert.equal(result.error.code, ERR.RETRIES_EXHAUSTED);
  const codes = [];
  let cur = result.error;
  while (cur) {
    codes.push(cur.code);
    cur = cur.cause;
  }
  assert.deepEqual(codes, [ERR.RETRIES_EXHAUSTED, ERR.HTTP, ERR.HTTP, ERR.HTTP]);
});

test('per-attempt timeout aborts fetch and surfaces TIMEOUT', async () => {
  const result = await runFetchJob(
    { id: 'r5', url: 'https://example.test/slow', options: { timeout: 30, retries: 1, retryDelay: 1 } },
    {
      fetchImpl: (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, ERR.RETRIES_EXHAUSTED);
  assert.equal(result.error.cause.code, ERR.TIMEOUT);
});

test('deadline aborts before a later attempt can start', async () => {
  const start = Date.now();
  const result = await runFetchJob(
    { id: 'r6', url: 'https://example.test/down', options: { timeout: 50, deadline: 25, retries: 5, retryDelay: 40 } },
    {
      fetchImpl: async (url, init) => new Promise((resolve, reject) => {
        setTimeout(() => reject(Object.assign(new Error('network down'), { name: 'TypeError' })), 10);
      }),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, ERR.DEADLINE);
  assert.ok(Date.now() - start < 200);
});

test('network errors are retried and wrapped in a chain', async () => {
  let calls = 0;
  const result = await runFetchJob(
    { id: 'r7', url: 'https://example.test/nx', options: { retries: 1, retryDelay: 1 } },
    {
      fetchImpl: async () => {
        calls++;
        throw Object.assign(new Error('fetch failed'), { name: 'TypeError' });
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(calls, 2);
  assert.equal(result.error.code, ERR.RETRIES_EXHAUSTED);
  assert.equal(result.error.cause.code, ERR.NETWORK);
});

test('error.toJSON / deserializeError round-trips the chain', async () => {
  const { deserializeError } = await import('../src/errors.js');
  const result = await runFetchJob(
    { id: 'r8', url: 'https://example.test/x', options: { retries: 1, retryDelay: 1 } },
    { fetchImpl: async () => jsonResponse(500, {}) },
  );
  const json = result.error.toJSON();
  assert.equal(json.code, ERR.RETRIES_EXHAUSTED);
  assert.equal(json.cause.code, ERR.HTTP);
  const rebuilt = deserializeError(json);
  assert.equal(rebuilt.code, ERR.RETRIES_EXHAUSTED);
  assert.equal(rebuilt.cause.code, ERR.HTTP);
  assert.equal(rebuilt.cause.status, 500);
});

test('Retry-After header drives the backoff delay', async () => {
  const retries = [];
  let calls = 0;
  const start = Date.now();
  await runFetchJob(
    { id: 'r9', url: 'https://example.test/ra', options: { retries: 1, retryDelay: 1 } },
    {
      fetchImpl: async () => {
        calls++;
        return calls === 1 ? jsonResponse(503, {}, { 'retry-after': '0.06' }) : jsonResponse(200, {});
      },
      onRetry: (info) => retries.push(info),
    },
  );
  assert.ok(retries[0].delay >= 50, `delay was ${retries[0].delay}`);
  assert.ok(Date.now() - start >= 45);
});
