// Applications: the tracker, and the review page where the user checks, approves and submits each one.
import { api, enc } from '../api.js';
import {
  html, mount, loading, emptyState, toast, toastError, confirmDialog, openModal, trackJob, setBusy, replaceQuery,
  debounce, copyText, fmtRel, fmtDate, plural, sentence, tabsHTML, bindTabKeys, $, $$, on,
} from '../ui.js';
import { navigate } from '../nav.js';
import {
  jobsNav, hitlNote, loadStats, reviewCount, limitText, appStatusBadge, APP_STATUS, recBadge, scoreBand, postingMeta,
  extLink, attributionHTML, SENSITIVE, FORM_ONLY, isEmptyValue, isoDay, todayIso, errorBody, safeUrl, matchExplainHTML,
  warningsHTML,
} from './jobs-common.js';

const GROUPS = [
  ['all', 'All', null],
  ['review', 'To review', ['preparing', 'needs_review', 'failed']],
  ['ready', 'Ready to submit', ['approved', 'filling', 'filled']],
  ['submitted', 'Submitted', ['submitted']],
  ['active', 'Interviews and offers', ['interviewing', 'offer']],
  ['closed', 'Closed', ['rejected', 'withdrawn']],
];

function fmtLocalDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) return String(day || '');
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function followUp(a) {
  const day = isoDay(a.follow_up_at);
  if (!day) return '';
  const due = day <= todayIso() && ['submitted', 'interviewing', 'offer'].includes(a.status);
  return html`<span class="${due ? 'follow-due' : ''}">${due ? 'Follow up now' : `Follow up ${fmtLocalDay(day)}`}</span>`;
}

function whenLine(a) {
  if (a.submitted_at) return `Submitted ${fmtRel(a.submitted_at)}`;
  if (a.approved_at) return `Approved ${fmtRel(a.approved_at)}`;
  return `Started ${fmtRel(a.created_at)}`;
}

function scoreChip(score) {
  const has = score !== null && score !== undefined && !Number.isNaN(Number(score));
  return html`<span class="score-chip ${has ? scoreBand(score) : ''}" title="Match score">${has ? Math.round(Number(score)) : '–'}</span>`;
}

// =================================================================================================
// #/jobs/applications
// =================================================================================================
export async function applicationsList(root, { query, signal }) {
  document.title = 'Applications · Jobs · Interview App';
  mount(root, loading('Loading applications…'));
  const [apps, stats] = await Promise.all([api('/api/careers/applications', { signal }), loadStats(signal)]);
  const list = [...(apps || [])].sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
  const count = (statuses) => (statuses ? list.filter((a) => statuses.includes(a.status)).length : list.length);
  let tab = query.get('tab') || 'all';
  if (!GROUPS.some(([k]) => k === tab)) tab = 'all';
  const by = (stats && stats.by_status) || {};
  const sum = (...ks) => ks.reduce((n, k) => n + Number(by[k] || 0), 0);

  mount(root, html`
    <div class="page-head">
      <div><h1>Jobs</h1>
        <p class="lead">Every application waits for your review. Approve it, then submit it yourself on the employer's site.</p></div>
      <div class="actions"><a class="btn btn-secondary" href="#/jobs">Find more jobs</a></div>
    </div>
    ${jobsNav('applications', { review: reviewCount(stats) })}
    ${list.length ? html`
      <section class="card card-tight" aria-label="Summary">
        <div class="stat-strip">
          <div class="stat"><span class="label">To review</span><span class="value">${count(['needs_review'])}</span></div>
          <div class="stat"><span class="label">Approved today</span><span class="value">${stats ? `${stats.approved_today || 0}` : '–'}<small class="subtle">${stats && stats.daily_limit ? ` / ${stats.daily_limit}` : ''}</small></span></div>
          <div class="stat"><span class="label">Submitted</span><span class="value">${stats ? sum('submitted', 'interviewing', 'offer', 'rejected') : count(['submitted', 'interviewing', 'offer', 'rejected'])}</span></div>
          <div class="stat"><span class="label">Interviews and offers</span><span class="value">${count(['interviewing', 'offer'])}</span></div>
        </div>
      </section>
      ${tabsHTML(GROUPS.map(([key, label, statuses]) => ({ key, label, count: count(statuses) })), tab, { label: 'Application status' })}
      <div id="panel" role="tabpanel" tabindex="0" aria-labelledby="tab-${tab}"></div>`
    : html`<section class="card">${emptyState({
      title: 'No applications yet',
      text: 'Find a job you like and choose "Prepare application". The app drafts it from your CV, then waits for you.',
      action: html`<a class="btn btn-primary" href="#/jobs">Find jobs</a>`,
    })}<div class="mt-3">${hitlNote()}</div></section>`}
  `);
  if (!list.length) return;

  function renderPanel() {
    const statuses = GROUPS.find(([k]) => k === tab)[2];
    const items = statuses ? list.filter((a) => statuses.includes(a.status)) : list;
    mount($('#panel', root), items.length ? html`<section class="card"><div class="list-rows">${items.map((a) => {
      const p = a.posting || {};
      return html`<a class="list-row app-row" href="#/jobs/applications/${enc(a.id)}">
        ${scoreChip(a.score)}
        <div class="main"><div class="t">${p.title || 'Untitled role'}</div>
          <div class="item-meta">${p.company ? html`<span>${p.company}</span>` : ''}${p.location ? html`<span>${p.location}</span>` : ''}
            <span>${whenLine(a)}</span>${followUp(a)}</div></div>
        ${appStatusBadge(a.status)}</a>`;
    })}</div></section>` : html`<section class="card">${emptyState({ title: 'Nothing here', text: 'No applications have this status.' })}</section>`);
  }
  function select(key) {
    tab = key;
    $$('.tabs [role="tab"]', root).forEach((b) => {
      const on2 = b.dataset.tab === key;
      b.setAttribute('aria-selected', on2 ? 'true' : 'false');
      b.tabIndex = on2 ? 0 : -1;
    });
    $('#panel', root).setAttribute('aria-labelledby', `tab-${key}`);
    replaceQuery({ tab: key === 'all' ? null : key });
    renderPanel();
  }
  const tablist = $('.tabs', root);
  tablist.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) select(b.dataset.tab);
  });
  bindTabKeys(tablist, select);
  renderPanel();
}

// =================================================================================================
// #/jobs/applications/:id: review, approve, fill, submit, track
// =================================================================================================
const EDITABLE = new Set(['needs_review', 'approved', 'filled']);
const AFTER_APPROVAL = new Set(['approved', 'filling', 'filled']);
const SUBMITTED_PLUS = new Set(['submitted', 'interviewing', 'offer', 'rejected', 'withdrawn']);
const TRACK_STATUSES = [['interviewing', 'Interviewing'], ['offer', 'Offer'], ['rejected', 'Rejected'], ['withdrawn', 'Withdrawn']];
const CATEGORY_LABEL = {
  profile: 'Profile', open_text: 'Open question', legal: 'Legal', demographic: 'Diversity, optional',
  compensation: 'Salary', consent: 'Consent', availability: 'Availability', file: 'File', other: 'Other',
};
const SOURCE_BADGE = {
  profile: ['badge-ok', 'From your profile'], saved: ['badge-ok', 'Your saved answer'], ai: ['badge-accent', 'AI draft'],
  user: ['badge-ok', 'Your answer'], empty: ['badge-warn', 'Not answered'],
};
const EVENT_LABEL = {
  created: 'Started', drafted: 'Drafts ready', edited: 'You edited it', regenerated: 'Drafts regenerated',
  truth_ack: 'You confirmed a claim', approved: 'You approved it', fill_started: 'Form filling started',
  filled: 'Form filled', fill_failed: 'Form filling failed', submitted: 'You submitted it', status: 'Status changed',
  prep: 'Interview prep created', failed: 'Something went wrong', unapproved: 'Sent back for review',
  reopened: 'Sent back for review', needs_review: 'Sent back for review', edited_after_approval: 'Edited after approval',
  filling: 'Form filling started', interviewing: 'Marked as interviewing', offer: 'Marked as offer', rejected: 'Marked as rejected',
  withdrawn: 'Marked as withdrawn',
};
const COMMAND_RE = /\\|\bpip\b|\bpython\b|\.bat\b|\.sh\b/;
/** Answers worth offering to save for next time (profile fields already come from the profile). */
const REUSABLE = new Set(['legal', 'other', 'availability', 'compensation', 'open_text']);
function setupSteps(steps) {
  const list = (steps || []).filter(Boolean);
  if (!list.length) return '';
  return html`<ol class="list small mt-2">${list.map((s) => html`<li>${COMMAND_RE.test(s) ? html`<code>${s}</code>` : s}</li>`)}</ol>`;
}
const ASSIST_APPROVED = "Open the application page, copy in your answers and cover letter from this page, check everything and click Submit on the employer's site. Then mark it as submitted here.";
const NEXT = {
  needs_review: ['info', 'ℹ', 'Check it, then approve',
    'Read the drafts and answers. Fix or confirm anything the truth check flags and answer what only you can answer, then approve. Nothing is sent until you do, and even then you click Submit yourself.'],
  approved: ['ok', '✓', 'Approved. Now submit it yourself',
    "Fill the form in a browser window on this PC, or open the application page and use your drafts. Check everything, click Submit on the employer's site, then mark it as submitted here."],
  filled: ['warn', '⚑', 'The form is filled. Your turn',
    'Check every field in the browser window, solve any verification yourself, and click Submit. Then mark it as submitted here.'],
  submitted: ['ok', '✓', 'Submitted', 'Set a follow-up date below so you remember to check in.'],
  interviewing: ['ok', '★', 'Interviewing', 'Practise with a mock interview built from this job and your CV.'],
  offer: ['ok', '★', 'Offer', 'Congratulations. Keep notes on the offer below.'],
  rejected: ['', '·', 'Closed', 'The job and your drafts stay here for reference.'],
  withdrawn: ['', '·', 'Withdrawn', 'The job and your drafts stay here for reference.'],
  failed: ['danger', '⚠', "This didn't finish", 'Drafting failed. Try again with "Regenerate drafts".'],
};
const PLACEHOLDER_RE = /\[[^\]\n]{2,120}\]/g;

/** Answers are plain strings on the server: several choices are joined with "; " (options can contain commas)
 *  and yes/no is "Yes"/"No". */
function readAnswer(el) {
  if (el.matches('fieldset')) return $$('input[type=checkbox]:checked', el).map((i) => i.value).join('; ');
  if (el.dataset.bool) return el.value === 'yes' ? 'Yes' : el.value === 'no' ? 'No' : '';
  return el.value;
}

function answerControl(ans, id, editable) {
  const v = ans.value;
  const ro = editable ? '' : 'disabled';
  if (ans.kind === 'textarea') {
    return html`<textarea id="${id}" class="textarea short" data-answer="${ans.key}" ${editable ? '' : 'readonly'}>${v ?? ''}</textarea>`;
  }
  if (ans.kind === 'select') {
    const opts = [...(ans.options || [])].map(String);
    const cur = v === null || v === undefined ? '' : String(v);
    if (cur && !opts.includes(cur)) opts.unshift(cur);
    return html`<select id="${id}" class="select" data-answer="${ans.key}" ${ro}><option value="">Choose…</option>${opts.map((o) => html`<option value="${o}" ${o === cur ? 'selected' : ''}>${o}</option>`)}</select>`;
  }
  if (ans.kind === 'multiselect') {
    const opts = (ans.options || []).map(String);
    const raw = Array.isArray(v) ? v.map(String) : String(v || '');
    const chosen = new Set(Array.isArray(raw) ? raw : opts.filter((o) => raw === o || raw.split(/\s*;\s*/).includes(o)));
    return html`<fieldset id="${id}" class="multi" data-answer="${ans.key}"><legend class="sr-only">${ans.label}</legend>
      ${opts.map((o) => html`<label class="check"><input type="checkbox" value="${o}" ${chosen.has(o) ? 'checked' : ''} ${ro}><span>${o}</span></label>`)}</fieldset>`;
  }
  if (ans.kind === 'boolean') {
    const cur = v === true || /^(yes|true)$/i.test(String(v)) ? 'yes' : v === false || /^(no|false)$/i.test(String(v)) ? 'no' : '';
    return html`<select id="${id}" class="select" data-answer="${ans.key}" data-bool="1" ${ro}><option value="">Choose…</option>
      <option value="yes" ${cur === 'yes' ? 'selected' : ''}>Yes</option><option value="no" ${cur === 'no' ? 'selected' : ''}>No</option></select>`;
  }
  if (ans.kind === 'file') {
    return html`<p class="small" id="${id}">${isEmptyValue(v)
      ? html`<span class="needs-text">No file yet.</span> <a href="#/jobs/profile">Upload your CV in your profile</a>.`
      : html`<span aria-hidden="true">📎 </span>${v}`}</p>`;
  }
  return html`<input id="${id}" class="input" data-answer="${ans.key}" value="${v ?? ''}" ${editable ? '' : 'readonly'} autocomplete="off">`;
}

function fillReportHTML(fr) {
  if (!fr) return '';
  const sec = (title, items, cls) => (items && items.length
    ? html`<div><div class="section-title">${title}</div><ul class="list small ${cls}">${items.map((x) => html`<li>${x}</li>`)}</ul></div>` : '');
  return html`<div class="fill-report mt-4"><h3>Last fill ${fr.at ? html`<span class="subtle small">${fmtRel(fr.at)}</span>` : ''}</h3>
    ${fr.captcha ? html`<div class="banner banner-warn mt-2"><span class="banner-icon" aria-hidden="true">⚠</span><span class="small">The page shows a verification check. Solve it yourself in the browser window.</span></div>` : ''}
    <div class="stack-sm mt-2">
      ${sec('Needs your attention', fr.needs_attention, 'list-flag')}
      ${sec('Left for you to fill', fr.skipped, 'list-arrow')}
      ${sec('Filled', fr.filled, 'list-check')}
    </div></div>`;
}

export async function applicationDetail(root, { params, signal }) {
  const id = params.id;
  mount(root, loading('Loading application…'));
  let first;
  try {
    first = await api(`/api/careers/applications/${enc(id)}`, { signal });
  } catch (err) {
    if (err.status === 404) {
      document.title = 'Application not found · Interview App';
      mount(root, emptyState({ title: 'Application not found', text: 'It may have been deleted.', action: html`<a class="btn btn-primary" href="#/jobs/applications">All applications</a>` }));
      return undefined;
    }
    throw err;
  }
  const st = {
    app: first,
    stats: await loadStats(signal),
    pending: { materials: {}, answers: new Map(), other: {} },
    inflight: null,
    watching: null,
    seenJobs: new Set(),
  };
  const url = `/api/careers/applications/${enc(id)}`;

  // --- rendering ---------------------------------------------------------------------------------
  function render() {
    const a = st.app;
    const p = a.posting || {};
    document.title = `${p.title || 'Application'} · Applications · Interview App`;
    mount(root, html`
      <div class="page-head">
        <div><a class="crumb" href="#/jobs/applications">← Applications</a>
          <h1>${p.title || 'Untitled role'}</h1>
          ${postingMeta(p)}
          <div class="row mt-2" id="head-status"></div>
        </div>
        <div class="actions">${extLink(p.url, 'View job', { cls: 'btn btn-secondary' })}</div>
      </div>
      <div id="next"></div>
      <div id="warnings" ${warningsHTML(a.warnings) ? '' : 'hidden'}>${warningsHTML(a.warnings)}</div>
      <div class="app-grid">
        <div class="app-main">
          ${jobCard(a)}
          <section class="card" id="materials-card" aria-labelledby="mat-title"></section>
          <section class="card" id="answers-card" aria-labelledby="ans-title"></section>
        </div>
        <div class="app-side">
          <section class="card" id="approve-card" aria-labelledby="approve-title"></section>
          <section class="card" id="truth-card" aria-labelledby="truth-title"></section>
          <section class="card" id="submit-card" aria-labelledby="submit-title"></section>
          <section class="card" id="track-card" aria-labelledby="track-title"></section>
          <section class="card" id="history-card" aria-labelledby="history-title"></section>
          <section class="card card-tight" id="danger-card" aria-label="More actions"></section>
        </div>
      </div>`);
    renderHeadStatus();
    renderNext();
    renderMaterials();
    renderAnswers();
    renderSide();
    renderTrack();
  }

  function renderHeadStatus() {
    const a = st.app;
    const m = a.match;
    mount($('#head-status', root), html`${appStatusBadge(a.status)}
      ${m ? html`<span class="badge" title="How well the job matches your CV">Match ${Math.round(Number(m.score) || 0)}</span>${recBadge(m.recommendation)}` : ''}
      ${attributionHTML(a.posting)}`);
  }

  function jobCard(a) {
    const p = a.posting || {};
    const m = a.match;
    const reasons = (m && m.reasons) || [];
    const gaps = (m && m.gaps) || [];
    const flags = (m && m.red_flags) || [];
    return html`<section class="card" aria-labelledby="job-title">
      <div class="card-head"><h2 id="job-title">The job</h2>${extLink(p.apply_url || p.url, p.apply_url ? 'Application page' : 'View job')}</div>
      ${reasons.length || gaps.length || flags.length ? html`<div class="why-grid">
        ${reasons.length ? html`<div><div class="section-title">Why it fits</div><ul class="list list-check small">${reasons.map((r) => html`<li>${r}</li>`)}</ul></div>` : ''}
        ${gaps.length ? html`<div><div class="section-title">Gaps</div><ul class="list list-arrow small">${gaps.map((g) => html`<li>${g}</li>`)}</ul></div>` : ''}
        ${flags.length ? html`<div><div class="section-title">Watch out</div><ul class="list list-flag small">${flags.map((f) => html`<li>${f}</li>`)}</ul></div>` : ''}
      </div>` : ''}
      ${matchExplainHTML(m) ? html`<details class="desc mt-3"><summary>How it matches your CV</summary><div class="mt-2">${matchExplainHTML(m)}</div></details>` : ''}
      <details class="desc ${reasons.length || matchExplainHTML(m) ? 'mt-3' : ''}"><summary>Full job description</summary>
        <div class="desc-body pre small mt-2">${p.description_text || p.description_snippet || 'No description available.'}</div></details>
    </section>`;
  }

  function renderNext() {
    const a = st.app;
    const box = $('#next', root);
    if (!box) return;
    if (a.status === 'preparing' || a.status === 'filling') {
      if (a.job_id && !st.seenJobs.has(a.job_id)) {
        if (st.watching !== a.job_id) watch(a.job_id, a.status);
        return;
      }
      mount(box, html`<div class="banner banner-info" role="status"><span class="banner-icon" aria-hidden="true">ℹ</span>
        <div class="stack-sm"><strong>${a.status === 'filling' ? 'Filling the form…' : 'Drafting…'}</strong>
        <span>Still working. Check back in a moment.</span><div><button type="button" class="btn btn-secondary btn-sm" data-action="reload">Check again</button></div></div></div>`);
      return;
    }
    const [kind, icon, title, base] = NEXT[a.status] || ['', '·', sentence(a.status), ''];
    const text = a.status === 'approved' && a.mode === 'assist' ? ASSIST_APPROVED : base;
    const when = a.status === 'approved' && a.approved_at ? ` (${fmtRel(a.approved_at)})` : a.status === 'submitted' && a.submitted_at ? ` (${fmtRel(a.submitted_at)})` : '';
    const lastFail = a.status === 'failed' ? [...(a.history || [])].reverse().find((h) => h.detail) : null;
    mount(box, html`<div class="banner ${kind ? `banner-${kind}` : ''}" role="status"><span class="banner-icon" aria-hidden="true">${icon}</span>
      <div class="stack-sm"><strong>${title}${when}</strong><span>${text}</span>
        ${lastFail ? html`<span class="small muted">${lastFail.detail}</span>` : ''}
        ${a.status === 'interviewing' && !a.target_id ? html`<div><button type="button" class="btn btn-primary btn-sm" data-action="prep">Prep for this interview</button></div>` : ''}
        ${a.status === 'failed' ? html`<div><button type="button" class="btn btn-primary btn-sm" data-action="regenerate">Regenerate drafts</button></div>` : ''}
      </div></div>`);
  }

  async function watch(jobId, kind) {
    st.watching = jobId;
    const box = $('#next', root);
    const job = await trackJob(box, jobId, {
      title: kind === 'filling' ? 'Filling the form in your browser' : 'Drafting your application',
      subtitle: kind === 'filling'
        ? 'A browser window opened on this PC. The app fills in the fields and uploads your CV, then stops before Submit.'
        : 'Reading the job, drafting from your CV, then checking every claim against it. You can leave this page; it keeps running.',
      signal,
    });
    st.seenJobs.add(jobId);
    if (st.watching === jobId) st.watching = null;
    if (!job || signal.aborted) return;
    let fresh;
    try {
      fresh = await api(url, { signal });
    } catch (err) {
      if (err.name !== 'AbortError') toastError(err);
      return;
    }
    st.stats = await loadStats(signal).catch(() => st.stats);
    st.app = fresh;
    if (job.status === 'done') {
      toast(kind === 'filling' ? 'The form is filled. Check it in the browser window and submit it yourself.' : 'The drafts are ready for your review.', 'success', { timeout: 5000 });
    } else if (kind === 'filling') {
      toast(job.error || "The form couldn't be filled. You can still apply on the employer's page.", 'error', { timeout: 9000 });
    }
    if (fresh.status === 'preparing' || fresh.status === 'filling') {
      // The job ended but the application didn't move on: keep the job card (it shows what happened) and offer a reload.
      box.insertAdjacentHTML('beforeend', '<div class="mt-2"><button type="button" class="btn btn-secondary btn-sm" data-action="reload">Check again</button></div>');
      return;
    }
    render();
  }

  function renderMaterials() {
    const a = st.app;
    const box = $('#materials-card', root);
    const mat = a.materials || {};
    const editable = EDITABLE.has(a.status);
    if (a.status === 'preparing' && !mat.cover_letter && !mat.summary) {
      mount(box, html`<div class="card-head"><h2 id="mat-title">Your materials</h2></div>${loading('Drafting from your CV…')}`);
      return;
    }
    const ro = editable ? '' : 'readonly';
    mount(box, html`
      <div class="card-head"><h2 id="mat-title">Your materials</h2><span class="save-state" data-save-state aria-live="polite"></span></div>
      <p class="small muted">Drafted from your CV for this job. ${editable ? 'Edit freely: your edits are saved and checked against your CV again.' : ''}
        ${a.status === 'approved' || a.status === 'filled' ? html`<strong>Editing now sends it back for your approval.</strong>` : ''}</p>
      <div class="field mt-3">
        <div class="row-between"><label for="m-summary">Summary</label><button type="button" class="link-btn small" data-copy="#m-summary">Copy</button></div>
        <textarea id="m-summary" class="textarea short" data-mat="summary" ${ro}>${mat.summary || ''}</textarea>
      </div>
      <div class="field mt-3">
        <div class="row-between"><label for="m-cover">Cover letter</label><button type="button" class="link-btn small" data-copy="#m-cover">Copy</button></div>
        <textarea id="m-cover" class="textarea tall" data-mat="cover_letter" ${ro}>${mat.cover_letter || ''}</textarea>
        <span class="hint" data-hint="cover"></span>
      </div>
      <div class="field mt-3">
        <div class="row-between"><label for="m-hl">Highlights</label><button type="button" class="link-btn small" data-copy="#m-hl">Copy</button></div>
        <textarea id="m-hl" class="textarea short" data-mat="highlights" ${ro}>${(mat.highlights || []).join('\n')}</textarea>
        <span class="hint">One per line: short proof points from your CV that fit this job.</span>
      </div>`);
    updateMaterialHints();
  }

  function updateMaterialHints() {
    const cover = $('#m-cover', root);
    const hint = $('[data-hint="cover"]', root);
    if (!cover || !hint) return;
    const words = (cover.value.match(/\S+/g) || []).length;
    const holes = [...$$('[data-mat]', root)].reduce((n, el) => n + (el.value.match(PLACEHOLDER_RE) || []).length, 0);
    mount(hint, html`${plural(words, 'word')}${holes ? html` · <strong class="needs-text">${plural(holes, '[bracketed] part')} to fill in: only you know what goes there</strong>` : ''}`);
  }

  function renderAnswers() {
    const a = st.app;
    const box = $('#answers-card', root);
    const answers = a.answers || [];
    if (a.status === 'preparing' && !answers.length) {
      mount(box, html`<div class="card-head"><h2 id="ans-title">Application questions</h2></div>${loading('Reading the form…')}`);
      return;
    }
    if (!answers.length) {
      mount(box, html`<div class="card-head"><h2 id="ans-title">Application questions</h2></div>
        <p class="muted small">This job site doesn't publish its form questions. Use your materials when you apply on the employer's page.</p>`);
      return;
    }
    const you = []; const ai = []; const prof = []; const formOnly = [];
    answers.forEach((ans, i) => {
      if (FORM_ONLY.has(ans.category)) formOnly.push([ans, i]);
      else if (ans.needs_input || ans.source === 'empty') you.push([ans, i]);
      else if (ans.source === 'ai') ai.push([ans, i]);
      else prof.push([ans, i]);
    });
    const group = (key, title, text, items) => (items.length ? html`<div class="q-group" data-group="${key}">
      <div class="q-group-head"><h3>${title}</h3><span class="badge">${items.length}</span></div>
      <p class="small muted">${text}</p>
      ${items.map(([ans, i]) => answerRow(ans, i))}
    </div>` : '');
    mount(box, html`
      <div class="card-head"><h2 id="ans-title">Application questions</h2>
        <span class="row"><span class="save-state" data-save-state aria-live="polite"></span><span data-required-left></span></span></div>
      ${a.mode === 'assist' ? html`<p class="small muted">This job's site can't be filled in by the app. Use the Copy buttons to paste each answer into the employer's form.</p>` : ''}
      ${group('you', 'You answer this', "Only you can answer these. The AI never answers legal or salary questions, and leaves anything your CV doesn't cover to you.", you)}
      ${group('ai', 'Drafted by AI: check it', 'Drafted from your CV. Make sure each one is true and sounds like you.', ai)}
      ${group('profile', 'From your profile', 'Filled in from your profile and saved answers.', prof)}
      ${group('form', 'You answer these on the form', "Consent boxes and voluntary self-identification questions. The app never fills them: you tick or choose them yourself on the employer's form.", formOnly)}`);
    updateAnswerStates();
  }

  function formOnlyRow(ans) {
    const opts = (ans.options || []).map(String).filter(Boolean);
    return html`<div class="answer-row form-only" data-key="${ans.key}" data-required="" data-kind="${ans.kind}">
      <div class="answer-head"><span class="field-label">${ans.label}${ans.required ? html`<span class="req" aria-hidden="true"> *</span><span class="sr-only"> (required on the form)</span>` : ''}</span>
        <span class="badge"><span aria-hidden="true">🔒 </span>${CATEGORY_LABEL[ans.category] || sentence(ans.category)}</span></div>
      ${opts.length ? html`<p class="small muted">Choices on the form: ${opts.join(' · ')}</p>` : ''}
      <p class="hint">${ans.note || (ans.category === 'consent'
    ? "Only you can give consent. Read it and tick it yourself on the employer's form."
    : "Voluntary and optional. Answer it yourself on the employer's form, or choose not to say.")}</p>
    </div>`;
  }

  function answerRow(ans, i) {
    if (FORM_ONLY.has(ans.category)) return formOnlyRow(ans);
    const editable = EDITABLE.has(st.app.status);
    const ctlId = `ans-${i}`;
    const sensitive = SENSITIVE.has(ans.category);
    const [srcCls, srcLabel] = SOURCE_BADGE[ans.source] || ['', sentence(ans.source || '')];
    const copyable = st.app.mode === 'assist' && ans.kind !== 'file';
    const reusable = editable && REUSABLE.has(ans.category) && !/cover ?letter/i.test(ans.label) && !['cover_letter_text', 'comments'].includes(ans.key);
    // The server needs an answer when the form requires one, and always for legal questions.
    const needed = ans.kind !== 'file' && (ans.required || ans.category === 'legal');
    const labelTag = ans.kind === 'file' || ans.kind === 'multiselect'
      ? html`<span class="field-label">${ans.label}${ans.required ? html`<span class="req" aria-hidden="true"> *</span><span class="sr-only"> (required)</span>` : ''}</span>`
      : html`<label class="field-label" for="${ctlId}">${ans.label}${ans.required ? html`<span class="req" aria-hidden="true"> *</span><span class="sr-only"> (required)</span>` : ''}</label>`;
    return html`<div class="answer-row" data-key="${ans.key}" data-required="${needed ? '1' : ''}" data-kind="${ans.kind}">
      <div class="answer-head">${labelTag}
        <span class="row">${sensitive ? html`<span class="badge" title="The AI never answers this"><span aria-hidden="true">🔒 </span>${CATEGORY_LABEL[ans.category]}</span>` : ''}
          <span class="badge ${srcCls}" data-src>${srcLabel}</span></span></div>
      ${ans.description ? html`<p class="small muted">${ans.description}</p>` : ''}
      ${answerControl(ans, ctlId, editable)}
      ${ans.note ? html`<p class="hint">${ans.note}</p>` : ''}
      <p class="hint needs-text" data-needs hidden>${ans.required ? 'Required: answer this before you approve.' : 'Needs your answer before you approve.'}</p>
      ${reusable || copyable ? html`<div class="row answer-tools">
        ${copyable ? html`<button type="button" class="link-btn small" data-copy-answer="${ans.key}">Copy<span class="sr-only"> answer to "${ans.label}"</span></button>` : ''}
        ${reusable ? html`<button type="button" class="link-btn small" data-save-answer="${ans.key}">Save for reuse</button>` : ''}
      </div>` : ''}
    </div>`;
  }

  /** Re-mark which answers still need input, from what's on screen (the server copy may lag behind typing). */
  function updateAnswerStates() {
    const rows = $$('.answer-row', root);
    let left = 0;
    for (const row of rows) {
      const key = row.dataset.key;
      const ans = (st.app.answers || []).find((x) => x.key === key);
      const ctl = $('[data-answer]', row);
      const value = ctl ? readAnswer(ctl) : ans && ans.value;
      const missing = row.dataset.required === '1' && isEmptyValue(value);
      if (missing) left += 1;
      row.classList.toggle('needs', missing);
      const needs = $('[data-needs]', row);
      if (needs) needs.hidden = !missing;
      if (ans && !st.pending.answers.has(key)) {
        const [cls, label] = SOURCE_BADGE[ans.source] || ['', sentence(ans.source || '')];
        const badge = $('[data-src]', row);
        if (badge) { badge.className = `badge ${cls}`; badge.textContent = label; }
      }
    }
    const holder = $('[data-required-left]', root);
    if (holder) mount(holder, left ? html`<span class="badge badge-warn">${plural(left, 'required answer')} missing</span>` : html`<span class="badge badge-ok">All required answered</span>`);
  }

  function renderSide() {
    renderApprove();
    renderTruth();
    renderSubmit();
    renderHistory();
    renderDanger();
  }

  function renderApprove() {
    const a = st.app;
    const box = $('#approve-card', root);
    if (!box) return;
    if (a.status === 'preparing') {
      mount(box, html`<div class="card-head"><h2 id="approve-title">Approve</h2></div><p class="small muted">Available when the drafts are ready.</p>`);
      return;
    }
    if (AFTER_APPROVAL.has(a.status) || (SUBMITTED_PLUS.has(a.status) && a.approved_at)) {
      mount(box, html`<div class="card-head"><h2 id="approve-title">Approved</h2><span class="badge badge-ok">✓ You approved it</span></div>
        <p class="small muted">${a.approved_at ? `On ${fmtDate(a.approved_at)}.` : ''} ${AFTER_APPROVAL.has(a.status) ? 'Editing the drafts or answers sends it back for review.' : ''}</p>`);
      return;
    }
    if (SUBMITTED_PLUS.has(a.status)) { mount(box, ''); box.hidden = true; return; }
    box.hidden = false;
    const items = a.checklist || [];
    // Only blocking items stop approval; the others are advice.
    const left = items.filter((c) => !c.ok && c.blocking !== false);
    const advice = items.filter((c) => !c.ok && c.blocking === false);
    const stats = st.stats;
    const limitHit = !!(stats && stats.daily_limit && (stats.approved_today || 0) >= stats.daily_limit);
    const can = a.status === 'needs_review' && !left.length && !limitHit;
    const again = !!a.approved_at || (a.history || []).some((h) => h.event === 'approved');
    const help = can ? (a.mode === 'assist' ? "Approving marks it ready. You then fill in the employer's form and click Submit yourself."
      : 'Approving lets the app fill the form for you. You still click Submit yourself.')
      : left.length ? `Finish the ${plural(left.length, 'item')} marked ! to approve.`
        : limitHit ? "You've reached today's limit. It resets tomorrow." : '';
    mount(box, html`
      <div class="card-head"><h2 id="approve-title">Approve</h2>
        ${items.length ? html`<span class="badge ${left.length ? 'badge-warn' : 'badge-ok'}">${left.length ? `${left.length} to finish` : 'Ready'}</span>` : ''}</div>
      ${again && a.status === 'needs_review' ? html`<p class="small muted mb-2">You changed it after approving, so it needs your approval again.</p>` : ''}
      ${items.length ? html`<ul class="checklist">${items.map((c) => {
        const blocking = c.blocking !== false;
        const cls = c.ok ? 'ck-ok' : blocking ? 'ck-no' : 'ck-advice';
        return html`<li class="${cls}">
        <span class="ck-icon" aria-hidden="true">${c.ok ? '✓' : blocking ? '!' : 'i'}</span>
        <div><span>${c.label}</span><span class="sr-only">${c.ok ? ': done' : blocking ? ': not yet, needed to approve' : ': recommended'}</span>
          ${!c.ok && !blocking ? html` <span class="badge">Recommended</span>` : ''}
          ${c.detail ? html`<div class="subtle small">${c.detail}</div>` : ''}</div></li>`;
      })}</ul>` : ''}
      ${advice.length && !left.length ? html`<p class="small muted mt-2">The items marked i are recommended, not required.</p>` : ''}
      <div class="stack-sm mt-3">
        <button type="button" class="btn btn-primary" data-action="approve" ${can ? '' : 'disabled'} aria-describedby="approve-help">${again ? 'Approve again' : 'Approve application'}</button>
        ${help ? html`<span class="subtle small" id="approve-help">${help}</span>` : ''}
        ${limitText(stats) ? html`<span class="subtle small" title="A daily cap keeps every application considered and reviewed.">${limitText(stats)}</span>` : ''}
        <div data-blockers></div>
      </div>`);
  }

  function fieldRef(field) {
    const f = String(field || '');
    if (/summary$/.test(f)) return { label: 'Summary', sel: '#m-summary' };
    if (/cover_letter/.test(f)) return { label: 'Cover letter', sel: '#m-cover' };
    if (/highlight/.test(f)) return { label: 'Highlights', sel: '#m-hl' };
    const key = f.replace(/^answers?(?:\.|:|\[)/, '').replace(/\]$/, '');
    const ans = (st.app.answers || []).find((x) => x.key === key || x.key === f);
    if (ans) return { label: ans.label, sel: `.answer-row[data-key="${CSS.escape(ans.key)}"] [data-answer]` };
    return { label: f ? sentence(f) : '', sel: null };
  }

  function renderTruth() {
    const a = st.app;
    const box = $('#truth-card', root);
    if (!box) return;
    const t = a.truth;
    if (!t) {
      mount(box, html`<div class="card-head"><h2 id="truth-title">Truth check</h2></div>
        <p class="small muted">${a.status === 'preparing' ? 'Runs when the drafts are ready.' : 'Not run yet.'}</p>`);
      return;
    }
    const issues = t.issues || [];
    const open = issues.filter((i) => !i.acknowledged);
    const blocking = open.filter((i) => i.severity === 'block');
    const editable = EDITABLE.has(a.status);
    mount(box, html`
      <div class="card-head"><h2 id="truth-title">Truth check</h2>
        ${blocking.length ? html`<span class="badge badge-danger">${blocking.length} blocking</span>` : open.length ? html`<span class="badge badge-warn">${open.length} to check</span>` : html`<span class="badge badge-ok">All clear</span>`}</div>
      <p class="small muted">Every claim in the drafts is compared with your CV, profile and extra facts.</p>
      ${issues.length ? html`<div class="stack-sm mt-3">${issues.map((i) => {
        const ref = fieldRef(i.field);
        const cls = i.acknowledged ? 'acked' : i.severity === 'block' ? 'block' : 'warn';
        return html`<div class="issue ${cls}" data-issue="${i.id}">
          <div class="row-between"><span class="badge ${i.acknowledged ? 'badge-ok' : i.severity === 'block' ? 'badge-danger' : 'badge-warn'}">${i.acknowledged ? 'Confirmed by you' : i.severity === 'block' ? 'Blocks approval' : 'Check this'}</span>
            <span class="subtle small">${ref.label}${ref.label && i.source ? ' · ' : ''}${i.source === 'ai' ? 'found by the AI check' : i.source === 'rules' ? 'found by the rule check' : ''}</span></div>
          ${i.text ? html`<blockquote class="quote small">${i.text}</blockquote>` : ''}
          <p class="small">${i.problem}</p>
          ${!i.acknowledged && editable ? html`<div class="row">
            <button type="button" class="btn btn-secondary btn-sm" data-ack="${i.id}">This is true: I can back it up</button>
            ${ref.sel ? html`<button type="button" class="link-btn small" data-goto="${i.id}">Edit the text</button>` : ''}</div>` : ''}
        </div>`;
      })}</div>` : html`<p class="mt-2 small"><span aria-hidden="true">✓ </span>Everything in the drafts matches your CV and profile.</p>`}
      ${open.length ? html`<p class="small muted mt-3">Fix the text, or confirm a claim you can back up. If it's true but missing from your CV, add it to
        <a href="#/jobs/profile">Extra facts</a> in your profile so it isn't flagged again.</p>` : ''}
      ${t.meta && t.meta.checked_at ? html`<p class="subtle small mt-2">Last checked ${fmtRel(t.meta.checked_at)}.</p>` : ''}`);
  }

  function renderSubmit() {
    const a = st.app;
    const box = $('#submit-card', root);
    if (!box) return;
    const p = a.posting || {};
    if (SUBMITTED_PLUS.has(a.status)) { mount(box, ''); box.hidden = true; return; }
    box.hidden = false;
    const assist = a.mode === 'assist';
    if (!AFTER_APPROVAL.has(a.status)) {
      mount(box, html`<div class="card-head"><h2 id="submit-title">Submit</h2><span class="badge">After you approve</span></div>
        <p class="small muted">${assist
    ? "This job's site can't be filled in by the app. Once you approve, open the application page and copy your answers in."
    : 'Once you approve, the app can fill the form in a browser window on this PC. You check it and click Submit yourself.'}</p>`);
      return;
    }
    const browser = st.stats && st.stats.browser;
    const applyHref = safeUrl(p.apply_url || p.url);
    mount(box, html`
      <div class="card-head"><h2 id="submit-title" tabindex="-1">Submit</h2></div>
      ${assist ? html`<div class="stack-sm">
        ${applyHref ? extLink(applyHref, 'Open the application page', { cls: 'btn btn-primary' }) : html`<p class="small warn-text">This job has no application link. Apply the way the posting describes.</p>`}
        <p class="small muted">The app can't fill in this site's form. Open it, copy your cover letter and answers from this page with the Copy buttons,
          check everything and click Submit yourself.</p>
      </div>` : html`<div class="stack-sm">
        <button type="button" class="btn btn-primary" data-action="fill" ${a.status === 'filling' ? 'disabled' : ''}>${a.status === 'filled' ? 'Fill in browser again' : 'Fill in browser'}</button>
        <p class="small muted">Opens the form in a browser window on this PC, fills it in and uploads your CV. It never clicks Submit. Check everything, solve any verification yourself, and click Submit.</p>
        ${browser && browser.available === false && browser.detail ? html`<div class="small warn-text">${browser.detail}${setupSteps(browser.setup)}</div>` : ''}
        ${browser && browser.busy && a.status !== 'filling' ? html`<p class="small warn-text">Another application is being filled right now. Finish or close that browser window first.</p>` : ''}
        <div data-fill-error></div>
        ${applyHref ? html`<p class="small">Or apply yourself: ${extLink(applyHref, 'open the application page')} and paste in your drafts.</p>` : ''}
      </div>`}
      <hr class="divider">
      <div class="stack-sm">
        <button type="button" class="btn btn-secondary" data-action="submitted">I submitted it</button>
        <p class="small muted">Mark it only after you clicked Submit on the employer's site.</p>
      </div>
      ${fillReportHTML(a.fill_report)}`);
  }

  function renderTrack() {
    const a = st.app;
    const box = $('#track-card', root);
    if (!box) return;
    const after = SUBMITTED_PLUS.has(a.status);
    mount(box, html`
      <div class="card-head"><h2 id="track-title">${after ? 'Track it' : 'Notes'}</h2><span class="save-state" data-save-state-track aria-live="polite"></span></div>
      <div class="stack-sm">
        ${after ? html`<div class="field"><label for="t-status">Status</label>
          <select id="t-status" class="select">
            ${a.status === 'submitted' ? html`<option value="submitted" selected disabled>Submitted, waiting to hear back</option>` : ''}
            ${TRACK_STATUSES.map(([v, l]) => html`<option value="${v}" ${a.status === v ? 'selected' : ''}>${l}</option>`)}
          </select></div>` : ''}
        <div class="field"><label for="t-follow">Follow up on</label>
          <input id="t-follow" type="date" class="input" value="${isoDay(a.follow_up_at)}">
          <span class="hint">A reminder for you. It shows in your applications list.</span></div>
        <div class="field"><label for="t-notes">Notes</label>
          <textarea id="t-notes" class="textarea short" placeholder="Recruiter, referral, what they said…">${a.notes || ''}</textarea></div>
        ${a.status !== 'preparing' ? (a.target_id
    ? html`<a class="btn btn-secondary" href="#/prep/${enc(a.target_id)}">Open interview prep</a>`
    : html`<div><button type="button" class="btn btn-secondary" data-action="prep">Prep for this interview</button>
            <p class="small subtle mt-2">Builds a mock-interview pack from this job and your CV.</p></div>`) : ''}
      </div>`);
  }

  function renderHistory() {
    const box = $('#history-card', root);
    if (!box) return;
    const items = [...(st.app.history || [])].sort((x, y) => String(y.at || '').localeCompare(String(x.at || '')));
    mount(box, html`<div class="card-head"><h2 id="history-title">History</h2></div>
      ${items.length ? html`<ol class="timeline">${items.map((e) => html`<li>
        <div class="small"><strong>${EVENT_LABEL[e.event] || sentence(e.event || 'update')}</strong></div>
        ${e.detail ? html`<div class="small muted">${e.detail}</div>` : ''}
        <div class="when" title="${fmtDate(e.at)}">${fmtRel(e.at)}</div></li>`)}</ol>` : html`<p class="subtle">Nothing yet.</p>`}`);
  }

  function renderDanger() {
    const a = st.app;
    const box = $('#danger-card', root);
    if (!box) return;
    const canRegen = ['needs_review', 'failed', 'approved'].includes(a.status);
    mount(box, html`<div class="row">
      ${canRegen ? html`<button type="button" class="btn btn-secondary btn-sm" data-action="regenerate">Regenerate drafts</button>` : ''}
      <button type="button" class="btn btn-danger btn-sm" data-action="delete">Delete application</button>
    </div>`);
  }

  // --- saving edits (debounced PUT; the response carries the re-run truth check and checklist) ----------
  function hasPending() {
    const p = st.pending;
    return Object.keys(p.materials).length > 0 || p.answers.size > 0 || Object.keys(p.other).length > 0;
  }
  function setSaveState(text, { error = false } = {}) {
    $$('[data-save-state], [data-save-state-track]', root).forEach((el) => {
      el.textContent = text;
      el.classList.toggle('dirty', error);
    });
  }
  function queue(kind, key, value) {
    if (kind === 'material') st.pending.materials[key] = value;
    else if (kind === 'answer') st.pending.answers.set(key, value);
    else st.pending.other[key] = value;
    setSaveState('Unsaved changes');
    saveSoon();
  }
  async function flush() {
    if (st.inflight) await st.inflight.catch(() => {});
    if (!hasPending() || (signal.aborted && !st.leaving)) return;
    const sent = st.pending;
    st.pending = { materials: {}, answers: new Map(), other: {} };
    const body = { ...sent.other };
    if (Object.keys(sent.materials).length) body.materials = { ...sent.materials };
    if (sent.answers.size) body.answers = [...sent.answers].map(([key, value]) => ({ key, value }));
    setSaveState('Saving…');
    const run = api(url, { method: 'PUT', body });
    st.inflight = run;
    try {
      const updated = await run;
      if (!st.leaving) applyUpdate(updated);
      setSaveState(hasPending() ? 'Unsaved changes' : 'Saved and checked');
    } catch (err) {
      st.pending.materials = { ...sent.materials, ...st.pending.materials };
      for (const [k, v] of sent.answers) if (!st.pending.answers.has(k)) st.pending.answers.set(k, v);
      st.pending.other = { ...sent.other, ...st.pending.other };
      setSaveState('Not saved', { error: true });
      if (!st.leaving) toastError(err);
    } finally {
      if (st.inflight === run) st.inflight = null;
    }
  }
  const saveSoon = debounce(() => { flush(); }, 900);
  async function flushNow() {
    saveSoon.cancel();
    await flush();
    if (hasPending()) throw Object.assign(new Error('Your latest edits could not be saved. Try again.'), { handled: false });
  }

  function applyUpdate(updated) {
    const before = st.app.status;
    st.app = updated;
    if (updated.status !== before) {
      renderHeadStatus();
      renderNext();
      if (before !== 'needs_review' && updated.status === 'needs_review') {
        toast('You changed it after approving, so it needs your approval again.', 'info', { timeout: 5000 });
      }
    }
    renderSide();
    updateAnswerStates();
  }

  // --- actions ----------------------------------------------------------------------------------------
  async function reload() {
    try {
      st.app = await api(url, { signal });
      st.stats = await loadStats(signal);
      st.seenJobs.clear();
      render();
    } catch (err) { toastError(err); }
  }

  async function approve(btn) {
    try { await flushNow(); } catch (err) { toastError(err); return; }
    const ok = await confirmDialog({
      title: 'Approve this application?',
      message: "You're confirming that the drafts and answers are true and that you want to apply. The app can then fill in the form for you, but it never clicks Submit.",
      confirmLabel: 'Approve',
    });
    if (!ok) return;
    setBusy(btn, true, 'Approving…');
    try {
      st.app = await api(`${url}/approve`, { method: 'POST', body: {} });
      st.stats = await loadStats(signal);
      toast(st.app.mode === 'assist' ? 'Approved. Next: open the application page and submit it yourself.'
        : 'Approved. Next: fill the form and submit it yourself.', 'success', { timeout: 4500 });
      render();
      $('#submit-title', root)?.focus();
    } catch (err) {
      setBusy(btn, false);
      if (err.status !== 409) { toastError(err); return; }
      const { blockers } = errorBody(err);
      try {
        st.app = await api(url, { signal });
        st.stats = await loadStats(signal);
        renderSide();
        updateAnswerStates();
      } catch { /* keep what we have */ }
      const box = $('[data-blockers]', root);
      if (box) {
        mount(box, html`<div class="banner banner-warn" role="alert"><span class="banner-icon" aria-hidden="true">⚠</span>
          <div class="stack-sm"><strong>${err.detail || 'Not ready to approve yet.'}</strong>
          ${blockers.length ? html`<ul class="list small">${blockers.map((b) => html`<li>${b}</li>`)}</ul>` : ''}</div></div>`);
      }
    }
  }

  async function acknowledge(issueId, btn) {
    const issue = ((st.app.truth && st.app.truth.issues) || []).find((i) => i.id === issueId);
    if (!issue) return;
    const ok = await confirmDialog({
      title: 'Confirm this claim is true?',
      message: `"${issue.text || issue.problem}". Only confirm it if it's true and you could explain it in an interview.`,
      confirmLabel: "Yes, it's true",
    });
    if (!ok) return;
    try { await flushNow(); } catch (err) { toastError(err); return; }
    // Saving re-runs the check, which can renumber issues: find the same claim again.
    const fresh = ((st.app.truth && st.app.truth.issues) || []).find((i) => i.id === issueId)
      || ((st.app.truth && st.app.truth.issues) || []).find((i) => !i.acknowledged && i.field === issue.field && i.text === issue.text && i.problem === issue.problem);
    if (!fresh) { toast('That text changed, so the check ran again.', 'info', { timeout: 3500 }); renderSide(); return; }
    if (btn && btn.isConnected) setBusy(btn, true, 'Saving…');
    try {
      st.app = await api(`${url}/truth/${enc(fresh.id)}/ack`, { method: 'POST', body: {} });
      renderSide();
      updateAnswerStates();
      $('#truth-title', root)?.scrollIntoView({ block: 'nearest' });
    } catch (err) {
      if (btn && btn.isConnected) setBusy(btn, false);
      toastError(err);
    }
  }

  function gotoIssue(issueId) {
    const issue = ((st.app.truth && st.app.truth.issues) || []).find((i) => i.id === issueId);
    if (!issue) return;
    const ref = fieldRef(issue.field);
    const el = ref.sel && $(ref.sel, root);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.focus({ preventScroll: true });
    if (issue.text && typeof el.setSelectionRange === 'function') {
      const at = el.value.indexOf(issue.text);
      if (at >= 0) el.setSelectionRange(at, at + issue.text.length);
    }
  }

  async function fill(btn) {
    try { await flushNow(); } catch (err) { toastError(err); return; }
    setBusy(btn, true, 'Opening…');
    try {
      const res = await api(`${url}/fill`, { method: 'POST', body: {} });
      st.app = { ...st.app, status: 'filling', job_id: res.job_id };
      renderHeadStatus();
      renderSide();
      watch(res.job_id, 'filling');
      $('#next', root)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch (err) {
      setBusy(btn, false);
      const box = $('[data-fill-error]', root);
      if ([400, 409, 501, 503].includes(err.status) && box) {
        mount(box, html`<div class="banner banner-warn" role="alert"><span class="banner-icon" aria-hidden="true">⚠</span>
          <div class="small"><div class="pre">${err.detail}</div>${setupSteps(err.body && err.body.setup)}</div></div>`);
      } else toastError(err);
    }
  }

  function askSubmitted() {
    return new Promise((resolve) => {
      let answered = false;
      const { el } = openModal({
        title: 'Did you submit it?',
        body: html`<p>Mark it as submitted only after you clicked Submit on the employer's site.</p>
          <div class="field"><label for="sub-note">Note <span class="subtle">(optional)</span></label>
          <input id="sub-note" class="input" placeholder="e.g. Confirmation email received" autocomplete="off"></div>`,
        actions: [
          { label: 'Not yet', kind: 'btn-ghost', onClick: () => { answered = true; resolve(null); } },
          { label: 'Yes, I submitted it', kind: 'btn-primary', onClick: (dlg) => { answered = true; resolve({ note: $('#sub-note', dlg).value.trim() }); } },
        ],
        onClose: () => { if (!answered) resolve(null); },
      });
      $('#sub-note', el)?.focus();
    });
  }

  async function markSubmitted(btn) {
    const answer = await askSubmitted();
    if (!answer) return;
    setBusy(btn, true, 'Saving…');
    try {
      st.app = await api(`${url}/submitted`, { method: 'POST', body: answer.note ? { note: answer.note } : {} });
      st.stats = await loadStats(signal);
      const follow = isoDay(st.app.follow_up_at);
      toast(`Marked as submitted. Good luck!${follow ? ` A follow-up reminder is set for ${fmtLocalDay(follow)}.` : ''}`, 'success', { timeout: 5000 });
      render();
    } catch (err) {
      setBusy(btn, false);
      toastError(err);
    }
  }

  async function setStatus(sel) {
    const status = sel.value;
    const prev = st.app.status;
    sel.disabled = true;
    try {
      st.app = await api(`${url}/status`, { method: 'POST', body: { status } });
      toast(`Marked as ${(APP_STATUS[status] || ['', sentence(status)])[1].toLowerCase()}.`, 'success', { timeout: 2500 });
      renderHeadStatus();
      renderNext();
      renderSide();
      renderTrack();
    } catch (err) {
      sel.value = prev;
      sel.disabled = false;
      toastError(err);
    }
  }

  async function prep(btn) {
    setBusy(btn, true, 'Creating…');
    try {
      const res = await api(`${url}/prep`, { method: 'POST', body: {} });
      toast('Building your interview prep…', 'success', { timeout: 3000 });
      navigate(`#/prep/${enc(res.target_id)}`);
    } catch (err) {
      setBusy(btn, false);
      toastError(err);
    }
  }

  async function regenerate(btn) {
    const ok = await confirmDialog({
      title: 'Regenerate the drafts?',
      message: 'The summary, cover letter, highlights and AI-drafted answers are written again from your CV, replacing your edits to them. Answers from your profile stay.',
      confirmLabel: 'Regenerate',
    });
    if (!ok) return;
    try { await flushNow(); } catch (err) { toastError(err); return; }
    setBusy(btn, true, 'Starting…');
    try {
      const res = await api(`${url}/regenerate`, { method: 'POST', body: {} });
      st.app = { ...st.app, status: 'preparing', job_id: res.job_id };
      st.seenJobs.delete(res.job_id);
      render();
    } catch (err) {
      setBusy(btn, false);
      toastError(err);
    }
  }

  async function remove() {
    const ok = await confirmDialog({
      title: 'Delete this application?',
      message: "Your drafts, answers and notes for it are deleted. The job itself stays in your matches. Nothing is sent to the employer.",
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    saveSoon.cancel();
    st.pending = { materials: {}, answers: new Map(), other: {} };
    try {
      await api(url, { method: 'DELETE' });
      toast('Application deleted.', 'success', { timeout: 2500 });
      navigate('#/jobs/applications');
    } catch (err) { toastError(err); }
  }

  async function saveForReuse(key, btn) {
    const ans = (st.app.answers || []).find((x) => x.key === key);
    const ctl = $(`.answer-row[data-key="${CSS.escape(key)}"] [data-answer]`, root);
    const value = ctl ? readAnswer(ctl) : ans && ans.value;
    if (!ans || isEmptyValue(value)) { toast('Answer it first, then save it for reuse.', 'info', { timeout: 3000 }); return; }
    const text = Array.isArray(value) ? value.join('; ') : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value).trim();
    setBusy(btn, true, 'Saving…');
    try {
      const profile = await api('/api/careers/profile', { signal });
      await api('/api/careers/profile', { method: 'PUT', body: { saved_answers: { ...(profile.saved_answers || {}), [ans.label]: text } } });
      toast('Saved to your profile. Forms that ask the same question will reuse it.', 'success', { timeout: 3500 });
    } catch (err) {
      toastError(err);
    } finally {
      if (btn.isConnected) setBusy(btn, false);
    }
  }

  // --- events (delegated once on the view root) -----------------------------------------------------
  on(root, 'input', '[data-mat]', (e, el) => {
    const key = el.dataset.mat;
    queue('material', key, key === 'highlights' ? el.value.split('\n').map((s) => s.trim()).filter(Boolean) : el.value);
    updateMaterialHints();
  });
  on(root, 'input', 'input[data-answer], textarea[data-answer]', (e, el) => {
    queue('answer', el.dataset.answer, readAnswer(el));
    updateAnswerStates();
  });
  on(root, 'change', 'select[data-answer]', (e, el) => {
    queue('answer', el.dataset.answer, readAnswer(el));
    updateAnswerStates();
  });
  on(root, 'change', 'fieldset[data-answer] input', (e, el) => {
    const fs = el.closest('fieldset[data-answer]');
    queue('answer', fs.dataset.answer, readAnswer(fs));
    updateAnswerStates();
  });
  on(root, 'input', '#t-notes', (e, el) => queue('other', 'notes', el.value));
  on(root, 'change', '#t-follow', (e, el) => {
    queue('other', 'follow_up_at', el.value || null);
    saveSoon.flush();
  });
  on(root, 'change', '#t-status', (e, el) => setStatus(el));
  on(root, 'click', '[data-action]', (e, el) => {
    const action = el.dataset.action;
    if (action === 'approve') approve(el);
    else if (action === 'fill') fill(el);
    else if (action === 'submitted') markSubmitted(el);
    else if (action === 'prep') prep(el);
    else if (action === 'regenerate') regenerate(el);
    else if (action === 'delete') remove();
    else if (action === 'reload' || action === 'retry') reload();
  });
  on(root, 'click', '[data-ack]', (e, el) => acknowledge(el.dataset.ack, el));
  on(root, 'click', '[data-goto]', (e, el) => gotoIssue(el.dataset.goto));
  on(root, 'click', '[data-copy-answer]', (e, el) => {
    const key = el.dataset.copyAnswer;
    const ctl = $(`.answer-row[data-key="${CSS.escape(key)}"] [data-answer]`, root);
    const ans = (st.app.answers || []).find((x) => x.key === key);
    const value = ctl ? readAnswer(ctl) : ans && ans.value;
    if (isEmptyValue(value)) { toast('Nothing to copy yet: answer it first.', 'info', { timeout: 2500 }); return; }
    copyText(Array.isArray(value) ? value.join(', ') : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value));
  });
  on(root, 'click', '[data-copy]', (e, el) => {
    const src = $(el.dataset.copy, root);
    if (src && src.value.trim()) copyText(src.value);
  });
  on(root, 'click', '[data-save-answer]', (e, el) => saveForReuse(el.dataset.saveAnswer, el));

  // Closing the tab with unsaved edits asks first; moving within the app just saves them on the way out.
  const onUnload = (e) => {
    if (hasPending() || st.inflight) { e.preventDefault(); e.returnValue = 'Your latest edits are still being saved.'; }
  };
  window.addEventListener('beforeunload', onUnload);

  render();
  return () => {
    st.leaving = true;
    saveSoon.cancel();
    if (hasPending()) flush().finally(() => window.removeEventListener('beforeunload', onUnload));
    else window.removeEventListener('beforeunload', onUnload);
  };
}
