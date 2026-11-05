// Demo persistence: tables kept in memory and mirrored to localStorage under "ia-demo:" keys.
// Every storage access is guarded; if storage is unavailable the demo still works for the session.

export const PREFIX = 'ia-demo:';
const TABLES = ['targets', 'questions', 'stories', 'sessions', 'turns', 'skills', 'meetings', 'segments', 'jobs',
  'traces', 'feedback', 'eval_runs', 'meta', 'careers', 'cr_sources', 'cr_postings', 'cr_apps'];
const MAX_TRACES = 400;

function readKey(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function writeKey(key, value) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}

export const db = {};
for (const t of TABLES) db[t] = readKey(t) || {};

const dirty = new Set();
let flushTimer = null;
export function save(...tables) {
  tables.forEach((t) => dirty.add(t));
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 0);
}
export function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  for (const t of dirty) writeKey(t, db[t]);
  dirty.clear();
}
try { window.addEventListener('pagehide', flush); } catch { /* not in a browser */ }

export function clearAll() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch { /* ignore */ }
  for (const t of TABLES) db[t] = {};
}

export function newId(prefix) {
  let hex = '';
  try {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    hex = Math.random().toString(16).slice(2, 14).padEnd(12, '0');
  }
  return `${prefix}_${hex}`;
}

/** Python-style ISO timestamp: 2026-11-05T09:00:00+00:00 */
export function nowIso(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

export function nextInt(name) {
  const n = (db.meta[`seq_${name}`] || 0) + 1;
  db.meta[`seq_${name}`] = n;
  save('meta');
  return n;
}

export const rows = (table) => Object.values(db[table]);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function trimTraces() {
  const all = rows('traces');
  if (all.length <= MAX_TRACES) return;
  all.sort((a, b) => a.seq - b.seq);
  for (const t of all.slice(0, all.length - MAX_TRACES)) delete db.traces[t.id];
}

export class DemoError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// --- background jobs (simulated, persisted, resumable) ------------------------------------------
const handlers = {};
export function registerJob(kind, fn) { handlers[kind] = fn; }

export class JobHandle {
  constructor(job) { this.job = job; }
  touch() { this.job.updated_at = nowIso(); save('jobs'); }
  plan(steps) {
    for (const s of steps) {
      if (!this.job.steps.find((x) => x.key === s.key)) this.job.steps.push({ key: s.key, label: s.label, agent: s.agent || null, status: 'pending' });
    }
    this.touch();
  }
  async step(key, label, agent, fn) {
    let st = this.job.steps.find((x) => x.key === key);
    if (!st) { st = { key, label, agent: agent || null, status: 'pending' }; this.job.steps.push(st); }
    Object.assign(st, { status: 'running', started_at: nowIso(), detail: '' });
    this.touch();
    await sleep(320 + Math.random() * 380);
    try {
      const res = await fn(st);
      if (st.status === 'running') st.status = 'done';
      st.ended_at = nowIso();
      this.touch();
      return res;
    } catch (err) {
      Object.assign(st, { status: 'failed', detail: String(err.message || err).slice(0, 300), ended_at: nowIso() });
      this.touch();
      throw err;
    }
  }
  static record(st, meta) {
    Object.assign(st, {
      provider: meta.provider, model: meta.model, latency_ms: meta.latency_ms, trace_id: meta.trace_id,
      attempts: meta.attempts, status: 'degraded', detail: 'used built-in rules (no model available)',
    });
  }
}

async function runJob(id) {
  const job = db.jobs[id];
  if (!job) return;
  const fn = handlers[job.kind];
  job.status = 'running';
  job.attempts += 1;
  job.updated_at = nowIso();
  save('jobs');
  try {
    const result = fn ? await fn(new JobHandle(job), job.payload || {}) : null;
    Object.assign(job, { status: 'done', result: result || {}, error: null, updated_at: nowIso() });
  } catch (err) {
    console.error(err);
    Object.assign(job, { status: 'failed', error: String(err.message || err).slice(0, 1000), updated_at: nowIso() });
    const onFail = handlers[`${job.kind}:failed`];
    if (onFail) { try { await onFail(new JobHandle(job), job.payload || {}); } catch { /* ignore */ } }
  }
  save('jobs');
}

export function submitJob(kind, payload) {
  const id = newId('job');
  const now = nowIso();
  db.jobs[id] = { id, kind, payload, status: 'queued', steps: [], result: null, error: null, attempts: 0, created_at: now, updated_at: now };
  save('jobs');
  setTimeout(() => runJob(id), 50);
  return id;
}

/** Resume jobs interrupted by a page reload (handlers are idempotent). */
export function recoverJobs() {
  for (const job of rows('jobs')) {
    if (job.status === 'queued' || job.status === 'running') setTimeout(() => runJob(job.id), 100);
  }
}

export function jobView(id) {
  const j = db.jobs[id];
  if (!j) return null;
  return {
    id: j.id, kind: j.kind, status: j.status, steps: j.steps, result: j.result, error: j.error,
    attempts: j.attempts, created_at: j.created_at, updated_at: j.updated_at,
  };
}
