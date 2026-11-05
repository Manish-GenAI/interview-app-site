// Prep: targets (resume + job description), fit analysis, question bank, story bank.
import { api, enc } from '../api.js';
import {
  html, mount, loading, emptyState, errorState, statusBadge, metaBadge, chips, bullets, meter, difficultyDots,
  fmtRel, fmtDate, fmtScore, toast, toastError, confirmDialog, openModal, trackJob, tabsHTML, bindTabKeys,
  replaceQuery, setBusy, sentence, $, $$, on,
} from '../ui.js';
import { navigate } from '../nav.js';

const CATEGORIES = ['behavioral', 'technical', 'role', 'situational', 'motivation', 'system_design', 'culture'];

async function uploadText(file) {
  const fd = new FormData();
  fd.append('file', file);
  return api('/api/extract-text', { method: 'POST', form: fd });
}

// =================================================================================================
// Target list + create
// =================================================================================================
export async function prepList(root, { query, signal }) {
  document.title = 'Prep · Interview App';
  mount(root, loading('Loading targets…'));
  const targets = await api('/api/targets', { signal });
  targets.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const showForm = query.get('new') === '1' || targets.length === 0;

  mount(root, html`
    <div class="page-head">
      <div><h1>Prep</h1><p class="lead">A target is one job you're preparing for. Give the agents your resume and the job description; they analyse fit, draft STAR stories and plan likely questions.</p></div>
      <div class="actions"><button type="button" class="btn btn-primary" data-action="toggle-form" aria-expanded="${showForm ? 'true' : 'false'}" aria-controls="new-target">＋ New target</button></div>
    </div>
    <section class="card ${showForm ? '' : 'hidden'}" id="new-target">
      <div class="card-head"><h2>New target</h2></div>
      <form class="stack" id="target-form" novalidate>
        <div class="form-grid">
          <div class="field"><label for="t-title">Job title <span class="subtle">(optional)</span></label><input id="t-title" class="input" name="title" placeholder="e.g. Senior Backend Engineer" autocomplete="off"></div>
          <div class="field"><label for="t-company">Company <span class="subtle">(optional)</span></label><input id="t-company" class="input" name="company" placeholder="e.g. Acme" autocomplete="off"></div>
        </div>
        <div class="grid-2">
          <div class="field">
            <div class="row-between"><label for="t-resume">Your resume</label>
              <span class="btn btn-secondary btn-sm file-btn">Upload file<input type="file" accept=".pdf,.docx,.txt,.md" data-upload="t-resume" aria-label="Upload resume file"></span></div>
            <textarea id="t-resume" class="textarea tall" name="resume_text" placeholder="Paste your resume here, or upload a PDF, DOCX, TXT or MD file." required></textarea>
            <span class="hint" data-count="t-resume">0 characters</span>
          </div>
          <div class="field">
            <div class="row-between"><label for="t-jd">Job description</label>
              <span class="btn btn-secondary btn-sm file-btn">Upload file<input type="file" accept=".pdf,.docx,.txt,.md" data-upload="t-jd" aria-label="Upload job description file"></span></div>
            <textarea id="t-jd" class="textarea tall" name="jd_text" placeholder="Paste the full job description here." required></textarea>
            <span class="hint" data-count="t-jd">0 characters</span>
          </div>
        </div>
        <p class="subtle">Everything stays on this computer. Agents run on your local models (or Claude, if you added a key).</p>
        <div class="row"><button type="submit" class="btn btn-primary btn-lg">Analyse and build my prep</button>
          ${targets.length ? html`<button type="button" class="btn btn-ghost" data-action="toggle-form">Cancel</button>` : ''}</div>
      </form>
    </section>
    <section>
      ${targets.length ? html`<div class="grid-3">${targets.map((t) => html`
        <a class="card card-link item-card" href="#/prep/${enc(t.id)}">
          <div class="row-between"><span class="title">${t.title || 'Untitled target'}</span>${statusBadge(t.status)}</div>
          ${t.company ? html`<span class="muted">${t.company}</span>` : ''}
          ${t.match_score !== null && t.match_score !== undefined ? html`<div class="stack-sm"><div class="row-between small"><span class="muted">Fit</span><strong>${Math.round(t.match_score)}/100</strong></div>${meter(t.match_score, 100, { label: 'Fit score' })}</div>` : ''}
          <div class="item-meta"><span>${t.question_count ?? 0} questions</span><span>${t.story_count ?? 0} stories</span><span>${t.session_count ?? 0} sessions</span><span>${fmtRel(t.created_at)}</span></div>
        </a>`)}</div>`
        : emptyState({ title: 'No targets yet', text: 'Fill in the form above to create your first one.' })}
    </section>
  `);

  const formCard = $('#new-target', root);
  on(root, 'click', '[data-action="toggle-form"]', () => {
    const hidden = formCard.classList.toggle('hidden');
    $$('[data-action="toggle-form"][aria-expanded]', root).forEach((b) => b.setAttribute('aria-expanded', hidden ? 'false' : 'true'));
    if (!hidden) $('#t-title', root).focus();
  });
  const updateCount = (id) => {
    const ta = $(`#${id}`, root);
    const counter = $(`[data-count="${id}"]`, root);
    if (ta && counter) counter.textContent = `${ta.value.length.toLocaleString()} characters`;
  };
  ['t-resume', 't-jd'].forEach((id) => $(`#${id}`, root).addEventListener('input', () => updateCount(id)));
  $$('input[type=file][data-upload]', root).forEach((input) => {
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const targetId = input.dataset.upload;
      const holder = input.parentElement;
      holder.classList.add('disabled');
      try {
        const res = await uploadText(file);
        $(`#${targetId}`, root).value = res.text || '';
        updateCount(targetId);
        toast(`Loaded ${res.filename || file.name} (${(res.chars || 0).toLocaleString()} characters)`, 'success', { timeout: 3000 });
      } catch (err) {
        toastError(err);
      } finally {
        holder.classList.remove('disabled');
        input.value = '';
      }
    });
  });
  $('#target-form', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const resume = form.resume_text.value.trim();
    const jd = form.jd_text.value.trim();
    if (resume.length < 40) { toast('Please add your resume (at least a few lines).', 'error'); form.resume_text.focus(); return; }
    if (jd.length < 40) { toast('Please add the job description (at least a few lines).', 'error'); form.jd_text.focus(); return; }
    const btn = form.querySelector('button[type=submit]');
    setBusy(btn, true, 'Creating…');
    try {
      const body = { resume_text: resume, jd_text: jd };
      if (form.title.value.trim()) body.title = form.title.value.trim();
      if (form.company.value.trim()) body.company = form.company.value.trim();
      const res = await api('/api/targets', { method: 'POST', body });
      navigate(`#/prep/${enc(res.target.id)}`);
    } catch (err) {
      toastError(err);
      setBusy(btn, false);
    }
  });
}

// =================================================================================================
// Target detail
// =================================================================================================
export async function prepDetail(root, { params, query, signal }) {
  const id = params.id;
  let tab = query.get('tab') || 'overview';
  if (!['overview', 'questions', 'stories', 'sessions'].includes(tab)) tab = 'overview';
  const state = { target: null, questions: null, stories: null, sessions: null };

  async function loadTarget() {
    state.target = await api(`/api/targets/${enc(id)}`, { signal });
    return state.target;
  }

  mount(root, loading('Loading target…'));
  try {
    await loadTarget();
  } catch (err) {
    if (err.status === 404) {
      mount(root, emptyState({ title: 'Target not found', text: 'It may have been deleted.', action: html`<a class="btn btn-primary" href="#/prep">Back to Prep</a>` }));
      return undefined;
    }
    throw err;
  }

  function renderShell() {
    const t = state.target;
    document.title = `${t.title || 'Target'} · Prep · Interview App`;
    const preparing = t.status === 'preparing' || t.status === 'new';
    mount(root, html`
      <div class="page-head">
        <div><a class="crumb" href="#/prep">← Prep</a>
          <h1>${t.title || (t.job && t.job.title) || 'Untitled target'}</h1>
          <div class="item-meta mt-2">${t.company || (t.job && t.job.company) ? html`<span>${t.company || t.job.company}</span>` : ''}${statusBadge(t.status)}<span>Created ${fmtRel(t.created_at)}</span></div>
        </div>
        <div class="actions">
          <a class="btn btn-primary ${t.status !== 'ready' ? 'disabled' : ''}" href="#/practice?target=${enc(t.id)}" ${t.status !== 'ready' ? html`aria-disabled="true"` : ''}>Practice now</a>
          <button type="button" class="btn btn-secondary" data-action="reprep" ${preparing ? 'disabled' : ''}>Re-run prep</button>
          <button type="button" class="btn btn-ghost" data-action="delete" aria-label="Delete target">Delete</button>
        </div>
      </div>
      <div id="job-area"></div>
      ${tabsHTML([
        { key: 'overview', label: 'Overview' },
        { key: 'questions', label: 'Questions', count: t.question_count ?? (state.questions ? state.questions.length : null) },
        { key: 'stories', label: 'Stories', count: t.story_count ?? (state.stories ? state.stories.length : null) },
        { key: 'sessions', label: 'Sessions' },
      ], tab, { label: 'Target sections' })}
      <div id="panel" role="tabpanel" tabindex="0" aria-labelledby="tab-${tab}"></div>
    `);
    const tablist = $('.tabs', root);
    tablist.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (b) selectTab(b.dataset.tab);
    });
    bindTabKeys(tablist, selectTab);
    $('[data-action="reprep"]', root).addEventListener('click', rerunPrep);
    $('[data-action="delete"]', root).addEventListener('click', deleteTarget);
    if (preparing && t.job_id) watchJob(t.job_id);
    else if (t.status === 'failed') {
      mount($('#job-area', root), html`<div class="banner banner-danger" role="alert"><span class="banner-icon" aria-hidden="true">⚠</span>
        <div class="stack-sm"><strong>Prep didn't finish.</strong><span>Try running it again. If it keeps failing, check System for model status.</span>
        <div><button type="button" class="btn btn-secondary btn-sm" data-action="reprep2">Run prep again</button></div></div></div>`);
      $('[data-action="reprep2"]', root).addEventListener('click', rerunPrep);
    }
    renderPanel();
  }

  function selectTab(key) {
    tab = key;
    $$('.tabs [role="tab"]', root).forEach((b) => {
      const sel = b.dataset.tab === key;
      b.setAttribute('aria-selected', sel ? 'true' : 'false');
      b.tabIndex = sel ? 0 : -1;
    });
    $('#panel', root).setAttribute('aria-labelledby', `tab-${key}`);
    replaceQuery({ tab: key === 'overview' ? null : key });
    renderPanel();
  }

  async function watchJob(jobId) {
    const area = $('#job-area', root);
    await trackJob(area, jobId, {
      title: 'Building your prep',
      subtitle: 'Each agent hands its output to the next. You can leave this page — it keeps running.',
      signal,
      onDone: async () => {
        toast('Prep is ready.', 'success', { timeout: 3000 });
        state.questions = null; state.stories = null;
        await loadTarget();
        renderShell();
      },
      onFailed: async () => { await loadTarget().catch(() => {}); },
    });
  }

  async function rerunPrep() {
    const ok = await confirmDialog({ title: 'Re-run prep?', message: 'The agents will re-analyse your resume and the job description and regenerate the fit analysis, stories and questions. Questions you added yourself are kept.', confirmLabel: 'Re-run' });
    if (!ok) return;
    try {
      const res = await api(`/api/targets/${enc(id)}/prepare`, { method: 'POST', body: {} });
      state.target.status = 'preparing';
      state.target.job_id = res.job_id;
      renderShell();
    } catch (err) { toastError(err); }
  }

  async function deleteTarget() {
    const ok = await confirmDialog({ title: 'Delete this target?', message: 'This deletes its questions, stories, practice sessions and progress. This cannot be undone.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await api(`/api/targets/${enc(id)}`, { method: 'DELETE' });
      toast('Target deleted.', 'success', { timeout: 2500 });
      navigate('#/prep');
    } catch (err) { toastError(err); }
  }

  async function renderPanel() {
    const old = $('#panel', root);
    if (!old) return;
    // Fresh element each time so delegated listeners from the previous tab don't pile up.
    const panel = old.cloneNode(false);
    old.replaceWith(panel);
    try {
      if (tab === 'overview') renderOverview(panel);
      else if (tab === 'questions') await renderQuestions(panel);
      else if (tab === 'stories') await renderStories(panel);
      else if (tab === 'sessions') await renderSessions(panel);
    } catch (err) {
      if (err.name === 'AbortError') return;
      mount(panel, errorState(err));
      $('[data-action="retry"]', panel)?.addEventListener('click', () => renderPanel());
    }
  }

  // --- overview ---------------------------------------------------------------------------------
  function renderOverview(panel) {
    const t = state.target;
    const meta = t.meta || {};
    const fit = t.fit;
    const job = t.job;
    const prof = t.profile;
    if (!fit && !job && !prof) {
      mount(panel, emptyState({ title: t.status === 'failed' ? 'No analysis yet' : 'Analysis in progress', text: 'The fit analysis, job breakdown and profile will appear here when the agents finish.' }));
      return;
    }
    mount(panel, html`<div class="stack">
      ${fit ? html`<section class="card">
        <div class="card-head"><h2>Fit</h2>${metaBadge(meta.fit)}</div>
        <div class="row" style="gap:24px;align-items:center">
          <div class="hero-num">${Math.round(fit.match_score ?? 0)}<small>/100</small></div>
          <div style="flex:1;min-width:180px">${meter(fit.match_score ?? 0, 100, { label: 'Fit score', lg: true })}</div>
        </div>
        ${fit.summary ? html`<p class="mt-3">${fit.summary}</p>` : ''}
        <div class="grid-2 mt-4">
          <div><h3>Strengths</h3>${(fit.strengths || []).length ? html`<ul class="list-check list">${fit.strengths.map((s) => html`<li><strong>${s.skill}</strong>${s.evidence ? html` — <span class="muted">${s.evidence}</span>` : ''}</li>`)}</ul>` : html`<p class="subtle">—</p>`}</div>
          <div><h3>Gaps to prepare for</h3>${(fit.gaps || []).length ? html`<ul class="list-arrow list">${fit.gaps.map((g) => html`<li><strong>${g.skill}</strong>${g.mitigation ? html` — <span class="muted">${g.mitigation}</span>` : ''}</li>`)}</ul>` : html`<p class="subtle">No major gaps found.</p>`}</div>
        </div>
        ${(fit.talking_points || []).length ? html`<h3 class="mt-4">Talking points</h3>${bullets(fit.talking_points)}` : ''}
      </section>` : ''}
      <div class="grid-2">
        ${job ? html`<section class="card">
          <div class="card-head"><h2>The role</h2>${metaBadge(meta.job)}</div>
          <dl class="kv"><dt>Title</dt><dd>${job.title || '—'}</dd><dt>Seniority</dt><dd>${sentence(job.seniority || 'unknown')}</dd>${job.company ? html`<dt>Company</dt><dd>${job.company}</dd>` : ''}</dl>
          <h3 class="mt-4">Must-have skills</h3>${chips(job.must_have_skills)}
          <h3 class="mt-4">Nice to have</h3>${chips(job.nice_to_have_skills)}
          <h3 class="mt-4">Competencies they'll assess</h3>
          ${(job.competencies || []).length ? html`<ul class="list-plain">${job.competencies.map((c) => html`<li><div class="row"><strong>${c.name}</strong><span class="dots" role="img" aria-label="Weight ${c.weight} of 5">${[1, 2, 3, 4, 5].map((i) => html`<i class="${i <= c.weight ? 'on' : ''}"></i>`)}</span></div>${c.why ? html`<div class="small muted">${c.why}</div>` : ''}</li>`)}</ul>` : html`<p class="subtle">—</p>`}
          ${(job.interview_focus || []).length ? html`<h3 class="mt-4">Likely interview focus</h3>${bullets(job.interview_focus)}` : ''}
          ${(job.responsibilities || []).length ? html`<details class="mt-4"><summary>Responsibilities (${job.responsibilities.length})</summary><div class="mt-2">${bullets(job.responsibilities)}</div></details>` : ''}
          ${(job.keywords || []).length ? html`<h3 class="mt-4">Keywords</h3>${chips(job.keywords)}` : ''}
        </section>` : ''}
        ${prof ? html`<section class="card">
          <div class="card-head"><h2>Your profile</h2>${metaBadge(meta.profile)}</div>
          <dl class="kv">${prof.name ? html`<dt>Name</dt><dd>${prof.name}</dd>` : ''}${prof.headline ? html`<dt>Headline</dt><dd>${prof.headline}</dd>` : ''}<dt>Experience</dt><dd>${prof.years_experience ? `${fmtScore(prof.years_experience, prof.years_experience % 1 ? 1 : 0)} years` : '—'}</dd></dl>
          <h3 class="mt-4">Skills</h3>${chips(prof.skills)}
          ${(prof.roles || []).length ? html`<h3 class="mt-4">Experience</h3><ul class="list-plain">${prof.roles.map((r) => html`<li><strong>${r.title}</strong>${r.company ? html` · ${r.company}` : ''}${r.period ? html` <span class="subtle">(${r.period})</span>` : ''}${(r.highlights || []).length ? html`<ul class="list small mt-2">${r.highlights.map((h) => html`<li>${h}</li>`)}</ul>` : ''}</li>`)}</ul>` : ''}
          ${(prof.achievements || []).length ? html`<h3 class="mt-4">Achievements</h3>${bullets(prof.achievements)}` : ''}
          ${(prof.projects || []).length ? html`<h3 class="mt-4">Projects</h3>${bullets(prof.projects)}` : ''}
          ${(prof.education || []).length ? html`<h3 class="mt-4">Education</h3>${bullets(prof.education)}` : ''}
        </section>` : ''}
      </div>
      <details class="card card-tight"><summary><strong>Source documents</strong> <span class="subtle">(what the agents read)</span></summary>
        <div class="grid-2 mt-3"><div><h3>Resume</h3><div class="answer-box pre">${t.resume_text}</div></div><div><h3>Job description</h3><div class="answer-box pre">${t.jd_text}</div></div></div>
      </details>
    </div>`);
  }

  // --- questions -----------------------------------------------------------------------------------
  async function renderQuestions(panel) {
    if (!state.questions) {
      mount(panel, loading('Loading questions…'));
      state.questions = await api(`/api/targets/${enc(id)}/questions`, { signal });
    }
    const qs = state.questions;
    const competencies = Array.from(new Set([
      ...((state.target.job && state.target.job.competencies) || []).map((c) => c.name),
      ...qs.map((q) => q.competency).filter(Boolean),
    ]));
    const cats = Array.from(new Set(qs.map((q) => q.category).filter(Boolean)));
    mount(panel, html`<div class="stack">
      <div class="row-between">
        <div class="row">
          <label class="sr-only" for="qf-cat">Category</label>
          <select id="qf-cat" class="select" style="width:auto"><option value="">All categories</option>${cats.map((c) => html`<option value="${c}">${sentence(c)}</option>`)}</select>
          <label class="sr-only" for="qf-comp">Competency</label>
          <select id="qf-comp" class="select" style="width:auto"><option value="">All competencies</option>${competencies.map((c) => html`<option value="${c}">${c}</option>`)}</select>
          <label class="sr-only" for="qf-text">Search questions</label>
          <input id="qf-text" class="input" type="search" placeholder="Filter…" style="width:auto;min-width:160px">
        </div>
        <button type="button" class="btn btn-primary" data-action="add-q" aria-expanded="false" aria-controls="q-form">＋ Add question</button>
      </div>
      <form class="card card-tight stack hidden" id="q-form">
        <h3>Add your own question</h3>
        <div class="field"><label for="q-text">Question</label><textarea id="q-text" class="textarea" style="min-height:80px" required placeholder="e.g. Tell me about a time you disagreed with your manager."></textarea></div>
        <div class="form-grid">
          <div class="field"><label for="q-cat">Category</label><select id="q-cat" class="select">${CATEGORIES.map((c) => html`<option value="${c}">${sentence(c)}</option>`)}</select></div>
          <div class="field"><label for="q-comp">Competency</label><input id="q-comp" class="input" list="q-comp-list" placeholder="e.g. Ownership"><datalist id="q-comp-list">${competencies.map((c) => html`<option value="${c}"></option>`)}</datalist></div>
          <div class="field"><label for="q-diff">Difficulty</label><select id="q-diff" class="select"><option value="1">1 — warm-up</option><option value="2" selected>2 — standard</option><option value="3">3 — hard</option></select></div>
        </div>
        <div class="row"><button type="submit" class="btn btn-primary">Add question</button><button type="button" class="btn btn-ghost" data-action="add-q">Cancel</button></div>
      </form>
      <p class="subtle" id="q-count"></p>
      <div class="stack-sm" id="q-list"></div>
    </div>`);

    const listEl = $('#q-list', panel);
    const countEl = $('#q-count', panel);
    function renderList() {
      const cat = $('#qf-cat', panel).value;
      const comp = $('#qf-comp', panel).value;
      const text = $('#qf-text', panel).value.trim().toLowerCase();
      const shown = qs.filter((q) => (!cat || q.category === cat) && (!comp || q.competency === comp) && (!text || q.text.toLowerCase().includes(text)));
      countEl.textContent = `${shown.length} of ${qs.length} questions`;
      if (!shown.length) {
        mount(listEl, emptyState({ title: qs.length ? 'No questions match' : 'No questions yet', text: qs.length ? 'Try a different filter.' : 'Questions appear when prep finishes, or add your own.' }));
        return;
      }
      mount(listEl, html`${shown.map((q) => html`<details class="q-item" data-qid="${q.id}">
        <summary><span class="q-text">${q.text}</span>
          <span class="item-meta"><span class="badge">${sentence(q.category)}</span>${q.competency ? html`<span>${q.competency}</span>` : ''}${difficultyDots(q.difficulty)}
          ${q.source && q.source !== 'generated' ? html`<span class="badge badge-accent">${q.source === 'debrief' ? 'From a debrief' : 'Added by you'}</span>` : ''}
          ${q.times_asked ? html`<span>Asked ${q.times_asked}×</span>` : ''}${q.last_score ? html`<span>Last ${fmtScore(q.last_score)}/5</span>` : ''}</span></summary>
        <div class="q-body">
          ${q.why_asked ? html`<div><div class="section-title">Why they ask it</div><p>${q.why_asked}</p></div>` : ''}
          ${(q.good_answer_signals || []).length ? html`<div><div class="section-title">What a good answer shows</div>${bullets(q.good_answer_signals, { cls: 'list list-check' })}</div>` : ''}
          <div class="row-between"><span class="subtle">${q.last_asked_at ? `Last practised ${fmtRel(q.last_asked_at)}` : 'Not practised yet'}</span>
            <button type="button" class="btn btn-ghost btn-sm" data-action="del-q" data-id="${q.id}">Delete</button></div>
        </div></details>`)}`);
    }
    renderList();
    ['#qf-cat', '#qf-comp'].forEach((s) => $(s, panel).addEventListener('change', renderList));
    $('#qf-text', panel).addEventListener('input', renderList);
    const form = $('#q-form', panel);
    on(panel, 'click', '[data-action="add-q"]', () => {
      const hidden = form.classList.toggle('hidden');
      $('[data-action="add-q"][aria-expanded]', panel).setAttribute('aria-expanded', hidden ? 'false' : 'true');
      if (!hidden) $('#q-text', panel).focus();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = $('#q-text', panel).value.trim();
      if (text.length < 8) { toast('Please write the full question.', 'error'); return; }
      const btn = form.querySelector('button[type=submit]');
      setBusy(btn, true, 'Adding…');
      try {
        const body = { text, category: $('#q-cat', panel).value, difficulty: Number($('#q-diff', panel).value) };
        const comp = $('#q-comp', panel).value.trim();
        if (comp) body.competency = comp;
        const q = await api(`/api/targets/${enc(id)}/questions`, { method: 'POST', body });
        qs.unshift(q);
        state.target.question_count = qs.length;
        toast('Question added.', 'success', { timeout: 2000 });
        form.reset();
        form.classList.add('hidden');
        renderList();
        updateCounts();
      } catch (err) { toastError(err); } finally { setBusy(btn, false); }
    });
    on(panel, 'click', '[data-action="del-q"]', async (e, btn) => {
      const ok = await confirmDialog({ title: 'Delete question?', message: 'It will be removed from this target\'s practice bank.', confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      try {
        await api(`/api/questions/${enc(btn.dataset.id)}`, { method: 'DELETE' });
        const i = qs.findIndex((q) => q.id === btn.dataset.id);
        if (i >= 0) qs.splice(i, 1);
        state.target.question_count = qs.length;
        renderList();
        updateCounts();
      } catch (err) { toastError(err); }
    });
  }

  function updateCounts() {
    const qTab = $('#tab-questions .count', root);
    if (qTab && state.questions) qTab.textContent = String(state.questions.length);
    const sTab = $('#tab-stories .count', root);
    if (sTab && state.stories) sTab.textContent = String(state.stories.length);
  }

  // --- stories ---------------------------------------------------------------------------------------
  async function renderStories(panel) {
    if (!state.stories) {
      mount(panel, loading('Loading stories…'));
      state.stories = await api(`/api/targets/${enc(id)}/stories`, { signal });
    }
    const stories = state.stories;
    mount(panel, html`<div class="stack">
      <div class="row-between"><p class="muted">Your STAR stories — the agents drafted these from your resume. Edit them in your own words; practice hints point you to them.</p>
        <button type="button" class="btn btn-primary" data-action="new-story">＋ Add story</button></div>
      ${stories.length ? html`<div class="stack">${stories.map((s) => html`<article class="card card-tight stack-sm">
        <div class="row-between"><h3 style="margin:0">${s.title}</h3>
          <div class="row">${s.source === 'user' ? html`<span class="badge badge-accent">Edited by you</span>` : html`<span class="badge">Draft</span>`}
          <button type="button" class="btn btn-secondary btn-sm" data-action="edit-story" data-id="${s.id}">Edit</button>
          <button type="button" class="btn btn-ghost btn-sm" data-action="del-story" data-id="${s.id}">Delete</button></div></div>
        <div class="star-grid">
          <div><div class="lbl">Situation</div><p>${s.situation || '—'}</p></div>
          <div><div class="lbl">Task</div><p>${s.task || '—'}</p></div>
          <div><div class="lbl">Action</div><p>${s.action || '—'}</p></div>
          <div><div class="lbl">Result</div><p>${s.result || '—'}</p></div>
        </div>
        <div class="row">${(s.competencies || []).length ? chips(s.competencies) : ''}${(s.metrics || []).length ? html`<span class="subtle">Metrics:</span>${chips(s.metrics)}` : ''}</div>
      </article>`)}</div>`
        : emptyState({ title: 'No stories yet', text: 'Stories appear when prep finishes, or add your own.' })}
    </div>`);

    on(panel, 'click', '[data-action="new-story"]', () => storyEditor(null));
    on(panel, 'click', '[data-action="edit-story"]', (e, btn) => storyEditor(stories.find((s) => s.id === btn.dataset.id)));
    on(panel, 'click', '[data-action="del-story"]', async (e, btn) => {
      const ok = await confirmDialog({ title: 'Delete story?', message: 'This removes it from your story bank.', confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      try {
        await api(`/api/stories/${enc(btn.dataset.id)}`, { method: 'DELETE' });
        state.stories = stories.filter((s) => s.id !== btn.dataset.id);
        state.target.story_count = state.stories.length;
        updateCounts();
        renderPanel();
      } catch (err) { toastError(err); }
    });
  }

  function storyEditor(story) {
    const s = story || { title: '', situation: '', task: '', action: '', result: '', competencies: [], metrics: [] };
    const field = (key, label, hint) => html`<div class="field"><label for="st-${key}">${label}</label>${hint ? html`<span class="hint">${hint}</span>` : ''}
      <textarea id="st-${key}" class="textarea" style="min-height:76px">${s[key] || ''}</textarea></div>`;
    openModal({
      title: story ? 'Edit story' : 'New story',
      wide: true,
      body: html`<div class="field"><label for="st-title">Title</label><input id="st-title" class="input" value="${s.title || ''}" placeholder="e.g. Cut checkout latency by 40%"></div>
        ${field('situation', 'Situation', 'The context, in one or two sentences.')}
        ${field('task', 'Task', 'What you were responsible for.')}
        ${field('action', 'Action', 'What you did — use "I", be specific.')}
        ${field('result', 'Result', 'The outcome, ideally with a number, and what you learned.')}
        <div class="form-grid">
          <div class="field"><label for="st-comp">Competencies</label><input id="st-comp" class="input" value="${(s.competencies || []).join(', ')}" placeholder="Comma-separated"></div>
          <div class="field"><label for="st-metrics">Metrics</label><input id="st-metrics" class="input" value="${(s.metrics || []).join(', ')}" placeholder="e.g. 40% faster, $1.2M saved"></div>
        </div>`,
      actions: [
        { label: 'Cancel', kind: 'btn-ghost' },
        { label: story ? 'Save changes' : 'Add story', kind: 'btn-primary', onClick: async (dlg) => {
          const val = (k) => dlg.querySelector(`#st-${k}`).value.trim();
          const list = (k) => val(k).split(',').map((x) => x.trim()).filter(Boolean);
          const body = { title: val('title'), situation: val('situation'), task: val('task'), action: val('action'), result: val('result'), competencies: list('comp'), metrics: list('metrics') };
          if (!body.title) { toast('Give the story a title.', 'error'); return false; }
          const saved = story
            ? await api(`/api/stories/${enc(story.id)}`, { method: 'PUT', body })
            : await api(`/api/targets/${enc(id)}/stories`, { method: 'POST', body });
          if (story) state.stories = state.stories.map((x) => (x.id === story.id ? saved : x));
          else state.stories = [saved, ...state.stories];
          state.target.story_count = state.stories.length;
          updateCounts();
          toast(story ? 'Story saved.' : 'Story added.', 'success', { timeout: 2000 });
          if (tab === 'stories') renderPanel();
          return true;
        } },
      ],
    });
  }

  // --- sessions ------------------------------------------------------------------------------------
  async function renderSessions(panel) {
    if (!state.sessions) {
      mount(panel, loading('Loading sessions…'));
      state.sessions = await api(`/api/sessions?target_id=${enc(id)}`, { signal });
    }
    const list = [...state.sessions].sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')));
    mount(panel, html`<div class="stack">
      <div class="row-between"><p class="muted">Every mock interview for this target.</p>
        <a class="btn btn-primary" href="#/practice?target=${enc(id)}">Start a practice session</a></div>
      ${list.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Started</th><th>Mode</th><th>Status</th><th class="num">Answered</th><th class="num">Score</th><th><span class="sr-only">Open</span></th></tr></thead>
        <tbody>${list.map((s) => html`<tr><td>${fmtDate(s.started_at)}</td><td>${sentence(s.mode || 'mixed')}</td><td>${statusBadge(s.status)}</td>
          <td class="num">${s.answered ?? 0}</td><td class="num">${s.overall_score ? fmtScore(s.overall_score) : '–'}</td>
          <td><a href="#/practice/${enc(s.id)}${s.status === 'done' ? '/report' : ''}">${s.status === 'done' ? 'Report' : 'Open'}</a></td></tr>`)}</tbody>
      </table></div>` : emptyState({ title: 'No sessions yet', text: 'Run a mock interview to start tracking your progress.' })}
    </div>`);
  }

  renderShell();
  return undefined;
}
