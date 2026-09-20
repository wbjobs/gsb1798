// Error codes for the whole loader.
export const ERR = Object.freeze({
  NETWORK: 'NETWORK_ERROR',
  HTTP: 'HTTP_ERROR',
  TIMEOUT: 'TIMEOUT',
  DEADLINE: 'DEADLINE_EXCEEDED',
  CANCELED: 'CANCELED',
  RETRIES_EXHAUSTED: 'RETRIES_EXHAUSTED',
  FALLBACK: 'FALLBACK',
  WORKER: 'WORKER_ERROR',
  INVALID: 'INVALID_RESOURCE',
});

// Error class that keeps a structured "exception chain" via `cause`.
export class ResourceError extends Error {
  constructor(message, { code = 'RESOURCE_ERROR', cause = null, status, details } = {}) {
    super(message);
    this.name = 'ResourceError';
    this.code = code;
    if (cause !== null && cause !== undefined) this.cause = cause;
    if (status !== undefined) this.status = status;
    if (details !== undefined) this.details = details;
  }

  toJSON() {
    const serialize = (err) => {
      if (!err) return null;
      return {
        name: err.name || 'Error',
        message: err.message,
        code: err.code || null,
        status: err.status ?? null,
        details: err.details,
        cause: err.cause ? serialize(err.cause) : null,
      };
    };
    return serialize(this);
  }
}

// Reconstruct a ResourceError from a structured payload (e.g. postMessage
// from a Web Worker). Restores the full `cause` chain.
export function deserializeError(payload) {
  if (!payload || typeof payload !== 'object') {
    return new ResourceError('Unknown error', { code: ERR.NETWORK });
  }
  const build = (node) => {
    const err = new ResourceError(node.message, {
      code: node.code || 'RESOURCE_ERROR',
      cause: node.cause ? build(node.cause) : null,
      details: node.details,
    });
    err.name = node.name || 'ResourceError';
    if (node.status != null) err.status = node.status;
    return err;
  };
  return build(payload);
}

export function errorChainOf(err) {
  const chain = [];
  let cur = err;
  while (cur) {
    chain.push({
      name: cur.name || 'Error',
      code: cur.code || null,
      message: cur.message,
      status: cur.status ?? null,
    });
    cur = cur.cause || null;
  }
  return chain;
}
