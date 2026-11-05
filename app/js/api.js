// Thin fetch wrapper for the local API, plus job polling and small caches.

export class ApiError extends Error {
  constructor(status, detail) {
    super(detail || `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail || `Request failed (${status})`;
  }
}

function detailText(body, fallback) {
  if (!body) return fallback;
  const d = body.detail;
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) {
    // FastAPI validation errors: [{loc, msg, type}]
    return d.map((e) => {
      const loc = Array.isArray(e.loc) ? e.loc.filter((p) => p !== 'body').join('.') : '';
      return loc ? `${loc}: ${e.msg}` : e.msg;
    }).join('; ');
  }
  if (d && typeof d === 'object' && typeof (d.detail || d.message) === 'string') return d.detail || d.message;
  if (d) return JSON.stringify(d);
  return fallback;
}

// Demo mode (static hosting such as GitHub Pages): /api calls are answered in the browser by js/demo/server.js.
export const DEMO = (() => {
  try { return window.IA_DEMO === true || new URLSearchParams(location.search).get('demo') === '1'; } catch { return false; }
})();
let demoServer = null;
function demoFetch(path, opts) {
  if (!demoServer) demoServer = import('./demo/server.js');
  return demoServer.then((m) => m.handle(path, opts));
}

export async function api(path, { method = 'GET', body, form, signal, raw = false } = {}) {
  const opts = { method, headers: { Accept: 'application/json' }, signal };
  if (form) {
    opts.body = form;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = DEMO && String(path).startsWith('/api/') ? await demoFetch(path, opts) : await fetch(path, opts);
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new ApiError(0, "Can't reach the app server. Is it still running?");
  }
  if (!res.ok) {
    let parsed = null;
    try { parsed = await res.json(); } catch { /* not JSON */ }
    const error = new ApiError(res.status, detailText(parsed, res.statusText || `HTTP ${res.status}`));
    error.body = parsed; // e.g. 409 {detail, blockers}
    throw error;
  }
  if (raw) return res;
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

export const get = (path, opts) => api(path, opts);
export const post = (path, body, opts = {}) => api(path, { ...opts, method: 'POST', body: body ?? {} });
export const put = (path, body, opts = {}) => api(path, { ...opts, method: 'PUT', body: body ?? {} });
export const del = (path, opts = {}) => api(path, { ...opts, method: 'DELETE' });

export const enc = encodeURIComponent;

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); return; }
      signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    }
  });
}

/** Poll a background job until it finishes. Calls onUpdate(job) on every poll. */
export async function pollJob(id, onUpdate, { signal, interval = 700, timeoutMs = 45 * 60 * 1000 } = {}) {
  const started = Date.now();
  let failures = 0;
  for (;;) {
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    let job;
    try {
      job = await api(`/api/jobs/${enc(id)}`, { signal });
      failures = 0;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      failures += 1;
      if (failures >= 5) throw err;
      await sleep(interval * 2, signal);
      continue;
    }
    if (onUpdate) onUpdate(job);
    if (job.status === 'done' || job.status === 'failed') return job;
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for the background job.');
    await sleep(interval, signal);
  }
}

// --- small caches ------------------------------------------------------------------------
let healthCache = null; // { at, promise }
export function getHealth({ force = false } = {}) {
  const now = Date.now();
  if (!force && healthCache && now - healthCache.at < 15000) return healthCache.promise;
  const promise = api(force ? '/api/health?force=1' : '/api/health');
  healthCache = { at: now, promise };
  promise.catch(() => { if (healthCache && healthCache.promise === promise) healthCache = null; });
  return promise;
}
export function invalidateHealth() { healthCache = null; }

let settingsCache = null;
export function getSettings({ force = false } = {}) {
  if (!force && settingsCache) return settingsCache;
  settingsCache = api('/api/settings');
  settingsCache.catch(() => { settingsCache = null; });
  return settingsCache;
}
export function invalidateSettings() { settingsCache = null; }

let templatesCache = null;
export function getTemplates() {
  if (!templatesCache) {
    templatesCache = api('/api/templates');
    templatesCache.catch(() => { templatesCache = null; });
  }
  return templatesCache;
}
