// UI helpers: safe HTML templating, toasts, dialogs, job progress, badges, formatters.
import { api, pollJob, enc } from './api.js';

// --- safe templating -------------------------------------------------------------------------
class SafeHTML {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}
/** Mark a string as already-safe HTML. Only use for markup built by this file or html``. */
export function raw(s) { return new SafeHTML(String(s)); }
function piece(v) {
  if (v === null || v === undefined || v === false || v === true) return '';
  if (v instanceof SafeHTML) return v.s;
  if (Array.isArray(v)) return v.map(piece).join('');
  return esc(v);
}
/** Tagged template: interpolated values are escaped unless they are html``/raw() results. */
export function html(strings, ...values) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += piece(values[i]);
  });
  return new SafeHTML(out);
}
export function mount(el, content) {
  if (!el) return el;
  el.innerHTML = content instanceof SafeHTML ? content.s : esc(content);
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
/** Delegated event listener. Returns an unsubscribe function. */
export function on(root, type, selector, handler) {
  const fn = (e) => {
    const target = e.target.closest(selector);
    if (target && root.contains(target)) handler(e, target);
  };
  root.addEventListener(type, fn);
  return () => root.removeEventListener(type, fn);
}
/** Escape text, then turn FTS snippet markers (\u0002…\u0003) into <mark>. */
export function snippetHTML(text) {
  const safe = esc(text || '').replace(/\u0002/g, '<mark>').replace(/\u0003/g, '</mark>');
  return raw(safe);
}
export function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  wrapped.flush = (...args) => { clearTimeout(t); return fn(...args); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}
export function storageGet(key, fallback = null) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
export function storageSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard', 'success', { timeout: 2000 });
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Copied to clipboard', 'success', { timeout: 2000 }); }
    catch { toast("Couldn't copy - select the text and copy it manually.", 'error'); }
    ta.remove();
  }
}

// --- formatting ---------------------------------------------------------------------------------
const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : dateFmt.format(d);
}
export function fmtDay(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : dayFmt.format(d);
}
export function fmtRel(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (Number.isNaN(diff)) return String(iso);
  const future = diff < 0;
  const s = Math.abs(diff);
  let out;
  if (s < 45) out = 'just now';
  else if (s < 3600) out = `${Math.round(s / 60)} min`;
  else if (s < 86400) out = `${Math.round(s / 3600)} h`;
  else if (s < 86400 * 30) out = `${Math.round(s / 86400)} d`;
  else return fmtDay(iso);
  if (out === 'just now') return out;
  return future ? `in ${out}` : `${out} ago`;
}
export function fmtClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}
export function fmtMs(ms) {
  if (ms === null || ms === undefined) return '';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
export function fmtScore(x, digits = 1) {
  return x === null || x === undefined || Number.isNaN(Number(x)) ? '–' : Number(x).toFixed(digits);
}
export function fmtUsd(x) { return `$${(Number(x) || 0).toFixed(2)}`; }
export function pct(x) { return x === null || x === undefined ? '–' : `${Math.round(Number(x) * 100)}%`; }
export function plural(n, word, pluralWord) { return `${n} ${n === 1 ? word : (pluralWord || `${word}s`)}`; }
export function titleCase(s) { return String(s || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }
export function sentence(s) { const t = String(s || '').replace(/[_-]+/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); }

// --- small components ------------------------------------------------------------------------------
export function loading(text = 'Loading…') {
  return html`<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span><span>${text}</span></div>`;
}
export function emptyState({ title, text, action } = {}) {
  return html`<div class="empty">
    <h3>${title || 'Nothing here yet'}</h3>
    ${text ? html`<p>${text}</p>` : ''}
    ${action || ''}
  </div>`;
}
export function errorState(err, { retry = true } = {}) {
  const msg = (err && (err.detail || err.message)) || String(err);
  return html`<div class="banner banner-danger" role="alert">
    <span class="banner-icon" aria-hidden="true">⚠</span>
    <div class="stack-sm"><strong>Something went wrong</strong><span>${msg}</span>
      ${retry ? html`<div><button type="button" class="btn btn-secondary btn-sm" data-action="retry">Try again</button></div>` : ''}
    </div></div>`;
}
export function chips(items, { cls = '' } = {}) {
  const list = (items || []).filter((x) => x !== null && x !== undefined && String(x).trim() !== '');
  if (!list.length) return html`<span class="subtle">—</span>`;
  return html`<ul class="chips ${cls}">${list.map((x) => html`<li class="chip">${x}</li>`)}</ul>`;
}
export function bullets(items, { cls = 'list', empty = '—' } = {}) {
  const list = (items || []).filter((x) => x && String(x).trim());
  if (!list.length) return html`<p class="subtle">${empty}</p>`;
  return html`<ul class="${cls}">${list.map((x) => html`<li>${x}</li>`)}</ul>`;
}
export function meter(value, max = 5, { label = '', lg = false } = {}) {
  const v = Math.max(0, Math.min(Number(value) || 0, max));
  const w = (v / max) * 100;
  return html`<div class="meter ${lg ? 'meter-lg' : ''}" role="meter" aria-valuemin="0" aria-valuemax="${max}"
    aria-valuenow="${v.toFixed(1)}" aria-label="${label || 'score'}"><span style="width:${w.toFixed(1)}%"></span></div>`;
}
export function scoreRow(label, value, max = 5) {
  const missing = value === null || value === undefined;
  return html`<div class="score-row"><span class="lbl">${label}</span>
    ${missing ? html`<span class="subtle">not assessed</span>` : meter(value, max, { label })}
    <span class="val">${missing ? '' : fmtScore(value, Number.isInteger(value) ? 0 : 1)}</span></div>`;
}
export function difficultyDots(n, max = 3) {
  const d = Math.max(0, Math.min(Number(n) || 0, max));
  return html`<span class="dots" role="img" aria-label="Difficulty ${d} of ${max}">${Array.from({ length: max }, (_, i) => html`<i class="${i < d ? 'on' : ''}"></i>`)}</span>`;
}
export function statusBadge(status) {
  const map = {
    ready: ['badge-ok', 'Ready'], done: ['badge-ok', 'Done'], preparing: ['badge-accent', 'Preparing…'],
    new: ['badge-accent', 'Queued'], processing: ['badge-accent', 'Writing notes…'], finishing: ['badge-accent', 'Building report…'],
    active: ['badge-accent', 'In progress'], live: ['badge-live', 'Live'], failed: ['badge-danger', 'Failed'],
  };
  const [cls, label] = map[status] || ['', sentence(status || 'unknown')];
  return html`<span class="badge ${cls}">${label}</span>`;
}
/** Badge describing how an agent result was produced (model, or built-in rules). */
export function metaBadge(meta) {
  if (!meta) return '';
  if (meta.provider === 'heuristic' || meta.status === 'degraded') {
    return html`<span class="badge badge-warn" title="No language model was available, so built-in rules produced this. Install Ollama or add a Claude key for full quality.">Built-in rules</span>`;
  }
  const extra = meta.status === 'repaired' ? ' · self-corrected' : meta.status === 'fallback' ? ' · fallback provider' : '';
  const title = `Made by ${meta.model || meta.provider} (${meta.provider})${meta.attempts ? `, ${meta.attempts} attempt(s)` : ''}${meta.trace_id ? `, trace ${meta.trace_id}` : ''}`;
  return html`<span class="badge" title="${title}">${meta.model || meta.provider}${meta.latency_ms ? ` · ${fmtMs(meta.latency_ms)}` : ''}${extra}</span>`;
}

// --- toasts --------------------------------------------------------------------------------------------
export function toast(message, kind = 'info', { timeout = 5000 } = {}) {
  const box = document.getElementById('toasts');
  if (!box) return;
  const t = document.createElement('div');
  t.className = `toast toast-${kind}`;
  t.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const msg = document.createElement('div');
  msg.className = 'toast-msg';
  msg.textContent = message;
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'icon-btn'; close.setAttribute('aria-label', 'Dismiss'); close.textContent = '×';
  close.addEventListener('click', () => t.remove());
  t.append(msg, close);
  box.appendChild(t);
  if (timeout) setTimeout(() => t.remove(), timeout);
}
export function toastError(err) {
  if (!err || err.name === 'AbortError') return;
  toast(err.detail || err.message || String(err), 'error', { timeout: 9000 });
}

// --- dialogs ---------------------------------------------------------------------------------------------
/**
 * Open a modal <dialog>. actions: [{label, kind, onClick(dialogEl) -> false to keep open}]
 * Returns {el, close}.
 */
export function openModal({ title, body, actions = [], wide = false, onClose } = {}) {
  const d = document.createElement('dialog');
  d.className = `modal${wide ? ' modal-wide' : ''}`;
  const titleId = `dlg-${Math.random().toString(36).slice(2, 8)}`;
  d.setAttribute('aria-labelledby', titleId);
  mount(d, html`<div class="modal-inner">
    <header class="modal-head"><h2 id="${titleId}">${title}</h2>
      <button type="button" class="icon-btn" data-close aria-label="Close">×</button></header>
    <div class="modal-body">${body || ''}</div>
    ${actions.length ? html`<footer class="modal-foot">${actions.map((a, i) => html`<button type="button" class="btn ${a.kind || 'btn-secondary'}" data-i="${i}">${a.label}</button>`)}</footer>` : ''}
  </div>`);
  document.body.appendChild(d);
  let closed = false;
  const close = (value) => { if (!closed) { closed = true; d.close(value); } };
  d.addEventListener('close', () => { d.remove(); if (onClose) onClose(d.returnValue); });
  d.querySelector('[data-close]').addEventListener('click', () => close('cancel'));
  d.querySelectorAll('.modal-foot [data-i]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = actions[Number(btn.dataset.i)];
      if (!action.onClick) { close(action.value || 'ok'); return; }
      btn.disabled = true;
      try {
        const result = await action.onClick(d);
        if (result !== false) close(action.value || 'ok');
      } catch (err) {
        toastError(err);
      } finally {
        if (!closed) btn.disabled = false;
      }
    });
  });
  d.showModal();
  return { el: d, close };
}
export function confirmDialog({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    openModal({
      title,
      body: html`<p>${message}</p>`,
      actions: [
        { label: 'Cancel', kind: 'btn-ghost', onClick: () => { answered = true; resolve(false); } },
        { label: confirmLabel, kind: danger ? 'btn-danger' : 'btn-primary', onClick: () => { answered = true; resolve(true); } },
      ],
      onClose: () => { if (!answered) resolve(false); },
    });
  });
}
export function promptDialog({ title, label, value = '', confirmLabel = 'Save' } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const { el } = openModal({
      title,
      body: html`<div class="field"><label for="prompt-input">${label}</label><input id="prompt-input" class="input" value="${value}"></div>`,
      actions: [
        { label: 'Cancel', kind: 'btn-ghost', onClick: () => { answered = true; resolve(null); } },
        { label: confirmLabel, kind: 'btn-primary', onClick: (dlg) => { answered = true; resolve(dlg.querySelector('#prompt-input').value.trim()); } },
      ],
      onClose: () => { if (!answered) resolve(null); },
    });
    const input = el.querySelector('#prompt-input');
    input.focus(); input.select();
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); el.querySelector('.modal-foot .btn-primary').click(); }
    });
  });
}

// --- job progress -------------------------------------------------------------------------------------
const STEP_ICON = { pending: '', running: '', done: '✓', degraded: '✓', failed: '✕', skipped: '–' };
const STEP_SR = { pending: 'Waiting', running: 'In progress', done: 'Done', degraded: 'Done with built-in rules', failed: 'Failed', skipped: 'Skipped' };
export function stepsHTML(steps) {
  if (!steps || !steps.length) return loading('Starting…');
  return html`<ol class="steps">${steps.map((s) => {
    const status = s.status || 'pending';
    const meta = [];
    if (s.agent) meta.push(s.agent);
    if (s.model && s.provider && s.provider !== 'heuristic') meta.push(`${s.model} (${s.provider})`);
    if (s.latency_ms) meta.push(fmtMs(s.latency_ms));
    if (s.detail && status !== 'done' && status !== 'degraded') meta.push(s.detail);
    return html`<li class="step step-${status}">
      <span class="step-icon" aria-hidden="true">${STEP_ICON[status] || ''}</span>
      <div><div class="step-label">${s.label || s.key}<span class="sr-only"> — ${STEP_SR[status] || status}</span></div>
        ${meta.length ? html`<div class="step-meta">${meta.join(' · ')}</div>` : ''}</div>
      <div>${status === 'degraded' ? html`<span class="badge badge-warn" title="No language model answered, so built-in rules did this step.">built-in rules</span>` : ''}</div>
    </li>`;
  })}</ol>`;
}
/**
 * Render a live progress card for a background job into `container`, polling until it finishes.
 * Resolves with the final job (or null if aborted).
 */
export async function trackJob(container, jobId, { title = 'Working…', subtitle = '', signal, onDone, onFailed } = {}) {
  mount(container, html`<section class="card" aria-live="polite" aria-busy="true">
    <div class="card-head"><h2>${title}</h2><span class="badge badge-accent" data-job-status>Starting…</span></div>
    ${subtitle ? html`<p class="muted" style="margin-bottom:12px">${subtitle}</p>` : ''}
    <div data-job-steps>${loading('Starting…')}</div>
    <div data-job-error></div>
  </section>`);
  const stepsEl = container.querySelector('[data-job-steps]');
  const statusEl = container.querySelector('[data-job-status]');
  const errEl = container.querySelector('[data-job-error]');
  const statusLabel = { queued: 'Queued', running: 'Running', done: 'Done', failed: 'Failed' };
  try {
    const job = await pollJob(jobId, (j) => {
      mount(stepsEl, stepsHTML(j.steps));
      statusEl.textContent = statusLabel[j.status] || j.status;
      if (j.error && j.status === 'queued') mount(errEl, html`<p class="subtle mt-2">Retrying after an error: ${j.error}</p>`);
    }, { signal });
    container.firstElementChild?.setAttribute('aria-busy', 'false');
    if (job.status === 'done') {
      statusEl.className = 'badge badge-ok';
      if (onDone) await onDone(job);
    } else {
      statusEl.className = 'badge badge-danger';
      mount(errEl, html`<div class="banner banner-danger mt-3" role="alert"><span class="banner-icon" aria-hidden="true">⚠</span><span>${job.error || 'The job failed.'}</span></div>`);
      if (onFailed) await onFailed(job);
    }
    return job;
  } catch (err) {
    if (err.name === 'AbortError') return null;
    mount(errEl, errorState(err, { retry: false }));
    return null;
  }
}

// --- feedback widget --------------------------------------------------------------------------------
const REASONS = {
  evaluation: ['too_harsh', 'too_lenient', 'generic', 'wrong', 'other'],
  report: ['too_harsh', 'too_lenient', 'generic', 'wrong', 'other'],
  default: ['generic', 'wrong', 'other'],
};
const REASON_LABEL = { too_harsh: 'Too harsh', too_lenient: 'Too lenient', generic: 'Too generic', wrong: 'Wrong', other: 'Other' };
export function feedbackWidget(targetType, targetId, { label = 'Was this useful?' } = {}) {
  if (!targetId) return '';
  return html`<div class="feedback" data-fb data-type="${targetType}" data-id="${targetId}">
    <span>${label}</span>
    <button type="button" class="btn btn-secondary thumb" data-fb-up aria-pressed="false" aria-label="Yes, useful">👍</button>
    <button type="button" class="btn btn-secondary thumb" data-fb-down aria-pressed="false" aria-label="No, not useful">👎</button>
    <span class="row hidden" data-fb-reasons>${(REASONS[targetType] || REASONS.default).map((r) => html`<button type="button" class="chip chip-btn" data-fb-reason="${r}">${REASON_LABEL[r]}</button>`)}</span>
    <span class="subtle" data-fb-thanks hidden>Thanks — this tunes future feedback.</span>
  </div>`;
}
async function sendFeedback(box, rating, reason) {
  try {
    await api('/api/feedback', { method: 'POST', body: { target_type: box.dataset.type, target_id: box.dataset.id, rating, reason } });
    box.querySelector('[data-fb-reasons]').classList.add('hidden');
    box.querySelector('[data-fb-thanks]').hidden = false;
    box.querySelectorAll('.thumb').forEach((b) => { b.disabled = true; });
  } catch (err) { toastError(err); }
}
/** Install once: handles every feedback widget on the page. */
export function installFeedbackHandler() {
  document.addEventListener('click', (e) => {
    const box = e.target.closest('[data-fb]');
    if (!box) return;
    if (e.target.closest('[data-fb-up]')) {
      box.querySelector('[data-fb-up]').setAttribute('aria-pressed', 'true');
      sendFeedback(box, 1, 'helpful');
    } else if (e.target.closest('[data-fb-down]')) {
      box.querySelector('[data-fb-down]').setAttribute('aria-pressed', 'true');
      box.querySelector('[data-fb-reasons]').classList.remove('hidden');
    } else {
      const chip = e.target.closest('[data-fb-reason]');
      if (chip) sendFeedback(box, -1, chip.dataset.fbReason);
    }
  });
}

// --- tabs ----------------------------------------------------------------------------------------------
export function tabsHTML(items, active, { label = 'Sections' } = {}) {
  return html`<div class="tabs" role="tablist" aria-label="${label}">${items.map((t) => html`<button type="button" class="tab" role="tab"
    id="tab-${t.key}" aria-controls="panel-${t.key}" aria-selected="${t.key === active ? 'true' : 'false'}" tabindex="${t.key === active ? '0' : '-1'}"
    data-tab="${t.key}">${t.label}${t.count !== undefined && t.count !== null ? html`<span class="count">${t.count}</span>` : ''}</button>`)}</div>`;
}
/** Arrow-key navigation for a tablist. */
export function bindTabKeys(tablist, onSelect) {
  tablist.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const tabs = $$('[role="tab"]', tablist);
    const idx = tabs.indexOf(document.activeElement);
    if (idx < 0) return;
    e.preventDefault();
    let next = idx;
    if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
    if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = tabs.length - 1;
    tabs[next].focus();
    onSelect(tabs[next].dataset.tab);
  });
}

/** Update the current hash's query string without triggering a re-render. */
export function replaceQuery(params) {
  const hash = location.hash || '#/';
  const [path, qs] = hash.split('?');
  const q = new URLSearchParams(qs || '');
  Object.entries(params).forEach(([k, v]) => {
    if (v === null || v === undefined || v === '') q.delete(k); else q.set(k, v);
  });
  const next = `${path}${q.toString() ? `?${q}` : ''}`;
  history.replaceState(null, '', next);
  window.dispatchEvent(new CustomEvent('app:hash-replaced', { detail: next }));
}

export function setBusy(button, busy, busyLabel) {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="spinner spinner-sm" aria-hidden="true"></span> ${esc(busyLabel || 'Working…')}`;
  } else {
    button.disabled = false;
    if (button.dataset.label !== undefined) button.innerHTML = button.dataset.label;
  }
}

export { enc };
