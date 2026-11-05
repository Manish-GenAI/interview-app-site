// Progress: competency skill model (spaced repetition), session scores over time.
import { api, enc } from '../api.js';
import { html, mount, loading, emptyState, meter, fmtScore, fmtRel, fmtDate, fmtDay, replaceQuery, $ } from '../ui.js';
import { lineChart } from '../chart.js';

export default async function progressView(root, { query, signal }) {
  document.title = 'Progress · Interview App';
  mount(root, loading('Loading progress…'));
  const targets = (await api('/api/targets', { signal })).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  if (!targets.length) {
    mount(root, html`<div class="page-head"><div><h1>Progress</h1></div></div>
      <section class="card">${emptyState({ title: 'Nothing to track yet', text: 'Create a target and run a practice session.', action: html`<a class="btn btn-primary" href="#/prep?new=1">Create a target</a>` })}</section>`);
    return undefined;
  }
  let targetId = query.get('target');
  if (!targets.some((t) => t.id === targetId)) targetId = (targets.find((t) => t.status === 'ready') || targets[0]).id;
  let chartCleanup = null;

  mount(root, html`
    <div class="page-head"><div><h1>Progress</h1><p class="lead">Your skill model per competency. Weak or stale competencies come due again (spaced repetition) and the planner puts them first.</p></div>
      <div class="actions"><label class="sr-only" for="pg-target">Target</label>
        <select id="pg-target" class="select" style="width:auto;min-width:220px">${targets.map((t) => html`<option value="${t.id}" ${t.id === targetId ? 'selected' : ''}>${t.title || 'Untitled target'}${t.company ? ` · ${t.company}` : ''}</option>`)}</select></div></div>
    <div id="pg-body" class="stack"></div>`);

  async function load() {
    const body = $('#pg-body', root);
    if (chartCleanup) { chartCleanup(); chartCleanup = null; }
    mount(body, loading('Loading…'));
    const data = await api(`/api/progress?target_id=${enc(targetId)}`, { signal });
    const comps = [...(data.competencies || [])].sort((a, b) => (Number(b.due) - Number(a.due)) || (a.score - b.score));
    const sessions = [...(data.sessions || [])].filter((s) => s.overall_score !== null && s.overall_score !== undefined)
      .sort((a, b) => String(a.started_at || '').localeCompare(String(b.started_at || '')));
    const totals = data.totals || {};
    if (!comps.length && !sessions.length) {
      mount(body, html`<section class="card">${emptyState({ title: 'No practice yet for this target', text: 'Run a session and your competency scores will appear here.',
        action: html`<a class="btn btn-primary" href="#/practice?target=${enc(targetId)}">Start practising</a>` })}</section>`);
      return;
    }
    mount(body, html`
      <div class="grid-4">
        <div class="card card-tight stat"><span class="label">Sessions</span><span class="value">${totals.sessions ?? sessions.length}</span></div>
        <div class="card card-tight stat"><span class="label">Answers scored</span><span class="value">${totals.answers ?? '–'}</span></div>
        <div class="card card-tight stat"><span class="label">Average score</span><span class="value">${fmtScore(totals.avg_score)}<span class="subtle" style="font-size:0.9rem"> / 5</span></span></div>
        <div class="card card-tight stat"><span class="label">Due for practice</span><span class="value">${data.due_count ?? comps.filter((c) => c.due).length}</span></div>
      </div>
      <section class="card">
        <div class="card-head"><h2>Session score over time</h2><span class="subtle">Overall score per session, 1-5</span></div>
        ${sessions.length ? html`<div id="pg-chart"></div><p class="kbd-hint mt-2">Tip: focus the chart and use ← → to step through sessions. Every value is also in the table below.</p>`
          : html`<p class="muted">Finish a session to see your trend.</p>`}
      </section>
      <section class="card">
        <div class="card-head"><h2>Competencies</h2><a class="btn btn-secondary btn-sm" href="#/practice?target=${enc(targetId)}">Practise what's due</a></div>
        ${comps.length ? html`<div class="list-rows">${comps.map((c) => html`<div class="list-row" style="flex-wrap:wrap">
          <div class="main" style="min-width:180px"><div class="t">${c.competency}</div>
            <div class="item-meta"><span>${c.n} ${c.n === 1 ? 'answer' : 'answers'}</span><span>Last practised ${fmtRel(c.last_practiced)}</span>${c.next_due && !c.due ? html`<span>Next due ${fmtDay(c.next_due)}</span>` : ''}</div></div>
          <div style="flex:1;min-width:140px;max-width:320px">${meter(c.score, 5, { label: `${c.competency} score` })}</div>
          <strong style="width:36px;text-align:right">${fmtScore(c.score)}</strong>
          ${c.due ? html`<span class="badge badge-warn"><span aria-hidden="true">⏰</span> Due</span>` : html`<span class="badge badge-ok"><span aria-hidden="true">✓</span> On track</span>`}
          <a class="btn btn-ghost btn-sm" href="#/practice?target=${enc(targetId)}&focus=${enc(c.competency)}">Practise</a>
        </div>`)}</div>` : html`<p class="muted">No competency scores yet.</p>`}
      </section>
      ${sessions.length ? html`<section class="card"><div class="card-head"><h2>Sessions</h2></div>
        <div class="table-wrap"><table class="table"><caption class="sr-only">Overall score per session</caption>
          <thead><tr><th>Date</th><th class="num">Overall score</th><th><span class="sr-only">Report</span></th></tr></thead>
          <tbody>${[...sessions].reverse().map((s) => html`<tr><td>${fmtDate(s.started_at)}</td><td class="num">${fmtScore(s.overall_score)}</td><td><a href="#/practice/${enc(s.id)}/report">Report</a></td></tr>`)}</tbody>
        </table></div></section>` : ''}
    `);
    const chartEl = $('#pg-chart', body);
    if (chartEl) {
      chartCleanup = lineChart(chartEl, sessions.map((s) => ({ x: s.started_at, y: Number(s.overall_score) })), {
        yMin: 1, yMax: 5, yTicks: [1, 2, 3, 4, 5], valueLabel: 'Session score',
      });
    }
  }

  $('#pg-target', root).addEventListener('change', (e) => {
    targetId = e.target.value;
    replaceQuery({ target: targetId });
    load().catch(() => {});
  });
  await load();
  return () => { if (chartCleanup) chartCleanup(); };
}
