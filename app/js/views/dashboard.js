// Home: health banner, quick actions, recent work, competencies due.
import { api, getHealth, enc, DEMO } from '../api.js';
import { html, mount, loading, statusBadge, fmtRel, fmtScore, fmtClock, emptyState, meter } from '../ui.js';

function byNewest(list, key = 'created_at') {
  return [...(list || [])].sort((a, b) => String(b[key] || '').localeCompare(String(a[key] || '')));
}

function healthBanner(health) {
  if (!health) {
    return html`<div class="banner banner-danger" role="alert"><span class="banner-icon" aria-hidden="true">⚠</span>
      <div><strong>Can't reach the app server.</strong> Make sure the start script is still running, then reload.</div></div>`;
  }
  const parts = [];
  if (DEMO) {
    // The demo banner at the top already explains what the browser-only version can and can't do.
    return parts;
  }
  if (!health.llm_ready) {
    parts.push(html`<div class="banner banner-warn" role="status"><span class="banner-icon" aria-hidden="true">⚠</span>
      <div class="stack-sm"><strong>Running on built-in rules.</strong>
      <span>Install Ollama and pull a model, or add a Claude key, for full quality. Everything still works — feedback is just simpler.</span>
      <span><a href="#/system">See setup steps</a> · <a href="#/settings">Settings</a></span></div></div>`);
  }
  const stt = health.stt || {};
  if (stt.available === false || stt.engine === 'browser') {
    parts.push(html`<div class="banner banner-info"><span class="banner-icon" aria-hidden="true">ℹ</span>
      <div>Local speech-to-text isn't active${stt.detail ? html` (${String(stt.detail).replace(/[.\s]+$/, '')})` : ''}. Practice answers can use your browser's speech recognition or typing; meeting-audio capture needs the local engine. <a href="#/system">Details</a></div></div>`);
  }
  return parts;
}

export default async function dashboard(root, { signal }) {
  document.title = 'Home · Interview App';
  mount(root, loading('Loading your dashboard…'));
  const [health, targets, sessions, meetings] = await Promise.all([
    getHealth().catch(() => null),
    api('/api/targets', { signal }).catch(() => []),
    api('/api/sessions', { signal }).catch(() => []),
    api('/api/meetings?limit=6', { signal }).catch(() => []),
  ]);
  const ready = byNewest(targets).filter((t) => t.status === 'ready');
  let progress = null;
  const focusTarget = ready[0] || null;
  if (focusTarget) {
    progress = await api(`/api/progress?target_id=${enc(focusTarget.id)}`, { signal }).catch(() => null);
  }
  const due = (progress && progress.competencies ? progress.competencies : []).filter((c) => c.due).sort((a, b) => a.score - b.score).slice(0, 5);
  const recentSessions = byNewest(sessions, 'started_at').slice(0, 5);
  const recentTargets = byNewest(targets).slice(0, 4);
  const recentMeetings = byNewest(meetings, 'started_at').slice(0, 5);

  mount(root, html`
    <div class="page-head"><div><h1>Welcome back</h1>
      <p class="lead">Practice for a specific job, track what's improving, and keep clear notes from your meetings — all on your own PC.</p></div></div>
    ${healthBanner(health)}
    <div class="grid-3">
      <a class="card card-link quick" href="#/prep?new=1"><span class="q-icon" aria-hidden="true">＋</span><h2>New target</h2>
        <p class="muted">Add your resume and a job description. The agents build a question bank, story bank and fit analysis.</p></a>
      <a class="card card-link quick" href="#/practice"><span class="q-icon" aria-hidden="true">🎙</span><h2>Practice</h2>
        <p class="muted">Run a mock interview. Answer out loud or type, get live coaching hints and a scored debrief.</p></a>
      <a class="card card-link quick" href="#/meetings/new"><span class="q-icon" aria-hidden="true">📝</span><h2>New meeting notes</h2>
        <p class="muted">Transcribe a meeting (with everyone's knowledge) and get clean notes, decisions and action items.</p></a>
    </div>

    ${focusTarget ? html`<section class="card">
      <div class="card-head"><h2>Due for practice</h2><span class="subtle">${focusTarget.title || 'Untitled target'}${focusTarget.company ? ` · ${focusTarget.company}` : ''}</span></div>
      ${due.length ? html`<div class="stack-sm">${due.map((c) => html`<div class="score-row"><span class="lbl">${c.competency}</span>${meter(c.score, 5, { label: c.competency })}<span class="val">${fmtScore(c.score)}</span></div>`)}
        <div class="mt-2"><a class="btn btn-primary" href="#/practice?target=${enc(focusTarget.id)}&focus=${enc(due[0].competency)}">Practice ${due[0].competency}</a></div></div>`
        : html`<p class="muted">Nothing is due right now. ${progress && progress.totals && progress.totals.sessions ? 'Nice work — keep the streak going with a short session.' : 'Run your first session to start tracking competencies.'}</p>
          <div class="mt-3"><a class="btn btn-secondary" href="#/practice?target=${enc(focusTarget.id)}">Start a session</a></div>`}
    </section>` : ''}

    <div class="grid-2">
      <section class="card">
        <div class="card-head"><h2>Targets</h2><a href="#/prep">All targets</a></div>
        ${recentTargets.length ? html`<div class="list-rows">${recentTargets.map((t) => html`<a class="list-row" href="#/prep/${enc(t.id)}">
          <div class="main"><div class="t">${t.title || 'Untitled target'}</div><div class="item-meta">${t.company || ''}<span>${t.question_count ?? 0} questions</span><span>${fmtRel(t.created_at)}</span></div></div>
          ${t.match_score !== null && t.match_score !== undefined ? html`<span class="badge">Fit ${Math.round(t.match_score)}</span>` : ''}${statusBadge(t.status)}</a>`)}</div>`
          : emptyState({ title: 'No targets yet', text: 'A target is one job you are preparing for.', action: html`<a class="btn btn-primary" href="#/prep?new=1">Create a target</a>` })}
      </section>
      <section class="card">
        <div class="card-head"><h2>Recent practice</h2><a href="#/practice">Practice</a></div>
        ${recentSessions.length ? html`<div class="list-rows">${recentSessions.map((s) => html`<a class="list-row" href="#/practice/${enc(s.id)}${s.status === 'done' ? '/report' : ''}">
          <div class="main"><div class="t">${s.target_title || 'Practice session'}</div><div class="item-meta"><span>${s.mode || 'mixed'}</span><span>${s.answered ?? 0} answered</span><span>${fmtRel(s.started_at)}</span></div></div>
          ${s.overall_score ? html`<span class="badge">${fmtScore(s.overall_score)} / 5</span>` : ''}${statusBadge(s.status)}</a>`)}</div>`
          : emptyState({ title: 'No sessions yet', text: 'Your mock interviews will show up here.' })}
      </section>
    </div>
    <section class="card">
      <div class="card-head"><h2>Recent meetings</h2><a href="#/meetings">All meetings</a></div>
      ${recentMeetings.length ? html`<div class="list-rows">${recentMeetings.map((m) => html`<a class="list-row" href="#/meetings/${enc(m.id)}">
        <div class="main"><div class="t">${m.title}</div><div class="item-meta"><span>${fmtRel(m.started_at)}</span>${m.duration_sec ? html`<span>${fmtClock(m.duration_sec)}</span>` : ''}<span>${m.segment_count ?? 0} lines</span></div></div>
        ${statusBadge(m.status)}</a>`)}</div>`
        : emptyState({ title: 'No meetings yet', text: 'Start a meeting to get a live transcript and enhanced notes.', action: html`<a class="btn btn-secondary" href="#/meetings/new">New meeting</a>` })}
    </section>
  `);
}
