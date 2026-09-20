// Turn a fetched payload into a usable resource, and build degraded
// placeholders when loading fails.
//
// All DOM/font globals are injected so the same code is unit-testable in Node.

export const DEFAULT_PLACEHOLDER_SVG =
  'data:image/svg+xml;charset=UTF-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180">' +
    '<rect width="100%" height="100%" fill="#e5e7eb"/>' +
    '<text x="50%" y="50%" font-family="sans-serif" font-size="16" ' +
    'fill="#9ca3af" text-anchor="middle" dominant-baseline="middle">image unavailable</text>' +
    '</svg>',
  );

export const SYSTEM_FONT_STACK = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';

function toBlobUrl(result, defaultType, dom) {
  const type = result.contentType || defaultType;
  const blob = new dom.Blob([result.buffer], { type });
  return dom.URL.createObjectURL(blob);
}

export async function materializeSuccess(spec, result, env = globalThis) {
  switch (spec.type) {
    case 'image':
      return {
        kind: 'image',
        url: toBlobUrl(result, 'image/*', env),
        width: spec.width ?? null,
        height: spec.height ?? null,
      };
    case 'script':
      return {
        kind: 'script',
        url: toBlobUrl(result, 'text/javascript', env),
        execute(targetElement) {
          return executeScript(result, spec, targetElement, env);
        },
      };
    case 'font':
      return loadFont(spec, result, env);
    default:
      return {
        kind: spec.type,
        url: result.buffer ? toBlobUrl(result, 'application/octet-stream', env) : null,
        text: result.text ?? null,
      };
  }
}

export function materializeFallback(spec, error, env = globalThis) {
  const fallback = typeof spec.fallback === 'function' ? spec.fallback(spec, error) : spec.fallback;
  switch (spec.type) {
    case 'image':
      return { kind: 'image', url: fallback || DEFAULT_PLACEHOLDER_SVG, degraded: true };
    case 'font':
      return { kind: 'font', family: spec.family, stack: fallback || SYSTEM_FONT_STACK, degraded: true };
    case 'script':
      return { kind: 'script', url: fallback || null, text: typeof fallback === 'string' && !/^(https?:|data:|\/)/.test(fallback) ? fallback : null, degraded: true };
    default:
      return { kind: spec.type, value: fallback ?? null, degraded: true };
  }
}

async function executeScript(result, spec, targetElement, env) {
  const text = result.text ?? new TextDecoder().decode(result.buffer);
  if (spec.inline !== false && env.document) {
    const script = env.document.createElement('script');
    script.type = spec.module ? 'module' : 'text/javascript';
    if (spec.async) script.async = true;
    if (spec.defer) script.defer = true;
    script.dataset.loadedBy = 'priority-resource-loader';
    script.dataset.source = spec.url;
    script.text = text;
    (targetElement || env.document.head || env.document.documentElement).appendChild(script);
    return { executed: true, inline: true };
  }
  return { executed: false, inline: false, text };
}

async function loadFont(spec, result, env) {
  const family = spec.family || 'LoadedFont';
  if (!env.FontFace || !env.document?.fonts) {
    return { kind: 'font', family, url: toBlobUrl(result, 'font/woff2', env), registered: false };
  }
  const face = new env.FontFace(
    family,
    result.buffer,
    {
      style: spec.style,
      weight: spec.weight,
      display: spec.fontDisplay || 'swap',
    },
  );
  await face.load();
  env.document.fonts.add(face);
  return { kind: 'font', family, style: `${spec.weight || 'normal'} ${spec.style || 'normal'}`, face, registered: true };
}

export function revokeResource(resource, env = globalThis) {
  if (resource?.url?.startsWith?.('blob:') && env.URL?.revokeObjectURL) {
    env.URL.revokeObjectURL(resource.url);
  }
}
