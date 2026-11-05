// Meetings: consent-gated live transcription, notepad, live search + catch-me-up; enhanced notes after.
import { api, enc, getSettings, getTemplates } from '../api.js';
import {
  html, mount, loading, emptyState, errorState, statusBadge, metaBadge, bullets, snippetHTML,
  fmtRel, fmtDate, fmtClock, fmtDay, toast, toastError, confirmDialog, promptDialog, openModal, trackJob,
  feedbackWidget, tabsHTML, bindTabKeys, replaceQuery, setBusy, debounce, storageGet, storageSet, copyText,
  sentence, $, $$, on,
} from '../ui.js';
import { navigate, setLeaveGuard } from '../nav.js';
import { startCapture, displayCaptureSupported } from '../audio.js';

const DISCLOSURE = "Heads up: I'm using a note-taking app that transcribes this call for my notes.";

function speakerClass(speaker) {
  const s = String(speaker || '').toLowerCase();
  if (s === 'me') return 'me';
  if (s === 'them') return 'them';
  return 'other';
}
function segHTML(seg, { partial = false } = {}) {
  return html`<div class="seg ${speakerClass(seg.speaker)}${partial ? ' partial' : ''}" ${seg.id !== null && seg.id !== undefined ? html`id="seg-${seg.id}" data-seg="${seg.id}"` : ''}>
    <div class="meta"><span class="who">${seg.speaker || 'Speaker'}</span>${partial ? '…' : fmtClock(seg.t0)}</div>
    <div class="txt">${seg.text}</div></div>`;
}
function legendKeys() {
  return html`<span class="row"><span class="legend-key"><i style="background:var(--me)"></i>Me (your mic)</span><span class="legend-key"><i style="background:var(--them)"></i>Them (meeting audio)</span></span>`;
}
async function templateName(id) {
  try {
    const list = await getTemplates();
    const t = list.find((x) => x.id === id);
    return t ? t.name : sentence(id || 'general');
  } catch { return sentence(id || 'general'); }
}
function highlightSegments(container, ids) {
  const els = ids.map((sid) => container.querySelector(`#seg-${CSS.escape(String(sid))}`)).filter(Boolean);
  if (!els.length) { toast("That part of the transcript isn't available (it may have been deleted).", 'warn', { timeout: 4000 }); return; }
  els.forEach((el) => { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); });
  els[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// =================================================================================================
// List
// =================================================================================================
export async function meetingsList(root, { query, signal }) {
  document.title = 'Meetings · Interview App';
  mount(root, loading('Loading meetings…'));
  const meetings = await api('/api/meetings?limit=50', { signal });
  const q0 = query.get('q') || '';

  mount(root, html`
    <div class="page-head"><div><h1>Meetings</h1>
      <p class="lead">Transparent meeting notes: a live transcript everyone knows about, your own jottings, and AI-enhanced notes with decisions and action items afterwards.</p></div>
      <div class="actions"><a class="btn btn-primary" href="#/meetings/new">＋ New meeting</a></div></div>
    <div class="grid-2" style="align-items:start">
      <section class="card stack-sm"><h2>Search transcripts and notes</h2>
        <form id="ms-form" role="search" class="row"><label class="sr-only" for="ms-q">Search meetings</label>
          <input id="ms-q" class="input" type="search" placeholder="e.g. pricing, launch date, Priya" value="${q0}" style="flex:1;min-width:180px">
          <button class="btn btn-secondary" type="submit">Search</button></form></section>
      <section class="card stack-sm"><h2>Ask across saved meetings</h2>
        <form id="ask-form" class="row"><label class="sr-only" for="ask-q">Question</label>
          <input id="ask-q" class="input" placeholder="e.g. What did we decide about the Q3 roadmap?" style="flex:1;min-width:180px">
          <button class="btn btn-secondary" type="submit">Ask</button></form>
        <div id="ask-out" aria-live="polite"></div></section>
    </div>
    <section class="card"><div class="card-head"><h2 id="ml-title">All meetings</h2></div><div id="ml" class="list-rows"></div></section>
  `);

  const listEl = $('#ml', root);
  function renderList(items, searching) {
    $('#ml-title', root).textContent = searching ? `Results for “${searching}”` : 'All meetings';
    if (!items.length) {
      mount(listEl, searching ? emptyState({ title: 'No matches', text: 'Try different words.' })
        : emptyState({ title: 'No meetings yet', text: 'Start one to get a live transcript and enhanced notes.', action: html`<a class="btn btn-primary" href="#/meetings/new">New meeting</a>` }));
      return;
    }
    mount(listEl, html`${items.map((m) => html`<a class="list-row" href="#/meetings/${enc(m.id)}${searching ? `?q=${enc(searching)}` : ''}">
      <div class="main"><div class="t">${m.title}</div>
        ${m.snippet ? html`<div class="small muted mt-2">${snippetHTML(m.snippet)}</div>` : ''}
        <div class="item-meta"><span>${fmtDate(m.started_at)}</span>${m.duration_sec ? html`<span>${fmtClock(m.duration_sec)}</span>` : ''}<span>${m.segment_count ?? 0} lines</span><span>${sentence(m.template || 'general')}</span></div></div>
      ${statusBadge(m.status)}</a>`)}`);
  }
  async function search(q) {
    replaceQuery({ q: q || null });
    if (!q) { renderList(meetings, ''); return; }
    mount(listEl, loading('Searching…'));
    try {
      const hits = await api(`/api/meetings?q=${enc(q)}&limit=50`, { signal });
      renderList(hits, q);
    } catch (err) { if (err.name !== 'AbortError') mount(listEl, errorState(err, { retry: false })); }
  }
  const debounced = debounce((q) => search(q), 350);
  $('#ms-q', root).addEventListener('input', (e) => debounced(e.target.value.trim()));
  $('#ms-form', root).addEventListener('submit', (e) => { e.preventDefault(); debounced.flush($('#ms-q', root).value.trim()); });
  if (q0) search(q0); else renderList(meetings, '');

  $('#ask-form', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const question = $('#ask-q', root).value.trim();
    const out = $('#ask-out', root);
    if (question.length < 3) { toast('Type a question first.', 'error'); return; }
    const btn = e.currentTarget.querySelector('button');
    setBusy(btn, true, 'Asking…');
    mount(out, loading('Reading your saved meetings…'));
    try {
      const res = await api('/api/ask', { method: 'POST', body: { question } });
      mount(out, html`<div class="stack-sm mt-3">
        ${res.not_found ? html`<p class="muted">I couldn't find that in your saved meetings.</p>` : html`<p class="answer-text">${res.answer}</p>`}
        ${(res.citations || []).length ? html`<div class="citations"><div class="section-title">Sources</div>${res.citations.map((c) => html`<a class="hit" href="#/meetings/${enc(c.meeting_id)}?tab=transcript&seg=${enc(c.segment_id)}">
          <span class="hm"><strong>${c.meeting_title || 'Meeting'}</strong><span>${c.speaker}</span><span>${fmtClock(c.t0)}</span></span><span>${c.text}</span></a>`)}</div>` : ''}
        <div class="row-between">${metaBadge(res.meta)}${feedbackWidget('answer', `ask:${question.slice(0, 60)}`)}</div></div>`);
    } catch (err) { mount(out, errorState(err, { retry: false })); }
    finally { setBusy(btn, false); }
  });
  return undefined;
}

// =================================================================================================
// New meeting (consent gate)
// =================================================================================================
export async function meetingNew(root, { signal }) {
  document.title = 'New meeting · Interview App';
  mount(root, loading('Loading…'));
  const [templates, settings] = await Promise.all([getTemplates().catch(() => []), getSettings().catch(() => null)]);
  const defTemplate = (settings && settings.notes && settings.notes.default_template) || 'general';
  const list = templates.length ? templates : [{ id: 'general', name: 'General meeting', description: 'Overview, discussion and next steps.', sections: [] }];
  const checkedId = list.some((t) => t.id === defTemplate) ? defTemplate : list[0].id;
  const defaultTitle = `Meeting · ${fmtDay(new Date().toISOString())}`;

  mount(root, html`
    <div class="page-head"><div><a class="crumb" href="#/meetings">← Meetings</a><h1>New meeting</h1>
      <p class="lead">Pick a template so the notes come out in the right shape. You'll confirm that everyone knows about the transcription before anything is recorded.</p></div></div>
    <form class="card stack" id="nm-form">
      <div class="field"><label for="nm-title">Title</label><input id="nm-title" class="input" value="${defaultTitle}" autocomplete="off"></div>
      <fieldset><legend>Template</legend><div class="template-grid">${list.map((t) => html`<label class="template-card">
        <input type="radio" name="template" value="${t.id}" ${t.id === checkedId ? 'checked' : ''}>
        <span class="tn">${t.name}</span><span class="td">${t.description || ''}</span>
        ${(t.sections || []).length ? html`<span class="subtle small">${t.sections.join(' · ')}</span>` : ''}</label>`)}</div></fieldset>
      <div><button type="submit" class="btn btn-primary btn-lg">Continue</button></div>
    </form>`);

  $('#nm-form', root).addEventListener('submit', (e) => {
    e.preventDefault();
    const title = $('#nm-title', root).value.trim() || defaultTitle;
    const template = (root.querySelector('input[name=template]:checked') || {}).value || 'general';
    const { el } = openModal({
      title: 'Before you start',
      body: html`<p>Transcription records what people say. Make sure everyone in the meeting knows — in many places all participants must consent to being recorded.</p>
        <div class="field"><span class="field-label">Say or paste this at the start</span>
          <div class="consent-line"><span>${DISCLOSURE}</span><button type="button" class="btn btn-secondary btn-sm" data-copy>Copy</button></div></div>
        <label class="check"><input type="checkbox" id="consent-check"><span><strong>Everyone in this meeting knows it's being transcribed</strong></span></label>
        <div class="field"><label for="consent-note">How did you let them know? <span class="subtle">(optional, saved with the meeting)</span></label>
          <input id="consent-note" class="input" placeholder="e.g. Announced at the start; nobody objected"></div>`,
      actions: [
        { label: 'Cancel', kind: 'btn-ghost' },
        { label: 'Start meeting', kind: 'btn-primary', onClick: async (dlg) => {
          if (!dlg.querySelector('#consent-check').checked) {
            toast('Please confirm everyone knows the meeting is being transcribed.', 'error');
            dlg.querySelector('#consent-check').focus();
            return false;
          }
          const body = { title, template, consent_confirmed: true };
          const note = dlg.querySelector('#consent-note').value.trim();
          if (note) body.consent_note = note;
          const meeting = await api('/api/meetings', { method: 'POST', body });
          navigate(`#/meetings/${enc(meeting.id)}`);
          return true;
        } },
      ],
    });
    el.querySelector('[data-copy]').addEventListener('click', () => copyText(DISCLOSURE));
  });
  return undefined;
}

// =================================================================================================
// Meeting (live or saved)
// =================================================================================================
export async function meetingView(root, { params, query, signal }) {
  mount(root, loading('Loading meeting…'));
  let meeting;
  try {
    meeting = await api(`/api/meetings/${enc(params.id)}`, { signal });
  } catch (err) {
    if (err.status === 404) {
      mount(root, emptyState({ title: 'Meeting not found', text: 'It may have been deleted.', action: html`<a class="btn btn-primary" href="#/meetings">Back to Meetings</a>` }));
      return undefined;
    }
    throw err;
  }
  document.title = `${meeting.title} · Meetings · Interview App`;
  if (meeting.status === 'live') return liveView(root, meeting, { signal });
  return detailView(root, meeting, { query, signal });
}

// --- live ---------------------------------------------------------------------------------------------
async function liveView(root, meeting, { signal }) {
  const id = meeting.id;
  const tplName = await templateName(meeting.template);
  const started = new Date(meeting.started_at).getTime() || Date.now();
  const st = {
    segments: [...(meeting.segments || [])].sort((a, b) => a.t0 - b.t0),
    caps: { me: null, them: null }, starting: { me: false, them: false },
    partials: { me: '', them: '' }, paused: false, elapsedId: null, disposed: false,
  };
  const elapsedSec = () => Math.max(0, (Date.now() - started) / 1000);

  mount(root, html`
    <div class="page-head">
      <div><a class="crumb" href="#/meetings">← Meetings</a><h1 id="m-title">${meeting.title}</h1>
        <div class="item-meta mt-2"><span class="rec-indicator" id="rec" role="status">Not capturing</span><span id="elapsed">${fmtClock(elapsedSec())}</span><span>${tplName}</span><span class="badge badge-ok">✓ Consent confirmed</span></div></div>
      <div class="actions"><button type="button" class="btn btn-ghost" data-action="rename">Rename</button>
        <button type="button" class="btn btn-primary" data-action="stop-meeting">Stop &amp; write notes</button></div>
    </div>
    <section class="card stack-sm">
      <div class="capture-bar">
        <div class="capture-ctl"><button type="button" class="btn btn-secondary" data-action="cap" data-ch="me" aria-pressed="false">🎙 Start my mic</button>
          <span class="level" aria-hidden="true"><span id="lvl-me"></span></span><span class="eng" id="eng-me"></span></div>
        <div class="capture-ctl"><button type="button" class="btn btn-secondary" data-action="cap" data-ch="them" aria-pressed="false" ${displayCaptureSupported() ? '' : 'disabled'}>🖥 Start meeting audio</button>
          <span class="level" aria-hidden="true"><span id="lvl-them"></span></span><span class="eng" id="eng-them"></span></div>
        <button type="button" class="btn btn-secondary" data-action="pause" aria-pressed="false" disabled>⏸ Pause</button>
        <span class="spacer"></span>
        <button type="button" class="btn btn-ghost" data-action="redact" title="Privacy: permanently delete the last two minutes of transcript">🗑 Delete last 2 min</button>
      </div>
      <details class="small"><summary class="muted">How to capture the other side of the call</summary>
        <ul class="list mt-2">
          <li><strong>Calls in the browser</strong> (Meet, Teams or Zoom web): Start meeting audio → pick the meeting's tab → tick <em>Share tab audio</em>.</li>
          <li><strong>Desktop apps</strong> (Zoom, Teams): choose <em>Entire screen</em> and tick <em>Share system audio</em> (Windows).</li>
          <li><strong>Wear headphones</strong> so other people's voices aren't picked up a second time by your mic.</li>
          <li>Your mic is labelled <em>Me</em>; meeting audio is labelled <em>Them</em>. Pause any time — nothing is captured while paused.</li>
        </ul></details>
    </section>
    <div class="live-grid">
      <section class="card stack-sm">
        <div class="card-head"><h2>Transcript</h2>${legendKeys()}</div>
        <div class="transcript" id="transcript" aria-live="polite" aria-relevant="additions" tabindex="0" aria-label="Live transcript"></div>
        <div id="partials" class="stack-sm"></div>
      </section>
      <div class="live-side">
        <section class="card stack-sm"><div class="card-head" style="margin-bottom:0"><h2>Your notes</h2><span class="save-state" id="save-state" aria-live="polite"></span></div>
          <p class="subtle">Jot the points that matter to you. When you stop, the AI writes full notes around them.</p>
          <label class="sr-only" for="notepad">Your notes</label><textarea id="notepad" class="textarea notepad" placeholder="- Pricing: they want annual billing&#10;- Follow up with Sam about the API">${meeting.user_notes || ''}</textarea></section>
        <section class="card stack-sm"><h2>Search what was said</h2>
          <form id="s-form" role="search" class="stack-sm"><div class="row"><label class="sr-only" for="s-q">Search the transcript</label>
            <input id="s-q" class="input" type="search" placeholder="e.g. budget, deadline, Priya" style="flex:1;min-width:140px"><button type="submit" class="btn btn-secondary">Search</button></div>
            <div class="segmented" role="radiogroup" aria-label="Search scope"><label><input type="radio" name="scope" value="meeting" checked><span>This meeting</span></label><label><input type="radio" name="scope" value="all"><span>All meetings</span></label></div></form>
          <div id="s-out" class="stack-sm" aria-live="polite"></div></section>
        <section class="card stack-sm"><h2>Catch me up</h2><p class="subtle">A short recap of what was said — nothing more.</p>
          <div class="row"><label class="sr-only" for="recap-min">Time window</label>
            <select id="recap-min" class="select" style="width:auto"><option value="2">Last 2 min</option><option value="5" selected>Last 5 min</option><option value="10">Last 10 min</option><option value="0">Whole meeting</option></select>
            <button type="button" class="btn btn-secondary" data-action="recap">Catch me up</button></div>
          <div id="recap-out" aria-live="polite"></div></section>
      </div>
    </div>
    <div id="stop-area"></div>
  `);

  const transcriptEl = $('#transcript', root);
  function renderTranscript() {
    if (!st.segments.length) {
      mount(transcriptEl, html`<p class="subtle">The transcript appears here once you start your mic or the meeting audio.</p>`);
      return;
    }
    mount(transcriptEl, html`${st.segments.map((s) => segHTML(s))}`);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }
  function addSegment(seg) {
    const nearBottom = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 80;
    const last = st.segments[st.segments.length - 1];
    st.segments.push(seg);
    if (!last || seg.t0 >= last.t0) {
      if (st.segments.length === 1) transcriptEl.innerHTML = '';
      transcriptEl.insertAdjacentHTML('beforeend', segHTML(seg).toString());
    } else {
      st.segments.sort((a, b) => a.t0 - b.t0);
      mount(transcriptEl, html`${st.segments.map((s) => segHTML(s))}`);
    }
    if (nearBottom) transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }
  function renderPartials() {
    const items = ['me', 'them'].filter((ch) => st.partials[ch]).map((ch) => ({ speaker: ch === 'me' ? 'Me' : 'Them', text: st.partials[ch] }));
    mount($('#partials', root), html`${items.map((p) => segHTML(p, { partial: true }))}`);
  }
  renderTranscript();

  // --- capture state ---
  const anyCapturing = () => Boolean(st.caps.me || st.caps.them);
  function updateCaptureUI() {
    ['me', 'them'].forEach((ch) => {
      const btn = root.querySelector(`[data-action="cap"][data-ch="${ch}"]`);
      if (!btn) return;
      const on = Boolean(st.caps[ch]);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.className = `btn ${on ? 'btn-record' : 'btn-secondary'}`;
      btn.disabled = st.starting[ch] || (ch === 'them' && !displayCaptureSupported());
      btn.textContent = st.starting[ch] ? 'Starting…' : ch === 'me' ? (on ? '■ Stop my mic' : '🎙 Start my mic') : (on ? '■ Stop meeting audio' : '🖥 Start meeting audio');
      const eng = $(`#eng-${ch}`, root);
      if (eng) eng.textContent = on ? (st.caps[ch].engine === 'browser' ? 'browser recognition' : 'local engine') : '';
      if (!on) setLevel(ch, 0);
    });
    const pauseBtn = $('[data-action="pause"]', root);
    pauseBtn.disabled = !anyCapturing();
    pauseBtn.setAttribute('aria-pressed', st.paused ? 'true' : 'false');
    pauseBtn.textContent = st.paused ? '▶ Resume' : '⏸ Pause';
    const rec = $('#rec', root);
    const live = anyCapturing() && !st.paused;
    rec.classList.toggle('on', live);
    rec.textContent = live ? 'Transcribing' : anyCapturing() ? 'Paused — nothing is being captured' : 'Not capturing';
    setLeaveGuard(anyCapturing() ? 'Transcription is running. Leave this page and stop capturing?' : null);
  }
  function setLevel(ch, level) {
    const bar = document.getElementById(`lvl-${ch}`);
    if (bar) bar.style.width = `${Math.round(Math.min(1, level) * 100)}%`;
  }
  async function stopCap(ch) {
    const cap = st.caps[ch];
    st.caps[ch] = null;
    st.partials[ch] = '';
    renderPartials();
    if (!anyCapturing()) st.paused = false;
    updateCaptureUI();
    if (cap) { try { await cap.stop(); } catch { /* ignore */ } }
  }
  async function toggleCap(ch) {
    if (st.caps[ch]) { await stopCap(ch); return; }
    st.starting[ch] = true;
    updateCaptureUI();
    try {
      const cap = await startCapture({
        source: ch === 'me' ? 'mic' : 'display', mode: 'meeting', meetingId: id, channel: ch, offsetSec: elapsedSec(),
        onPartial: (text) => { st.partials[ch] = text; renderPartials(); },
        onFinal: (seg) => addSegment(seg),
        onLevel: (lv) => setLevel(ch, lv),
        onStatus: (s) => {
          if (s.type === 'error') toast(s.message, 'error');
          else if ((s.type === 'ended' || s.type === 'closed') && st.caps[ch]) {
            toast(s.type === 'ended' ? `${ch === 'me' ? 'Mic' : 'Meeting audio'} capture ended.` : 'Lost the connection to the speech engine.', 'warn', { timeout: 5000 });
            stopCap(ch);
          }
        },
      });
      if (st.disposed) { cap.stop(); return; }
      st.caps[ch] = cap;
      if (st.paused) cap.pause();
    } catch (err) {
      toastError(err);
    } finally {
      st.starting[ch] = false;
      updateCaptureUI();
    }
  }
  function togglePause() {
    st.paused = !st.paused;
    ['me', 'them'].forEach((ch) => {
      const cap = st.caps[ch];
      if (!cap) return;
      if (st.paused) cap.pause(); else cap.resume();
    });
    if (st.paused) { st.partials = { me: '', them: '' }; renderPartials(); }
    updateCaptureUI();
  }

  // --- notes autosave ---
  const saveState = $('#save-state', root);
  let lastSaved = meeting.user_notes || '';
  const save = debounce(async (text) => {
    if (text === lastSaved) return;
    saveState.textContent = 'Saving…';
    try {
      await api(`/api/meetings/${enc(id)}`, { method: 'PUT', body: { user_notes: text } });
      lastSaved = text;
      saveState.textContent = 'Saved';
    } catch {
      saveState.textContent = 'Not saved — will retry';
      setTimeout(() => save($('#notepad', root) ? $('#notepad', root).value : text), 3000);
    }
  }, 800);
  $('#notepad', root).addEventListener('input', (e) => { saveState.textContent = 'Editing…'; save(e.target.value); });

  // --- search ---
  $('#s-form', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('#s-q', root).value.trim();
    const out = $('#s-out', root);
    if (!q) { mount(out, ''); return; }
    const scope = (root.querySelector('input[name=scope]:checked') || {}).value || 'meeting';
    mount(out, loading('Searching…'));
    try {
      const res = await api(`/api/meetings/${enc(id)}/search?q=${enc(q)}&scope=${enc(scope)}`, { signal });
      const hits = res.hits || [];
      mount(out, hits.length ? html`<p class="subtle">${hits.length} ${hits.length === 1 ? 'match' : 'matches'}${res.took_ms !== undefined ? ` · ${res.took_ms} ms` : ''}</p>
        ${hits.map((h) => html`<button type="button" class="hit" data-hit-seg="${h.segment_id}" data-hit-mid="${h.meeting_id}">
          <span class="hm">${h.meeting_id !== id ? html`<strong>${h.meeting_title || 'Another meeting'}</strong>` : ''}<span>${h.speaker}</span><span>${fmtClock(h.t0)}</span></span>
          <span>${snippetHTML(h.snippet || h.text)}</span></button>`)}`
        : html`<p class="muted">No matches${scope === 'meeting' ? ' in this meeting yet' : ''}.</p>`);
    } catch (err) { if (err.name !== 'AbortError') mount(out, errorState(err, { retry: false })); }
  });
  on(root, 'click', '[data-hit-seg]', (e, btn) => {
    const mid = btn.dataset.hitMid;
    if (mid === id) highlightSegments(transcriptEl, [btn.dataset.hitSeg]);
    else navigate(`#/meetings/${enc(mid)}?tab=transcript&seg=${enc(btn.dataset.hitSeg)}`);
  });

  // --- recap ---
  async function recap(btn) {
    const minutes = Number($('#recap-min', root).value);
    const out = $('#recap-out', root);
    setBusy(btn, true, 'Summarising…');
    try {
      const res = await api(`/api/meetings/${enc(id)}/recap`, { method: 'POST', body: { minutes } });
      const w = res.window || {};
      const empty = !(res.recap || []).length && !(res.decisions || []).length && !(res.open_questions || []).length;
      mount(out, html`<div class="stack-sm mt-2">
        <div class="row-between"><span class="subtle">${w.from_sec !== undefined ? `${fmtClock(w.from_sec)} – ${fmtClock(w.to_sec)}` : ''}</span>${metaBadge(res.meta)}</div>
        ${empty ? html`<p class="muted">Nothing was said in that window yet.</p>` : html`
          ${(res.recap || []).length ? bullets(res.recap) : ''}
          ${(res.decisions || []).length ? html`<div><div class="section-title">Decisions</div>${bullets(res.decisions)}</div>` : ''}
          ${(res.open_questions || []).length ? html`<div><div class="section-title">Open questions</div>${bullets(res.open_questions)}</div>` : ''}`}
        ${feedbackWidget('recap', id)}</div>`);
    } catch (err) { mount(out, errorState(err, { retry: false })); }
    finally { setBusy(btn, false); }
  }

  // --- redact ---
  async function redact() {
    const ok = await confirmDialog({ title: 'Delete the last 2 minutes?', message: 'This permanently removes those transcript lines from this meeting and from search. Your notepad is not affected.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      const res = await api(`/api/meetings/${enc(id)}/redact`, { method: 'POST', body: { minutes: 2 } });
      const fresh = await api(`/api/meetings/${enc(id)}`, { signal });
      st.segments = [...(fresh.segments || [])].sort((a, b) => a.t0 - b.t0);
      renderTranscript();
      toast(`Deleted ${res.deleted ?? 0} transcript ${res.deleted === 1 ? 'line' : 'lines'}.`, 'success', { timeout: 3000 });
    } catch (err) { toastError(err); }
  }

  // --- rename ---
  async function rename() {
    const title = await promptDialog({ title: 'Rename meeting', label: 'Title', value: $('#m-title', root).textContent });
    if (!title) return;
    try {
      await api(`/api/meetings/${enc(id)}`, { method: 'PUT', body: { title } });
      $('#m-title', root).textContent = title;
      document.title = `${title} · Meetings · Interview App`;
    } catch (err) { toastError(err); }
  }

  // --- stop ---
  async function stopMeeting(btn) {
    const ok = await confirmDialog({ title: 'Stop and write notes?', message: 'Capturing stops and the agents write your notes from the transcript and your jottings. You can still edit and re-run them afterwards.', confirmLabel: 'Stop & write notes' });
    if (!ok) return;
    setBusy(btn, true, 'Stopping…');
    await Promise.all(['me', 'them'].map((ch) => (st.caps[ch] ? stopCap(ch) : null)));
    try {
      await save.flush($('#notepad', root).value);
      const res = await api(`/api/meetings/${enc(id)}/stop`, { method: 'POST', body: {} });
      setLeaveGuard(null);
      clearInterval(st.elapsedId);
      root.querySelectorAll('.capture-bar button, .live-grid button, .live-grid input, .live-grid textarea, .live-grid select').forEach((el) => { el.disabled = true; });
      const area = $('#stop-area', root);
      area.scrollIntoView({ behavior: 'smooth' });
      await trackJob(area, res.job_id, {
        title: 'Writing your notes',
        subtitle: 'The agents merge your jottings with the transcript, pull out decisions and action items, and index everything for search.',
        signal,
        onDone: () => navigate(`#/meetings/${enc(id)}`),
        onFailed: () => navigate(`#/meetings/${enc(id)}`),
      });
    } catch (err) {
      toastError(err);
      setBusy(btn, false);
    }
  }

  on(root, 'click', '[data-action]', (e, btn) => {
    const a = btn.dataset.action;
    if (a === 'cap') toggleCap(btn.dataset.ch);
    else if (a === 'pause') togglePause();
    else if (a === 'redact') redact();
    else if (a === 'recap') recap(btn);
    else if (a === 'rename') rename();
    else if (a === 'stop-meeting') stopMeeting(btn);
  });
  st.elapsedId = setInterval(() => { const el = $('#elapsed', root); if (el) el.textContent = fmtClock(elapsedSec()); }, 1000);
  updateCaptureUI();

  return () => {
    st.disposed = true;
    clearInterval(st.elapsedId);
    ['me', 'them'].forEach((ch) => { if (st.caps[ch]) { try { st.caps[ch].stop(); } catch { /* ignore */ } st.caps[ch] = null; } });
    const pad = document.getElementById('notepad');
    if (pad && pad.value !== lastSaved) save.flush(pad.value);
    setLeaveGuard(null);
  };
}

// --- saved meeting ------------------------------------------------------------------------------------
async function detailView(root, meeting, { query, signal }) {
  const id = meeting.id;
  const tplName = await templateName(meeting.template);
  const head = () => html`<div class="page-head">
    <div><a class="crumb" href="#/meetings">← Meetings</a><h1 id="m-title">${meeting.title}</h1>
      <div class="item-meta mt-2"><span>${fmtDate(meeting.started_at)}</span>${meeting.duration_sec ? html`<span>${fmtClock(meeting.duration_sec)}</span>` : ''}<span>${tplName}</span><span>${(meeting.segments || []).length} lines</span>${statusBadge(meeting.status)}</div></div>
    <div class="actions">
      <button type="button" class="btn btn-ghost" data-action="rename">Rename</button>
      ${meeting.status !== 'processing' ? html`<button type="button" class="btn btn-secondary" data-action="enhance">Re-run notes</button>` : ''}
      <a class="btn btn-secondary" href="/api/meetings/${enc(id)}/export.md" download>Export .md</a>
      <button type="button" class="btn btn-ghost" data-action="delete">Delete</button>
    </div></div>`;

  async function rename() {
    const title = await promptDialog({ title: 'Rename meeting', label: 'Title', value: meeting.title });
    if (!title) return;
    try {
      await api(`/api/meetings/${enc(id)}`, { method: 'PUT', body: { title } });
      meeting.title = title;
      $('#m-title', root).textContent = title;
      document.title = `${title} · Meetings · Interview App`;
    } catch (err) { toastError(err); }
  }
  async function del() {
    const ok = await confirmDialog({ title: 'Delete this meeting?', message: 'The transcript, notes and search index for it are deleted permanently.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try { await api(`/api/meetings/${enc(id)}`, { method: 'DELETE' }); toast('Meeting deleted.', 'success', { timeout: 2500 }); navigate('#/meetings'); }
    catch (err) { toastError(err); }
  }
  async function enhance() {
    let templates = [];
    try { templates = await getTemplates(); } catch { /* ignore */ }
    openModal({
      title: 'Re-run notes',
      body: html`<p class="muted">The agents rewrite the notes from the transcript and your jottings. Edits made to the notes are replaced.</p>
        <div class="field"><label for="re-tpl">Template</label><select id="re-tpl" class="select">${(templates.length ? templates : [{ id: meeting.template, name: tplName }]).map((t) => html`<option value="${t.id}" ${t.id === meeting.template ? 'selected' : ''}>${t.name}</option>`)}</select></div>`,
      actions: [
        { label: 'Cancel', kind: 'btn-ghost' },
        { label: 'Re-run', kind: 'btn-primary', onClick: async (dlg) => {
          const res = await api(`/api/meetings/${enc(id)}/enhance`, { method: 'POST', body: { template: dlg.querySelector('#re-tpl').value } });
          meeting.status = 'processing';
          meeting.job_id = res.job_id;
          renderProcessing();
          return true;
        } },
      ],
    });
  }
  function bindHead() {
    on(root, 'click', '[data-action="rename"]', rename);
    on(root, 'click', '[data-action="delete"]', del);
    on(root, 'click', '[data-action="enhance"]', enhance);
  }

  async function renderProcessing() {
    mount(root, html`${head()}<div id="job"></div>`);
    await trackJob($('#job', root), meeting.job_id, {
      title: 'Writing your notes', signal,
      onDone: () => navigate(`#/meetings/${enc(id)}`),
      onFailed: () => navigate(`#/meetings/${enc(id)}`),
    });
  }

  bindHead();
  if (meeting.status === 'processing' && meeting.job_id) { renderProcessing(); return undefined; }

  const notes = meeting.notes;
  let tab = query.get('tab') || 'notes';
  if (!['notes', 'transcript', 'ask', 'drafts'].includes(tab)) tab = 'notes';
  let focusSeg = query.get('seg');
  if (focusSeg) tab = 'transcript';
  const segments = [...(meeting.segments || [])].sort((a, b) => a.t0 - b.t0);
  const actionsKey = `ia.actions.${id}`;
  const draftCache = {};

  mount(root, html`${head()}
    ${meeting.status === 'failed' ? html`<div class="banner banner-danger" role="alert"><span class="banner-icon" aria-hidden="true">⚠</span>
      <div class="stack-sm"><strong>The notes couldn't be written.</strong><span>Your transcript is safe. Try again — if it keeps failing, check System for model status.</span>
      <div><button type="button" class="btn btn-secondary btn-sm" data-action="enhance">Try again</button></div></div></div>` : ''}
    ${tabsHTML([{ key: 'notes', label: 'Notes' }, { key: 'transcript', label: 'Transcript', count: segments.length }, { key: 'ask', label: 'Ask' }, { key: 'drafts', label: 'Drafts' }], tab, { label: 'Meeting sections' })}
    <div id="panel" role="tabpanel" tabindex="0" aria-labelledby="tab-${tab}"></div>`);

  const tablist = $('.tabs', root);
  tablist.addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) selectTab(b.dataset.tab); });
  bindTabKeys(tablist, selectTab);

  function selectTab(key, after) {
    tab = key;
    $$('.tabs [role="tab"]', root).forEach((b) => { const sel = b.dataset.tab === key; b.setAttribute('aria-selected', sel ? 'true' : 'false'); b.tabIndex = sel ? 0 : -1; });
    replaceQuery({ tab: key === 'notes' ? null : key, seg: null });
    renderPanel();
    if (after) after();
  }

  function renderPanel() {
    const old = $('#panel', root);
    const panel = old.cloneNode(false);
    panel.setAttribute('aria-labelledby', `tab-${tab}`);
    old.replaceWith(panel);
    if (tab === 'notes') renderNotes(panel);
    else if (tab === 'transcript') renderTranscriptTab(panel);
    else if (tab === 'ask') renderAsk(panel);
    else renderDrafts(panel);
  }

  function showSegments(ids) {
    selectTab('transcript', () => {
      const container = $('#panel .transcript', root);
      if (container) highlightSegments(container, ids);
    });
  }

  // --- notes ---
  function renderNotes(panel) {
    if (!notes) {
      mount(panel, emptyState({ title: 'No notes yet', text: meeting.status === 'failed' ? 'Use “Try again” above to write them.' : 'Notes appear once the agents finish.' }));
      return;
    }
    const done = storageGet(actionsKey, {}) || {};
    mount(panel, html`<section class="card notes-doc">
      <div class="row-between"><div class="notes-legend"><span class="you">Your notes</span><span>AI additions <span class="ai-tag">AI</span></span></div>${metaBadge(notes.meta)}</div>
      ${notes.summary ? html`<p class="summary">${notes.summary}</p>` : ''}
      ${(notes.sections || []).map((s) => html`<section><h3>${s.heading}</h3>${(s.bullets || []).length ? html`<ul>${s.bullets.map((b) => html`<li class="${b.source === 'ai' ? 'ai' : 'you'}">${b.text}${b.source === 'ai' ? html`<span class="ai-tag" title="Written by AI from the transcript">AI</span>` : ''}${(b.refs || []).length ? html` <button type="button" class="link-btn small" data-refs="${b.refs.join(',')}" aria-label="Show the source in the transcript">source</button>` : ''}</li>`)}</ul>` : html`<p class="subtle">—</p>`}</section>`)}
      ${(notes.decisions || []).length ? html`<section><h3>Decisions</h3>${bullets(notes.decisions)}</section>` : ''}
      ${(notes.action_items || []).length ? html`<section><h3>Action items</h3><ul class="list-plain">${notes.action_items.map((a, i) => html`<li class="action-item ${done[i] ? 'done' : ''}">
        <input type="checkbox" id="ai-${i}" data-action-item="${i}" ${done[i] ? 'checked' : ''}><label for="ai-${i}"><span class="task">${a.task}</span>
        ${a.owner || a.due ? html`<span class="subtle small"> — ${[a.owner, a.due].filter(Boolean).join(' · ')}</span>` : ''}</label></li>`)}</ul></section>` : ''}
      ${(notes.open_questions || []).length ? html`<section><h3>Open questions</h3>${bullets(notes.open_questions)}</section>` : ''}
      ${(notes.questions_asked || []).length ? html`<section><div class="row-between"><h3>Questions you were asked</h3><button type="button" class="btn btn-secondary btn-sm" data-action="to-practice">Add to practice bank</button></div>
        ${bullets(notes.questions_asked)}</section>` : ''}
      ${meeting.user_notes ? html`<details><summary class="muted">Your original jottings</summary><p class="pre mt-2">${meeting.user_notes}</p></details>` : ''}
      ${feedbackWidget('notes', id, { label: 'Were these notes useful?' })}
    </section>`);
    on(panel, 'click', '[data-refs]', (e, btn) => showSegments(btn.dataset.refs.split(',').filter(Boolean)));
    on(panel, 'change', '[data-action-item]', (e, box) => {
      const state = storageGet(actionsKey, {}) || {};
      state[box.dataset.actionItem] = box.checked;
      storageSet(actionsKey, state);
      box.closest('.action-item').classList.toggle('done', box.checked);
    });
    on(panel, 'click', '[data-action="to-practice"]', toPractice);
  }

  async function toPractice() {
    let targets = [];
    try { targets = await api('/api/targets'); } catch (err) { toastError(err); return; }
    if (!targets.length) { toast('Create a target in Prep first, then add these questions to it.', 'warn'); return; }
    openModal({
      title: 'Add to a practice bank',
      body: html`<p class="muted">These questions go into the target's bank so you can practise them in your next session.</p>
        <div class="field"><label for="tp-target">Target</label><select id="tp-target" class="select">${targets.map((t) => html`<option value="${t.id}">${t.title || 'Untitled target'}${t.company ? ` · ${t.company}` : ''}</option>`)}</select></div>`,
      actions: [
        { label: 'Cancel', kind: 'btn-ghost' },
        { label: 'Add questions', kind: 'btn-primary', onClick: async (dlg) => {
          const sel = dlg.querySelector('#tp-target');
          const res = await api(`/api/meetings/${enc(id)}/to-practice`, { method: 'POST', body: { target_id: sel.value } });
          const name = sel.options[sel.selectedIndex].textContent;
          toast(`Added ${res.added ?? 0} ${res.added === 1 ? 'question' : 'questions'} to ${name}.`, 'success');
          return true;
        } },
      ],
    });
  }

  // --- transcript ---
  function renderTranscriptTab(panel) {
    mount(panel, html`<section class="card stack-sm">
      <div class="row-between"><div class="row"><label class="sr-only" for="tf">Filter transcript</label><input id="tf" class="input" type="search" placeholder="Filter lines…" style="width:auto;min-width:200px"></div>${legendKeys()}</div>
      ${segments.length ? html`<div class="transcript static" id="t-list">${segments.map((s) => segHTML(s))}</div>` : html`<p class="muted">No transcript lines were captured.</p>`}
    </section>`);
    const filter = $('#tf', panel);
    filter.addEventListener('input', () => {
      const q = filter.value.trim().toLowerCase();
      $$('#t-list .seg', panel).forEach((el) => { el.hidden = Boolean(q) && !el.textContent.toLowerCase().includes(q); });
    });
    if (focusSeg && tab === 'transcript') {
      const container = $('#t-list', panel);
      const segId = focusSeg;
      focusSeg = null;
      if (container) setTimeout(() => highlightSegments(container, [segId]), 50);
    }
  }

  // --- ask ---
  function renderAsk(panel) {
    mount(panel, html`<section class="card stack">
      <form id="ask-form" class="stack-sm"><label for="ask-q" class="field-label">Ask about this meeting</label>
        <div class="row"><input id="ask-q" class="input" placeholder="e.g. What did Sam commit to?" style="flex:1;min-width:200px"><button type="submit" class="btn btn-primary">Ask</button></div>
        <span class="subtle">Answers come only from this meeting's transcript, with sources.</span></form>
      <div id="ask-out" aria-live="polite"></div></section>`);
    $('#ask-form', panel).addEventListener('submit', async (e) => {
      e.preventDefault();
      const question = $('#ask-q', panel).value.trim();
      const out = $('#ask-out', panel);
      if (question.length < 3) { toast('Type a question first.', 'error'); return; }
      const btn = e.currentTarget.querySelector('button');
      setBusy(btn, true, 'Asking…');
      mount(out, loading('Reading the transcript…'));
      try {
        const res = await api(`/api/meetings/${enc(id)}/ask`, { method: 'POST', body: { question } });
        mount(out, html`<div class="stack-sm">
          ${res.not_found ? html`<p class="muted">I couldn't find that in this meeting.</p>` : html`<p class="answer-text">${res.answer}</p>`}
          ${(res.citations || []).length ? html`<div class="citations"><div class="section-title">Sources</div>${res.citations.map((c) => html`<button type="button" class="hit" data-cite="${c.segment_id}">
            <span class="hm"><span>${c.speaker}</span><span>${fmtClock(c.t0)}</span></span><span>${c.text}</span></button>`)}</div>` : ''}
          <div class="row-between">${metaBadge(res.meta)}${feedbackWidget('answer', `${id}:${question.slice(0, 60)}`)}</div></div>`);
      } catch (err) { mount(out, errorState(err, { retry: false })); }
      finally { setBusy(btn, false); }
    });
    on(panel, 'click', '[data-cite]', (e, btn) => showSegments([btn.dataset.cite]));
  }

  // --- drafts (recipes) ---
  async function renderDrafts(panel) {
    if (meeting.status !== 'ready') {
      mount(panel, emptyState({ title: 'Drafts need finished notes', text: 'Once the notes are written you can turn them into a follow-up email, a chat summary or a to-do list.' }));
      return;
    }
    mount(panel, loading('Loading draft types…'));
    let recipes = [];
    try { recipes = await api('/api/recipes', { signal }); } catch (err) { mount(panel, errorState(err, { retry: false })); return; }
    mount(panel, html`<section class="card stack">
      <div><h2>Drafts</h2><p class="muted mt-2">Turn this meeting into something you can send. Drafts are written from the transcript and notes — review before sending.</p></div>
      <div class="row">${recipes.map((r) => html`<button type="button" class="btn btn-secondary" data-recipe="${r.id}" title="${r.description || ''}">${r.name}</button>`)}</div>
      <div id="draft-out" aria-live="polite"></div></section>`);
    const out = $('#draft-out', panel);
    function show(d) {
      mount(out, html`<article class="card card-tight stack-sm">
        <div class="row-between"><h3 style="margin:0">${d.title || 'Draft'}</h3><div class="row">${metaBadge(d.meta)}<button type="button" class="btn btn-secondary btn-sm" data-copy-draft>Copy</button></div></div>
        <div class="answer-box pre" style="max-height:none">${d.body}</div></article>`);
      $('[data-copy-draft]', out).addEventListener('click', () => copyText(`${d.title ? `${d.title}\n\n` : ''}${d.body || ''}`));
    }
    on(panel, 'click', '[data-recipe]', async (e, btn) => {
      const recipe = btn.dataset.recipe;
      if (draftCache[recipe]) { show(draftCache[recipe]); return; }
      setBusy(btn, true, 'Writing…');
      mount(out, loading('Drafting…'));
      try {
        const d = await api(`/api/meetings/${enc(id)}/recipe`, { method: 'POST', body: { recipe } });
        draftCache[recipe] = d;
        show(d);
      } catch (err) { mount(out, errorState(err, { retry: false })); }
      finally { setBusy(btn, false); }
    });
  }

  renderPanel();
  return undefined;
}
