export const ERROR_CODES = Object.freeze({
  ABORT: 'ABORT',
  HTTP_ERROR: 'HTTP_ERROR',
  NETWORK: 'NETWORK',
  TIMEOUT: 'TIMEOUT',
  UNKNOWN: 'UNKNOWN'
});

export class ResourceError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ResourceError';
    this.code = options.code ?? ERROR_CODES.UNKNOWN;
    this.url = options.url ?? '';
    this.resourceType = options.resourceType ?? '';
    this.attempt = options.attempt ?? 0;
    this.status = options.status ?? 0;
    this.cause = options.cause;
  }

  getCauses() {
    const causes = [];
    let current = this.cause;
    while (current) {
      causes.push(current);
      current = current.cause;
    }
    return causes;
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      url: this.url,
      resourceType: this.resourceType,
      attempt: this.attempt,
      status: this.status,
      stack: this.stack,
      cause: this.cause ? serializeError(this.cause) : undefined
    };
  }
}

export function serializeError(error) {
  if (!error) return null;
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      url: error.url,
      resourceType: error.resourceType,
      attempt: error.attempt,
      status: error.status,
      stack: error.stack,
      cause: error.cause ? serializeError(error.cause) : undefined
    };
  }
  return { message: String(error) };
}

export function formatErrorChain(error) {
  const lines = [];
  let current = error;
  let depth = 0;
  while (current) {
    const prefix = depth === 0 ? '最终异常' : `原因 ${depth}`;
    const status = current.status ? ` HTTP ${current.status}` : '';
    lines.push(`${prefix}: [${current.code ?? current.name}] ${current.message}${status}`);
    current = current.cause;
    depth += 1;
  }
  return lines.join('\n');
}
