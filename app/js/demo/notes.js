// Port of meeting notes: backend/app/notes/{agents,search,service}.py (rule-based paths).
import { TEMPLATES, RECIPES, CATEGORY_DEFAULTS } from './data.js';
import * as tx from './text.js';
import { db, save, newId, nowIso, rows, nextInt, DemoError, registerJob, submitJob, JobHandle } from './store.js';
import { runAgent } from './common.js';
import { guessCompetencies, questionDict } from './coach.js';

const CHUNK_CHARS = 9000;
const DIRECT_LIMIT = 12000;
const HL_START = '\u0002';
const HL_END = '\u0003';
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export const templateById = (id) => TEMPLATES.find((t) => t.id === id) || TEMPLATES[0];
const recipeById = (id) => RECIPES.find((r) => r.id === id) || null;

// --- agent helpers (notes/agents.py) -----------------------------------------------------------------
const REQUEST_RE = /^(?:can you|could you|would you|will you|please)\b/i;
const ACTION_RE = /\b(?:i'll|i will|we'll|we will|action item|follow up|follow-up|send|share|schedule|by (?:monday|tuesday|wednesday|thursday|friday|tomorrow|next week|end of (?:day|week))|can you|could you|please|to do|todo|will take|will own|is going to own)\b/i;
const DECISION_RE = /\b(?:we decided|decided to|let's go with|agreed|we'll go with|decision is|final answer|we're going (?:to|with)|approved)\b/i;
const OWNER_RE = /^(?:(I|we)\b|([A-Z][a-z]+)\s+(?:will|to|can|should))/;
const DUE_RE = /\b(?:by|before|on|until)\s+((?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|today|week|month|end of (?:the )?(?:day|week|month|quarter))|\d{1,2}(?:st|nd|rd|th)?(?:\s+\w+)?)\b/i;

export function fmtTime(sec) {
  const s = Math.trunc(Number(sec) || 0);
  const p2 = (n) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p2(Math.floor((s % 3600) / 60))}:${p2(s % 60)}` : `${p2(Math.floor(s / 60))}:${p2(s % 60)}`;
}

export function formatTranscript(segs, limitChars = null) {
  let text = segs.map((s) => `[#${s.id} ${fmtTime(s.t0)} ${s.speaker}] ${s.text}`).join('\n');
  if (limitChars && text.length > limitChars) {
    text = text.slice(-limitChars);
    text = text.slice(text.indexOf('\n') + 1);
  }
  return text;
}

function sentencesWithIds(segs) {
  const out = [];
  for (const s of segs) {
    const sents = tx.sentences(s.text);
    for (const sent of (sents.length ? sents : [s.text])) out.push([sent, s.id, s.speaker]);
  }
  return out;
}

function extractive(segs, k = 6) {
  const sents = sentencesWithIds(segs);
  if (!sents.length) return [];
  const allText = sents.map(([s]) => s).join(' ');
  const kws = new Map(tx.keywords(allText, 25).map((w, i) => [w.toLowerCase(), i]));
  const scored = [];
  sents.forEach(([sent, sid], idx) => {
    const ws = tx.words(sent).map((w) => w.toLowerCase());
    if (ws.length < 5) return;
    let score = ws.filter((w) => kws.has(w)).reduce((acc, w) => acc + 1 / (1 + kws.get(w) / 5), 0);
    score += tx.numbersCount(sent) ? 1 : 0;
    score += DECISION_RE.test(sent) ? 1 : 0;
    score /= Math.max(1, ws.length / 18);
    scored.push([score, idx, sent, sid]);
  });
  const top = [...scored].sort((a, b) => b[0] - a[0]).slice(0, k);
  return top.sort((a, b) => a[1] - b[1]).map(([, , sent, sid]) => [sent, sid]);
}

function owner(sentence, speaker) {
  const m = sentence.trim().match(OWNER_RE);
  if (!m) return '';
  if (m[1]) return speaker === 'Me' && m[1].toLowerCase() === 'i' ? 'Me' : (m[1].toLowerCase() === 'we' ? '' : speaker);
  return m[2] || '';
}
function due(sentence) {
  const m = sentence.match(DUE_RE);
  return m ? m[1] : '';
}

function ruleExtract(segs) {
  const actions = [];
  const decisions = [];
  const questions = [];
  for (const [sent, , speaker] of sentencesWithIds(segs)) {
    const request = REQUEST_RE.test(sent.trim());
    if (DECISION_RE.test(sent)) {
      decisions.push(tx.truncate(sent, 200));
    } else if (request || (ACTION_RE.test(sent) && tx.words(sent).length >= 4 && !sent.endsWith('?'))) {
      const who = request ? (speaker !== 'Me' ? 'Me' : '') : owner(sent, speaker);
      actions.push({ task: tx.truncate(sent.replace(/\?+$/, '').trim(), 200), owner: who, due: due(sent) });
      continue;
    }
    if (sent.endsWith('?') && tx.words(sent).length >= 4) questions.push(tx.truncate(sent, 200));
  }
  return { actions: actions.slice(0, 10), decisions: decisions.slice(0, 8), questions: questions.slice(0, 10) };
}

function userNoteLines(userNotes) {
  const out = [];
  let heading = null;
  for (const raw of tx.splitLines(userNotes)) {
    const ln = raw.trim();
    if (!ln) continue;
    if (ln.startsWith('#')) { heading = ln.replace(/^#+/, '').trim() || null; continue; }
    out.push([heading, ln.replace(tx.BULLET_RE, '').trim()]);
  }
  return out;
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).join(' ');

function chunkNotes(templateId, segs) {
  const rules = ruleExtract(segs);
  return {
    key_points: extractive(segs, 5).map(([text, sid]) => ({ text, refs: [sid] })),
    decisions: rules.decisions, action_items: rules.actions, open_questions: rules.questions.slice(0, 5),
    questions_asked: templateId === 'interview_debrief' ? rules.questions : [],
  };
}

function enhanceNotes({ title, templateId, userNotes, segments, chunks, validIds }) {
  const tpl = templateById(templateId);
  const sections = new Map(tpl.sections.map((h) => [h, { heading: h, bullets: [] }]));
  const order = [...tpl.sections];
  for (const [heading, line] of userNoteLines(userNotes)) {
    let target = heading ? order.find((h) => h.toLowerCase() === heading.toLowerCase()) : undefined;
    if (heading && !target) { sections.set(heading, { heading, bullets: [] }); order.push(heading); target = heading; }
    sections.get(target || order[0]).bullets.push({ text: line, source: 'you', refs: [] });
  }
  let points;
  let rules;
  let asked;
  if (chunks) {
    points = chunks.flatMap((c) => c.key_points.map((p) => [p.text, p.refs.length ? p.refs[0] : null]));
    rules = { actions: chunks.flatMap((c) => c.action_items), decisions: chunks.flatMap((c) => c.decisions), questions: chunks.flatMap((c) => c.open_questions) };
    asked = chunks.flatMap((c) => c.questions_asked);
  } else {
    points = extractive(segments, 8);
    rules = ruleExtract(segments);
    asked = rules.questions;
  }
  const main = order.length > 1 ? order[1] : order[0];
  const actionTexts = new Set(rules.actions.map((a) => norm(a.task).slice(0, 60)));
  points = points.filter(([t]) => !actionTexts.has(norm(t).slice(0, 60)));
  for (const [text, sid] of points) sections.get(main).bullets.push({ text: tx.truncate(text, 240), source: 'ai', refs: sid ? [sid] : [] });
  const last = order[order.length - 1];
  for (const a of rules.actions.slice(0, 5)) sections.get(last).bullets.push({ text: a.task, source: 'ai', refs: [] });
  const summary = points.slice(0, 2).map(([t]) => tx.truncate(t, 200)).join(' ') || 'No transcript was captured for this meeting.';
  const nonEmpty = order.map((h) => sections.get(h)).filter((s) => s.bullets.length);
  const out = {
    title, summary, sections: nonEmpty.length ? nonEmpty : [sections.get(order[0])],
    decisions: rules.decisions.slice(0, 8), action_items: rules.actions.slice(0, 10), open_questions: rules.questions.slice(0, 6),
    questions_asked: templateId === 'interview_debrief' ? asked.slice(0, 12) : [],
  };
  if (templateId === 'interview_debrief') {
    for (const [, line] of userNoteLines(userNotes)) if (line.endsWith('?') && !out.questions_asked.includes(line)) out.questions_asked.push(line);
  }
  // postprocess (guarantees the user's own notes are never lost; only valid refs)
  for (const section of out.sections) {
    for (const bl of section.bullets) bl.refs = bl.source === 'you' || !validIds.size ? [] : bl.refs.filter((r) => validIds.has(r)).slice(0, 6);
  }
  const have = out.sections.flatMap((s) => s.bullets.filter((bl) => bl.source === 'you').map((bl) => norm(bl.text))).join(' ');
  const missing = userNoteLines(userNotes).map(([, line]) => line).filter((line) => !have.includes(norm(line).slice(0, 40)));
  if (missing.length) {
    if (!out.sections.length) out.sections.push({ heading: tpl.sections[0], bullets: [] });
    out.sections[0].bullets = missing.map((m) => ({ text: m, source: 'you', refs: [] })).concat(out.sections[0].bullets);
  }
  if (templateId !== 'interview_debrief') out.questions_asked = [];
  out.title = String(out.title || '').trim() || title;
  return out;
}

function recapNotes(segs) {
  if (!segs.length) return { recap: ['Nothing has been transcribed in this window yet.'], decisions: [], open_questions: [] };
  const rules = ruleExtract(segs);
  return { recap: extractive(segs, 5).map(([s]) => tx.truncate(s, 200)), decisions: rules.decisions.slice(0, 4), open_questions: rules.questions.slice(0, 4) };
}

function qaAnswer(excerpts) {
  if (!excerpts.length) return { answer: "I couldn't find anything about that in your saved meetings.", citations: [], not_found: true };
  const top = excerpts.slice(0, 3);
  const lines = top.map((e) => `- ${e.speaker} (${fmtTime(e.t0)}): ${tx.truncate(e.text, 220)}`);
  return { answer: `These are the most relevant moments I found:\n${lines.join('\n')}`, citations: top.map((e) => e.id), not_found: false };
}

function recipeDraft(recipe, title, n) {
  const actions = n.action_items || [];
  const decisions = n.decisions || [];
  if (recipe.id === 'todo_list') {
    const minePre = actions.filter((a) => ['', 'Me', null, undefined].includes(a.owner));
    const mine = minePre.length ? minePre : actions;
    const body = mine.map((a) => `- [ ] ${a.task}${a.due ? ` (due ${a.due})` : ''}`).join('\n');
    return { title: `To-do: ${title}`, body: body || '- [ ] (no action items found)' };
  }
  if (recipe.id === 'slack_summary') {
    let bullets = decisions.slice(0, 3).map((d) => `- Decided: ${d}`).concat(actions.slice(0, 3).map((a) => `- Next: ${a.task}${a.owner ? ` (${a.owner})` : ''}`));
    if (!bullets.length) bullets = [`- ${n.summary || 'No summary available.'}`];
    return { title: `${title} - summary`, body: bullets.join('\n') };
  }
  let lines = ['Hi all,', '', 'Thanks for the time today. A quick recap:', ''];
  if (n.summary) lines = lines.concat([n.summary, '']);
  if (decisions.length) lines = lines.concat(['Decisions:'], decisions.slice(0, 5).map((d) => `- ${d}`), ['']);
  if (actions.length) lines = lines.concat(['Next steps:'], actions.slice(0, 6).map((a) => `- ${a.task}${a.owner ? ` - ${a.owner}` : ''}${a.due ? ` (by ${a.due})` : ''}`), ['']);
  lines.push('Best,');
  return { title: `Follow-up: ${title}`, body: lines.join('\n') };
}

// --- search (notes/search.py; prefix matching stands in for FTS5) -------------------------------------
const FTS_STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'was', 'what', 'did', 'do', 'does',
  'about', 'we', 'they', 'he', 'she', 'it', 'i', 'you', 'say', 'said', 'when', 'who', 'how', 'that', 'this']);

function terms(query) {
  const toks = (String(query || '').match(/[\p{L}\p{N}_']+/gu) || []).map((t) => tx.pyStrip(t.toLowerCase(), "'")).filter(Boolean);
  const content = toks.filter((t) => !FTS_STOP.has(t));
  return (content.length ? content : toks).slice(0, 12);
}

const TOKEN_G = /[\p{L}\p{N}_]+/gu;
function scoreText(text, ts, mode) {
  const toks = (String(text || '').match(TOKEN_G) || []).map((t) => t.toLowerCase());
  let hits = 0;
  let matchedTerms = 0;
  for (const t of ts) {
    const n = toks.filter((w) => w.startsWith(t)).length;
    if (n) { matchedTerms += 1; hits += n; }
  }
  if (mode === 'and' ? matchedTerms < ts.length : matchedTerms === 0) return 0;
  return hits / (1 + Math.log(1 + toks.length));
}

/** Highlight matching words and trim long text to ~14 words around the first hit, like FTS5 snippet(). */
function snippet(text, ts) {
  const words = [];
  for (const m of String(text || '').matchAll(TOKEN_G)) words.push({ start: m.index, end: m.index + m[0].length, hit: ts.some((t) => m[0].toLowerCase().startsWith(t)) });
  let from = 0;
  let to = words.length;
  if (words.length > 14) {
    const first = Math.max(0, words.findIndex((w) => w.hit));
    from = Math.max(0, Math.min(first - 3, words.length - 14));
    to = from + 14;
  }
  let out = from > 0 ? '…' : '';
  let pos = from > 0 ? words[from].start : 0;
  for (let i = from; i < to; i += 1) {
    const w = words[i];
    out += text.slice(pos, w.start) + (w.hit ? HL_START + text.slice(w.start, w.end) + HL_END : text.slice(w.start, w.end));
    pos = w.end;
  }
  out += to < words.length ? '…' : text.slice(pos);
  return out;
}

export function searchSegments(query, meetingId = null, limit = 20) {
  const ts = terms(query);
  if (!ts.length) return [];
  const pool = rows('segments').filter((s) => !meetingId || s.meeting_id === meetingId);
  let ranked = [];
  for (const mode of ['and', 'or']) {
    ranked = pool.map((s) => [scoreText(s.text, ts, mode), s]).filter(([sc]) => sc > 0).sort((a, b) => b[0] - a[0]).slice(0, limit);
    if (ranked.length) break;
  }
  return ranked.filter(([, s]) => db.meetings[s.meeting_id]).map(([, s]) => ({
    meeting_id: s.meeting_id, meeting_title: db.meetings[s.meeting_id].title, segment_id: s.id, speaker: s.speaker,
    t0: s.t0, t1: s.t1, text: s.text, snippet: snippet(s.text, ts),
  }));
}

function searchMeetings(query, limit = 50) {
  const ts = terms(query);
  if (!ts.length) return [];
  const scores = new Map();
  for (const mode of ['and', 'or']) {
    const hits = rows('meetings').filter((m) => m.status !== 'live').map((m) => {
      const body = `${m.user_notes || ''}\n${m.notes_md || ''}`;
      const sc = scoreText(`${m.title} ${body}`, ts, mode);
      return [sc, m, scoreText(m.title, ts, 'or') && !scoreText(body, ts, 'or') ? m.title : body];
    }).filter(([sc]) => sc > 0).sort((a, b) => b[0] - a[0]).slice(0, limit);
    for (const [sc, m, src] of hits) scores.set(m.id, [-sc, snippet(src, ts)]);
    if (scores.size) break;
  }
  for (const hit of searchSegments(query, null, 100)) if (!scores.has(hit.meeting_id)) scores.set(hit.meeting_id, [0, hit.snippet]);
  return [...scores.entries()].sort((a, b) => a[1][0] - b[1][0]).slice(0, limit).map(([id, [, snip]]) => ({ meeting_id: id, snippet: snip }));
}

// --- meetings (notes/service.py) --------------------------------------------------------------------------
function meetingRow(id) {
  const m = db.meetings[id];
  if (!m) throw new DemoError('Meeting not found', 404);
  return m;
}
const segmentsOf = (id) => rows('segments').filter((s) => s.meeting_id === id).sort((a, b) => (a.t0 - b.t0) || (a.id - b.id))
  .map(({ id: sid, speaker, t0, t1, text }) => ({ id: sid, speaker, t0, t1, text }));

function duration(m) {
  const start = m.started_at ? Date.parse(m.started_at) : NaN;
  const end = m.ended_at ? Date.parse(m.ended_at) : NaN;
  if (!Number.isNaN(start) && !Number.isNaN(end)) return tx.pyRound((end - start) / 1000, 1);
  if (!Number.isNaN(start) && m.status === 'live') return tx.pyRound((Date.now() - start) / 1000, 1);
  return null;
}

export function meetingDict(id, withSegments = true) {
  const m = meetingRow(id);
  const out = {
    id: m.id, title: m.title, template: m.template, status: m.status, consent_confirmed: Boolean(m.consent_confirmed),
    consent_note: m.consent_note, started_at: m.started_at, ended_at: m.ended_at, duration_sec: duration(m), user_notes: m.user_notes,
    notes: m.notes, notes_md: m.notes_md, job_id: m.job_id,
  };
  if (withSegments) out.segments = segmentsOf(id);
  return out;
}

export function createMeeting(settings, body) {
  if (!body.consent_confirmed) throw new DemoError("Confirm that everyone in the meeting knows it's being transcribed before you start.");
  const tpl = templateById(body.template || settings.notes.default_template);
  const now = new Date();
  const mon = now.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const p2 = (n) => String(n).padStart(2, '0');
  const fallback = `Meeting ${mon} ${p2(now.getUTCDate())}, ${p2(now.getUTCHours())}:${p2(now.getUTCMinutes())} UTC`;
  const id = newId('mtg');
  db.meetings[id] = {
    id, _seq: nextInt('meeting'), title: String(body.title || '').trim() || fallback, template: tpl.id, status: 'live', consent_confirmed: 1,
    consent_note: String(body.consent_note || '').slice(0, 500), user_notes: '', notes: null, notes_md: null, job_id: null,
    started_at: nowIso(now), ended_at: null,
  };
  save('meetings');
  return meetingDict(id);
}

export function listMeetings(q = null, limit = 50) {
  const view = (m, snip) => ({
    id: m.id, title: m.title, template: m.template, status: m.status, started_at: m.started_at, ended_at: m.ended_at,
    duration_sec: duration(m), segment_count: rows('segments').filter((s) => s.meeting_id === m.id).length, snippet: snip ?? null,
  });
  if (q) return searchMeetings(q, limit).filter((h) => db.meetings[h.meeting_id]).map((h) => view(db.meetings[h.meeting_id], h.snippet));
  return rows('meetings').sort((a, b) => cmp(b.started_at, a.started_at) || (b._seq - a._seq)).slice(0, limit).map((m) => view(m));
}

export function updateMeeting(id, body) {
  const m = meetingRow(id);
  if (body.title !== null && body.title !== undefined && String(body.title).trim()) m.title = String(body.title).trim().slice(0, 200);
  if (body.user_notes !== null && body.user_notes !== undefined) m.user_notes = String(body.user_notes).slice(0, 100000);
  if (body.template !== null && body.template !== undefined) m.template = templateById(body.template).id;
  if (body.notes !== null && body.notes !== undefined) {
    if (typeof body.notes !== 'object' || !body.notes.title) throw new DemoError('notes: invalid notes object', 422);
    m.notes = body.notes;
    m.notes_md = renderMarkdown(m, body.notes);
  }
  save('meetings');
  return meetingDict(id);
}

export function deleteMeeting(id) {
  meetingRow(id);
  delete db.meetings[id];
  for (const [k, s] of Object.entries(db.segments)) if (s.meeting_id === id) delete db.segments[k];
  save('meetings', 'segments');
}

export function addSegment(id, body) {
  const text = String(body.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const m = meetingRow(id);
  if (m.status !== 'live') throw new DemoError('This meeting has ended - start a new one to keep transcribing.', 409);
  const t0 = Number(body.t0) || 0;
  const t1 = Math.max(t0, Number(body.t1) || 0);
  const speaker = String(body.speaker || 'Me').slice(0, 40);
  const segId = nextInt('segment');
  db.segments[segId] = { id: segId, meeting_id: id, speaker, t0, t1, text: text.slice(0, 4000), created_at: nowIso() };
  save('segments');
  return { id: segId, speaker, t0, t1, text };
}

export function redactLast(id, minutes) {
  meetingRow(id);
  const segs = rows('segments').filter((s) => s.meeting_id === id);
  if (!segs.length) return 0;
  const cutoff = Math.max(...segs.map((s) => s.t1)) - Math.max(0, Number(minutes) || 0) * 60;
  const gone = segs.filter((s) => s.t1 > cutoff);
  for (const s of gone) delete db.segments[s.id];
  save('segments');
  return gone.length;
}

export function liveSearch(id, q, scope = 'meeting') {
  meetingRow(id);
  const started = performance.now();
  const hits = searchSegments(q, scope !== 'all' ? id : null, 25);
  return { hits, took_ms: Math.round(performance.now() - started) };
}

export function recap(id, minutes = 5) {
  meetingRow(id);
  const segs = segmentsOf(id);
  const end = segs.length ? Math.max(...segs.map((s) => s.t1)) : 0;
  const start = minutes ? Math.max(0, end - minutes * 60) : 0;
  const window = segs.filter((s) => s.t1 >= start);
  const res = runAgent('RecapAgent', () => recapNotes(window), id);
  return { ...res.output, window: { from_sec: start, to_sec: end }, meta: res.meta };
}

export function stopMeeting(id) {
  const m = meetingRow(id);
  if (m.status === 'processing' && m.job_id) return m.job_id;
  const jobId = submitJob('finalize_meeting', { meeting_id: id });
  Object.assign(m, { status: 'processing', ended_at: m.ended_at || nowIso(), job_id: jobId });
  save('meetings');
  return jobId;
}

export function enhanceAgain(id, template = null) {
  const m = meetingRow(id);
  if (m.status === 'live') throw new DemoError('Stop the meeting first.', 409);
  if (template) m.template = templateById(template).id;
  return stopMeeting(id);
}

function chunks(segs) {
  const out = [];
  let cur = [];
  let size = 0;
  for (const s of segs) {
    const len = s.text.length + 24;
    if (cur.length && size + len > CHUNK_CHARS) { out.push(cur); cur = []; size = 0; }
    cur.push(s);
    size += len;
  }
  if (cur.length) out.push(cur);
  return out;
}

function finalizeCore(m, runId, onChunk = null) {
  const segs = segmentsOf(m.id);
  const long = formatTranscript(segs).length > DIRECT_LIMIT;
  let chunkOut = null;
  if (long) chunkOut = chunks(segs).map((part) => runAgent('ChunkNotesAgent', () => chunkNotes(m.template, part), runId).output);
  if (onChunk) onChunk(chunkOut);
  const res = runAgent('NoteEnhancerAgent', () => enhanceNotes({
    title: m.title, templateId: m.template, userNotes: m.user_notes, segments: segs, chunks: chunkOut, validIds: new Set(segs.map((s) => s.id)),
  }), runId);
  const notes = { ...res.output, meta: res.meta };
  m.notes = notes;
  m.notes_md = renderMarkdown(m, notes);
  save('meetings');
  return { res, segs, chunkOut, long };
}

export function finalizeSync(id) {
  const m = meetingRow(id);
  Object.assign(m, { status: 'processing', ended_at: m.ended_at || nowIso() });
  finalizeCore(m, newId('run'));
  m.status = 'ready';
  save('meetings');
}

async function runFinalizeMeeting(job, payload) {
  const m = db.meetings[payload.meeting_id];
  if (!m) return { skipped: 'meeting deleted' };
  const long = formatTranscript(segmentsOf(m.id)).length > DIRECT_LIMIT;
  const plan = [{ key: 'notes', label: 'Writing your enhanced notes', agent: 'NoteEnhancerAgent' }, { key: 'index', label: 'Indexing for search' },
    { key: 'embed', label: 'Building semantic search' }];
  if (long) plan.unshift({ key: 'chunks', label: 'Reading the transcript in parts', agent: 'ChunkNotesAgent' });
  job.plan(plan);
  let out;
  if (long) {
    await job.step('chunks', 'Reading the transcript in parts', 'ChunkNotesAgent', (st) => {
      Object.assign(st, { provider: 'heuristic', model: 'rules', status: 'degraded', detail: `${chunks(segmentsOf(m.id)).length} parts, built-in rules` });
    });
  }
  await job.step('notes', 'Writing your enhanced notes', 'NoteEnhancerAgent', (st) => {
    out = finalizeCore(m, job.job.id);
    JobHandle.record(st, out.res.meta);
  });
  await job.step('index', 'Indexing for search', null, () => {});
  await job.step('embed', 'Building semantic search', null, (st) => {
    Object.assign(st, { status: 'skipped', detail: 'optional - semantic search needs the installed app (Ollama embeddings)' });
  });
  m.status = 'ready';
  save('meetings');
  return { segments: out.segs.length, chunks: (out.chunkOut || []).length, notes_status: 'degraded' };
}

registerJob('finalize_meeting', runFinalizeMeeting);
registerJob('finalize_meeting:failed', async (job, p) => { if (db.meetings[p.meeting_id]) { db.meetings[p.meeting_id].status = 'failed'; save('meetings'); } });

export function renderMarkdown(m, notes) {
  const tpl = templateById(m.template || 'general');
  const started = m.started_at ? new Date(m.started_at) : null;
  const p2 = (n) => String(n).padStart(2, '0');
  const when = started && !Number.isNaN(started.getTime())
    ? `${started.getUTCFullYear()}-${p2(started.getUTCMonth() + 1)}-${p2(started.getUTCDate())} ${p2(started.getUTCHours())}:${p2(started.getUTCMinutes())} UTC` : '';
  let lines = [`# ${notes.title || m.title}`, ''];
  const metaLine = [when, tpl.name].filter(Boolean).join(' · ');
  if (metaLine) lines.push(`*${metaLine}*`, '');
  if (notes.summary) lines.push('## Summary', '', notes.summary, '');
  for (const section of notes.sections || []) {
    if (!(section.bullets || []).length) continue;
    lines.push(`## ${section.heading}`, '');
    for (const bl of section.bullets) lines.push(`- ${bl.text}`);
    lines.push('');
  }
  if ((notes.decisions || []).length) lines = lines.concat(['## Decisions', ''], notes.decisions.map((d) => `- ${d}`), ['']);
  if ((notes.action_items || []).length) {
    lines.push('## Action items', '');
    for (const a of notes.action_items) {
      const extra = [a.owner || '', a.due ? `due ${a.due}` : ''].filter(Boolean).join(' - ');
      lines.push(`- [ ] ${a.task}${extra ? ` (${extra})` : ''}`);
    }
    lines.push('');
  }
  if ((notes.open_questions || []).length) lines = lines.concat(['## Open questions', ''], notes.open_questions.map((q) => `- ${q}`), ['']);
  if ((notes.questions_asked || []).length) lines = lines.concat(['## Questions I was asked', ''], notes.questions_asked.map((q) => `- ${q}`), ['']);
  return `${lines.join('\n').trim()}\n`;
}

export function exportMarkdown(id) {
  const m = meetingRow(id);
  let md = m.notes_md || renderMarkdown(m, m.notes || { title: m.title });
  const segs = segmentsOf(id);
  if (segs.length) md += `\n## Transcript\n\n${segs.map((s) => `**${s.speaker}** [${fmtTime(s.t0)}]: ${s.text}`).join('\n')}\n`;
  const safe = m.title.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'meeting';
  return { md, filename: `${safe}.md` };
}

function retrieve(question, meetingIds, k = 14) {
  const ids = [];
  const single = meetingIds && meetingIds.length === 1 ? meetingIds[0] : null;
  for (const hit of searchSegments(question, single, 30)) {
    if (meetingIds && !meetingIds.includes(hit.meeting_id)) continue;
    if (!ids.includes(hit.segment_id)) ids.push(hit.segment_id);
  }
  return ids.slice(0, k).map((sid) => db.segments[sid]).filter(Boolean).map((s) => ({
    id: s.id, meeting_id: s.meeting_id, speaker: s.speaker, t0: s.t0, t1: s.t1, text: s.text, meeting_title: (db.meetings[s.meeting_id] || {}).title,
  }));
}

function citations(excerpts, ids, multi) {
  const byId = new Map(excerpts.map((e) => [e.id, e]));
  return ids.map((sid) => byId.get(sid)).filter(Boolean).map((e) => ({
    segment_id: e.id, speaker: e.speaker, t0: e.t0, text: e.text, ...(multi ? { meeting_id: e.meeting_id, meeting_title: e.meeting_title } : {}),
  }));
}

export function ask(id, question) {
  const m = meetingRow(id);
  if (m.status === 'live') throw new DemoError('Ask works once the meeting is saved. During the meeting, use Search or Catch me up.', 409);
  const excerpts = retrieve(question, [id]);
  const res = runAgent('MeetingQAAgent', () => qaAnswer(excerpts), id);
  return { answer: res.output.answer, not_found: res.output.not_found, citations: citations(excerpts, res.output.citations, false), meta: res.meta };
}

export function askAll(question) {
  const ready = rows('meetings').filter((m) => m.status === 'ready').map((m) => m.id);
  if (!ready.length) return { answer: "You don't have any saved meetings yet.", not_found: true, citations: [], meta: null };
  const excerpts = retrieve(question, ready, 18);
  const res = runAgent('MeetingQAAgent', () => qaAnswer(excerpts));
  return { answer: res.output.answer, not_found: res.output.not_found, citations: citations(excerpts, res.output.citations, true), meta: res.meta };
}

export function runRecipe(id, recipeId) {
  const m = meetingRow(id);
  if (m.status === 'live') throw new DemoError('Drafts are available once the meeting is saved.', 409);
  const recipe = recipeById(recipeId);
  if (!recipe) throw new DemoError('Unknown recipe', 404);
  const { meta, ...notes } = m.notes || {};
  const res = runAgent('RecipeAgent', () => recipeDraft(recipe, m.title, notes), id);
  return { recipe: recipeId, title: res.output.title, body: res.output.body, meta: res.meta };
}

export function toPractice(id, targetId) {
  const m = meetingRow(id);
  const target = db.targets[targetId];
  if (!target) throw new DemoError('Target not found', 404);
  const asked = ((m.notes || {}).questions_asked || []).map((q) => q.trim()).filter(Boolean);
  if (!asked.length) {
    throw new DemoError("No interview questions were found in these notes. Use the 'Interview debrief' template and list the questions you were asked.", 409);
  }
  const comps = ((target.job || {}).competencies || []).map((c) => c.name);
  const existing = new Set(rows('questions').filter((q) => q.target_id === targetId).map((q) => tx.normKey(q.text)));
  const added = [];
  for (const q of asked) {
    const key = tx.normKey(q);
    if (existing.has(key)) continue;
    existing.add(key);
    const technical = /\b(design|implement|algorithm|complexity|code|architecture|scale|sql|api)\b/i.test(q);
    const category = technical ? 'technical' : 'behavioral';
    const qid = newId('q');
    db.questions[qid] = {
      id: qid, _seq: nextInt('question'), target_id: targetId, text: q.slice(0, 600), category,
      competency: (guessCompetencies(q, comps)[0]) || 'General', difficulty: 2,
      why_asked: 'You were asked this in a real interview - worth nailing.', good_answer_signals: [...CATEGORY_DEFAULTS[category].signals],
      source: 'debrief', times_asked: 0, last_score: null, last_asked_at: null, created_at: nowIso(),
    };
    added.push(qid);
  }
  save('questions');
  return { added: added.length, questions: added.map((qid) => questionDict(db.questions[qid])) };
}

export const templates = () => TEMPLATES;
export const recipes = () => RECIPES.map(({ id, name, description }) => ({ id, name, description }));

// Exposed for the parity tests (Node) only.
export const _agents = { enhanceNotes, recapNotes, ruleExtract, extractive };
