// System: provider health, the agent pipeline, routing/circuit state, evals, feedback loop, traces.
import { api, enc, getHealth, invalidateHealth } from '../api.js';
import {
  html, mount, loading, emptyState, errorState, meter, fmtMs, fmtUsd, fmtDate, fmtRel, pct, sentence,
  trackJob, toastError, copyText, setBusy, $, on,
} from '../ui.js';

const TRACE_STATUS = {
  ok: ['badge-ok', 'ok'], repaired: ['badge-accent', 'self-corrected'], fallback: ['badge-accent', 'fallback'],
  degraded: ['badge-warn', 'built-in rules'], error: ['badge-danger', 'error'],
};

function providerCard(p) {
  const ok = p.available;
  const circuit = p.circuit || {};
  const isOllama = p.name === 'ollama';
  const missing = p.missing || [];
  return html`<article class="card provider-card">
    <div class="row-between"><h2>${isOllama ? 'Ollama (local models)' : p.name === 'claude' ? 'Claude (Anthropic API)' : sentence(p.name)}</h2>
      <span class="state ${ok ? 'ok' : 'bad'}">${ok ? 'Available' : 'Unavailable'}</span></div>
    <p class="muted">${p.detail || ''}</p>
    ${p.models ? html`<dl class="kv small">${Object.entries(p.models).filter(([, v]) => v).map(([k, v]) => html`<dt>${sentence(k)}</dt><dd><code>${v}</code></dd>`)}</dl>` : ''}
    ${isOllama && missing.length ? html`<div class="stack-sm"><span class="small"><strong>Pull the missing models</strong> (run in a terminal):</span>
      ${missing.map((m) => html`<div class="copy-row"><code>ollama pull ${m}</code><button type="button" class="btn btn-ghost btn-sm" data-copy="ollama pull ${m}">Copy</button></div>`)}</div>` : ''}
    ${isOllama && !p.reachable ? html`<p class="small">Install Ollama from <code>ollama.com</code>, start it, then pull a model, e.g. <code>ollama pull qwen3:14b</code>.</p>` : ''}
    ${p.name === 'claude' && p.monthly_budget_usd ? html`<div class="stack-sm"><div class="row-between small"><span class="muted">This month</span><span>${fmtUsd(p.month_spend_usd)} of ${fmtUsd(p.monthly_budget_usd)}</span></div>
      ${meter(p.month_spend_usd || 0, p.monthly_budget_usd, { label: 'Claude budget used' })}</div>` : ''}
    ${p.name === 'claude' && !ok ? html`<p class="small">Optional. Add a key in <a href="#/settings">Settings</a> to use Claude when local models can't answer.</p>` : ''}
    <div class="item-meta">${p.version ? html`<span>v${p.version}</span>` : ''}<span>Circuit: ${circuit.state || 'closed'}</span>${circuit.calls ? html`<span>${circuit.calls} calls</span>` : ''}${circuit.retry_in_sec ? html`<span>retry in ${circuit.retry_in_sec}s</span>` : ''}</div>
    ${circuit.last_error ? html`<p class="small" style="color:var(--danger)">Last error: ${circuit.last_error}</p>` : ''}
  </article>`;
}
function sttCard(stt) {
  if (!stt) return '';
  const ok = stt.available !== false && stt.engine !== 'off';
  return html`<article class="card provider-card">
    <div class="row-between"><h2>Speech-to-text</h2><span class="state ${ok ? (stt.engine === 'browser' ? 'warn' : 'ok') : 'bad'}">${ok ? (stt.engine === 'browser' ? 'Browser fallback' : 'Available') : 'Unavailable'}</span></div>
    <p class="muted">${stt.detail || ''}</p>
    <dl class="kv small"><dt>Engine</dt><dd>${stt.engine || '—'}</dd>${stt.model ? html`<dt>Model</dt><dd><code>${stt.model}</code></dd>` : ''}${stt.device ? html`<dt>Device</dt><dd>${stt.device}</dd>` : ''}<dt>Loaded</dt><dd>${stt.loaded ? 'yes' : 'not yet (loads on first use)'}</dd></dl>
    ${!ok || stt.engine === 'browser' ? html`<p class="small">For fully local transcription install the speech extras (see the README), then restart the app. Without it, practice can use typing or the browser's recognizer.</p>` : ''}
  </article>`;
}

export default async function systemView(root, { signal }) {
  document.title = 'System · Interview App';
  mount(root, loading('Loading system status…'));

  async function loadAll(force = false) {
    const [health, agents, feedback, evals] = await Promise.all([
      getHealth({ force }).catch((e) => ({ error: e })),
      api('/api/agents', { signal }).catch((e) => ({ error: e })),
      api('/api/feedback/summary', { signal }).catch(() => null),
      api('/api/evals/latest', { signal }).catch(() => null),
    ]);
    return { health, agents, feedback, evals };
  }

  let data = await loadAll();
  function render() {
    const { health, agents, feedback, evals } = data;
    const agentList = (agents && agents.agents) || [];
    const routing = (agents && agents.routing) || {};
    const spend = (agents && agents.spend) || null;
    mount(root, html`
      <div class="page-head"><div><h1>System</h1><p class="lead">Which models the agents use, how each agent is performing, and how the system improves from your feedback and evals.</p></div>
        <div class="actions"><button type="button" class="btn btn-secondary" data-action="recheck">Re-check connections</button></div></div>
      ${health.error ? errorState(health.error, { retry: false }) : html`<div class="grid-3">${(health.providers || []).map(providerCard)}${sttCard(health.stt)}</div>
        ${health.data_dir ? html`<p class="subtle">Your data is stored in <code>${health.data_dir}</code>${health.fts === false ? ' · full-text search unavailable (using simple matching)' : ''}.</p>` : ''}`}

      <section class="card">
        <div class="card-head"><h2>Agents</h2>${spend ? html`<span class="subtle">Claude spend ${spend.month}: ${fmtUsd(spend.claude_usd)} of ${fmtUsd(spend.budget_usd)}</span>` : ''}</div>
        <p class="muted" style="margin-bottom:12px">Each agent receives a typed input, makes one decision, and passes a validated output on. If a model fails, the agent repairs its output, tries the next provider, and finally falls back to built-in rules so the pipeline always finishes.</p>
        ${agents.error ? errorState(agents.error, { retry: false }) : agentList.length ? html`<div class="table-wrap"><table class="table">
          <thead><tr><th>Agent</th><th>Receives → decides → passes to</th><th class="num">Calls</th><th class="num">OK</th><th class="num">Built-in rules</th><th class="num">Avg time</th></tr></thead>
          <tbody>${agentList.map((a) => html`<tr>
            <td><strong>${a.name}</strong><div class="item-meta"><span class="badge">${a.module || '—'}</span><span>${a.tier || ''}</span>${a.prompt_version ? html`<span>${a.prompt_version}</span>` : ''}</div>${a.role ? html`<div class="small muted">${a.role}</div>` : ''}</td>
            <td class="flow"><div><b>Receives:</b> ${a.receives || '—'}</div><div><b>Decides:</b> ${a.decides || '—'}</div><div><b>Passes to:</b> ${a.passes_to || '—'}</div></td>
            <td class="num">${a.calls ?? 0}</td><td class="num">${a.calls ? pct(a.ok_rate) : '–'}</td><td class="num">${a.calls ? pct(a.degraded_rate) : '–'}</td><td class="num">${a.avg_latency_ms ? fmtMs(a.avg_latency_ms) : '–'}</td></tr>`)}</tbody>
        </table></div>` : emptyState({ title: 'No agents reported' })}
      </section>

      <section class="card">
        <div class="card-head"><h2>Routing</h2><span class="subtle">Circuit breakers and adaptive routing</span></div>
        <div class="grid-2">
          <div><h3>Circuit breakers</h3>${Object.keys(routing.breakers || {}).length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Provider</th><th>State</th><th class="num">Failures</th><th class="num">Calls</th></tr></thead>
            <tbody>${Object.entries(routing.breakers).map(([name, b]) => html`<tr><td>${name}</td><td><span class="badge ${b.state === 'open' ? 'badge-danger' : b.state === 'half-open' ? 'badge-warn' : 'badge-ok'}">${b.state}</span>${b.retry_in_sec ? html` <span class="subtle small">retry in ${b.retry_in_sec}s</span>` : ''}${b.last_error ? html`<div class="small err" style="color:var(--danger)">${b.last_error}</div>` : ''}</td><td class="num">${b.failures}</td><td class="num">${b.calls ?? 0}</td></tr>`)}</tbody></table></div>`
            : html`<p class="subtle">No calls yet.</p>`}</div>
          <div><h3>Per-agent quality</h3><p class="small muted" style="margin-bottom:8px">A provider that keeps producing unusable output for an agent (over 50% of its last 6+ calls) is moved behind the next one for that agent.</p>
            ${(routing.quality || []).length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Agent</th><th>Provider</th><th class="num">Calls</th><th class="num">Failure rate</th><th class="num">Avg</th></tr></thead>
            <tbody>${routing.quality.map((q) => html`<tr><td>${q.agent}</td><td>${q.provider}${q.demoted ? html` <span class="badge badge-warn">demoted</span>` : ''}</td><td class="num">${q.calls}</td><td class="num">${pct(q.failure_rate)}</td><td class="num">${q.avg_latency_ms ? fmtMs(q.avg_latency_ms) : '–'}</td></tr>`)}</tbody></table></div>`
            : html`<p class="subtle">No model calls yet.</p>`}</div>
        </div>
      </section>

      <section class="card" id="evals">
        <div class="card-head"><h2>Evals</h2><button type="button" class="btn btn-secondary" data-action="run-evals">Run evals</button></div>
        <p class="muted" style="margin-bottom:12px">A fixed set of sample answers with known score ranges. Run it after changing models or settings to check the coach still scores sensibly.</p>
        <div id="eval-job"></div>
        ${evals ? html`<div class="grid-4" style="margin-bottom:12px">
            <div class="stat"><span class="label">Pass rate</span><span class="value">${pct(evals.summary.pass_rate)}</span></div>
            <div class="stat"><span class="label">Passed</span><span class="value">${evals.summary.passed}/${evals.summary.cases}</span></div>
            <div class="stat"><span class="label">Mean abs. error</span><span class="value">${Number(evals.summary.mean_abs_error ?? 0).toFixed(2)}</span></div>
            <div class="stat"><span class="label">Run</span><span class="value" style="font-size:1rem">${fmtRel(evals.created_at)}</span></div></div>
          <div class="table-wrap"><table class="table"><thead><tr><th>Case</th><th class="num">Expected</th><th class="num">Got</th><th>Result</th><th>Provider</th></tr></thead>
            <tbody>${(evals.cases || []).map((c) => html`<tr><td>${c.question || c.id}</td><td class="num">${(c.expected || []).join('–')}</td><td class="num">${c.got !== null && c.got !== undefined ? Number(c.got).toFixed(1) : '–'}</td>
              <td>${c.passed ? html`<span class="badge badge-ok">✓ pass</span>` : html`<span class="badge badge-danger">✕ fail</span>`}</td><td>${c.provider || '—'}${c.status === 'degraded' ? html` <span class="badge badge-warn">rules</span>` : ''}</td></tr>`)}</tbody></table></div>`
          : html`<p class="subtle">No eval runs yet.</p>`}
      </section>

      <section class="card">
        <div class="card-head"><h2>Feedback loop</h2><a class="btn btn-secondary btn-sm" href="/api/feedback/export" download>Export feedback (JSONL)</a></div>
        <p class="muted" style="margin-bottom:12px">Your 👍/👎 ratings become short guidance added to the relevant agent's instructions, and can be exported to grow the eval set.</p>
        ${feedback ? html`<div class="grid-4" style="margin-bottom:12px">
            <div class="stat"><span class="label">Ratings</span><span class="value">${feedback.total ?? 0}</span></div>
            <div class="stat"><span class="label">Helpful</span><span class="value">${feedback.positive ?? 0}</span></div>
            <div class="stat"><span class="label">Not helpful</span><span class="value">${feedback.negative ?? 0}</span></div></div>
          ${Object.keys(feedback.reasons || {}).length ? html`<div class="row" style="margin-bottom:12px"><span class="subtle">Reasons:</span>${Object.entries(feedback.reasons).map(([k, v]) => html`<span class="chip">${sentence(k)} · ${v}</span>`)}</div>` : ''}
          ${Object.keys(feedback.guidance || {}).length ? html`<h3>Current guidance per agent</h3><div class="stack-sm">${Object.entries(feedback.guidance).map(([agent, text]) => html`<div><strong>${agent}</strong><p class="pre small muted">${text}</p></div>`)}</div>`
            : html`<p class="subtle">No guidance yet — it appears after a few ratings.</p>`}
          ${(feedback.recent || []).length ? html`<details class="mt-3"><summary>Recent ratings (${feedback.recent.length})</summary><div class="table-wrap mt-2"><table class="table"><thead><tr><th>When</th><th>On</th><th>Rating</th><th>Reason</th></tr></thead>
            <tbody>${feedback.recent.map((f) => html`<tr><td>${fmtRel(f.created_at)}</td><td>${sentence(f.target_type)}</td><td>${f.rating > 0 ? '👍' : '👎'}</td><td>${f.reason ? sentence(f.reason) : '—'}${f.comment ? html` <span class="muted">— ${f.comment}</span>` : ''}</td></tr>`)}</tbody></table></div></details>` : ''}`
          : html`<p class="subtle">No feedback yet.</p>`}
      </section>

      <section class="card">
        <div class="card-head"><h2>Traces</h2>
          <div class="row"><label class="sr-only" for="tr-agent">Agent</label><select id="tr-agent" class="select" style="width:auto"><option value="">All agents</option>${agentList.map((a) => html`<option value="${a.name}">${a.name}</option>`)}</select>
            <label class="sr-only" for="tr-status">Status</label><select id="tr-status" class="select" style="width:auto"><option value="">Any status</option>${Object.keys(TRACE_STATUS).map((s) => html`<option value="${s}">${TRACE_STATUS[s][1]}</option>`)}</select>
            <button type="button" class="btn btn-ghost btn-sm" data-action="traces">Refresh</button></div></div>
        <div id="traces"></div>
      </section>
    `);
    loadTraces();
  }

  async function loadTraces() {
    const box = $('#traces', root);
    if (!box) return;
    const agent = $('#tr-agent', root).value;
    const status = $('#tr-status', root).value;
    mount(box, loading('Loading traces…'));
    try {
      const rows = await api(`/api/traces?limit=100${agent ? `&agent=${enc(agent)}` : ''}${status ? `&status=${enc(status)}` : ''}`, { signal });
      mount(box, rows.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>When</th><th>Agent</th><th>Model</th><th>Status</th><th class="num">Tries</th><th class="num">Time</th><th class="num">Tokens</th><th class="num">Cost</th><th>Errors</th></tr></thead>
        <tbody>${rows.map((t) => { const [cls, label] = TRACE_STATUS[t.status] || ['', t.status];
          return html`<tr><td class="nowrap" title="${fmtDate(t.created_at)}">${fmtRel(t.created_at)}</td><td>${t.agent}${t.prompt_version ? html`<div class="subtle small">${t.prompt_version}</div>` : ''}</td>
            <td>${t.provider === 'heuristic' ? 'built-in rules' : html`${t.model || '—'}<div class="subtle small">${t.provider}</div>`}</td><td><span class="badge ${cls}">${label}</span></td>
            <td class="num">${t.attempts ?? 0}</td><td class="num">${fmtMs(t.latency_ms)}</td><td class="num">${(t.tokens_in || 0) + (t.tokens_out || 0) || '–'}</td><td class="num">${t.cost_usd ? `$${Number(t.cost_usd).toFixed(4)}` : '–'}</td>
            <td class="err small">${t.error || ''}</td></tr>`; })}</tbody></table></div>`
        : emptyState({ title: 'No traces yet', text: 'Agent calls are logged here as you use the app.' }));
    } catch (err) { if (err.name !== 'AbortError') mount(box, errorState(err, { retry: false })); }
  }

  on(root, 'click', '[data-copy]', (e, btn) => copyText(btn.dataset.copy));
  on(root, 'change', '#tr-agent, #tr-status', () => loadTraces());
  on(root, 'click', '[data-action]', async (e, btn) => {
    const a = btn.dataset.action;
    if (a === 'traces') loadTraces();
    else if (a === 'recheck') {
      setBusy(btn, true, 'Checking…');
      invalidateHealth();
      try { data = await loadAll(true); render(); window.dispatchEvent(new Event('app:health-changed')); }
      catch (err) { toastError(err); setBusy(btn, false); }
    } else if (a === 'run-evals') {
      setBusy(btn, true, 'Running…');
      try {
        const res = await api('/api/evals/run', { method: 'POST', body: {} });
        await trackJob($('#eval-job', root), res.job_id, {
          title: 'Running evals', signal,
          onDone: async () => { data.evals = await api('/api/evals/latest', { signal }).catch(() => null); data.agents = await api('/api/agents', { signal }).catch(() => data.agents); render(); $('#evals', root)?.scrollIntoView({ block: 'start' }); },
        });
      } catch (err) { toastError(err); } finally { if (btn.isConnected) setBusy(btn, false); }
    }
  });
  render();
  return undefined;
}
