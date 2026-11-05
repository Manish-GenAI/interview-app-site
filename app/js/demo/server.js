// In-browser stand-in for the FastAPI backend (demo mode only). Answers the same /api routes with the same
// JSON shapes and status codes, using the ported rule-based agents. Returns real Response objects.
import { SETTINGS_DEFAULTS, GOLDEN, SAMPLE_RESUME, SAMPLE_JD } from './data.js';
import {
  db, save, flush, nowIso, newId, rows, DemoError, registerJob, submitJob, recoverJobs, jobView, JobHandle,
} from './store.js';
import { runAgent, addFeedback, feedbackSummary, feedbackExportJsonl, listTraces, agentsView } from './common.js';
import * as coach from './coach.js';
import * as notes from './notes.js';

export const VERSION = '0.1.0';
const DEMO_DETAIL = 'Demo mode: this version runs in your browser with built-in rules. Install the app to use local AI (Ollama) or Claude.';
const DEMO_NO_KEY = "API keys can't be used in the browser demo. Install the app to connect Claude.";

// --- settings ------------------------------------------------------------------------------------------
function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}
function settings() {
  return deepMerge(SETTINGS_DEFAULTS, db.meta.settings || {});
}
function settingsView() {
  const s = settings();
  s.claude = { ...s.claude, api_key_set: false, api_key_source: null };
  return s;
}
const ENUMS = {
  'coach.persona': ['friendly', 'neutral', 'challenging'], 'stt.engine': ['auto', 'faster-whisper', 'browser', 'off'],
  'stt.device': ['auto', 'cuda', 'cpu'], 'ollama.think': ['off', 'on', 'auto'],
  'claude.smart_effort': ['low', 'medium', 'high', 'xhigh', 'max'], 'claude.fast_effort': ['low', 'medium', 'high', 'xhigh', 'max'],
};
function putSettings(patch) {
  const p = JSON.parse(JSON.stringify(patch || {}));
  if (p.claude && 'api_key' in p.claude) {
    const key = String(p.claude.api_key || '').trim();
    if (key) throw new DemoError(DEMO_NO_KEY, 400);
    delete p.claude.api_key;
  }
  if (p.claude) { delete p.claude.api_key_set; delete p.claude.api_key_source; }
  const merged = deepMerge(db.meta.settings || {}, p);
  const full = deepMerge(SETTINGS_DEFAULTS, merged);
  for (const [path, allowed] of Object.entries(ENUMS)) {
    const [a, b] = path.split('.');
    if (full[a] && !allowed.includes(full[a][b])) throw new DemoError(`Invalid setting ${path}: Input should be ${allowed.map((x) => `'${x}'`).join(', ')}`, 422);
  }
  if (!Array.isArray(full.provider_order) || full.provider_order.some((x) => !['ollama', 'claude'].includes(x))) {
    throw new DemoError("Invalid setting provider_order: Input should be 'ollama' or 'claude'", 422);
  }
  db.meta.settings = merged;
  save('meta');
  return settingsView();
}

// --- health -------------------------------------------------------------------------------------------
function health() {
  const s = settings();
  const circuit = { state: 'closed', failures: 0, retry_in_sec: 0, last_error: '', calls: 0 };
  const providers = {
    ollama: {
      name: 'ollama', available: false, reachable: false, base_url: s.ollama.base_url,
      models: { smart: s.ollama.smart_model, fast: s.ollama.fast_model, embed: s.ollama.embed_model },
      installed: [], missing: [], version: null, detail: DEMO_DETAIL, circuit,
    },
    claude: {
      name: 'claude', available: false, models: { smart: s.claude.smart_model, fast: s.claude.fast_model },
      month_spend_usd: 0, monthly_budget_usd: s.claude.monthly_budget_usd, detail: DEMO_DETAIL, circuit,
    },
  };
  return {
    version: VERSION, demo: true, llm_ready: false,
    providers: s.provider_order.filter((n) => providers[n]).map((n) => providers[n]),
    stt: {
      engine: 'browser', available: false, detail: "Demo mode uses your browser's speech recognition for the microphone.",
      model: s.stt.whisper_model, device: 'browser', loaded: false,
    },
    data_dir: 'This browser (demo data in localStorage)', fts: true,
  };
}

// --- evals ---------------------------------------------------------------------------------------------
function runEvalCases() {
  const results = GOLDEN.map((c) => {
    const metrics = coach.finalMetrics(c.answer, c.duration_sec, null);
    const res = runAgent('EvaluatorAgent', () => coach.evaluate({
      question: c.question, category: c.category, competency: c.competency, answer: c.answer, metrics, job_title: '', seniority: 'unknown', signals: [],
    }));
    const [lo, hi] = c.expected;
    const got = res.output.overall;
    const miss = got >= lo && got <= hi ? 0 : Math.min(Math.abs(got - lo), Math.abs(got - hi));
    return { id: c.id, question: c.question, expected: [lo, hi], got, passed: miss === 0, error: Math.round(miss * 100) / 100, provider: 'heuristic', model: 'rules', status: 'degraded' };
  });
  const passed = results.filter((r) => r.passed).length;
  const summary = {
    cases: results.length, passed, pass_rate: Math.round((passed / Math.max(1, results.length)) * 1000) / 1000,
    mean_abs_error: Math.round((results.reduce((a, r) => a + r.error, 0) / Math.max(1, results.length)) * 1000) / 1000,
    providers: { heuristic: results.length }, prompt_version: 'v2',
  };
  const id = newId('evr');
  db.eval_runs[id] = { id, created_at: nowIso(), summary, cases: results, at: Date.now() };
  save('eval_runs');
  return { id, summary };
}
registerJob('run_evals', async (job) => {
  job.plan([{ key: 'cases', label: 'Scoring the golden answers', agent: 'EvaluatorAgent' }]);
  let out;
  await job.step('cases', 'Scoring the golden answers', 'EvaluatorAgent', (st) => { out = runEvalCases(); st.detail = `${out.summary.cases} cases`; });
  return { ...out.summary, run_id: out.id };
});
function latestEval() {
  const all = rows('eval_runs').sort((a, b) => (b.at || 0) - (a.at || 0));
  if (!all.length) return null;
  const { at, ...run } = all[0];
  return run;
}

// --- sample data ----------------------------------------------------------------------------------------
export function ensureSeeded() {
  if (db.meta.seeded) return;
  db.meta.seeded = nowIso();
  save('meta');
  const tid = newId('tgt');
  const now = nowIso();
  db.targets[tid] = {
    id: tid, _seq: 0, title: 'Sample - Senior Backend Engineer', company: 'Globex (demo)', status: 'preparing', job_id: null,
    resume_text: SAMPLE_RESUME, jd_text: SAMPLE_JD, profile: null, job: null, fit: null, meta: {}, created_at: now, updated_at: now,
  };
  coach.prepareSync(db.targets[tid]);
  const m = notes.createMeeting(settings(), { title: 'Sample - Weekly sync', template: 'general', consent_confirmed: true, consent_note: 'Demo data' });
  const lines = [
    ['Them', 'Thanks everyone. The goal today is to agree the rollout plan for the new billing API.'],
    ['Me', 'I can walk through the load test results from Tuesday.'],
    ['Them', 'Great. We decided to keep annual billing as the default plan.'],
    ['Me', "I'll share the migration checklist by Friday."],
    ['Them', 'Can you also check with legal about the data retention policy?'],
    ['Them', 'Open question: do we need SOC 2 sign-off before launch?'],
  ];
  lines.forEach(([speaker, text], i) => notes.addSegment(m.id, { speaker, text, t0: i * 9, t1: i * 9 + 7 }));
  notes.updateMeeting(m.id, { user_notes: 'rollout plan\nSOC 2?' });
  db.meetings[m.id].ended_at = nowIso(new Date(Date.parse(db.meetings[m.id].started_at) + 52000));
  notes.finalizeSync(m.id);
  flush();
}

// --- routing ---------------------------------------------------------------------------------------------
const routes = [];
const route = (method, pattern, fn) => {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:([a-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  routes.push({ method, re, keys, fn });
};
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const download = (text, type, filename) => new Response(text, { status: 200, headers: { 'content-type': type, 'content-disposition': `attachment; filename="${filename}"` } });

const intParam = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

// system
route('GET', '/api/health', () => json(health()));
route('GET', '/api/settings', () => json(settingsView()));
route('PUT', '/api/settings', ({ body }) => json(putSettings(body)));
route('GET', '/api/jobs/:id', ({ p }) => {
  const j = jobView(p.id);
  return j ? json(j) : json({ detail: 'Job not found' }, 404);
});
route('GET', '/api/agents', () => json(agentsView(settings())));
route('GET', '/api/traces', ({ q }) => json(listTraces({ limit: intParam(q.get('limit'), 100), agent: q.get('agent') || null, status: q.get('status') || null })));
route('POST', '/api/feedback', ({ body }) => {
  const types = ['evaluation', 'hint', 'report', 'notes', 'answer', 'recap', 'recipe'];
  if (!types.includes(body.target_type)) throw new DemoError('target_type: Input should be one of the feedback targets', 422);
  if (![1, -1].includes(body.rating)) throw new DemoError('rating: Input should be 1 or -1', 422);
  return json({ id: addFeedback(body) }, 201);
});
route('GET', '/api/feedback/summary', () => json(feedbackSummary()));
route('GET', '/api/feedback/export', () => download(feedbackExportJsonl(), 'application/x-ndjson', 'feedback.jsonl'));
route('POST', '/api/evals/run', () => json({ job_id: submitJob('run_evals', {}) }));
route('GET', '/api/evals/latest', () => json(latestEval()));
route('GET', '/api/templates', () => json(notes.templates()));
route('GET', '/api/recipes', () => json(notes.recipes()));
route('POST', '/api/extract-text', async ({ form }) => {
  const file = form && form.get('file');
  if (!file) throw new DemoError('file: Field required', 422);
  const name = String(file.name || '').toLowerCase();
  if (/\.(pdf|docx)$/.test(name)) throw new DemoError('PDF and DOCX upload needs the installed app — paste the text here instead.', 400);
  if (!/\.(txt|md|markdown|text|rtf)$/.test(name)) throw new DemoError('Unsupported file type. Use .txt or .md in the demo - or paste the text.', 400);
  let text = await file.text();
  text = text.replace(/\r\n/g, '\n').replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return json({ text, filename: file.name, chars: text.length });
});
route('POST', '/api/stt/transcribe', () => { throw new DemoError('Transcribing audio files needs the installed app (local Whisper).', 409); });

// coach
route('POST', '/api/targets', ({ body }) => json(coach.createTarget(body.title, body.company, body.resume_text, body.jd_text), 201));
route('GET', '/api/targets', () => json(coach.listTargets()));
route('GET', '/api/targets/:id', ({ p }) => json(coach.targetDict(coach.loadTarget(p.id))));
route('DELETE', '/api/targets/:id', ({ p }) => { coach.deleteTarget(p.id); return json({ ok: true }); });
route('POST', '/api/targets/:id/prepare', ({ p }) => json({ job_id: coach.prepareAgain(p.id) }));
route('GET', '/api/targets/:id/questions', ({ p }) => json(coach.listQuestions(p.id)));
route('POST', '/api/targets/:id/questions', ({ p, body }) => json(coach.addQuestion(p.id, body), 201));
route('DELETE', '/api/questions/:id', ({ p }) => { coach.deleteQuestion(p.id); return json({ ok: true }); });
route('GET', '/api/targets/:id/stories', ({ p }) => json(coach.listStories(p.id)));
route('POST', '/api/targets/:id/stories', ({ p, body }) => json(coach.addStory(p.id, body), 201));
route('PUT', '/api/stories/:id', ({ p, body }) => json(coach.updateStory(p.id, body)));
route('DELETE', '/api/stories/:id', ({ p }) => { coach.deleteStory(p.id); return json({ ok: true }); });
route('POST', '/api/sessions', ({ body }) => json(coach.startSession(settings(), body), 201));
route('GET', '/api/sessions', ({ q }) => json(coach.listSessions(q.get('target_id'))));
route('GET', '/api/sessions/:id', ({ p }) => json(coach.sessionDict(p.id)));
route('POST', '/api/sessions/:id/hints', ({ p, body }) => json(coach.liveHints(settings(), p.id, body)));
route('POST', '/api/sessions/:id/answer', ({ p, body }) => json(coach.submitAnswer(p.id, body)));
route('POST', '/api/sessions/:id/skip', ({ p, body }) => json(coach.skipTurn(p.id, body.turn_id)));
route('POST', '/api/sessions/:id/end', ({ p }) => json({ job_id: coach.endSession(p.id) }));
route('GET', '/api/progress', ({ q }) => { coach.loadTarget(q.get('target_id')); return json(coach.progress(q.get('target_id'))); });

// meetings
route('POST', '/api/meetings', ({ body }) => json(notes.createMeeting(settings(), body), 201));
route('GET', '/api/meetings', ({ q }) => json(notes.listMeetings(q.get('q') || null, Math.max(1, Math.min(200, intParam(q.get('limit'), 50))))));
route('GET', '/api/meetings/:id', ({ p }) => json(notes.meetingDict(p.id)));
route('PUT', '/api/meetings/:id', ({ p, body }) => json(notes.updateMeeting(p.id, body)));
route('DELETE', '/api/meetings/:id', ({ p }) => { notes.deleteMeeting(p.id); return json({ ok: true }); });
route('POST', '/api/meetings/:id/segments', ({ p, body }) => {
  const seg = notes.addSegment(p.id, body);
  if (!seg) throw new DemoError('Empty segment');
  return json(seg, 201);
});
route('POST', '/api/meetings/:id/stop', ({ p }) => json({ job_id: notes.stopMeeting(p.id) }));
route('POST', '/api/meetings/:id/enhance', ({ p, body }) => json({ job_id: notes.enhanceAgain(p.id, (body || {}).template || null) }));
route('GET', '/api/meetings/:id/search', ({ p, q }) => json(notes.liveSearch(p.id, q.get('q') || '', q.get('scope') || 'meeting')));
route('POST', '/api/meetings/:id/recap', ({ p, body }) => json(notes.recap(p.id, body && body.minutes !== undefined ? Number(body.minutes) : 5)));
route('POST', '/api/meetings/:id/ask', ({ p, body }) => json(notes.ask(p.id, String(body.question || ''))));
route('POST', '/api/ask', ({ body }) => json(notes.askAll(String(body.question || ''))));
route('POST', '/api/meetings/:id/redact', ({ p, body }) => json({ deleted: notes.redactLast(p.id, body.minutes ?? 2) }));
route('POST', '/api/meetings/:id/recipe', ({ p, body }) => json(notes.runRecipe(p.id, body.recipe)));
route('GET', '/api/meetings/:id/export\\.md', ({ p }) => {
  const { md, filename } = notes.exportMarkdown(p.id);
  return download(md, 'text/markdown; charset=utf-8', filename);
});
route('POST', '/api/meetings/:id/to-practice', ({ p, body }) => json(notes.toPractice(p.id, body.target_id)));

let booted = false;
function boot() {
  if (booted) return;
  booted = true;
  ensureSeeded();
  recoverJobs();
}

const LATENCY = { POST: 160, PUT: 60, DELETE: 60, GET: 25 };

/** Serve one API request: (path, fetch-like options) -> Response. */
export async function handle(path, opts = {}) {
  boot();
  const method = (opts.method || 'GET').toUpperCase();
  const url = new URL(path, 'http://demo.local');
  const match = routes.find((r) => r.method === method && r.re.test(url.pathname));
  await new Promise((r) => setTimeout(r, LATENCY[method] || 30));
  if (!match) return json({ detail: 'Not Found' }, 404);
  const m = url.pathname.match(match.re);
  const p = {};
  match.keys.forEach((k, i) => { p[k] = decodeURIComponent(m[i + 1]); });
  let body = {};
  if (typeof opts.body === 'string' && opts.body) {
    try { body = JSON.parse(opts.body); } catch { return json({ detail: 'Invalid JSON body' }, 422); }
  }
  const form = opts.body instanceof FormData ? opts.body : null;
  try {
    const res = await match.fn({ p, q: url.searchParams, body: body || {}, form });
    flush();
    return res;
  } catch (err) {
    flush();
    if (err instanceof DemoError) return json({ detail: err.message }, err.status);
    console.error('[demo]', err);
    return json({ detail: `Demo error: ${err.message || err}` }, 500);
  }
}

export { JobHandle };
