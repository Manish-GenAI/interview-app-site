// App shell: hash router, nav state, AI status chip, leave guard.
import { getHealth, DEMO } from './api.js';
import { html, mount, errorState, emptyState, installFeedbackHandler, confirmDialog, $$ } from './ui.js';
import { getLeaveGuard, setLeaveGuard } from './nav.js';
import dashboard from './views/dashboard.js';
import { prepList, prepDetail } from './views/prep.js';
import { practiceSetup, practiceSession, practiceReport } from './views/practice.js';
import progressView from './views/progress.js';
import { jobsSearch, jobsSources, jobsProfile } from './views/jobs.js';
import { applicationsList, applicationDetail } from './views/applications.js';
import { meetingsList, meetingNew, meetingView } from './views/meetings.js';
import systemView from './views/system.js';
import settingsView from './views/settings.js';

const routes = [
  ['/', dashboard, 'home'],
  ['/prep', prepList, 'prep'],
  ['/prep/:id', prepDetail, 'prep'],
  ['/practice', practiceSetup, 'practice'],
  ['/practice/:id', practiceSession, 'practice'],
  ['/practice/:id/report', practiceReport, 'practice'],
  ['/jobs', jobsSearch, 'jobs'],
  ['/jobs/sources', jobsSources, 'jobs'],
  ['/jobs/profile', jobsProfile, 'jobs'],
  ['/jobs/applications', applicationsList, 'jobs'],
  ['/jobs/applications/:id', applicationDetail, 'jobs'],
  ['/progress', progressView, 'progress'],
  ['/meetings', meetingsList, 'meetings'],
  ['/meetings/new', meetingNew, 'meetings'],
  ['/meetings/:id', meetingView, 'meetings'],
  ['/system', systemView, 'system'],
  ['/settings', settingsView, 'settings'],
];

function matchPattern(pattern, path) {
  const a = pattern.split('/').filter(Boolean);
  const b = path.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

function parseHash() {
  const h = location.hash || '#/';
  if (!h.startsWith('#/')) return null;
  const [path, qs] = h.slice(1).split('?');
  return { path: path.replace(/\/+$/, '') || '/', query: new URLSearchParams(qs || '') };
}

// --- rendering ---------------------------------------------------------------------------------
const main = document.getElementById('main');
let current = { controller: null, cleanup: null };
let prevHash = location.hash || '#/';
let ignoreNextHashChange = false;

function highlightNav(section) {
  $$('.nav a').forEach((a) => {
    if (a.dataset.nav === section) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

async function render() {
  const route = parseHash();
  if (!route) return;
  // Tear down the previous view (stop polling, audio, timers).
  if (current.controller) current.controller.abort();
  if (typeof current.cleanup === 'function') {
    try { current.cleanup(); } catch (err) { console.error(err); }
  }
  // A dialog left open by the previous page (e.g. after the browser's Back button) must not cover the next one.
  document.querySelectorAll('dialog[open]').forEach((d) => d.close('navigate'));
  setLeaveGuard(null);
  const controller = new AbortController();
  current = { controller, cleanup: null };

  let found = null;
  for (const [pattern, view, section] of routes) {
    const params = matchPattern(pattern, route.path);
    if (params) { found = { view, params, section }; break; }
  }
  highlightNav(found ? found.section : '');
  const container = document.createElement('div');
  container.className = 'view';
  main.replaceChildren(container);
  window.scrollTo(0, 0);

  if (!found) {
    document.title = 'Not found · Interview App';
    mount(container, emptyState({ title: 'Page not found', text: "That link doesn't match anything in the app.", action: html`<a class="btn btn-primary" href="#/">Go home</a>` }));
    return;
  }
  try {
    const cleanup = await found.view(container, { params: found.params, query: route.query, signal: controller.signal });
    if (current.controller === controller) current.cleanup = cleanup;
    else if (typeof cleanup === 'function') cleanup();
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    console.error(err);
    if (current.controller === controller) {
      mount(container, errorState(err));
      container.querySelector('[data-action="retry"]')?.addEventListener('click', () => render());
    }
  }
}

window.addEventListener('hashchange', async () => {
  if (ignoreNextHashChange) { ignoreNextHashChange = false; return; }
  const guard = getLeaveGuard();
  if (guard && location.hash !== prevHash) {
    // Stay put and ask in the page (native confirm() is unavailable in some embedded viewers).
    const target = location.hash;
    ignoreNextHashChange = true;
    location.hash = prevHash;
    const leave = await confirmDialog({ title: 'Leave this page?', message: guard, confirmLabel: 'Leave', danger: true });
    if (!leave) return;
    setLeaveGuard(null);
    location.hash = target;
    return;
  }
  prevHash = location.hash || '#/';
  render();
});
window.addEventListener('app:hash-replaced', (e) => { prevHash = e.detail; });

// --- AI status chip -------------------------------------------------------------------------------
async function refreshStatus(force = false) {
  const chip = document.getElementById('status-chip');
  if (!chip) return;
  const text = chip.querySelector('.status-text');
  if (DEMO) {
    chip.classList.remove('ok', 'bad');
    chip.classList.add('warn');
    text.textContent = 'Demo mode';
    chip.title = 'Demo mode: built-in rules running in your browser. Install the app for local AI or Claude.';
    return;
  }
  try {
    const health = await getHealth({ force });
    const live = (health.providers || []).filter((p) => p.available);
    chip.classList.remove('ok', 'warn', 'bad');
    if (live.length) {
      chip.classList.add('ok');
      const names = live.map((p) => (p.name === 'ollama' ? 'Local AI' : 'Claude'));
      text.textContent = names.join(' + ');
      chip.title = live.map((p) => `${p.name}: ${p.detail}`).join('\n');
    } else {
      chip.classList.add('warn');
      text.textContent = 'Built-in rules';
      chip.title = 'No language model is available. Open System for setup steps.';
    }
  } catch {
    chip.classList.remove('ok', 'warn');
    chip.classList.add('bad');
    text.textContent = 'Server offline';
    chip.title = "Can't reach the app server.";
  }
}
window.addEventListener('app:health-changed', () => refreshStatus(true));

// --- boot ---------------------------------------------------------------------------------------
document.getElementById('skip-link')?.addEventListener('click', () => main.focus());
installFeedbackHandler();
if (DEMO) import('./demo/boot.js').then((m) => m.initDemoUI()).catch((err) => console.error(err));
if (!location.hash || !location.hash.startsWith('#/')) {
  history.replaceState(null, '', '#/');
  prevHash = '#/';
}
render();
refreshStatus();
setInterval(() => refreshStatus(), 60000);
