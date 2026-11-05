// Shared demo plumbing: agent traces/meta (every agent runs on built-in rules here) and the feedback loop
// (port of backend/app/feedback.py).
import { REASON_GUIDANCE, TARGET_AGENTS, AGENT_REGISTRY } from './data.js';
import { db, save, newId, nowIso, nextInt, rows, trimTraces } from './store.js';

const PROMPT_VERSIONS = Object.fromEntries(AGENT_REGISTRY.map((a) => [a.name, a.prompt_version]));
export const DEMO_TRACE_NOTE = 'Demo mode: built-in rules run in your browser (no language model available)';

/** Run a rule-based agent and record a trace exactly like a degraded backend run. */
export function runAgent(name, fn, runId = null) {
  const started = performance.now();
  const output = fn();
  const latency = Math.max(1, Math.round(performance.now() - started));
  const id = newId('trc');
  db.traces[id] = {
    id, seq: nextInt('trace'), run_id: runId || newId('run'), agent: name, prompt_version: PROMPT_VERSIONS[name] || 'v1',
    provider: 'heuristic', model: 'rules', status: 'degraded', attempts: 0, latency_ms: latency, tokens_in: 0,
    tokens_out: 0, cost_usd: 0, error: DEMO_TRACE_NOTE, created_at: nowIso(),
  };
  trimTraces();
  save('traces');
  return { output, meta: { trace_id: id, provider: 'heuristic', model: 'rules', status: 'degraded', attempts: 0, latency_ms: latency } };
}

// --- feedback -> guidance + bounded calibration ----------------------------------------------------
function recent(types, limit = 60) {
  return rows('feedback').filter((r) => types.includes(r.target_type))
    .sort((a, b) => (b.seq || 0) - (a.seq || 0)).slice(0, limit);
}

export function guidanceFor(agent) {
  const types = Object.entries(TARGET_AGENTS).filter(([, agents]) => agents.includes(agent)).map(([t]) => t);
  if (!types.length) return '';
  const reasons = {};
  for (const r of recent(types)) if (r.rating < 0 && r.reason) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  const harsh = reasons.too_harsh || 0;
  const lenient = reasons.too_lenient || 0;
  const notes = [];
  if (harsh - lenient >= 2) notes.push(REASON_GUIDANCE.too_harsh);
  else if (lenient - harsh >= 2) notes.push(REASON_GUIDANCE.too_lenient);
  for (const reason of ['generic', 'wrong']) if ((reasons[reason] || 0) >= 2) notes.push(REASON_GUIDANCE[reason]);
  return notes.join(' ');
}

export function evaluationBias() {
  const rs = recent(['evaluation'], 40);
  const harsh = rs.filter((r) => r.rating < 0 && r.reason === 'too_harsh').length;
  const lenient = rs.filter((r) => r.rating < 0 && r.reason === 'too_lenient').length;
  if (Math.abs(harsh - lenient) >= 3) return Math.max(-0.25, Math.min(0.25, 0.05 * (harsh - lenient)));
  return 0;
}

export function addFeedback(body) {
  const id = newId('fb');
  db.feedback[id] = {
    id, seq: nextInt('feedback'), target_type: body.target_type, target_id: String(body.target_id || ''),
    rating: body.rating, reason: body.reason || '', comment: body.comment || '', trace_id: body.trace_id || null,
    created_at: nowIso(),
  };
  save('feedback');
  return id;
}

export function feedbackSummary() {
  const all = rows('feedback').sort((a, b) => (b.seq || 0) - (a.seq || 0)).slice(0, 500);
  const byTarget = {};
  const reasons = {};
  for (const r of all) {
    const bucket = byTarget[r.target_type] || (byTarget[r.target_type] = { up: 0, down: 0 });
    bucket[r.rating > 0 ? 'up' : 'down'] += 1;
    if (r.reason) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  }
  const agents = [...new Set(Object.values(TARGET_AGENTS).flat())].sort();
  const guidance = {};
  for (const a of agents) { const g = guidanceFor(a); if (g) guidance[a] = g; }
  const strip = ({ seq, ...r }) => r;
  return {
    total: all.length, positive: all.filter((r) => r.rating > 0).length, negative: all.filter((r) => r.rating < 0).length,
    by_target: byTarget, reasons, recent: all.slice(0, 20).map(strip), guidance, evaluation_bias: evaluationBias(),
  };
}

export function feedbackExportJsonl() {
  const ordered = rows('feedback').sort((a, b) => (a.seq || 0) - (b.seq || 0));
  return ordered.map(({ seq, ...r }) => {
    let content = null;
    const turn = db.turns[r.target_id];
    if (turn) {
      content = { question: turn.question_text, category: turn.category, competency: turn.competency, answer: turn.answer_text, evaluation: turn.evaluation };
    } else if (db.sessions[r.target_id]) {
      content = { report: db.sessions[r.target_id].report };
    } else if (db.meetings[r.target_id]) {
      content = { meeting: db.meetings[r.target_id].title, notes: db.meetings[r.target_id].notes };
    }
    return JSON.stringify({ ...r, content });
  }).join('\n') + (ordered.length ? '\n' : '');
}

// --- traces & agents ----------------------------------------------------------------------------------
export function listTraces({ limit = 100, agent = null, status = null } = {}) {
  let all = rows('traces');
  if (agent) all = all.filter((t) => t.agent === agent);
  if (status) all = all.filter((t) => t.status === status);
  all.sort((a, b) => (b.seq || 0) - (a.seq || 0));
  return all.slice(0, Math.max(1, Math.min(1000, limit))).map(({ seq, ...t }) => t);
}

export function agentsView(settings) {
  const stats = {};
  for (const t of rows('traces')) {
    const s = stats[t.agent] || (stats[t.agent] = { calls: 0, ok: 0, degraded: 0, latency: 0 });
    s.calls += 1;
    if (['ok', 'repaired', 'fallback'].includes(t.status)) s.ok += 1;
    if (t.status === 'degraded') s.degraded += 1;
    s.latency += t.latency_ms;
  }
  const breaker = { state: 'closed', failures: 0, retry_in_sec: 0, last_error: '', calls: 0 };
  return {
    agents: AGENT_REGISTRY.map((a) => {
      const s = stats[a.name];
      const calls = s ? s.calls : 0;
      return {
        ...a, calls,
        ok_rate: calls ? Math.round((s.ok / calls) * 1000) / 1000 : null,
        degraded_rate: calls ? Math.round((s.degraded / calls) * 1000) / 1000 : null,
        avg_latency_ms: calls ? Math.round(s.latency / calls) : null,
      };
    }),
    routing: { breakers: { ollama: { ...breaker }, claude: { ...breaker } }, quality: [] },
    spend: { month: nowIso().slice(0, 7), claude_usd: 0, budget_usd: settings.claude.monthly_budget_usd },
  };
}
