// Practice: set up a mock interview, run it (voice or typed), live coaching hints, debriefs, and the report.
import { api, enc, getSettings } from '../api.js';
import {
  html, mount, loading, emptyState, statusBadge, metaBadge, chips, bullets, meter, scoreRow,
  fmtRel, fmtDate, fmtClock, fmtScore, toast, toastError, confirmDialog, trackJob, feedbackWidget, setBusy,
  sentence, $, $$, on, esc,
} from '../ui.js';
import { navigate, setLeaveGuard } from '../nav.js';
import { startCapture, speak, stopSpeaking } from '../audio.js';

const HINT_INTERVAL_MS = 4000;
const SCORE_LABELS = [
  ['structure', 'Structure'], ['relevance', 'Relevance'], ['specificity', 'Specificity'],
  ['impact', 'Impact'], ['communication', 'Communication'], ['technical_depth', 'Technical depth'],
];
const HIRE_SIGNAL = {
  strong: { label: 'Strong hire signal', cls: 'badge-ok', icon: '✓✓' },
  lean_hire: { label: 'Leaning hire', cls: 'badge-ok', icon: '✓' },
  lean_no: { label: 'Leaning no hire', cls: 'badge-warn', icon: '!' },
  no: { label: 'No hire signal', cls: 'badge-danger', icon: '✕' },
};

function wordCount(text) { return (String(text || '').trim().match(/\S+/g) || []).length; }

// =================================================================================================
// Setup
// =================================================================================================
export async function practiceSetup(root, { query, signal }) {
  document.title = 'Practice · Interview App';
  mount(root, loading('Loading…'));
  const [targets, settings, sessions] = await Promise.all([
    api('/api/targets', { signal }),
    getSettings().catch(() => null),
    api('/api/sessions', { signal }).catch(() => []),
  ]);
  const coach = (settings && settings.coach) || {};
  const ready = targets.filter((t) => t.status === 'ready').sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const notReady = targets.filter((t) => t.status !== 'ready');
  const recent = [...sessions].sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || ''))).slice(0, 8);

  if (!ready.length) {
    mount(root, html`<div class="page-head"><div><h1>Practice</h1><p class="lead">Mock interviews built from a target job.</p></div></div>
      <section class="card">${emptyState({
        title: notReady.length ? 'Your target is still being prepared' : 'Create a target first',
        text: notReady.length ? 'Practice opens as soon as prep finishes.' : 'Practice questions come from a target: your resume plus a job description.',
        action: notReady.length ? html`<a class="btn btn-primary" href="#/prep/${enc(notReady[0].id)}">See progress</a>` : html`<a class="btn btn-primary" href="#/prep?new=1">Create a target</a>`,
      })}</section>`);
    return undefined;
  }
  const preselect = ready.find((t) => t.id === query.get('target')) || ready[0];
  const focusPre = query.get('focus') || '';
  const limits = [60, 90, 120, 150, 180, 240];
  const defLimit = coach.answer_time_limit_sec || 150;
  if (!limits.includes(defLimit)) limits.push(defLimit);
  limits.sort((a, b) => a - b);
  const persona = coach.persona || 'neutral';

  mount(root, html`
    <div class="page-head"><div><h1>Practice</h1>
      <p class="lead">A mock interview from your target's question bank. Answer out loud or type. Live hints and the scored debrief exist only in practice — they're here to build the skill.</p></div></div>
    <div class="grid-2" style="align-items:start">
      <form class="card stack" id="setup-form">
        <h2>New session</h2>
        <div class="field"><label for="p-target">Target</label>
          <select id="p-target" class="select">${ready.map((t) => html`<option value="${t.id}" ${t.id === preselect.id ? 'selected' : ''}>${t.title || 'Untitled target'}${t.company ? ` · ${t.company}` : ''}</option>`)}</select></div>
        <fieldset class="field"><legend>Question mix</legend>
          <div class="segmented" role="radiogroup" aria-label="Question mix">
            ${[['mixed', 'Mixed'], ['behavioral', 'Behavioral'], ['technical', 'Technical']].map(([v, l], i) => html`<label><input type="radio" name="mode" value="${v}" ${i === 0 ? 'checked' : ''}><span>${l}</span></label>`)}
          </div></fieldset>
        <div class="form-grid">
          <div class="field"><label for="p-count">Questions</label>
            <select id="p-count" class="select">${[3, 4, 5, 6, 8, 10, 12].map((n) => html`<option value="${n}" ${n === 5 ? 'selected' : ''}>${n}</option>`)}</select></div>
          <div class="field"><label for="p-limit">Time per answer</label>
            <select id="p-limit" class="select">${limits.map((s) => html`<option value="${s}" ${s === defLimit ? 'selected' : ''}>${fmtClock(s)}</option>`)}</select></div>
        </div>
        <fieldset class="field"><legend>Interviewer style</legend>
          <div class="segmented" role="radiogroup" aria-label="Interviewer style">
            ${[['friendly', 'Friendly'], ['neutral', 'Neutral'], ['challenging', 'Challenging']].map(([v, l]) => html`<label><input type="radio" name="persona" value="${v}" ${v === persona ? 'checked' : ''}><span>${l}</span></label>`)}
          </div></fieldset>
        <div class="field"><label for="p-focus">Focus competency <span class="subtle">(optional)</span></label>
          <select id="p-focus" class="select"><option value="">Let the planner choose (weakest and due first)</option></select></div>
        <label class="check"><input type="checkbox" id="p-hints" ${coach.hints_enabled !== false ? 'checked' : ''}><span><strong>Live coaching hints</strong><br><span class="subtle">STAR checklist, pacing and filler-word nudges while you answer.</span></span></label>
        <div><button type="submit" class="btn btn-primary btn-lg">Start interview</button></div>
      </form>
      <section class="card">
        <div class="card-head"><h2>Recent sessions</h2></div>
        ${recent.length ? html`<div class="list-rows">${recent.map((s) => html`<a class="list-row" href="#/practice/${enc(s.id)}${s.status === 'done' ? '/report' : ''}">
          <div class="main"><div class="t">${s.target_title || 'Practice session'}</div><div class="item-meta"><span>${sentence(s.mode || 'mixed')}</span><span>${s.answered ?? 0} answered</span><span>${fmtRel(s.started_at)}</span></div></div>
          ${s.overall_score ? html`<span class="badge">${fmtScore(s.overall_score)} / 5</span>` : ''}${statusBadge(s.status)}</a>`)}</div>`
          : emptyState({ title: 'No sessions yet', text: 'Your first session takes about 10-15 minutes.' })}
      </section>
    </div>`);

  const form = $('#setup-form', root);
  const focusSel = $('#p-focus', root);
  const compCache = new Map();
  async function loadFocus(targetId) {
    let comps = compCache.get(targetId);
    if (!comps) {
      try {
        const t = await api(`/api/targets/${enc(targetId)}`, { signal });
        comps = ((t.job && t.job.competencies) || []).map((c) => c.name);
      } catch { comps = []; }
      compCache.set(targetId, comps);
    }
    const current = focusSel.value || focusPre;
    mount(focusSel, html`<option value="">Let the planner choose (weakest and due first)</option>${comps.map((c) => html`<option value="${c}" ${c === current ? 'selected' : ''}>${c}</option>`)}`);
    if (current && !comps.includes(current)) {
      focusSel.insertAdjacentHTML('beforeend', `<option value="${esc(current)}" selected>${esc(current)}</option>`);
    }
  }
  loadFocus(preselect.id);
  $('#p-target', root).addEventListener('change', (e) => { focusSel.value = ''; loadFocus(e.target.value); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    setBusy(btn, true, 'Planning questions…');
    try {
      const body = {
        target_id: $('#p-target', root).value,
        mode: form.querySelector('input[name=mode]:checked').value,
        num_questions: Number($('#p-count', root).value),
        persona: form.querySelector('input[name=persona]:checked').value,
        answer_time_limit_sec: Number($('#p-limit', root).value),
        hints: $('#p-hints', root).checked,
        focus_competency: focusSel.value || null,
      };
      const session = await api('/api/sessions', { method: 'POST', body });
      navigate(`#/practice/${enc(session.id)}`);
    } catch (err) {
      toastError(err);
      setBusy(btn, false);
    }
  });
  return undefined;
}

// =================================================================================================
// Live session
// =================================================================================================
export async function practiceSession(root, { params, signal }) {
  const sid = params.id;
  mount(root, loading('Loading session…'));
  let session;
  try {
    session = await api(`/api/sessions/${enc(sid)}`, { signal });
  } catch (err) {
    if (err.status === 404) {
      mount(root, emptyState({ title: 'Session not found', action: html`<a class="btn btn-primary" href="#/practice">Back to Practice</a>` }));
      return undefined;
    }
    throw err;
  }
  if (session.status === 'done') { navigate(`#/practice/${enc(sid)}/report`); return undefined; }
  const settings = await getSettings().catch(() => null);
  const coach = (settings && settings.coach) || {};
  const cfg = session.config || {};
  const hintsOn = cfg.hints !== false;
  const limit = Number(cfg.answer_time_limit_sec || coach.answer_time_limit_sec || 150);
  let speakOn = coach.speak_questions !== false;
  document.title = `Practice · ${session.target_title || 'Session'} · Interview App`;

  const st = {
    turn: null, phase: 'question', inputMode: 'voice', capture: null, finals: [], partial: '', answerText: '',
    startedAt: 0, elapsed: 0, timerId: null, hintId: null, hintBusy: false, hints: [], star: {}, metrics: null,
    result: null, nextTurn: null, done: false, disposed: false,
  };

  function currentTurn() {
    const byId = session.turns.find((t) => t.id === session.current_turn_id);
    if (byId && byId.status === 'asked') return byId;
    return session.turns.find((t) => t.status === 'asked') || null;
  }
  function mainIndexOf(turn) {
    const mains = session.turns.filter((t) => t.kind === 'main');
    const anchorId = turn.kind === 'main' ? turn.id : turn.parent_turn_id;
    const idx = mains.findIndex((t) => t.id === anchorId);
    return idx >= 0 ? idx + 1 : mains.length;
  }
  function guard() {
    const busy = ['recording', 'typing', 'rating', 'submitting', 'stopping'].includes(st.phase);
    setLeaveGuard(busy ? "You're in the middle of an answer. Leave anyway? It won't be saved." : null);
  }

  // --- frame ------------------------------------------------------------------------------------------
  function renderFrame() {
    mount(root, html`
      <div class="page-head">
        <div><a class="crumb" href="#/prep/${enc(session.target_id)}">← ${session.target_title || 'Target'}</a>
          <h1>Mock interview</h1>
          <div class="item-meta mt-2"><span id="progress-label"></span><span>${sentence(cfg.mode || 'mixed')}</span><span>${sentence(cfg.persona || 'neutral')} interviewer</span>${cfg.focus_competency ? html`<span>Focus: ${cfg.focus_competency}</span>` : ''}</div>
        </div>
        <div class="actions">
          <label class="check small" style="align-items:center"><input type="checkbox" id="speak-toggle" ${speakOn ? 'checked' : ''}><span>Read questions aloud</span></label>
          <button type="button" class="btn btn-secondary" data-action="end">End session</button>
        </div>
      </div>
      <div id="turn-area" class="stack"></div>
      <details class="card card-tight" id="history-box"><summary><strong>Earlier in this session</strong> <span class="subtle" id="history-count"></span></summary><div id="history" class="mt-3"></div></details>
    `);
    $('#speak-toggle', root).addEventListener('change', (e) => { speakOn = e.target.checked; if (!speakOn) stopSpeaking(); });
    $('[data-action="end"]', root).addEventListener('click', endEarly);
    renderHistory();
  }

  function renderHistory() {
    const done = session.turns.filter((t) => t.status !== 'asked');
    const box = $('#history', root);
    if (!box) return;
    $('#history-count', root).textContent = done.length ? `(${done.length})` : '';
    $('#history-box', root).classList.toggle('hidden', done.length === 0);
    mount(box, html`${done.map((t) => html`<div class="history-item">
      <div class="row-between"><strong>${t.kind === 'followup' ? 'Follow-up: ' : ''}${t.question_text}</strong>
        ${t.status === 'skipped' ? html`<span class="badge">Skipped</span>` : t.evaluation ? html`<span class="badge">${fmtScore(t.evaluation.overall)} / 5</span>` : ''}</div>
      ${t.evaluation && t.evaluation.summary ? html`<p class="small muted mt-2">${t.evaluation.summary}</p>` : ''}
    </div>`)}`);
  }

  // --- turn ---------------------------------------------------------------------------------------
  function renderTurn() {
    const t = st.turn;
    const area = $('#turn-area', root);
    if (!t) {
      mount(area, html`<section class="card">${emptyState({ title: 'All questions answered', text: 'Build your report to see scores per competency and what to practise next.',
        action: html`<button type="button" class="btn btn-primary btn-lg" data-action="finish">Finish and get my report</button>` })}</section>`);
      $('[data-action="finish"]', area).addEventListener('click', finishSession);
      $('#progress-label', root).textContent = 'All questions answered';
      return;
    }
    const n = mainIndexOf(t);
    const total = cfg.num_questions || session.plan?.length || n;
    $('#progress-label', root).textContent = t.kind === 'followup' ? `Follow-up to question ${n} of ${total}` : `Question ${n} of ${total}`;
    const prep = t.prep;
    mount(area, html`
      <div class="session-grid ${hintsOn ? 'with-coach' : ''}">
        <section class="card interviewer" aria-labelledby="q-heading">
          <div class="who"><span class="avatar" aria-hidden="true">🧑‍💼</span><span>${t.kind === 'followup' ? 'Interviewer · follow-up' : 'Interviewer'}</span>
            <span class="spacer"></span><button type="button" class="btn btn-ghost btn-sm" data-action="repeat" aria-label="Read the question aloud">🔊 Repeat</button></div>
          <h2 class="question-text" id="q-heading">${t.question_text}</h2>
          <div class="item-meta">${t.category ? html`<span class="badge">${sentence(t.category)}</span>` : ''}${t.competency ? html`<span>${t.competency}</span>` : ''}</div>
          ${hintsOn && prep ? html`<details class="prep-panel"><summary>Prep notes for this question</summary><div class="stack-sm mt-3">
            ${prep.why_asked ? html`<div><div class="section-title">Why they ask it</div><p>${prep.why_asked}</p></div>` : ''}
            ${(prep.good_answer_signals || []).length ? html`<div><div class="section-title">What a good answer shows</div>${bullets(prep.good_answer_signals, { cls: 'list list-check' })}</div>` : ''}
            ${(prep.stories || []).length ? html`<div><div class="section-title">Stories from your bank that might fit</div><ul class="list">${prep.stories.map((s) => html`<li><strong>${s.title}</strong>${s.result ? html` — <span class="muted">${s.result}</span>` : ''}</li>`)}</ul></div>` : ''}
            ${(prep.tips || []).length ? html`<div><div class="section-title">Tips</div>${bullets(prep.tips)}</div>` : ''}
          </div></details>` : ''}
        </section>
        ${hintsOn ? html`<aside class="card stack" id="coach-panel" aria-label="Live coaching">
          <div class="row-between"><h2>Live coaching</h2><span class="badge">practice only</span></div>
          <div class="star-chips" id="star-chips" aria-label="STAR checklist">${['situation', 'task', 'action', 'result'].map((k) => html`<span class="star-chip" data-star="${k}" title="${sentence(k)}">${k[0].toUpperCase()}<span class="sr-only"> ${k}: not yet</span></span>`)}</div>
          <div class="stack-sm" id="hint-list" aria-live="polite"><p class="subtle">Hints appear while you answer.</p></div>
          <div class="mini-metrics" id="mini-metrics">
            <div class="stat"><span class="label">Words/min</span><span class="value" data-m="wpm">–</span></div>
            <div class="stat"><span class="label">Fillers</span><span class="value" data-m="filler">–</span></div>
            <div class="stat"><span class="label">Words</span><span class="value" data-m="words">–</span></div>
          </div>
        </aside>` : ''}
      </div>
      <section class="card stack" id="answer-card" aria-label="Your answer">
        <div class="row-between"><h2>Your answer</h2>
          <div class="timer" id="timer" style="min-width:220px"><span class="time">0:00 / ${fmtClock(limit)}</span>${meter(0, limit, { label: 'Time used' })}</div></div>
        <div id="answer-body"></div>
        <div class="row" id="answer-controls"></div>
        <p class="subtle" id="answer-status" aria-live="polite"></p>
      </section>
      <div id="eval-area"></div>
    `);
    $('[data-action="repeat"]', area).addEventListener('click', () => speak(t.question_text));
    st.hints = []; st.star = {}; st.metrics = null;
    setPhase('question');
    if (speakOn) speak(t.question_text);
  }

  // --- phases --------------------------------------------------------------------------------------
  function setPhase(phase) {
    st.phase = phase;
    guard();
    const body = $('#answer-body', root);
    const controls = $('#answer-controls', root);
    const status = $('#answer-status', root);
    if (!body || !controls) return;
    status.textContent = '';
    if (phase === 'question') {
      mount(body, html`<div class="answer-box" id="transcript" data-placeholder="Press “Start answering” and speak, or type your answer."></div>`);
      mount(controls, html`<button type="button" class="btn btn-record btn-lg" data-action="record">🎙 Start answering</button>
        <button type="button" class="btn btn-secondary" data-action="type">⌨ Type instead</button>
        <span class="spacer"></span><button type="button" class="btn btn-ghost" data-action="skip">Skip question</button>`);
    } else if (phase === 'starting') {
      mount(controls, html`<span class="loading" style="padding:0"><span class="spinner" aria-hidden="true"></span>Starting the microphone…</span>`);
    } else if (phase === 'recording') {
      renderTranscript();
      mount(controls, html`<button type="button" class="btn btn-primary btn-lg" data-action="done">■ Done answering</button>
        <span class="row small subtle"><span class="level" aria-hidden="true"><span id="level-bar"></span></span><span id="engine-label"></span></span>
        <span class="spacer"></span><button type="button" class="btn btn-ghost" data-action="cancel">Cancel</button>`);
      $('#engine-label', root).textContent = st.capture ? (st.capture.engine === 'browser' ? 'Browser speech recognition' : `Local speech engine${st.capture.model ? ` · ${st.capture.model}` : ''}`) : '';
      status.textContent = 'Listening…';
    } else if (phase === 'typing') {
      mount(body, html`<label class="sr-only" for="typed">Your answer</label><textarea id="typed" class="textarea tall" placeholder="Type your answer as you'd say it."></textarea>`);
      mount(controls, html`<button type="button" class="btn btn-primary btn-lg" data-action="submit-typed">Submit answer</button>
        <span class="spacer"></span><button type="button" class="btn btn-ghost" data-action="cancel">Cancel</button>`);
      $('#typed', root).focus();
    } else if (phase === 'stopping') {
      mount(controls, html`<span class="loading" style="padding:0"><span class="spinner" aria-hidden="true"></span>Finishing the transcript…</span>`);
    } else if (phase === 'rating') {
      mount(body, html`<div class="field"><label for="final-answer">Your answer <span class="subtle">— fix any transcription mistakes before it's scored</span></label>
        <textarea id="final-answer" class="textarea">${st.answerText}</textarea></div>`);
      mount(controls, html`<div class="stack-sm" style="width:100%">
        <strong id="rate-label">Before you see the coach's score — how do you think that went?</strong>
        <div class="row" role="group" aria-labelledby="rate-label">${[1, 2, 3, 4, 5].map((n) => html`<button type="button" class="btn btn-secondary" data-rate="${n}" aria-label="Rate yourself ${n} out of 5">${n}</button>`)}
          <span class="subtle small">1 = rough · 5 = nailed it</span><span class="spacer"></span>
          <button type="button" class="btn btn-ghost" data-rate="skip">Skip rating</button></div></div>`);
      status.textContent = 'Comparing your own rating with the coach builds self-assessment — a skill interviewers notice.';
    } else if (phase === 'submitting') {
      mount(controls, html`<span class="loading" style="padding:0"><span class="spinner" aria-hidden="true"></span>The coach is scoring your answer…</span>`);
      $$('#answer-body textarea', root).forEach((ta) => { ta.readOnly = true; });
    } else if (phase === 'evaluated') {
      mount(body, html`<div class="answer-box">${st.result && st.result.turn ? st.result.turn.answer_text : st.answerText}</div>`);
      mount(controls, '');
    } else if (phase === 'finishing') {
      mount(controls, html`<span class="loading" style="padding:0"><span class="spinner" aria-hidden="true"></span>Ending the session…</span>`);
    }
  }

  function renderTranscript() {
    const box = $('#transcript', root);
    if (!box) return;
    const finals = st.finals.join(' ');
    box.replaceChildren();
    if (finals) box.append(document.createTextNode(finals));
    if (st.partial) {
      const span = document.createElement('span');
      span.className = 'partial';
      span.textContent = `${finals ? ' ' : ''}${st.partial}`;
      box.append(span);
    }
    box.scrollTop = box.scrollHeight;
  }

  // --- timer + hints -----------------------------------------------------------------------------------
  function startTimer() {
    st.startedAt = Date.now();
    st.elapsed = 0;
    clearInterval(st.timerId);
    st.timerId = setInterval(tick, 250);
    tick();
  }
  function stopTimer() {
    clearInterval(st.timerId);
    st.timerId = null;
    if (st.startedAt) st.elapsed = (Date.now() - st.startedAt) / 1000;
  }
  function tick() {
    st.elapsed = (Date.now() - st.startedAt) / 1000;
    const timer = $('#timer', root);
    if (!timer) return;
    timer.querySelector('.time').textContent = `${fmtClock(st.elapsed)} / ${fmtClock(limit)}`;
    const ratio = st.elapsed / limit;
    const bar = timer.querySelector('.meter > span');
    if (bar) bar.style.width = `${Math.min(100, ratio * 100).toFixed(1)}%`;
    timer.querySelector('.meter')?.setAttribute('aria-valuenow', String(Math.min(limit, Math.round(st.elapsed))));
    timer.classList.toggle('warn', ratio >= 0.8 && ratio < 1);
    timer.classList.toggle('over', ratio >= 1);
    const status = $('#answer-status', root);
    if (status && ratio >= 1 && (st.phase === 'recording' || st.phase === 'typing')) status.textContent = 'Over time — land the result and wrap up.';
  }
  function currentTranscript() {
    if (st.phase === 'typing') return ($('#typed', root) || {}).value || '';
    return [...st.finals, st.partial].join(' ').trim();
  }
  function startHints() {
    stopHints();
    if (!hintsOn) return;
    st.hintId = setInterval(pollHints, HINT_INTERVAL_MS);
  }
  function stopHints() { clearInterval(st.hintId); st.hintId = null; }
  async function pollHints() {
    if (st.hintBusy || !st.turn || !['recording', 'typing'].includes(st.phase)) return;
    const transcript = currentTranscript();
    if (wordCount(transcript) < 3) return;
    st.hintBusy = true;
    try {
      // Typed answers have no speaking pace, so don't send elapsed time (it would produce bogus pace hints).
      const elapsed = st.inputMode === 'typed' ? 0 : Math.round(st.elapsed);
      const res = await api(`/api/sessions/${enc(sid)}/hints`, { method: 'POST', body: { turn_id: st.turn.id, transcript, elapsed_sec: elapsed } });
      if (st.disposed) return;
      renderHints(res);
    } catch (err) {
      if (err.name !== 'AbortError') console.warn('hints failed', err);
    } finally {
      st.hintBusy = false;
    }
  }
  function renderHints(res) {
    const panel = $('#coach-panel', root);
    if (!panel || !res) return;
    const star = res.star || {};
    $$('[data-star]', panel).forEach((chip) => {
      const k = chip.dataset.star;
      chip.classList.toggle('on', Boolean(star[k]));
      const sr = chip.querySelector('.sr-only');
      if (sr) sr.textContent = ` ${k}: ${star[k] ? 'covered' : 'not yet'}`;
    });
    const hints = res.hints || [];
    const list = $('#hint-list', panel);
    if (hints.length) {
      mount(list, html`${hints.slice(0, 4).map((h) => html`<div class="hint hint-${h.severity || 'info'}"><div><span class="k">${sentence(h.kind || 'tip')}</span>${h.text}</div></div>`)}`);
    } else {
      mount(list, html`<p class="subtle">Looking good — keep going.</p>`);
    }
    const m = res.metrics || {};
    const set = (key, val) => { const el = panel.querySelector(`[data-m="${key}"]`); if (el) el.textContent = val; };
    set('wpm', st.inputMode === 'voice' && m.wpm ? Math.round(m.wpm) : '–');
    set('filler', m.filler_count ?? '–');
    set('words', m.word_count ?? wordCount(currentTranscript()));
  }
  function setLevel(level) {
    const bar = document.getElementById('level-bar');
    if (bar) bar.style.width = `${Math.round(Math.min(1, level) * 100)}%`;
  }

  // --- actions ------------------------------------------------------------------------------------------
  async function startRecording() {
    stopSpeaking();
    st.inputMode = 'voice';
    st.finals = [];
    st.partial = '';
    setPhase('starting');
    try {
      st.capture = await startCapture({
        source: 'mic', mode: 'practice', channel: 'me', offsetSec: 0,
        onPartial: (text) => { st.partial = text; renderTranscript(); },
        onFinal: (seg) => { st.finals.push(seg.text); renderTranscript(); },
        onStatus: (s) => {
          if (s.type === 'error') toast(s.message, 'error');
          else if (s.type === 'closed' && st.phase === 'recording') toast('Lost the connection to the speech engine. What you said so far is kept — press Done.', 'warn');
        },
        onLevel: setLevel,
      });
    } catch (err) {
      st.capture = null;
      toastError(err);
      setPhase('question');
      $('#answer-status', root).textContent = 'Microphone unavailable — you can type your answer instead.';
      return;
    }
    if (st.disposed) { st.capture.stop(); return; }
    setPhase('recording');
    startTimer();
    startHints();
  }

  async function doneRecording() {
    setPhase('stopping');
    stopHints();
    stopTimer();
    try { if (st.capture) await st.capture.stop(); } catch { /* ignore */ }
    st.capture = null;
    const text = [...st.finals, st.partial].join(' ').replace(/\s+/g, ' ').trim();
    st.partial = '';
    if (!text) {
      toast("We didn't catch anything. Try again, or type your answer.", 'error');
      setPhase('question');
      return;
    }
    st.answerText = text;
    setPhase('rating');
  }

  async function cancelAnswer() {
    stopHints();
    stopTimer();
    if (st.capture) { try { await st.capture.stop(); } catch { /* ignore */ } st.capture = null; }
    st.finals = []; st.partial = ''; st.answerText = '';
    const timer = $('#timer', root);
    if (timer) { timer.classList.remove('warn', 'over'); timer.querySelector('.time').textContent = `0:00 / ${fmtClock(limit)}`; const bar = timer.querySelector('.meter > span'); if (bar) bar.style.width = '0%'; }
    setPhase('question');
  }

  function startTyping() {
    stopSpeaking();
    st.inputMode = 'typed';
    setPhase('typing');
    startTimer();
    startHints();
  }

  function submitTyped() {
    const text = (($('#typed', root) || {}).value || '').trim();
    if (wordCount(text) < 3) { toast('Write a little more before submitting.', 'error'); return; }
    stopHints();
    stopTimer();
    st.answerText = text;
    setPhase('rating');
  }

  async function submitAnswer(selfRating) {
    const ta = $('#final-answer', root);
    const text = ((ta && ta.value) || st.answerText).trim();
    if (!text) { toast('Your answer is empty.', 'error'); return; }
    st.answerText = text;
    setPhase('submitting');
    try {
      const body = { turn_id: st.turn.id, answer_text: text };
      // Speaking time drives pace metrics; a typed answer has none.
      if (st.inputMode === 'voice') body.duration_sec = Math.round(st.elapsed);
      if (selfRating) body.self_rating = selfRating;
      const res = await api(`/api/sessions/${enc(sid)}/answer`, { method: 'POST', body });
      if (st.disposed) return;
      st.result = res;
      st.nextTurn = res.next_turn || null;
      st.done = Boolean(res.done) || !res.next_turn;
      const i = session.turns.findIndex((t) => t.id === res.turn.id);
      if (i >= 0) session.turns[i] = res.turn; else session.turns.push(res.turn);
      if (res.next_turn && !session.turns.some((t) => t.id === res.next_turn.id)) session.turns.push(res.next_turn);
      session.current_turn_id = res.next_turn ? res.next_turn.id : null;
      setPhase('evaluated');
      renderEvaluation(res.turn);
      renderHistory();
    } catch (err) {
      toastError(err);
      setPhase('rating');
    }
  }

  async function skipQuestion() {
    const ok = await confirmDialog({ title: 'Skip this question?', message: 'It won\'t be scored. You can practise it again in a later session.', confirmLabel: 'Skip' });
    if (!ok) return;
    try {
      const res = await api(`/api/sessions/${enc(sid)}/skip`, { method: 'POST', body: { turn_id: st.turn.id } });
      const t = session.turns.find((x) => x.id === st.turn.id);
      if (t) t.status = 'skipped';
      if (res.next_turn && !session.turns.some((x) => x.id === res.next_turn.id)) session.turns.push(res.next_turn);
      session.current_turn_id = res.next_turn ? res.next_turn.id : null;
      renderHistory();
      if (res.next_turn) { st.turn = res.next_turn; renderTurn(); }
      else { st.turn = null; renderTurn(); }
    } catch (err) { toastError(err); }
  }

  function nextTurn() {
    st.result = null;
    st.answerText = '';
    st.turn = st.nextTurn;
    st.nextTurn = null;
    renderTurn();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function finishSession() {
    stopSpeaking();
    st.phase = 'finishing';
    guard();
    const area = $('#turn-area', root);
    try {
      const res = await api(`/api/sessions/${enc(sid)}/end`, { method: 'POST', body: {} });
      mount(area, html`<div id="finish-job"></div>`);
      await trackJob($('#finish-job', root), res.job_id, {
        title: 'Building your session report',
        subtitle: 'The coach agent reviews every answer and updates your skill model.',
        signal,
        onDone: () => navigate(`#/practice/${enc(sid)}/report`),
      });
    } catch (err) {
      toastError(err);
      st.phase = 'evaluated';
    }
  }

  async function endEarly() {
    const answered = session.turns.filter((t) => t.status === 'answered').length;
    const ok = await confirmDialog({
      title: 'End this session?',
      message: answered ? 'Unanswered questions will be skipped and your report will be built from the answers so far.' : "You haven't answered anything yet — the report will be empty.",
      confirmLabel: 'End and build report',
    });
    if (!ok) return;
    stopHints(); stopTimer();
    if (st.capture) { try { await st.capture.stop(); } catch { /* ignore */ } st.capture = null; }
    finishSession();
  }

  // --- evaluation -----------------------------------------------------------------------------------
  function renderEvaluation(turn) {
    const ev = turn.evaluation;
    const area = $('#eval-area', root);
    if (!area) return;
    if (!ev) { mount(area, html`<section class="card"><p>The answer was saved but couldn't be scored.</p></section>`); return; }
    const m = turn.metrics || {};
    const sig = HIRE_SIGNAL[ev.hire_signal];
    const selfRating = turn.self_rating ?? null;
    const gap = ev.self_rating_gap;
    let gapNote = '';
    if (selfRating && gap !== null && gap !== undefined) {
      const note = gap >= 0.75 ? 'You are underselling yourself.' : gap <= -0.75 ? 'You rated it higher than the coach — compare with the improvements below.' : 'Your self-assessment is well calibrated.';
      gapNote = html`<p><strong>You rated yourself ${selfRating}</strong> — the coach scored ${fmtScore(ev.overall)}. <span class="muted">${note}</span></p>`;
    }
    const decision = turn.decision;
    const nextLabel = st.done ? 'Finish and get my report' : (st.nextTurn && st.nextTurn.kind === 'followup' ? 'Answer the follow-up →' : 'Next question →');
    mount(area, html`<section class="card stack" id="eval-card" aria-labelledby="eval-h">
      <div class="card-head"><h2 id="eval-h">Coach's debrief</h2>${metaBadge(ev.meta)}</div>
      <div class="eval-head">
        <div><div class="hero-num">${fmtScore(ev.overall)}<small>/5</small></div><div class="subtle">Overall</div></div>
        <div class="stack-sm" style="flex:1;min-width:220px">
          ${sig ? html`<div class="row"><span class="subtle">Debrief read:</span><span class="badge ${sig.cls}" title="How an interview panel might read this one answer in a debrief. A practice signal, not a prediction."><span aria-hidden="true">${sig.icon}</span> ${sig.label}</span></div>` : ''}
          ${gapNote}
          <div class="item-meta">${m.duration_sec ? html`<span>${fmtClock(m.duration_sec)}</span>` : ''}${m.word_count ? html`<span>${m.word_count} words</span>` : ''}${m.wpm && m.wpm <= 260 ? html`<span>${Math.round(m.wpm)} wpm</span>` : ''}${m.filler_count !== undefined ? html`<span>${m.filler_count} fillers</span>` : ''}</div>
        </div>
      </div>
      <div class="stack-sm">${SCORE_LABELS.filter(([k]) => k !== 'technical_depth' || (ev.scores && ev.scores.technical_depth !== null && ev.scores.technical_depth !== undefined)).map(([k, l]) => scoreRow(l, ev.scores ? ev.scores[k] : null))}</div>
      ${ev.summary ? html`<p>${ev.summary}</p>` : ''}
      <div class="grid-2">
        <div><h3>What worked</h3>${bullets(ev.strengths, { cls: 'list list-check' })}</div>
        <div><h3>To improve</h3>${bullets(ev.improvements, { cls: 'list list-arrow' })}</div>
      </div>
      ${(ev.missing_elements || []).length ? html`<div><h3>Missing</h3>${bullets(ev.missing_elements)}</div>` : ''}
      ${(ev.evidence_quotes || []).length ? html`<div><h3>From your answer</h3><div class="stack-sm">${ev.evidence_quotes.map((q) => html`<blockquote class="quote">“${q}”</blockquote>`)}</div></div>` : ''}
      ${(ev.better_answer_outline || []).length ? html`<div><h3>Stronger answer outline</h3><ol class="list">${ev.better_answer_outline.map((x) => html`<li>${x}</li>`)}</ol></div>` : ''}
      ${(m.jd_terms || []).length || (m.top_words || []).length ? html`<div class="grid-2">
        <div><h3>Job terms you used</h3>${chips(m.jd_terms)}</div>
        <div><h3>Words you repeated</h3>${(m.top_words || []).length ? chips(m.top_words.map((w) => `${w.word} ×${w.count}`)) : html`<span class="subtle">None — nice variety.</span>`}</div>
      </div>` : ''}
      ${(ev.calibration_notes || []).length ? html`<details><summary class="small muted">How this score was checked (${ev.calibration_notes.length})</summary><div class="mt-2 small muted">${bullets(ev.calibration_notes)}</div></details>` : ''}
      ${feedbackWidget('evaluation', turn.id, { label: 'Was this debrief useful?' })}
      ${decision && decision.action === 'follow_up' && !st.done ? html`<div class="banner banner-info"><span class="banner-icon" aria-hidden="true">💬</span><div>The interviewer has a follow-up${decision.reason ? html`: <span class="muted">${decision.reason}</span>` : '.'}</div></div>` : ''}
      <div class="row"><button type="button" class="btn btn-primary btn-lg" data-action="next">${nextLabel}</button></div>
    </section>`);
    $('[data-action="next"]', area).addEventListener('click', () => (st.done ? finishSession() : nextTurn()));
    $('#eval-card', root).scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // --- wire up ------------------------------------------------------------------------------------
  renderFrame();
  on(root, 'click', '[data-action]', (e, btn) => {
    const a = btn.dataset.action;
    if (a === 'record') startRecording();
    else if (a === 'type') startTyping();
    else if (a === 'skip') skipQuestion();
    else if (a === 'done') doneRecording();
    else if (a === 'cancel') cancelAnswer();
    else if (a === 'submit-typed') submitTyped();
  });
  on(root, 'click', '[data-rate]', (e, btn) => {
    if (st.phase !== 'rating') return;
    const v = btn.dataset.rate;
    submitAnswer(v === 'skip' ? null : Number(v));
  });
  on(root, 'keydown', '#typed', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitTyped(); }
  });

  if (session.status === 'finishing' || session.status === 'failed') {
    const area = $('#turn-area', root);
    if (session.status === 'finishing' && session.job_id) {
      trackJob(area, session.job_id, { title: 'Building your session report', signal, onDone: () => navigate(`#/practice/${enc(sid)}/report`) });
    } else {
      mount(area, html`<section class="card">${emptyState({ title: 'The report could not be built', text: 'Try again — your answers are saved.', action: html`<button type="button" class="btn btn-primary" data-action="retry-end">Build report again</button>` })}</section>`);
      $('[data-action="retry-end"]', area).addEventListener('click', finishSession);
    }
  } else {
    st.turn = currentTurn();
    renderTurn();
  }

  return () => {
    st.disposed = true;
    stopHints();
    clearInterval(st.timerId);
    stopSpeaking();
    if (st.capture) { try { st.capture.stop(); } catch { /* ignore */ } st.capture = null; }
    setLeaveGuard(null);
  };
}

// =================================================================================================
// Report
// =================================================================================================
export async function practiceReport(root, { params, signal }) {
  const sid = params.id;
  mount(root, loading('Loading report…'));
  let session;
  try {
    session = await api(`/api/sessions/${enc(sid)}`, { signal });
  } catch (err) {
    if (err.status === 404) {
      mount(root, emptyState({ title: 'Session not found', action: html`<a class="btn btn-primary" href="#/practice">Back to Practice</a>` }));
      return undefined;
    }
    throw err;
  }
  document.title = `Report · ${session.target_title || 'Session'} · Interview App`;
  const head = html`<div class="page-head"><div><a class="crumb" href="#/prep/${enc(session.target_id)}?tab=sessions">← ${session.target_title || 'Target'}</a>
    <h1>Session report</h1><div class="item-meta mt-2"><span>${fmtDate(session.started_at)}</span><span>${sentence((session.config && session.config.mode) || 'mixed')}</span>${statusBadge(session.status)}</div></div>
    <div class="actions"><a class="btn btn-primary" href="#/practice?target=${enc(session.target_id)}">Practice again</a><a class="btn btn-secondary" href="#/progress?target=${enc(session.target_id)}">Progress</a></div></div>`;

  if (!session.report) {
    if (session.status === 'finishing' && session.job_id) {
      mount(root, html`${head}<div id="job"></div>`);
      await trackJob($('#job', root), session.job_id, { title: 'Building your session report', signal, onDone: () => navigate(`#/practice/${enc(sid)}/report`) });
      return undefined;
    }
    if (session.status === 'active') {
      mount(root, html`${head}<section class="card">${emptyState({ title: "This session hasn't ended yet", text: 'Continue answering, or end it now to build the report from your answers so far.',
        action: html`<div class="row" style="justify-content:center"><a class="btn btn-primary" href="#/practice/${enc(sid)}">Continue session</a><button type="button" class="btn btn-secondary" data-action="end">End and build report</button></div>` })}</section>`);
    } else {
      mount(root, html`${head}<section class="card">${emptyState({ title: 'No report yet', text: 'Building the report failed. Your answers are saved — try again.',
        action: html`<button type="button" class="btn btn-primary" data-action="end">Build report</button>` })}</section>`);
    }
    $('[data-action="end"]', root).addEventListener('click', async (e) => {
      setBusy(e.currentTarget, true, 'Starting…');
      try {
        const res = await api(`/api/sessions/${enc(sid)}/end`, { method: 'POST', body: {} });
        mount(root, html`${head}<div id="job"></div>`);
        await trackJob($('#job', root), res.job_id, { title: 'Building your session report', signal, onDone: () => navigate(`#/practice/${enc(sid)}/report`) });
      } catch (err) { toastError(err); setBusy(e.currentTarget, false); }
    });
    return undefined;
  }

  const r = session.report;
  const answered = session.turns.filter((t) => t.status === 'answered');
  mount(root, html`${head}
    <section class="card stack">
      <div class="card-head"><h2>${r.headline || 'How it went'}</h2>${metaBadge(r.meta)}</div>
      <div class="eval-head"><div><div class="hero-num">${fmtScore(r.overall_score ?? session.overall_score)}<small>/5</small></div><div class="subtle">Overall · ${answered.length} answers</div></div>
        ${r.encouragement ? html`<div class="banner banner-ok" style="flex:1;min-width:220px"><span class="banner-icon" aria-hidden="true">★</span><span>${r.encouragement}</span></div>` : ''}</div>
      ${(r.competency_scores || []).length ? html`<div><h3>By competency</h3><div class="stack-sm">${r.competency_scores.map((c) => {
        const d = Number(c.delta || 0);
        const delta = c.delta === null || c.delta === undefined || Math.abs(d) < 0.05 ? html`<span class="subtle small">no change</span>`
          : d > 0 ? html`<span class="delta-up small">▲ +${fmtScore(d)}</span>` : html`<span class="delta-down small">▼ ${fmtScore(d)}</span>`;
        return html`<div class="score-row" style="grid-template-columns:minmax(110px,170px) 1fr 34px 80px"><span class="lbl">${c.competency}</span>${meter(c.score, 5, { label: c.competency })}<span class="val">${fmtScore(c.score)}</span>${delta}</div>`;
      })}</div></div>` : ''}
      <div class="grid-2">
        <div><h3>Strengths</h3>${bullets(r.strengths, { cls: 'list list-check' })}</div>
        <div><h3>To improve</h3>${bullets(r.improvements, { cls: 'list list-arrow' })}</div>
      </div>
      ${feedbackWidget('report', session.id, { label: 'Was this report useful?' })}
    </section>
    ${(r.drills || []).length ? html`<section class="stack"><h2>Drills for next time</h2><div class="grid-3">${r.drills.map((d) => html`<article class="card card-tight stack-sm">
      <h3 style="margin:0">${d.title}</h3>${d.competency ? html`<span class="badge" style="align-self:flex-start">${d.competency}</span>` : ''}<p class="muted">${d.instructions}</p></article>`)}</div></section>` : ''}
    ${(r.next_focus || []).length ? html`<section class="card"><h2>Next focus</h2><div class="mt-3">${bullets(r.next_focus)}</div>
      <div class="mt-3"><a class="btn btn-secondary" href="#/practice?target=${enc(session.target_id)}">Start a focused session</a></div></section>` : ''}
    <section class="card"><h2>Question by question</h2><div class="mt-3 stack-sm">${session.turns.filter((t) => t.status !== 'asked').map((t) => html`<details class="q-item">
      <summary><span class="q-text">${t.kind === 'followup' ? 'Follow-up: ' : ''}${t.question_text}</span>
        <span class="item-meta">${t.status === 'skipped' ? html`<span class="badge">Skipped</span>` : t.evaluation ? html`<span class="badge">${fmtScore(t.evaluation.overall)} / 5</span>` : ''}${t.competency ? html`<span>${t.competency}</span>` : ''}${t.self_rating ? html`<span>Self-rated ${t.self_rating}</span>` : ''}</span></summary>
      <div class="q-body">${t.answer_text ? html`<div><div class="section-title">Your answer</div><p class="pre">${t.answer_text}</p></div>` : ''}
        ${t.evaluation ? html`${t.evaluation.summary ? html`<p>${t.evaluation.summary}</p>` : ''}<div class="grid-2"><div><h3>What worked</h3>${bullets(t.evaluation.strengths, { cls: 'list list-check' })}</div><div><h3>To improve</h3>${bullets(t.evaluation.improvements, { cls: 'list list-arrow' })}</div></div>` : ''}</div>
    </details>`)}</div></section>`);
  return undefined;
}
