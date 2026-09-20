// Web Worker entry: stateless fetch executor.
//
// Protocol (main -> worker):
//   { type: 'JOB', job, ports?: [MessagePort] }
//   { type: 'CANCEL', id }
// Protocol (worker -> main):
//   { type: 'RESULT', result }     // result.error is a structured payload
//   { type: 'RETRY', info }
//
// The worker enforces its own concurrency cap so a pool of workers cannot be
// oversubscribed by a single worker; the ResourceLoader additionally enforces
// the global concurrency limit on the main thread.

import { runFetchJob } from './fetch-job.js';

const MAX_INFLIGHT = 6;

const controllers = new Map();
let inflight = 0;
const pending = [];

if (typeof self !== 'undefined' && self.postMessage) {
  self.onmessage = (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'JOB') {
      pending.push({ job: msg.job, port: event.ports?.[0] || null });
      pump();
    } else if (msg.type === 'CANCEL') {
      controllers.get(msg.id)?.abort(
        Object.assign(new Error('Canceled'), { name: 'AbortError' }),
      );
    }
  };
  // Tell the main thread the worker booted (used as health probe).
  self.postMessage({ type: 'READY' });
}

function pump() {
  while (inflight < MAX_INFLIGHT && pending.length > 0) {
    const { job, port } = pending.shift();
    inflight++;
    run(job, port);
  }
}

async function run(job, port) {
  const controller = new AbortController();
  controllers.set(job.id, controller);
  try {
    const result = await runFetchJob(job, {
      signal: controller.signal,
      onRetry: (info) => send(port, { type: 'RETRY', info }),
    });
    if (!result.ok && result.error) {
      result.error = result.error.toJSON ? result.error.toJSON() : { message: String(result.error) };
    }
    send(port, { type: 'RESULT', result });
  } finally {
    controllers.delete(job.id);
    inflight--;
    pump();
  }
}

function send(port, message) {
  if (port) {
    const transfer = message.type === 'RESULT' && message.result?.buffer
      ? [message.result.buffer]
      : [];
    port.postMessage(message, transfer);
    return;
  }
  const transfer = [];
  if (message.type === 'RESULT' && message.result?.buffer) {
    transfer.push(message.result.buffer);
  }
  self.postMessage(message, transfer);
}
