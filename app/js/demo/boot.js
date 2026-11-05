// Demo-mode shell: banner with an install link and "Reset demo data", and downloads served in the browser.
import { handle } from './server.js';
import { clearAll } from './store.js';
import { confirmDialog } from '../ui.js';

const BANNER = `<div class="demo-banner-inner">
  <p><strong>Demo</strong> &middot; runs entirely in your browser with built-in rules, and your data stays on this device.
  Install the app for AI models and private speech-to-text.</p>
  <div class="demo-banner-actions">
    <a class="demo-install" href="${(typeof window !== 'undefined' && window.IA_SITE_URL) || '../'}#install">Install the app</a>
    <button type="button" class="demo-reset">Reset demo data</button>
  </div>
</div>`;

async function saveDownload(href) {
  const res = await handle(href, { method: 'GET' });
  if (!res.ok) {
    let detail = `Download failed (${res.status})`;
    try { detail = (await res.json()).detail || detail; } catch { /* not JSON */ }
    window.alert(detail);
    return;
  }
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') || '';
  const name = (cd.match(/filename="([^"]+)"/) || [])[1] || 'download.txt';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function initDemoUI() {
  document.documentElement.dataset.demo = 'true';
  const header = document.querySelector('.topbar');
  if (header && !document.querySelector('.demo-banner')) {
    const banner = document.createElement('div');
    banner.className = 'demo-banner';
    banner.setAttribute('role', 'note');
    banner.innerHTML = BANNER; // static markup only
    header.insertAdjacentElement('afterend', banner);
    banner.querySelector('.demo-reset').addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Reset the demo?',
        message: 'This deletes everything you created in this browser and restores the sample data.',
        confirmLabel: 'Reset demo', danger: true,
      });
      if (!ok) return;
      clearAll();
      location.hash = '#/';
      location.reload();
    });
  }
  // Export links point at /api/...: serve them from the in-browser backend instead of the network.
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href^="/api/"]') : null;
    if (!a) return;
    e.preventDefault();
    saveDownload(a.getAttribute('href'));
  }, true);
}
