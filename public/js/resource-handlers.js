export async function applyResource(type, response, options = {}) {
  if (type === 'image') return applyImage(response, options);
  if (type === 'script') return applyScript(response, options);
  if (type === 'font') return applyFont(response, options);
  return { body: await response.arrayBuffer() };
}

export async function defaultFallback(type, error, options = {}) {
  if (type === 'image') return imageFallback(options, error);
  if (type === 'script') return scriptFallback(options, error);
  if (type === 'font') return fontFallback(options, error);
  return null;
}

async function applyImage(response, options) {
  const blob = await response.blob();
  const src = URL.createObjectURL(blob);
  if (options.target) {
    options.target.src = src;
    options.target.dataset.resourceState = 'loaded';
  }
  return { kind: 'image', src, blob, url: response.url };
}

async function applyScript(response, options = {}) {
  const code = await response.text();
  if (options.execute === false) return { kind: 'script', code, executed: false };
  const script = document.createElement('script');
  script.dataset.resourceUrl = response.url;
  if (options.module) script.type = 'module';
  script.textContent = code;
  document.head.appendChild(script);
  script.remove();
  return { kind: 'script', code, executed: true, module: Boolean(options.module) };
}

async function applyFont(response, options = {}) {
  const buffer = await response.arrayBuffer();
  const family = options.family ?? 'PriorityWebFont';
  const font = new FontFace(family, buffer, options.descriptors ?? {});
  await font.load();
  document.fonts.add(font);
  if (options.target) options.target.style.fontFamily = `'${family}', system-ui, sans-serif`;
  return { kind: 'font', family, font, buffer };
}

function imageFallback(options = {}, error) {
  const label = options.fallbackLabel ?? '资源降级';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" fill="#eef2f7"/><rect x="18" y="18" width="284" height="144" rx="12" fill="#ffffff" stroke="#cbd5e1" stroke-dasharray="8 8"/><text x="160" y="82" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#64748b">${label}</text><text x="160" height="110" y="112" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#94a3b8">${error.code}</text></svg>`;
  const src = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  if (options.target) {
    options.target.src = src;
    options.target.dataset.resourceState = 'degraded';
    options.target.dataset.errorCode = error.code;
  }
  return { kind: 'image', src, degraded: true, error: error.toJSON?.() ?? error };
}

function scriptFallback(options = {}, error) {
  const result = {
    kind: 'script',
    executed: false,
    degraded: true,
    placeholder: options.placeholder ?? 'window.__resourceFallback = true;',
    error: error.toJSON?.() ?? error
  };
  if (options.target) {
    options.target.dataset.resourceState = 'degraded';
    options.target.dataset.errorCode = error.code;
  }
  return result;
}

function fontFallback(options = {}, error) {
  const fontFamily = options.fallbackFamily ?? 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  if (options.target) {
    options.target.style.fontFamily = fontFamily;
    options.target.dataset.resourceState = 'degraded';
    options.target.dataset.errorCode = error.code;
  }
  return { kind: 'font', family: fontFamily, degraded: true, error: error.toJSON?.() ?? error };
}
