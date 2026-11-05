// Jobs: find openings that match your CV, choose where to search, and keep the profile used for applications.
import { api, enc, DEMO } from '../api.js';
import {
  html, mount, loading, emptyState, errorState, toast, toastError, openModal, promptDialog, confirmDialog, trackJob,
  setBusy, replaceQuery, debounce, fmtRel, titleCase, plural, $, $$, on,
} from '../ui.js';
import { navigate, setLeaveGuard } from '../nav.js';
import {
  jobsNav, hitlNote, loadStats, reviewCount, limitText, recBadge, scoreBand, postingMeta, extLink, attributionHTML,
  SOURCE_KIND, splitList, fmtBytes, safeUrl, matchExplainHTML,
} from './jobs-common.js';

const REMOTE_LABEL = { onsite_ok: 'Remote, or on-site in my locations', remote_only: 'Remote only', any: 'Anywhere, remote or on-site' };
const SENIORITY = [['intern', 'Intern'], ['junior', 'Junior'], ['mid', 'Mid-level'], ['senior', 'Senior'],
  ['staff', 'Staff'], ['principal', 'Principal'], ['manager', 'Manager'], ['director', 'Director'], ['executive', 'Executive']];
const BOARD_KINDS = ['greenhouse', 'lever', 'ashby', 'smartrecruiters'];
const AGGREGATORS = [
  ['remotive', 'Remotive', 'Remote jobs from companies worldwide.'],
  ['arbeitnow', 'Arbeitnow', 'Jobs in Europe, many of them in Germany.'],
];

function whereText(sources, prefs) {
  const enabled = (sources || []).filter((s) => s.enabled).length;
  const agg = (prefs && prefs.aggregators) || {};
  const sites = AGGREGATORS.filter(([k]) => agg[k]).map(([, label]) => label);
  return { enabled, sites, any: enabled > 0 || sites.length > 0 };
}

// =================================================================================================
// #/jobs: search and matches
// =================================================================================================
export async function jobsSearch(root, { query, signal }) {
  document.title = 'Find jobs · Interview App';
  mount(root, loading('Loading jobs…'));
  const [profile, prefs, sources, stats] = await Promise.all([
    api('/api/careers/profile', { signal }),
    api('/api/careers/preferences', { signal }),
    api('/api/careers/sources', { signal }),
    loadStats(signal),
  ]);
  const st = {
    profile, prefs, sources, stats, matches: null, added: [], limit: 50, seq: 0, searching: false,
    q: query.get('q') || '', min: query.get('min') || '', rec: query.get('rec') || '',
  };

  function setup() {
    const where = whereText(st.sources, st.prefs);
    return {
      hasCv: String(st.profile.resume_text || '').trim().length >= 40,
      where,
      searched: !!(st.stats && st.stats.last_search_at),
    };
  }

  function guide(s) {
    if (s.hasCv && s.where.any && s.searched) return '';
    const cur = !s.hasCv ? 1 : !s.where.any ? 2 : 3;
    const step = (n, done, title, text, action) => html`<li class="setup-step ${done ? 'done' : ''} ${cur === n ? 'current' : ''}">
      <div class="row"><span class="n" aria-hidden="true">${done ? '✓' : n}</span><strong>${title}</strong>${done ? html`<span class="sr-only"> (done)</span>` : ''}</div>
      <p class="small muted">${text}</p><div>${action}</div></li>`;
    const btnCls = (n) => `btn ${cur === n ? 'btn-primary' : 'btn-secondary'} btn-sm`;
    const whereDone = `${plural(s.where.enabled, 'company board')}${s.where.sites.length ? ` and ${s.where.sites.join(' and ')}` : ''}.`;
    return html`<section class="card" aria-labelledby="guide-title">
      <div class="card-head"><h2 id="guide-title">Get started</h2><span class="subtle">Three steps</span></div>
      <ol class="setup-steps">
        ${step(1, s.hasCv, 'Add your CV', s.hasCv ? 'Your CV is in your profile.' : 'Upload it and check your contact details. Matching and drafts only use what it says.',
          html`<a class="${btnCls(1)}" href="#/jobs/profile">${s.hasCv ? 'Edit profile' : 'Add your CV'}</a>`)}
        ${step(2, s.where.any, 'Choose where to look', s.where.any ? whereDone : 'Pick company job boards from the suggestions, or paste a careers link.',
          html`<a class="${btnCls(2)}" href="#/jobs/sources">${s.where.any ? 'Manage sources' : 'Choose sources'}</a>`)}
        ${step(3, s.searched, 'Find matching jobs', 'The app reads every opening and ranks it against your CV.',
          html`<button type="button" class="${btnCls(3)}" data-action="search">Find jobs</button>`)}
      </ol>
      <div class="mt-3">${hitlNote()}</div>
    </section>`;
  }

  function renderShell() {
    const s = setup();
    mount(root, html`
      <div class="page-head">
        <div><h1>Jobs</h1>
          <p class="lead">Openings from company job boards, ranked against your CV. Prepare an application for the ones you like:
            the app drafts it, you check and approve it, and you submit it yourself.</p></div>
        <div class="actions">
          <button type="button" class="btn btn-primary" data-action="search">Find jobs</button>
          <button type="button" class="btn btn-secondary" data-action="manual">Paste a job</button>
        </div>
      </div>
      ${jobsNav('search', { review: reviewCount(st.stats) })}
      ${DEMO ? html`<div class="banner banner-info"><span class="banner-icon" aria-hidden="true">ℹ</span>
        <span>Demo: searches use about fifteen bundled sample openings from fictional companies. The installed app reads every
        job board you add, live, through the boards' official public APIs.</span></div>` : ''}
      ${guide(s)}
      <div id="search-job"></div>
      <section class="card card-tight" id="prefs-card" aria-labelledby="prefs-title"></section>
      <section class="stack" aria-labelledby="matches-title">
        <div class="row-between"><h2 id="matches-title" tabindex="-1">Matches</h2><span class="subtle" id="match-count" aria-live="polite"></span></div>
        <form class="filters" id="filters" role="search" aria-label="Filter matches">
          <label class="sr-only" for="f-q">Search matches</label>
          <input id="f-q" class="input" type="search" placeholder="Search title, company or skill" value="${st.q}" autocomplete="off">
          <label class="sr-only" for="f-min">Minimum score</label>
          <select id="f-min" class="select">
            ${[['', 'Any score'], ['50', 'Score 50+'], ['60', 'Score 60+'], ['70', 'Score 70+'], ['80', 'Score 80+']].map(([v, l]) => html`<option value="${v}" ${st.min === v ? 'selected' : ''}>${l}</option>`)}
          </select>
          <div class="segmented" role="radiogroup" aria-label="Recommendation">
            ${[['', 'All'], ['apply', 'Apply'], ['maybe', 'Maybe'], ['skip', 'Skip']].map(([v, l]) => html`<label><input type="radio" name="rec" value="${v}" ${st.rec === v ? 'checked' : ''}><span>${l}</span></label>`)}
          </div>
        </form>
        <div id="matches"></div>
      </section>
    `);
    renderPrefs();
    loadMatches();
  }

  function renderPrefs() {
    const p = st.prefs || {};
    const list = (arr, empty) => (arr && arr.length ? arr.join(', ') : html`<span class="subtle">${empty}</span>`);
    const where = whereText(st.sources, p);
    const stats = st.stats || {};
    const sen = (p.seniority || []).map((x) => (SENIORITY.find(([k]) => k === String(x).toLowerCase()) || [x, titleCase(x)])[1]);
    const last = stats.last_search || null;
    const count = (x) => Number(x || 0).toLocaleString();
    const cvTitles = !(p.titles && p.titles.length) && last && last.titles && last.titles.length ? last.titles : null;
    const errs = last && Array.isArray(last.errors) ? last.errors.length : 0;
    mount($('#prefs-card', root), html`
      <div class="card-head"><h2 id="prefs-title">What you're looking for</h2>
        <button type="button" class="btn btn-secondary btn-sm" data-action="edit-prefs">Edit</button></div>
      <dl class="kv">
        <dt>Job titles</dt><dd>${cvTitles ? html`${cvTitles.join(', ')} <span class="subtle">(from your CV)</span>` : list(p.titles, 'Taken from your CV')}</dd>
        <dt>Skills</dt><dd>${list(p.keywords, 'Taken from your CV')}</dd>
        <dt>Where</dt><dd>${list(p.locations, 'Your profile location')} · ${REMOTE_LABEL[p.remote] || p.remote || REMOTE_LABEL.onsite_ok}</dd>
        ${sen.length ? html`<dt>Seniority</dt><dd>${sen.join(', ')}</dd>` : ''}
        ${p.exclude_keywords && p.exclude_keywords.length ? html`<dt>Leave out</dt><dd>${p.exclude_keywords.join(', ')}</dd>` : ''}
        <dt>Searching</dt><dd>${where.any ? `${plural(where.enabled, 'company board')}${where.sites.length ? ` + ${where.sites.join(', ')}` : ''}` : html`<span class="subtle">Nothing yet. </span><a href="#/jobs/sources">Choose sources</a>`}</dd>
      </dl>
      <div class="item-meta mt-3">
        ${last ? html`<span title="Jobs read from your sources, then the ones relevant to your titles and skills, then the matches kept">Last search ${fmtRel(last.at)}:
            <strong>${count(last.fetched)}</strong> jobs → ${count(last.relevant)} relevant → <strong>${count(last.saved)}</strong> matches${last.apply ? ` (${count(last.apply)} to apply)` : ''}</span>`
    : html`<span>${stats.last_search_at ? `Last search ${fmtRel(stats.last_search_at)}` : 'No search yet'}</span>`}
        ${!last && stats.postings ? html`<span>${plural(stats.postings, 'match', 'matches')} saved</span>` : ''}
        ${errs ? html`<a class="warn-text" href="#/jobs/sources">${plural(errs, 'source')} couldn't be read</a>` : ''}
        <span>Hiding scores under ${p.min_score ?? 0}</span>
        ${limitText(stats) ? html`<span>${limitText(stats)}</span>` : ''}
        ${stats.last_search_at ? html`<button type="button" class="link-btn" data-action="refresh" title="Fetch every board again instead of using recent results">Refresh every board</button>` : ''}
      </div>`);
  }

  async function loadMatches() {
    const box = $('#matches', root);
    if (!box) return;
    const seq = ++st.seq;
    const params = new URLSearchParams();
    if (st.min) params.set('min_score', st.min);
    if (st.rec) params.set('recommendation', st.rec);
    if (st.q.trim()) params.set('q', st.q.trim());
    params.set('limit', String(st.limit));
    if (!st.matches) mount(box, loading('Loading matches…'));
    else box.setAttribute('aria-busy', 'true');
    try {
      const res = await api(`/api/careers/matches?${params}`, { signal });
      if (seq !== st.seq) return;
      st.matches = res || [];
      renderMatches();
    } catch (err) {
      if (err.name === 'AbortError' || seq !== st.seq) return;
      mount(box, errorState(err));
    } finally {
      if (seq === st.seq) box.removeAttribute('aria-busy');
    }
  }

  function allMatches() {
    const ids = new Set((st.matches || []).map((m) => m.posting && m.posting.id));
    return [...st.added.filter((m) => !ids.has(m.posting.id)), ...(st.matches || [])];
  }

  function renderMatches() {
    const box = $('#matches', root);
    if (!box) return;
    const list = allMatches();
    const more = (st.matches || []).length >= st.limit;
    $('#match-count', root).textContent = list.length ? `${plural(list.length, 'match', 'matches')}${more ? '+' : ''}` : '';
    if (!list.length) {
      const s = setup();
      const filtered = st.q.trim() || st.min || st.rec;
      mount(box, filtered
        ? emptyState({ title: 'No matches for these filters', text: 'Try a lower score or clear the search.', action: html`<button type="button" class="btn btn-secondary" data-action="clear-filters">Clear filters</button>` })
        : emptyState({
          title: s.searched ? 'No matches yet' : 'No search yet',
          text: s.searched ? 'Nothing passed your filters. Add more sources, widen your job titles, or lower the minimum score.' : 'Run a search to see openings ranked against your CV.',
          action: s.hasCv && s.where.any ? html`<button type="button" class="btn btn-primary" data-action="search">Find jobs</button>` : '',
        }));
      return;
    }
    mount(box, html`<div class="stack">${list.map(matchCard)}</div>
      ${more ? html`<div class="row mt-4" style="justify-content:center"><button type="button" class="btn btn-secondary" data-action="more">Show more</button></div>` : ''}`);
  }

  async function startSearch(refresh) {
    const s = setup();
    if (!s.hasCv) { toast('Add your CV to your profile first. Matching needs something to compare with.', 'warn'); navigate('#/jobs/profile'); return; }
    if (!s.where.any) { toast('Choose at least one place to search first.', 'warn'); navigate('#/jobs/sources'); return; }
    if (st.searching) return;
    st.searching = true;
    $$('[data-action="search"], [data-action="refresh"]', root).forEach((b) => { b.disabled = true; });
    try {
      const res = await api('/api/careers/search', { method: 'POST', body: refresh ? { refresh: true } : {} });
      const area = $('#search-job', root);
      await trackJob(area, res.job_id, {
        title: 'Finding jobs',
        subtitle: 'Reading every opening from your sources, then ranking each one against your CV. You can leave this page; it keeps running.',
        signal,
        onDone: async (job) => {
          const r = job.result || {};
          const n = r.matches ?? r.matched ?? r.saved ?? r.count;
          const checked = r.fetched ?? r.postings ?? r.total;
          const parts = [];
          if (checked !== undefined && checked !== null) parts.push(`${plural(Number(checked), 'opening')} checked`);
          if (n !== undefined && n !== null) parts.push(`${plural(Number(n), 'match', 'matches')}`);
          toast(`Search finished${parts.length ? `: ${parts.join(', ')}` : ''}.`, 'success', { timeout: 4000 });
          const errs = Array.isArray(r.errors) ? r.errors.length : Number(r.errors || 0);
          if (errs) toast(`${plural(errs, 'source')} couldn't be read. See Sources for details.`, 'warn', { timeout: 7000 });
          const [stats2, sources2] = await Promise.all([loadStats(signal), api('/api/careers/sources', { signal })]);
          st.stats = stats2; st.sources = sources2; st.matches = null;
          st.searching = false;
          renderShell();
          $('#matches-title', root)?.focus();
        },
      });
    } catch (err) {
      toastError(err);
    } finally {
      st.searching = false;
      $$('[data-action="search"], [data-action="refresh"]', root).forEach((b) => { b.disabled = false; });
    }
  }

  async function prepare(postingId, btn) {
    setBusy(btn, true, 'Preparing…');
    try {
      const res = await api('/api/careers/applications', { method: 'POST', body: { posting_id: postingId } });
      const app = res.application || res;
      navigate(`#/jobs/applications/${enc(app.id)}`);
    } catch (err) {
      toastError(err);
      setBusy(btn, false);
    }
  }

  async function dismiss(postingId, card, btn) {
    btn.disabled = true;
    try {
      await api(`/api/careers/postings/${enc(postingId)}/dismiss`, { method: 'POST', body: {} });
      st.matches = (st.matches || []).filter((m) => m.posting.id !== postingId);
      st.added = st.added.filter((m) => m.posting.id !== postingId);
      const next = card.nextElementSibling || card.previousElementSibling;
      card.remove();
      if (!allMatches().length) renderMatches();
      else {
        $('#match-count', root).textContent = plural(allMatches().length, 'match', 'matches');
        (next && $('button, a', next))?.focus();
      }
      toast("Hidden. It won't come back in future searches.", 'info', { timeout: 3000 });
    } catch (err) {
      btn.disabled = false;
      toastError(err);
    }
  }

  function manualDialog() {
    openModal({
      title: 'Add a job from anywhere',
      wide: true,
      body: html`<form class="stack" id="manual-form" novalidate>
        <p class="muted small">Found a job on LinkedIn, a company website or through a referral? Paste it here. It's scored against your CV like any other match,
          and you can prepare an application for it.</p>
        <div class="form-grid">
          <div class="field"><label for="mj-title">Job title</label><input id="mj-title" class="input" required autocomplete="off"></div>
          <div class="field"><label for="mj-company">Company</label><input id="mj-company" class="input" required autocomplete="off"></div>
          <div class="field"><label for="mj-location">Location <span class="subtle">(optional)</span></label><input id="mj-location" class="input" autocomplete="off" placeholder="e.g. Remote, or Pune"></div>
        </div>
        <div class="form-grid">
          <div class="field"><label for="mj-url">Link to the job <span class="subtle">(optional)</span></label><input id="mj-url" class="input" type="url" inputmode="url" placeholder="https://"></div>
          <div class="field"><label for="mj-apply">Link to the application form <span class="subtle">(optional)</span></label><input id="mj-apply" class="input" type="url" inputmode="url" placeholder="https://"></div>
        </div>
        <div class="field"><label for="mj-desc">Job description</label>
          <textarea id="mj-desc" class="textarea tall" required placeholder="Paste the whole job description, including the requirements."></textarea></div>
      </form>`,
      actions: [
        { label: 'Cancel', kind: 'btn-ghost' },
        {
          label: 'Add and score',
          kind: 'btn-primary',
          onClick: async (dlg) => {
            const val = (id) => $(id, dlg).value.trim();
            const body = { title: val('#mj-title'), company: val('#mj-company'), description_text: val('#mj-desc') };
            if (!body.title) { toast('Add the job title.', 'error'); $('#mj-title', dlg).focus(); return false; }
            if (!body.company) { toast('Add the company name.', 'error'); $('#mj-company', dlg).focus(); return false; }
            if (body.description_text.length < 80) { toast('Paste the full job description (at least a few lines).', 'error'); $('#mj-desc', dlg).focus(); return false; }
            for (const [key, id] of [['location', '#mj-location'], ['url', '#mj-url'], ['apply_url', '#mj-apply']]) {
              const v = val(id);
              if (!v) continue;
              if (key !== 'location' && !safeUrl(v)) { toast('Links must start with https:// or http://', 'error'); $(id, dlg).focus(); return false; }
              body[key] = v;
            }
            const match = await api('/api/careers/postings/manual', { method: 'POST', body });
            st.added = [match, ...st.added.filter((m) => m.posting.id !== match.posting.id)];
            renderMatches();
            toast(`Added and scored: ${Math.round(Number(match.score) || 0)} out of 100.`, 'success', { timeout: 3500 });
            setTimeout(() => $(`[data-posting="${CSS.escape(match.posting.id)}"] button`, root)?.focus(), 50);
            return true;
          },
        },
      ],
    });
    document.getElementById('mj-title')?.focus(); // the dialog is already open; a delayed focus could steal typing
  }

  function prefsDialog() {
    const p = st.prefs || {};
    const agg = p.aggregators || {};
    const known = new Set(SENIORITY.map(([k]) => k));
    const chosen = new Set((p.seniority || []).map((x) => String(x).toLowerCase()));
    const extraSeniority = (p.seniority || []).filter((x) => !known.has(String(x).toLowerCase()));
    openModal({
      title: 'What are you looking for?',
      wide: true,
      body: html`<form class="stack" id="prefs-form" novalidate>
        <div class="field"><label for="pf-titles">Job titles</label>
          <input id="pf-titles" class="input" value="${(p.titles || []).join(', ')}" placeholder="e.g. Machine Learning Engineer, Backend Engineer" autocomplete="off">
          <span class="hint">Separate with commas. Leave empty to use the titles in your CV.</span></div>
        <div class="field"><label for="pf-keywords">Skills and keywords</label>
          <input id="pf-keywords" class="input" value="${(p.keywords || []).join(', ')}" placeholder="e.g. PyTorch, LLMs, Kafka" autocomplete="off">
          <span class="hint">Openings that mention these rank higher. Leave empty to use the skills in your CV.</span></div>
        <div class="field"><label for="pf-exclude">Leave out jobs that mention</label>
          <input id="pf-exclude" class="input" value="${(p.exclude_keywords || []).join(', ')}" placeholder="e.g. unpaid, commission only, security clearance" autocomplete="off"></div>
        <div class="field"><label for="pf-locations">Locations</label>
          <input id="pf-locations" class="input" value="${(p.locations || []).join(', ')}" placeholder="e.g. Bengaluru, Pune, Remote" autocomplete="off">
          <span class="hint">Cities or countries you'd work in. Leave empty to use the location in your profile.</span></div>
        <fieldset><legend>Remote work</legend>
          <div class="segmented">${Object.entries(REMOTE_LABEL).map(([k, label]) => html`<label><input type="radio" name="pf-remote" value="${k}" ${(p.remote || 'onsite_ok') === k ? 'checked' : ''}><span>${label}</span></label>`)}</div>
        </fieldset>
        <fieldset><legend>Seniority <span class="subtle">(optional)</span></legend>
          <div class="row check-row">${SENIORITY.map(([k, label]) => html`<label class="check"><input type="checkbox" name="pf-seniority" value="${k}" ${chosen.has(k) ? 'checked' : ''}><span>${label}</span></label>`)}</div>
        </fieldset>
        <div class="form-grid">
          <div class="field"><label for="pf-min">Minimum match score</label>
            <input id="pf-min" class="input" type="number" min="0" max="100" step="5" value="${p.min_score ?? 45}" inputmode="numeric">
            <span class="hint">Matches below this score are hidden.</span></div>
          <div class="field"><label for="pf-max">Most matches to keep</label>
            <input id="pf-max" class="input" type="number" min="10" max="500" step="10" value="${p.max_results ?? 150}" inputmode="numeric"></div>
        </div>
        <fieldset><legend>Also search these job sites</legend>
          <div class="stack-sm">${AGGREGATORS.map(([k, label, text]) => html`<label class="check"><input type="checkbox" name="pf-agg" value="${k}" ${agg[k] ? 'checked' : ''}><span><strong>${label}</strong>: ${text}</span></label>`)}</div>
        </fieldset>
      </form>`,
      actions: [
        { label: 'Cancel', kind: 'btn-ghost' },
        {
          label: 'Save',
          kind: 'btn-primary',
          onClick: async (dlg) => {
            const minScore = Number($('#pf-min', dlg).value);
            const maxResults = Number($('#pf-max', dlg).value);
            if (!Number.isFinite(minScore) || minScore < 0 || minScore > 100) { toast('The minimum score must be between 0 and 100.', 'error'); return false; }
            if (!Number.isFinite(maxResults) || maxResults < 10 || maxResults > 500) { toast('Keep between 10 and 500 matches.', 'error'); return false; }
            const aggregators = { ...agg };
            AGGREGATORS.forEach(([k]) => { aggregators[k] = !!dlg.querySelector(`input[name="pf-agg"][value="${k}"]`).checked; });
            const body = {
              titles: splitList($('#pf-titles', dlg).value),
              keywords: splitList($('#pf-keywords', dlg).value),
              exclude_keywords: splitList($('#pf-exclude', dlg).value),
              locations: splitList($('#pf-locations', dlg).value),
              remote: (dlg.querySelector('input[name="pf-remote"]:checked') || {}).value || 'onsite_ok',
              seniority: [...$$('input[name="pf-seniority"]:checked', dlg).map((i) => i.value), ...extraSeniority],
              min_score: Math.round(minScore),
              max_results: Math.round(maxResults),
              aggregators,
            };
            st.prefs = await api('/api/careers/preferences', { method: 'PUT', body });
            renderPrefs();
            toast('Saved. Run a new search to use them.', 'success', { timeout: 3500 });
            return true;
          },
        },
      ],
    });
  }

  // --- events (delegated once; the root element survives re-renders) ---
  on(root, 'click', '[data-action]', (e, el) => {
    const action = el.dataset.action;
    if (action === 'search') startSearch(false);
    else if (action === 'refresh') startSearch(true);
    else if (action === 'manual') manualDialog();
    else if (action === 'edit-prefs') prefsDialog();
    else if (action === 'more') { st.limit += 50; loadMatches(); }
    else if (action === 'retry') loadMatches();
    else if (action === 'clear-filters') {
      st.q = ''; st.min = ''; st.rec = '';
      replaceQuery({ q: null, min: null, rec: null });
      $('#f-q', root).value = '';
      $('#f-min', root).value = '';
      const all = $('input[name="rec"][value=""]', root);
      if (all) all.checked = true;
      loadMatches();
    } else {
      const card = el.closest('[data-posting]');
      if (!card) return;
      if (action === 'prepare') prepare(card.dataset.posting, el);
      else if (action === 'dismiss') dismiss(card.dataset.posting, card, el);
    }
  });
  const onSearchInput = debounce(() => { st.limit = 50; replaceQuery({ q: st.q.trim() || null }); loadMatches(); }, 300);
  on(root, 'input', '#f-q', (e, el) => { st.q = el.value; onSearchInput(); });
  on(root, 'change', '#f-min', (e, el) => { st.min = el.value; st.limit = 50; replaceQuery({ min: st.min || null }); loadMatches(); });
  on(root, 'change', 'input[name="rec"]', (e, el) => { st.rec = el.value; st.limit = 50; replaceQuery({ rec: st.rec || null }); loadMatches(); });
  on(root, 'submit', '#filters', (e) => { e.preventDefault(); onSearchInput.flush(); });
  // Full description on demand (the list only carries a snippet).
  root.addEventListener('toggle', async (e) => {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement) || !d.matches('[data-desc]') || !d.open || d.dataset.loaded) return;
    d.dataset.loaded = '1';
    const card = d.closest('[data-posting]');
    try {
      const p = await api(`/api/careers/postings/${enc(card.dataset.posting)}`, { signal });
      if (p && p.description_text) $('.desc-body', d).textContent = p.description_text;
    } catch (err) {
      if (err.name !== 'AbortError') d.dataset.loaded = '';
    }
  }, true);

  renderShell();
  return () => onSearchInput.cancel();
}

function matchCard(m) {
  const p = m.posting || {};
  const score = Math.round(Number(m.score) || 0);
  const hasLlm = m.llm_score !== null && m.llm_score !== undefined;
  const tip = `Rules score ${m.det_score ?? '–'}${hasLlm ? `, AI rerank ${m.llm_score}` : ' (not reranked by AI)'}`;
  const reasons = m.reasons || [];
  const gaps = m.gaps || [];
  const flags = m.red_flags || [];
  return html`<article class="card match-card" data-posting="${p.id}" aria-labelledby="m-${p.id}">
    <div class="match-score" title="${tip}">
      <div class="score-num ${scoreBand(score)}"><span class="sr-only">Match score </span>${score}<span class="sr-only"> out of 100</span></div>
      <div class="subtle small" aria-hidden="true">/ 100</div>
      ${recBadge(m.recommendation)}
    </div>
    <div class="match-main">
      <h3 class="match-title" id="m-${p.id}">${p.title || 'Untitled role'}</h3>
      ${postingMeta(p)}
      ${reasons.length || gaps.length || flags.length ? html`<div class="why-grid">
        ${reasons.length ? html`<div><div class="section-title">Why it fits</div><ul class="list list-check small">${reasons.map((r) => html`<li>${r}</li>`)}</ul></div>` : ''}
        ${gaps.length ? html`<div><div class="section-title">Gaps</div><ul class="list list-arrow small">${gaps.map((g) => html`<li>${g}</li>`)}</ul></div>` : ''}
        ${flags.length ? html`<div><div class="section-title">Watch out</div><ul class="list list-flag small">${flags.map((f) => html`<li>${f}</li>`)}</ul></div>` : ''}
      </div>` : ''}
      ${matchExplainHTML(m) ? html`<details class="desc"><summary>How it matches your CV</summary><div class="mt-2">${matchExplainHTML(m)}</div></details>` : ''}
      ${p.description_snippet ? html`<details class="desc" data-desc><summary>About the role</summary><div class="desc-body small muted pre">${p.description_snippet}</div></details>` : ''}
      <div class="match-actions">
        ${m.application_id
    ? html`<a class="btn btn-secondary btn-sm" href="#/jobs/applications/${enc(m.application_id)}">Open application</a>`
    : html`<button type="button" class="btn btn-primary btn-sm" data-action="prepare">Prepare application</button>`}
        ${extLink(p.url, 'View job', { cls: 'btn btn-ghost btn-sm' })}
        ${m.application_id ? '' : html`<button type="button" class="btn btn-ghost btn-sm" data-action="dismiss">Not interested</button>`}
        <span class="spacer"></span>
        ${attributionHTML(p)}
      </div>
    </div>
  </article>`;
}

// =================================================================================================
// #/jobs/sources: company boards and job sites
// =================================================================================================
export async function jobsSources(root, { signal }) {
  document.title = 'Sources · Jobs · Interview App';
  mount(root, loading('Loading sources…'));
  const [sources, suggestions, prefs, stats] = await Promise.all([
    api('/api/careers/sources', { signal }),
    api('/api/careers/sources/suggestions', { signal }).catch((err) => { if (err.name === 'AbortError') throw err; return []; }),
    api('/api/careers/preferences', { signal }),
    loadStats(signal),
  ]);
  const st = { sources: sources || [], suggestions: suggestions || [], prefs: prefs || {}, stats, filter: '', tag: '' };
  const key = (kind, token) => `${kind}:${String(token).toLowerCase()}`;

  mount(root, html`
    <div class="page-head">
      <div><h1>Jobs</h1>
        <p class="lead">Where the app looks for openings. It reads company job boards through their official public APIs
          (Greenhouse, Lever, Ashby and SmartRecruiters): no scraping and no logins.</p></div>
    </div>
    ${jobsNav('sources', { review: reviewCount(stats) })}
    ${DEMO ? html`<div class="banner banner-info"><span class="banner-icon" aria-hidden="true">ℹ</span>
      <span>Demo: you can add boards here, but searches only use the bundled sample openings. The installed app checks each board when you add it and reads it live on every search.</span></div>` : ''}
    <div class="grid-2">
      <section class="card" aria-labelledby="add-title">
        <div class="card-head"><h2 id="add-title">Add a company</h2></div>
        <form class="stack-sm" id="detect-form" novalidate>
          <label class="field-label" for="src-url">Link to the company's job board or one of its jobs</label>
          <div class="input-row">
            <input id="src-url" class="input" type="url" inputmode="url" placeholder="https://jobs.lever.co/company" autocomplete="off">
            <button type="submit" class="btn btn-primary">Add</button>
          </div>
          <span class="small subtle">Works with links from Greenhouse, Lever, Ashby and SmartRecruiters, e.g.
            <code>boards.greenhouse.io/company</code> or <code>jobs.ashbyhq.com/company/…</code></span>
        </form>
        <details class="mt-4">
          <summary>Add by platform and board name</summary>
          <form class="stack-sm mt-3" id="manual-src-form" novalidate>
            <div class="form-grid">
              <div class="field"><label for="src-kind">Platform</label>
                <select id="src-kind" class="select">${BOARD_KINDS.map((k) => html`<option value="${k}">${SOURCE_KIND[k]}</option>`)}</select></div>
              <div class="field"><label for="src-token">Board name</label>
                <input id="src-token" class="input" placeholder="e.g. stripe" autocomplete="off" spellcheck="false">
                <span class="hint">The part of the link after the platform's address.</span></div>
              <div class="field"><label for="src-name">Company name <span class="subtle">(optional)</span></label>
                <input id="src-name" class="input" autocomplete="off"></div>
            </div>
            <div><button type="submit" class="btn btn-secondary">Add board</button></div>
          </form>
        </details>
      </section>
      <section class="card" aria-labelledby="agg-title">
        <div class="card-head"><h2 id="agg-title">Job sites</h2></div>
        <p class="muted small">Public job sites with open APIs. Their jobs link back to the site and name it as the source, as their terms ask.</p>
        <ul class="list-plain mt-3" id="agg-list"></ul>
      </section>
    </div>
    <section class="card" aria-labelledby="mine-title">
      <div class="card-head"><h2 id="mine-title">Your company boards</h2><span class="subtle" id="mine-count" aria-live="polite"></span></div>
      <div class="input-row mb-2"><label class="sr-only" for="mine-filter">Filter your boards</label>
        <input id="mine-filter" class="input" type="search" placeholder="Filter by company, platform or tag" autocomplete="off"></div>
      <div id="mine"></div>
    </section>
    <section class="card" aria-labelledby="sugg-title">
      <div class="card-head"><h2 id="sugg-title">Suggested boards</h2><span class="subtle">Public boards checked to work. Tap one to add it.</span></div>
      <div id="suggest"></div>
    </section>
  `);

  function renderAgg() {
    const agg = st.prefs.aggregators || {};
    mount($('#agg-list', root), html`${AGGREGATORS.map(([k, label, text]) => html`<li class="source-row">
      <input type="checkbox" class="switch" role="switch" id="agg-${k}" data-agg="${k}" ${agg[k] ? 'checked' : ''}>
      <label class="main" for="agg-${k}"><span class="t">${label}</span><span class="small muted">${text}</span></label>
    </li>`)}`);
  }

  function renderMine() {
    const all = [...st.sources].sort((a, b) => (Number(!!b.enabled) - Number(!!a.enabled))
      || String(a.name || a.token).localeCompare(String(b.name || b.token)));
    const enabled = all.filter((s) => s.enabled).length;
    $('#mine-count', root).textContent = all.length ? `${enabled} of ${all.length} searched` : '';
    const f = st.filter.trim().toLowerCase();
    const list = f ? all.filter((s) => `${s.name} ${s.token} ${SOURCE_KIND[s.kind] || s.kind} ${(s.tags || []).join(' ')}`.toLowerCase().includes(f)) : all;
    if (!all.length) {
      mount($('#mine', root), emptyState({ title: 'No company boards yet', text: 'Add one above, or pick from the suggestions below.' }));
      return;
    }
    if (!list.length) {
      mount($('#mine', root), html`<p class="subtle">No boards match "${st.filter.trim()}".</p>`);
      return;
    }
    mount($('#mine', root), html`<ul class="list-plain source-list">${list.map((s) => html`<li class="source-row" data-id="${s.id}">
      <input type="checkbox" class="switch" role="switch" id="src-${s.id}" data-toggle ${s.enabled ? 'checked' : ''}>
      <div class="main">
        <label class="t" for="src-${s.id}">${s.name || s.token}</label>
        <div class="item-meta"><span class="badge">${SOURCE_KIND[s.kind] || s.kind}</span><code>${s.token}</code>
          <span>${s.job_count === null || s.job_count === undefined ? 'Not read yet' : plural(s.job_count, 'open job')}</span>
          ${s.last_fetched ? html`<span>Read ${fmtRel(s.last_fetched)}</span>` : ''}
          ${s.tags && s.tags.length ? html`<span>${s.tags.join(' · ')}</span>` : ''}</div>
        ${s.last_error ? html`<p class="small err-text"><span aria-hidden="true">⚠ </span>${s.last_error}</p>` : ''}
      </div>
      <div class="row row-actions">
        <button type="button" class="btn btn-ghost btn-sm" data-rename>Rename<span class="sr-only"> ${s.name || s.token}</span></button>
        <button type="button" class="btn btn-ghost btn-sm" data-remove>Remove<span class="sr-only"> ${s.name || s.token}</span></button>
      </div>
    </li>`)}</ul>`);
  }

  function suggestionState() {
    const mine = new Set(st.sources.map((s) => key(s.kind, s.token)));
    const open = st.suggestions.filter((s) => !s.added && !mine.has(key(s.kind, s.token)));
    const counts = new Map();
    open.forEach((s) => (s.tags || []).forEach((t) => counts.set(t, (counts.get(t) || 0) + 1)));
    if (st.tag && !counts.has(st.tag)) st.tag = '';
    return { open, counts, shown: open.filter((s) => !st.tag || (s.tags || []).includes(st.tag)) };
  }

  function renderSuggestions() {
    const box = $('#suggest', root);
    if (!st.suggestions.length) {
      mount(box, html`<p class="subtle">No suggestions available.</p>`);
      return;
    }
    const { open, counts, shown } = suggestionState();
    if (!open.length) {
      mount(box, html`<p class="muted small">All ${st.suggestions.length} suggested boards are in your list. Remove one and it shows up here again.</p>`);
      return;
    }
    const tags = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    mount(box, html`
      <div class="chips" role="group" aria-label="Show suggestions for">
        ${[['', `All ${open.length}`], ...tags.map(([t, n]) => [t, `${t} ${n}`])].map(([t, label]) => html`<button type="button"
          class="chip chip-btn ${st.tag === t ? 'chip-on' : ''}" data-tag="${t}" aria-pressed="${st.tag === t ? 'true' : 'false'}">${label}</button>`)}
      </div>
      <div class="chips mt-3">${shown.map((s) => html`<button type="button" class="chip-add" data-sugg="${key(s.kind, s.token)}"
        aria-label="Add ${s.name} (${SOURCE_KIND[s.kind] || s.kind})"><span aria-hidden="true">+</span>${s.name}<span class="k">${SOURCE_KIND[s.kind] || s.kind}</span></button>`)}</div>
      ${shown.length > 1 ? html`<div class="mt-3"><button type="button" class="btn btn-secondary btn-sm" data-add-shown>Add all ${shown.length}${st.tag ? ` ${st.tag}` : ''} boards</button></div>` : ''}`);
  }

  async function addSource(body, { quiet = false } = {}) {
    const exists = st.sources.find((s) => key(s.kind, s.token) === key(body.kind, body.token));
    if (exists) {
      if (!quiet) toast(`${exists.name || exists.token} is already in your sources.`, 'info', { timeout: 3000 });
      return exists;
    }
    const payload = { kind: body.kind, token: body.token };
    if (body.name) payload.name = body.name;
    const src = await api('/api/careers/sources', { method: 'POST', body: payload });
    st.sources.push(src);
    st.suggestions.forEach((s) => { if (key(s.kind, s.token) === key(src.kind, src.token)) s.added = true; });
    if (!quiet) {
      const jobs = src.job_count === null || src.job_count === undefined ? '' : `: ${plural(src.job_count, 'open job')}`;
      toast(`Added ${src.name || src.token}${jobs}.`, 'success', { timeout: 3500 });
    }
    return src;
  }

  on(root, 'submit', '#detect-form', async (e) => {
    e.preventDefault();
    const input = $('#src-url', root);
    const url = input.value.trim();
    if (!url) { toast('Paste a link to a job board or job first.', 'error'); input.focus(); return; }
    const btn = e.target.querySelector('button[type=submit]');
    setBusy(btn, true, 'Checking…');
    try {
      const found = await api('/api/careers/sources/detect', { method: 'POST', body: { url } });
      await addSource({ kind: found.kind, token: found.token, name: found.name });
      input.value = '';
      renderMine(); renderSuggestions();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(btn, false);
    }
  });
  on(root, 'submit', '#manual-src-form', async (e) => {
    e.preventDefault();
    const token = $('#src-token', root).value.trim();
    if (!token) { toast('Add the board name.', 'error'); $('#src-token', root).focus(); return; }
    const btn = e.target.querySelector('button[type=submit]');
    setBusy(btn, true, 'Checking…');
    try {
      await addSource({ kind: $('#src-kind', root).value, token, name: $('#src-name', root).value.trim() });
      $('#src-token', root).value = '';
      $('#src-name', root).value = '';
      renderMine(); renderSuggestions();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(btn, false);
    }
  });
  on(root, 'change', '[data-agg]', async (e, el) => {
    const aggregators = { ...(st.prefs.aggregators || {}), [el.dataset.agg]: el.checked };
    el.disabled = true;
    try {
      st.prefs = await api('/api/careers/preferences', { method: 'PUT', body: { aggregators } });
    } catch (err) {
      el.checked = !el.checked;
      toastError(err);
    } finally {
      el.disabled = false;
    }
  });
  on(root, 'change', '[data-toggle]', async (e, el) => {
    const id = el.closest('[data-id]').dataset.id;
    el.disabled = true;
    try {
      const updated = await api(`/api/careers/sources/${enc(id)}`, { method: 'PUT', body: { enabled: el.checked } });
      st.sources = st.sources.map((s) => (s.id === id ? { ...s, ...updated } : s));
      $('#mine-count', root).textContent = `${st.sources.filter((s) => s.enabled).length} of ${st.sources.length} searched`;
    } catch (err) {
      el.checked = !el.checked;
      toastError(err);
    } finally {
      el.disabled = false;
    }
  });
  on(root, 'click', '[data-rename]', async (e, el) => {
    const id = el.closest('[data-id]').dataset.id;
    const src = st.sources.find((s) => s.id === id);
    const name = await promptDialog({ title: 'Rename board', label: 'Company name', value: src.name || src.token });
    if (!name || name === src.name) return;
    try {
      const updated = await api(`/api/careers/sources/${enc(id)}`, { method: 'PUT', body: { name } });
      st.sources = st.sources.map((s) => (s.id === id ? { ...s, ...updated } : s));
      renderMine();
    } catch (err) { toastError(err); }
  });
  on(root, 'click', '[data-remove]', async (e, el) => {
    const id = el.closest('[data-id]').dataset.id;
    const src = st.sources.find((s) => s.id === id);
    const ok = await confirmDialog({
      title: `Remove ${src.name || src.token}?`,
      message: "Its jobs won't appear in new searches. Applications you already prepared stay.",
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/careers/sources/${enc(id)}`, { method: 'DELETE' });
      st.sources = st.sources.filter((s) => s.id !== id);
      st.suggestions.forEach((s) => { if (key(s.kind, s.token) === key(src.kind, src.token)) s.added = false; });
      renderMine(); renderSuggestions();
      toast('Removed.', 'info', { timeout: 2500 });
    } catch (err) { toastError(err); }
  });
  on(root, 'input', '#mine-filter', (e, el) => { st.filter = el.value; renderMine(); });
  on(root, 'click', '[data-tag]', (e, el) => {
    st.tag = el.dataset.tag;
    renderSuggestions();
    $(`[data-tag="${CSS.escape(st.tag)}"]`, root)?.focus();
  });
  on(root, 'click', '[data-sugg]', async (e, el) => {
    const sugg = st.suggestions.find((s) => key(s.kind, s.token) === el.dataset.sugg);
    if (!sugg) return;
    const next = el.nextElementSibling || el.previousElementSibling;
    const nextKey = next && next.dataset.sugg;
    el.disabled = true;
    try {
      await addSource(sugg);
      renderMine(); renderSuggestions();
      ((nextKey && $(`[data-sugg="${CSS.escape(nextKey)}"]`, root)) || $('#sugg-title', root))?.focus();
    } catch (err) {
      el.disabled = false;
      toastError(err);
    }
  });
  on(root, 'click', '[data-add-shown]', async (e, el) => {
    const todo = suggestionState().shown;
    setBusy(el, true, 'Adding…');
    let added = 0;
    const failed = [];
    for (const s of todo) {
      if (signal.aborted) return;
      try {
        await addSource(s, { quiet: true });
        added += 1;
      } catch (err) {
        failed.push(`${s.name}: ${err.detail || err.message}`);
      }
      renderMine();
    }
    renderSuggestions();
    toast(`Added ${plural(added, 'board')}.`, 'success', { timeout: 3000 });
    if (failed.length) toast(`Couldn't add ${failed.length}: ${failed.join('; ')}`, 'error', { timeout: 9000 });
  });

  renderAgg();
  renderMine();
  renderSuggestions();
}

// =================================================================================================
// #/jobs/profile: the facts used to fill forms and write drafts
// =================================================================================================
const CONTACT_FIELDS = [
  ['full_name', 'Full name', { auto: 'name' }],
  ['first_name', 'First name', { auto: 'given-name' }],
  ['last_name', 'Last name', { auto: 'family-name' }],
  ['email', 'Email', { type: 'email', auto: 'email' }],
  ['phone', 'Phone', { type: 'tel', auto: 'tel', placeholder: 'With country code, e.g. +91 …' }],
  ['location', 'City', { auto: 'address-level2', placeholder: 'e.g. Bengaluru' }],
  ['country', 'Country', { auto: 'country-name', placeholder: 'e.g. India' }],
  ['linkedin_url', 'LinkedIn', { type: 'url', placeholder: 'https://www.linkedin.com/in/…' }],
  ['github_url', 'GitHub', { type: 'url', placeholder: 'https://github.com/…' }],
  ['portfolio_url', 'Website or portfolio', { type: 'url', placeholder: 'https://' }],
];
const WORK_FIELDS = [
  ['current_title', 'Current job title', {}],
  ['current_company', 'Current company', {}],
  ['years_experience', 'Years of experience', { type: 'number', step: '0.5', min: '0', max: '60' }],
  ['notice_period', 'Notice period', { placeholder: 'e.g. 30 days' }],
  ['earliest_start', 'Earliest start date', { placeholder: 'e.g. 1 March 2027, or Immediately' }],
  ['salary_expectation', 'Salary expectation', { placeholder: 'e.g. ₹45 LPA, or €80,000', hint: 'Used only for salary questions, exactly as written. Leave it empty to answer each time yourself.' }],
];
const TEXT_KEYS = [...CONTACT_FIELDS, ...WORK_FIELDS].map(([k]) => k).filter((k) => k !== 'years_experience').concat(['extra_facts', 'resume_text']);

function triState(v) {
  return v === true ? 'true' : v === false ? 'false' : '';
}
function fromTriState(s) {
  return s === 'true' ? true : s === 'false' ? false : null;
}
function normYears(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function sortedJson(obj) {
  const o = obj || {};
  return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
}

export async function jobsProfile(root, { signal }) {
  document.title = 'Profile · Jobs · Interview App';
  mount(root, loading('Loading your profile…'));
  const [profile, stats] = await Promise.all([api('/api/careers/profile', { signal }), loadStats(signal)]);
  const st = { profile, saving: false };

  const field = ([k, label, o = {}]) => html`<div class="field">
    <label for="pf-${k}">${label}</label>
    <input id="pf-${k}" class="input" data-field="${k}" type="${o.type || 'text'}" ${o.auto ? html`autocomplete="${o.auto}"` : html`autocomplete="off"`}
      ${o.placeholder ? html`placeholder="${o.placeholder}"` : ''} ${o.step ? html`step="${o.step}"` : ''} ${o.min ? html`min="${o.min}"` : ''} ${o.max ? html`max="${o.max}"` : ''}
      ${o.type === 'number' ? html`inputmode="decimal"` : ''}>
    ${o.hint ? html`<span class="hint">${o.hint}</span>` : ''}
  </div>`;

  mount(root, html`
    <div class="page-head">
      <div><h1>Jobs</h1>
        <p class="lead">The facts used to match jobs, fill application forms and write drafts. Drafts may only say what's here or in your CV.</p></div>
    </div>
    ${jobsNav('profile', { review: reviewCount(stats) })}
    <form id="profile-form" class="stack" novalidate>
      <section class="card" aria-labelledby="cv-title">
        <div class="card-head"><h2 id="cv-title">Your CV</h2>
          <div class="row">
            <span class="btn btn-primary btn-sm file-btn">Upload CV<input type="file" id="cv-file" accept=".pdf,.docx,.txt,.md" aria-label="Upload your CV (PDF, DOCX, TXT or MD)"></span>
            <button type="button" class="btn btn-secondary btn-sm" data-action="import">Use the CV from Prep</button>
          </div>
        </div>
        <p class="small" id="cv-status"></p>
        <div class="field mt-3">
          <label for="pf-resume_text">CV text</label>
          <textarea id="pf-resume_text" class="textarea tall" data-field="resume_text" placeholder="Upload your CV, or paste its text here."></textarea>
          <span class="hint"><span id="cv-count">0 characters</span>. This is what matching, drafts and the truth check read. Fix anything the upload got wrong.</span>
        </div>
      </section>

      <section class="card" aria-labelledby="contact-title">
        <div class="card-head"><h2 id="contact-title">Contact details</h2></div>
        <div class="form-grid">${CONTACT_FIELDS.map(field)}</div>
      </section>

      <section class="card" aria-labelledby="work-title">
        <div class="card-head"><h2 id="work-title">Work</h2></div>
        <div class="form-grid">
          ${WORK_FIELDS.map(field)}
          <div class="field"><label for="pf-willing_to_relocate">Willing to relocate</label>
            <select id="pf-willing_to_relocate" class="select" data-tri="willing_to_relocate"><option value="">Not set: ask me</option><option value="true">Yes</option><option value="false">No</option></select></div>
        </div>
        <h3 class="mt-4">Work authorization</h3>
        <p class="small muted">Used only to flag jobs you may need a visa for. Work-authorization and sponsorship questions on a form are
          never answered from this: you answer them in the review, or save an answer below to reuse.</p>
        <div class="form-grid mt-2">
          <div class="field"><label for="pf-auth">Countries where you can already work</label>
            <input id="pf-auth" class="input" data-list="work_authorized_countries" placeholder="e.g. India" autocomplete="off">
            <span class="hint">Separate with commas.</span></div>
          <div class="field"><label for="pf-needs_sponsorship">Need visa sponsorship?</label>
            <select id="pf-needs_sponsorship" class="select" data-tri="needs_sponsorship"><option value="">Not set: ask me each time</option><option value="true">Yes</option><option value="false">No</option></select></div>
        </div>
      </section>

      <section class="card" aria-labelledby="facts-title">
        <div class="card-head"><h2 id="facts-title">Extra facts</h2></div>
        <div class="field">
          <label for="pf-extra_facts">True things about you that aren't in your CV</label>
          <textarea id="pf-extra_facts" class="textarea" data-field="extra_facts" placeholder="e.g. Led a 4-person team during 2024. Certified AWS Solutions Architect (2025). Fluent in Hindi and German (B2)."></textarea>
          <span class="hint">Drafts may use these, and the truth check accepts them. Only add what you can back up in an interview.</span>
        </div>
      </section>

      <section class="card" aria-labelledby="saved-title">
        <div class="card-head"><h2 id="saved-title">Saved answers</h2><button type="button" class="btn btn-secondary btn-sm" data-action="add-answer">Add answer</button></div>
        <p class="small muted">Answers you wrote or approved, reused when a form asks the same question. This is how you answer
          legal and salary questions once, in your own words: the AI never answers them.</p>
        <div id="saved-list" class="stack-sm mt-3"></div>
      </section>

      <section class="card card-tight" aria-labelledby="how-title">
        <h2 id="how-title" class="mb-2">How the app uses this</h2>
        <ul class="list small">
          <li>Contact and work details fill the matching form fields, exactly as written here.</li>
          <li>Open questions such as "Why do you want to work here?" are drafted from your CV. You check every draft.</li>
          <li>Legal and salary questions are never answered by the AI. They come only from your saved answers, or you answer them in the review.</li>
          <li>Consent boxes and voluntary self-identification questions (gender, ethnicity, veteran or disability status) are always left for you to answer on the employer's form. The app never fills them.</li>
          <li>Everything stays on this computer${DEMO ? ' (in the demo, in this browser)' : ''}.</li>
        </ul>
      </section>

      <div class="save-bar" role="region" aria-label="Save profile">
        <span class="save-state" id="save-state" aria-live="polite">All changes saved</span>
        <button type="submit" class="btn btn-primary" id="save-btn" disabled>Save profile</button>
      </div>
    </form>
  `);

  const form = $('#profile-form', root);

  function savedRow(label = '', answer = '') {
    return html`<div class="kv-edit" data-saved-row>
      <div class="field"><label class="sr-only">Question</label><input class="input" data-saved-q value="${label}" placeholder="Question, as forms ask it" autocomplete="off"></div>
      <div class="field"><label class="sr-only">Your answer</label><textarea class="textarea short" data-saved-a placeholder="Your answer">${answer}</textarea></div>
      <button type="button" class="btn btn-ghost btn-sm" data-action="remove-answer">Remove</button>
    </div>`;
  }

  function renderSaved(map) {
    const entries = Object.entries(map || {});
    mount($('#saved-list', root), entries.length ? html`${entries.map(([q, a]) => savedRow(q, a))}`
      : html`<p class="subtle" data-saved-empty>No saved answers yet. Use "Save for reuse" on an application, or add one here.</p>`);
    $$('[data-saved-row]', root).forEach((row, i) => {
      const q = $('[data-saved-q]', row);
      const a = $('[data-saved-a]', row);
      q.id = `sq-${i}`; a.id = `sa-${i}`;
      q.previousElementSibling.htmlFor = q.id;
      a.previousElementSibling.htmlFor = a.id;
      q.previousElementSibling.textContent = `Question ${i + 1}`;
      a.previousElementSibling.textContent = `Answer ${i + 1}`;
    });
  }

  function fillForm(p) {
    $$('[data-field]', form).forEach((el) => {
      const k = el.dataset.field;
      el.value = k === 'years_experience' ? (normYears(p[k]) ?? '') : (p[k] ?? '');
    });
    $$('[data-tri]', form).forEach((el) => { el.value = triState(p[el.dataset.tri]); });
    $$('[data-list]', form).forEach((el) => { el.value = (p[el.dataset.list] || []).join(', '); });
    renderSaved(p.saved_answers);
    renderCvStatus();
  }

  function renderCvStatus() {
    const p = st.profile;
    const f = p.resume_file;
    const text = $('#pf-resume_text', form).value;
    $('#cv-count', root).textContent = `${text.length.toLocaleString()} characters`;
    mount($('#cv-status', root), f && f.name
      ? html`<span class="badge badge-ok">CV file</span> <strong>${f.name}</strong> <span class="subtle">${f.size ? fmtBytes(f.size) : ''}${f.uploaded_at ? ` · uploaded ${fmtRel(f.uploaded_at)}` : ''}</span>
        <span class="subtle"> · attached when a form asks for a CV.</span>`
      : html`<span class="badge badge-warn">No CV file</span> <span class="muted">Upload one: most forms ask for the file, not just the text.</span>`);
  }

  function current() {
    const out = {};
    $$('[data-field]', form).forEach((el) => {
      const k = el.dataset.field;
      out[k] = k === 'years_experience' ? normYears(el.value) : el.value;
    });
    $$('[data-tri]', form).forEach((el) => { out[el.dataset.tri] = fromTriState(el.value); });
    $$('[data-list]', form).forEach((el) => { out[el.dataset.list] = splitList(el.value); });
    const saved = {};
    $$('[data-saved-row]', form).forEach((row) => {
      const q = $('[data-saved-q]', row).value.trim();
      const a = $('[data-saved-a]', row).value.trim();
      if (q && a) saved[q] = a;
    });
    out.saved_answers = saved;
    return out;
  }

  function diff() {
    const now = current();
    const p = st.profile;
    const changed = {};
    for (const [k, v] of Object.entries(now)) {
      let same;
      if (TEXT_KEYS.includes(k)) same = String(v).trim() === String(p[k] ?? '').trim();
      else if (k === 'years_experience') same = v === normYears(p[k]);
      else if (k === 'work_authorized_countries') same = v.join('\n') === (p[k] || []).join('\n');
      else if (k === 'saved_answers') same = sortedJson(v) === sortedJson(p[k]);
      else same = v === (p[k] ?? null);
      if (!same) changed[k] = TEXT_KEYS.includes(k) ? String(v).trim() : v;
    }
    return changed;
  }

  function refreshDirty() {
    if (signal.aborted) return 0;
    const n = Object.keys(diff()).length;
    $('#save-btn', root).disabled = n === 0 || st.saving;
    $('#save-state', root).textContent = st.saving ? 'Saving…' : n ? 'Unsaved changes' : 'All changes saved';
    $('#save-state', root).classList.toggle('dirty', n > 0);
    setLeaveGuard(n ? 'Your profile has unsaved changes.' : null);
    return n;
  }

  function validate(changes) {
    if (changes.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(changes.email)) return ['#pf-email', 'That email address looks incomplete.'];
    for (const k of ['linkedin_url', 'github_url', 'portfolio_url']) {
      if (changes[k] && !safeUrl(changes[k])) return [`#pf-${k}`, 'Links must start with https:// or http://'];
    }
    return null;
  }

  async function save({ quiet = false } = {}) {
    const changes = diff();
    if (!Object.keys(changes).length) return st.profile;
    const problem = validate(changes);
    if (problem) {
      toast(problem[1], 'error');
      $(problem[0], form)?.focus();
      throw Object.assign(new Error(problem[1]), { handled: true });
    }
    st.saving = true;
    refreshDirty();
    try {
      st.profile = await api('/api/careers/profile', { method: 'PUT', body: changes });
      fillForm(st.profile);
      if (!quiet) toast('Profile saved.', 'success', { timeout: 2500 });
      return st.profile;
    } finally {
      st.saving = false;
      refreshDirty();
    }
  }

  const refreshSoon = debounce(refreshDirty, 150);
  form.addEventListener('input', (e) => {
    if (e.target.id === 'pf-resume_text') $('#cv-count', root).textContent = `${e.target.value.length.toLocaleString()} characters`;
    refreshSoon();
  });
  form.addEventListener('change', refreshSoon);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await save(); } catch (err) { if (!err.handled) toastError(err); }
  });
  on(root, 'click', '[data-action="add-answer"]', () => {
    const list = $('#saved-list', root);
    $('[data-saved-empty]', list)?.remove();
    const tmp = document.createElement('div');
    mount(tmp, savedRow());
    list.append(...tmp.childNodes);
    const rows = $$('[data-saved-row]', list);
    const row = rows[rows.length - 1];
    const q = $('[data-saved-q]', row);
    const a = $('[data-saved-a]', row);
    q.id = `sq-new-${rows.length}`; a.id = `sa-new-${rows.length}`;
    q.previousElementSibling.htmlFor = q.id; q.previousElementSibling.textContent = `Question ${rows.length}`;
    a.previousElementSibling.htmlFor = a.id; a.previousElementSibling.textContent = `Answer ${rows.length}`;
    q.focus();
  });
  on(root, 'click', '[data-action="remove-answer"]', (e, el) => {
    el.closest('[data-saved-row]').remove();
    refreshDirty();
  });

  const fileInput = $('#cv-file', root);
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    const holder = fileInput.parentElement;
    holder.classList.add('disabled');
    try {
      await save({ quiet: true });
      const before = st.profile;
      const fd = new FormData();
      fd.append('file', file);
      st.profile = await api('/api/careers/profile/resume', { method: 'POST', form: fd });
      fillForm(st.profile);
      refreshDirty();
      const filled = [...CONTACT_FIELDS, ...WORK_FIELDS].map(([k, label]) => [k, label])
        .filter(([k]) => (before[k] === null || before[k] === undefined || before[k] === '') && st.profile[k] !== null && st.profile[k] !== undefined && st.profile[k] !== '');
      toast(`Loaded ${file.name}.${filled.length ? ` Filled ${plural(filled.length, 'empty field')} from it (${filled.map(([, l]) => l).join(', ')}): check them.` : ''}`, 'success', { timeout: 6000 });
    } catch (err) {
      if (!err.handled) toastError(err);
    } finally {
      holder.classList.remove('disabled');
      fileInput.value = '';
    }
  });

  on(root, 'click', '[data-action="import"]', async (e, btn) => {
    setBusy(btn, true, 'Loading…');
    let targets = [];
    try {
      targets = await api('/api/targets', { signal });
    } catch (err) {
      toastError(err);
      return;
    } finally {
      setBusy(btn, false);
    }
    if (!targets.length) { toast('There are no Prep targets yet. Upload your CV here instead.', 'info'); return; }
    targets.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    openModal({
      title: 'Use the CV from a Prep target',
      body: html`<p class="muted small">Copies the resume text you gave that target into your profile.</p>
        <fieldset><legend class="sr-only">Prep targets</legend><div class="template-grid">${targets.map((t, i) => html`<label class="template-card">
          <input type="radio" name="import-target" value="${t.id}" ${i === 0 ? 'checked' : ''}>
          <span class="tn">${t.title || 'Untitled target'}</span>
          <span class="td">${[t.company, `created ${fmtRel(t.created_at)}`].filter(Boolean).join(' · ')}</span></label>`)}</div></fieldset>`,
      actions: [
        { label: 'Cancel', kind: 'btn-ghost' },
        {
          label: 'Use this CV',
          kind: 'btn-primary',
          onClick: async (dlg) => {
            const picked = dlg.querySelector('input[name="import-target"]:checked');
            if (!picked) return false;
            try {
              await save({ quiet: true });
            } catch (err) {
              if (err.handled) return false;
              throw err;
            }
            st.profile = await api('/api/careers/profile/import-target', { method: 'POST', body: { target_id: picked.value } });
            fillForm(st.profile);
            refreshDirty();
            toast('Copied the CV text from Prep.', 'success', { timeout: 3000 });
            return true;
          },
        },
      ],
    });
  });

  fillForm(st.profile);
  refreshDirty();
  return () => { refreshSoon.cancel(); };
}
