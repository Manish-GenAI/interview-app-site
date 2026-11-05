// Port of the interview coach: backend/app/coach/{metrics,agents,memory,service}.py (rule-based paths).
import {
  BEHAVIORAL_BANK, CATEGORY_DEFAULTS, CATEGORY_TIPS, COMPETENCY_CUES, DEFAULT_COMPETENCIES, DRILL_LIBRARY,
  PREP_STEPS, SKILL_VOCAB, SYSTEM_DESIGN_BANK,
} from './data.js';
import * as tx from './text.js';
import {
  db, save, newId, nowIso, rows, nextInt, DemoError, registerJob, submitJob, JobHandle,
} from './store.js';
import { runAgent, evaluationBias } from './common.js';

const BEHAVIORAL_LIKE = new Set(['behavioral', 'situational', 'culture', 'motivation']);
const TECHNICAL_LIKE = new Set(['technical', 'system_design']);
export const CATEGORIES = ['behavioral', 'technical', 'role', 'situational', 'motivation', 'system_design', 'culture'];
const TECH_TITLE_RE = /engineer|developer|programmer|architect|devops|sre|scientist|ml |machine learning|data engineer|software|backend|frontend|full[- ]stack|technical/i;
const SENIORITIES = ['intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'manager', 'director', 'executive', 'unknown'];
const sum = (a) => a.reduce((x, y) => x + y, 0);
const countSub = (s, sub) => (sub ? s.split(sub).length - 1 : 0);

// =============================================================================================
// Metrics and live practice hints (coach/metrics.py)
// =============================================================================================
function hash10(s) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i += 1) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 ^ s.charCodeAt(i), 2246822519) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 10);
}

export function answerMetrics(text, durationSec) {
  const ws = tx.words(text);
  const n = ws.length;
  const fillers = tx.countPhrases(text, tx.FILLERS);
  const hedges = tx.countPhrases(text, tx.HEDGES);
  const fillerCount = sum(Object.values(fillers));
  const low = String(text || '').toLowerCase();
  const duration = durationSec ? Number(durationSec) : 0;
  return {
    word_count: n,
    duration_sec: duration ? tx.pyRound(duration, 1) : null,
    wpm: duration >= 5 ? tx.pyRound(n / (duration / 60)) : null,
    filler_count: fillerCount,
    filler_rate: n ? tx.pyRound((100 * fillerCount) / n, 1) : 0,
    fillers,
    hedge_count: sum(Object.values(hedges)),
    i_count: (low.match(/\b(?:i|i'm|i've|i'd|my|me)\b/g) || []).length,
    we_count: (low.match(/\b(?:we|we're|we've|our|us)\b/g) || []).length,
    numbers_count: tx.numbersCount(text),
    star: tx.starPresence(text),
  };
}

const hint = (kind, text, severity = 'nudge') => ({ id: hash10(`${kind}:${text}`), kind, text, severity });

export function ruleHints(metrics, elapsed, limit, category) {
  const hints = [];
  const star = metrics.star || {};
  const n = metrics.word_count || 0;
  const behavioral = BEHAVIORAL_LIKE.has(category);
  if (limit && elapsed >= limit) hints.push(hint('time', "Time's up - finish your sentence and stop.", 'warn'));
  else if (limit && elapsed >= 0.8 * limit) hints.push(hint('time', 'Start wrapping up: state the result and what you learned.', 'warn'));
  if (behavioral) {
    if (elapsed >= 40 && !star.action) hints.push(hint('structure', 'Move to what you did - your specific actions.'));
    if (elapsed >= 75 && !star.result) hints.push(hint('structure', 'Land the result - ideally with a number.'));
    if (n >= 60 && (metrics.we_count || 0) > Math.max(3, 1.5 * (metrics.i_count || 0))) hints.push(hint('content', "Say 'I' more - make your own contribution clear."));
  } else if (elapsed >= 60 && (metrics.numbers_count || 0) === 0 && TECHNICAL_LIKE.has(category)) {
    hints.push(hint('content', 'Add specifics: scale, numbers, trade-offs.'));
  }
  if (n >= 40 && (metrics.filler_rate || 0) > 6) hints.push(hint('delivery', 'Pause instead of filler words - silence is fine.', 'info'));
  const wpm = metrics.wpm;
  if (wpm && elapsed >= 30) {
    if (wpm > 180) hints.push(hint('delivery', "You're speaking fast - slow down a little.", 'info'));
    else if (wpm < 95 && n > 30) hints.push(hint('delivery', 'Pick up the pace slightly.', 'info'));
  }
  if ((metrics.hedge_count || 0) >= 3) hints.push(hint('delivery', "Sound decisive - fewer 'I think' / 'maybe'.", 'info'));
  if (elapsed >= 45 && n < 25) hints.push(hint('content', 'Keep going - add concrete detail.', 'nudge'));
  return hints.slice(0, 3);
}

// =============================================================================================
// Agents (coach/agents.py: heuristic + postprocess)
// =============================================================================================
export function guessCompetencies(text, allowed) {
  const low = String(text || '').toLowerCase();
  const hits = Object.entries(COMPETENCY_CUES).filter(([, cues]) => cues.some((c) => low.includes(c))).map(([c]) => c);
  if (!allowed.length) return hits.slice(0, 3);
  const map = new Map(allowed.map((a) => [a.toLowerCase(), a]));
  const matched = hits.filter((h) => map.has(h.toLowerCase())).map((h) => map.get(h.toLowerCase()));
  return (matched.length ? matched : [allowed[0]]).slice(0, 3);
}

export function isTechnicalRole(job) {
  const vocab = SKILL_VOCAB.slice(0, 120);
  return TECH_TITLE_RE.test(job.title || '') || ((job.must_have_skills || []).length >= 3
    && job.must_have_skills.some((s) => vocab.includes(s)));
}

const RANGE_SRC = '((?:19|20)\\d\\d)\\s*(?:-|–|—|to)\\s*((?:19|20)\\d\\d|present|current|now|today)';

function profileAgent(resumeText) {
  const text = resumeText || '';
  const allLines = tx.lines(text);
  let name = '';
  for (const ln of allLines.slice(0, 5)) {
    const parts = ln.split(/\s+/).filter(Boolean);
    const caps = parts.filter((p) => /\p{L}/u.test(p[0])).every((p) => p[0] !== p[0].toLowerCase());
    if (parts.length > 1 && parts.length <= 4 && ln.length < 40 && !ln.includes('@') && !/\d/.test(ln) && caps) {
      name = ln;
      break;
    }
  }
  let skills = tx.findSkills(text);
  for (const ln of allLines) {
    const m = ln.match(/^(?:technical\s+|core\s+|key\s+)?skills?\s*[:-]\s*(.+)$/i);
    if (m) skills = skills.concat(m[1].split(/[,;|•·/]/).map((s) => s.trim()).filter((s) => s.length > 1 && s.length < 40));
  }
  const years = [];
  for (const m of text.matchAll(new RegExp(RANGE_SRC, 'gi'))) {
    const s = parseInt(m[1], 10);
    const e = /^\d/.test(m[2]) ? parseInt(m[2], 10) : 2026;
    if (s > 1970 && s <= e && e <= 2030) years.push([s, e]);
  }
  const yearsExp = years.length ? Math.max(...years.map((y) => y[1])) - Math.min(...years.map((y) => y[0])) : 0;
  const roles = [];
  let current = null;
  for (const raw of tx.splitLines(text)) {
    const ln = raw.trim();
    if (!ln) continue;
    const rm = ln.match(new RegExp(RANGE_SRC, 'i'));
    if (rm && !tx.BULLET_RE.test(raw)) {
      const head = tx.pyStrip(ln.replace(new RegExp(RANGE_SRC, 'gi'), ''), ' |,-–—()');
      const parts = head.split(/\s+(?:at|@)\s+|\s+[|–—-]\s+|,\s+/).map((p) => p.trim()).filter(Boolean);
      current = { title: parts.length ? parts[0].slice(0, 80) : 'Role', company: parts.length > 1 ? parts[1].slice(0, 80) : '', period: rm[0], highlights: [] };
      roles.push(current);
    } else if (current && tx.BULLET_RE.test(raw)) {
      if (current.highlights.length < 6) current.highlights.push(raw.replace(tx.BULLET_RE, '').trim());
    }
  }
  const achievements = tx.bulletLines(text).filter((b) => tx.numbersCount(b) > 0).slice(0, 10);
  const education = allLines.filter((ln) => /\b(B\.?S\.?c?|B\.?A\.?|M\.?S\.?c?|MBA|Ph\.?D|B\.?Tech|M\.?Tech|B\.?E\.?|Bachelor|Master|University|College|Institute)\b/.test(ln)).slice(0, 4);
  const projects = [];
  let inProjects = false;
  for (const raw of tx.splitLines(text)) {
    const ln = raw.trim();
    if (/^projects?\b/i.test(ln)) { inProjects = true; continue; }
    if (inProjects) {
      if (tx.BULLET_RE.test(raw)) projects.push(raw.replace(tx.BULLET_RE, '').trim());
      else if (ln && ln.length < 40 && ln === ln.toUpperCase() && /\p{L}/u.test(ln)) break;
    }
  }
  const headline = roles.length ? roles[0].title + (yearsExp ? ` with ${Math.trunc(yearsExp)}+ years of experience` : '') : '';
  const out = {
    name, headline, years_experience: tx.clampNum(yearsExp, 0, 60), skills: tx.dedupe(tx.strList(skills), 40),
    roles: roles.slice(0, 8), projects: projects.slice(0, 6), education, achievements,
  };
  // postprocess
  out.skills = tx.dedupe(out.skills, 40);
  out.achievements = tx.dedupe(out.achievements, 12);
  out.roles = out.roles.slice(0, 8);
  out.roles.forEach((r) => { r.highlights = tx.dedupe(r.highlights, 6); });
  return out;
}

function jobAgent(jdText) {
  const jd = jdText || '';
  const allLines = tx.lines(jd);
  let title = '';
  for (const ln of allLines.slice(0, 12)) {
    if (TECH_TITLE_RE.test(ln) || /manager|analyst|designer|lead|director|specialist|consultant|intern|associate|coordinator|administrator|representative|officer|head of|recruiter|marketer|writer|accountant/i.test(ln)) {
      if (ln.length <= 90) {
        title = ln.replace(/^(job title|title|role|position)\s*[:-]\s*/i, '');
        break;
      }
    }
  }
  title = title || (allLines.length ? allLines[0].slice(0, 90) : 'Target role');
  let company = '';
  const split = title.match(/^(.*?)\s+(?:at|@)\s+([A-Z][\w&.-]*(?:[ \t][A-Z][\w&.-]*){0,3})\s*$/);
  if (split) { title = split[1].trim(); company = split[2].trim(); }
  const m = jd.match(/(?:About|Join|at)[ \t]+([A-Z][\w&.-]+(?:[ \t][A-Z][\w&.-]+){0,3})/);
  if (!company && m && !['the', 'our', 'us', 'we', 'this'].includes(m[1].toLowerCase())) company = m[1].trim();
  const low = jd.toLowerCase();
  let seniority = 'unknown';
  const levels = [['intern', ['intern']], ['principal', ['principal']], ['staff', ['staff ']], ['director', ['director', 'head of']],
    ['executive', ['vp ', 'vice president', 'chief']], ['manager', ['manager', 'people management']],
    ['senior', ['senior', 'sr.', 'lead ']], ['junior', ['junior', 'entry level', 'entry-level', 'graduate']]];
  for (const [level, pats] of levels) {
    if (pats.some((p) => low.includes(p))) { seniority = level; break; }
  }
  if (seniority === 'unknown' && /\b[3-6]\+?\s*years/.test(low)) seniority = 'mid';
  const sections = new Map([['_', []]]);
  let current = '_';
  for (const raw of tx.splitLines(jd)) {
    const ln = raw.trim();
    if (!ln) continue;
    const header = ln.length < 60 && (ln.endsWith(':') || /^(about|responsibilities|what you|requirements|qualifications|must|nice|preferred|bonus|you have|you will|who you are|benefits|skills)/i.test(ln)) && !tx.BULLET_RE.test(raw);
    if (header) {
      current = ln.toLowerCase();
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (!sections.has(current)) sections.set(current, []);
    sections.get(current).push(ln);
  }
  const pick = (...names) => [...sections.entries()].filter(([k]) => names.some((n) => k.includes(n))).map(([, v]) => v.join(' ')).join('\n');
  const reqText = pick('require', 'qualif', 'must', 'you have', 'who you are', 'skills');
  const niceText = pick('nice', 'prefer', 'bonus', 'plus');
  const respLines = [...sections.entries()].filter(([k]) => ['respons', 'what you', 'you will', 'role'].some((n) => k.includes(n))).flatMap(([, v]) => v);
  let must = tx.findSkills(reqText);
  if (!must.length) must = tx.findSkills(jd);
  const nice = tx.findSkills(niceText).filter((s) => !must.includes(s));
  let responsibilities = respLines.map((ln) => ln.replace(tx.BULLET_RE, '')).slice(0, 8);
  if (!responsibilities.length) responsibilities = tx.bulletLines(jd).slice(0, 6);
  const scored = [];
  for (const [comp, cues] of Object.entries(COMPETENCY_CUES)) {
    const hits = sum(cues.map((c) => countSub(low, c)));
    if (hits) scored.push([comp, hits]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  const comps = scored.slice(0, 6).map(([c, h]) => ({ name: c, weight: tx.clampInt(Math.max(1, Math.min(5, 1 + h)), 1, 5), why: 'Mentioned in the job description' }));
  const out = {
    title, company, seniority: SENIORITIES.includes(seniority) ? seniority : 'unknown',
    must_have_skills: must.slice(0, 20), nice_to_have_skills: nice.slice(0, 12), responsibilities: tx.strList(responsibilities),
    competencies: comps,
    interview_focus: comps.slice(0, 4).map((c) => c.name).concat(must.slice(0, 3).map((s) => `${s} knowledge`)),
    keywords: tx.keywords(jd, 12),
  };
  // postprocess
  out.must_have_skills = tx.dedupe(out.must_have_skills, 25);
  out.nice_to_have_skills = tx.dedupe(out.nice_to_have_skills, 20).filter((s) => !out.must_have_skills.includes(s));
  out.responsibilities = tx.dedupe(out.responsibilities, 12);
  const seen = new Set();
  const list = [];
  for (const comp of out.competencies) {
    let nm = comp.name.trim();
    nm = nm.slice(0, 1).toUpperCase() + nm.slice(1);
    if (!seen.has(nm.toLowerCase())) { seen.add(nm.toLowerCase()); list.push({ ...comp, name: nm }); }
  }
  for (const d of DEFAULT_COMPETENCIES) {
    if (list.length >= 4) break;
    if (!seen.has(d.toLowerCase())) { list.push({ name: d, weight: 2, why: 'Commonly assessed in interviews' }); seen.add(d.toLowerCase()); }
  }
  out.competencies = list.sort((a, b) => b.weight - a.weight).slice(0, 8);
  out.keywords = tx.dedupe(out.keywords, 15);
  return out;
}

function fitAgent(profile, job, resumeText) {
  const resumeLow = String(resumeText || '').toLowerCase();
  const prof = new Set(profile.skills.map((s) => s.toLowerCase()));
  const must = job.must_have_skills.length ? job.must_have_skills : job.nice_to_have_skills;
  const strengths = [];
  const gaps = [];
  for (const skill of must) {
    if (prof.has(skill.toLowerCase()) || resumeLow.includes(skill.toLowerCase())) {
      const evidence = tx.lines(resumeText).find((ln) => ln.toLowerCase().includes(skill.toLowerCase())) || '';
      strengths.push({ skill, evidence: tx.truncate(evidence, 140) });
    } else {
      gaps.push({ skill, mitigation: `Point to adjacent experience and a concrete plan to ramp up on ${skill}.` });
    }
  }
  const coverage = strengths.length / Math.max(1, must.length);
  const score = must.length ? tx.pyRound(100 * (0.8 * coverage + 0.2 * Math.min(1, profile.achievements.length / 5))) : 50;
  const points = profile.achievements.slice(0, 3).map((a) => tx.truncate(a, 140));
  if (strengths.length) points.push(`Hands-on experience with ${strengths.slice(0, 4).map((s) => s.skill).join(', ')}`);
  return {
    match_score: tx.clampInt(score, 0, 100),
    summary: must.length ? `The resume shows ${strengths.length} of ${must.length} key requirements.` : "Couldn't find a clear list of requirements in the job description.",
    strengths: strengths.slice(0, 10), gaps: gaps.slice(0, 8), talking_points: tx.dedupe(points, 6),
  };
}

function storyAgent(profile, job) {
  const comps = job.competencies.map((c) => c.name);
  const sources = profile.achievements.map((a) => [a, '']);
  for (const role of profile.roles) for (const h of role.highlights) sources.push([h, role.company || role.title]);
  const seen = new Set();
  const stories = [];
  for (const [bullet, where] of sources) {
    const key = bullet.toLowerCase().slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    const metrics = tx.numberMatches(bullet);
    stories.push({
      title: tx.firstWords(bullet, 8),
      situation: where ? `At ${where}: [add: the context and why it mattered]` : '[add: the context and why it mattered]',
      task: '[add: what you were responsible for]',
      action: bullet,
      result: metrics.length ? `[confirm the result: ${metrics.slice(0, 3).join(', ')}]` : '[add: the measurable result]',
      competencies: guessCompetencies(bullet, comps),
      metrics: tx.strList(metrics.slice(0, 4)),
    });
    if (stories.length >= 6) break;
  }
  if (!stories.length) {
    stories.push({
      title: "A project you're proud of", situation: '[add: the context]', task: '[add: your responsibility]',
      action: '[add: 3-4 specific things you did]', result: '[add: the measurable outcome]', competencies: comps.slice(0, 2), metrics: [],
    });
  }
  return { stories: stories.slice(0, 8) };
}

const qKey = (s) => tx.normKey(s);

function planAgent(profile, job, fit, existing, count = 20) {
  const title = job.title || 'this role';
  const at = job.company ? ` at ${job.company}` : '';
  const technical = isTechnicalRole(job);
  const compNames = job.competencies.map((c) => c.name);
  let qs = [];
  const add = (text, category, competency, difficulty) => {
    const d = CATEGORY_DEFAULTS[category];
    qs.push({ text, category, competency, difficulty: tx.clampInt(difficulty, 1, 3), why_asked: d.why, good_answer_signals: [...d.signals] });
  };
  add(`Walk me through your background and why ${title}${at} is the right next step.`, 'motivation', 'Communication', 1);
  add(`Why are you interested in ${job.company || 'this company'}?`, 'motivation', 'Communication', 1);
  for (const comp of job.competencies) {
    const bank = BEHAVIORAL_BANK[comp.name] || [
      `Tell me about a time you demonstrated ${comp.name.toLowerCase()}.`,
      `Describe a situation that tested your ${comp.name.toLowerCase()}. What did you do?`,
    ];
    bank.slice(0, 2).forEach((text, i) => add(text, 'behavioral', comp.name, 2 + (i === 1 && comp.weight >= 4 ? 1 : 0)));
  }
  const primary = job.competencies.length ? job.competencies[0].name : 'Problem solving';
  for (const resp of job.responsibilities.slice(0, 3)) {
    const short = tx.truncate(resp.replace(/\.+$/, ''), 90);
    add(`This role involves: "${short}". How would you approach that in your first 90 days?`, 'role', primary, 2);
  }
  for (const gap of fit.gaps.slice(0, 3)) {
    add(`You haven't listed much experience with ${gap.skill}. How would you get up to speed?`, 'situational',
      compNames.includes('Learning agility') ? 'Learning agility' : primary, 2);
  }
  if (technical) {
    const techComp = (job.competencies.find((c) => c.name.toLowerCase().includes('tech')) || {}).name || primary;
    for (const skill of job.must_have_skills.slice(0, 4)) {
      add(`How have you used ${skill} in production, and what trade-offs did you make?`, 'technical', techComp, 2);
    }
    const designComp = (job.competencies.find((c) => c.name.toLowerCase().includes('design')) || {}).name || techComp;
    for (const text of SYSTEM_DESIGN_BANK.slice(0, 2)) add(text, 'system_design', designComp, 3);
  }
  add("Imagine a key project is two weeks behind and the deadline can't move. What do you do?", 'situational',
    compNames.includes('Execution') ? 'Execution' : primary, 2);
  add('Tell me about a time you received difficult feedback. What did you do with it?', 'culture',
    compNames.includes('Learning agility') ? 'Learning agility' : primary, 2);
  add('Tell me about a time you failed. What happened and what did you learn?', 'behavioral', primary, 3);
  const existingKeys = new Set(existing.map(qKey));
  qs = qs.filter((q) => !existingKeys.has(qKey(q.text)));
  // postprocess
  const compMap = new Map(job.competencies.map((c) => [c.name.toLowerCase(), c.name]));
  const seen = new Set();
  const cleaned = [];
  for (const q of qs) {
    const key = qKey(q.text);
    if (!key || seen.has(key) || existingKeys.has(key)) continue;
    if (!technical && TECHNICAL_LIKE.has(q.category)) q.category = 'role';
    seen.add(key);
    q.competency = compMap.get(q.competency.toLowerCase()) || q.competency.trim() || 'General';
    if (!q.why_asked || !q.good_answer_signals.length) {
      const d = CATEGORY_DEFAULTS[q.category] || CATEGORY_DEFAULTS.behavioral;
      q.why_asked = q.why_asked || d.why;
      q.good_answer_signals = q.good_answer_signals.length ? q.good_answer_signals : [...d.signals];
    }
    cleaned.push(q);
  }
  return { questions: cleaned.slice(0, Math.max(count, 8) + 6) };
}

function quoteSupported(quote, answer) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  const q = norm(quote);
  const aw = norm(answer);
  if (!q.length) return true;
  if (` ${aw.join(' ')} `.includes(` ${q.join(' ')} `)) return true;
  const set = new Set(aw);
  return q.filter((w) => set.has(w)).length / q.length >= 0.8;
}

function properNounCount(text) {
  let n = 0;
  for (const m of text.matchAll(/\b[A-Z][a-z]{2,}/g)) {
    const i = m.index;
    if (i === 0) continue;
    if (i >= 2 && '.!?'.includes(text[i - 2]) && /\s/.test(text[i - 1])) continue;
    n += 1;
  }
  return n;
}

function evaluatorHeuristic(inp) {
  const m = inp.metrics;
  const star = m.star || {};
  const n = m.word_count || 0;
  const behavioral = BEHAVIORAL_LIKE.has(inp.category) && inp.category !== 'motivation';
  const technical = TECHNICAL_LIKE.has(inp.category);
  const parts = Object.values(star).filter(Boolean).length;
  const sents = tx.sentences(inp.answer).length;
  const nums = m.numbers_count || 0;
  const low = inp.answer.toLowerCase();
  const proper = properNounCount(inp.answer);
  const techSkills = tx.findSkills(inp.answer);
  const tradeoffs = (low.match(/\b(?:trade-?offs?|instead of|rather than|because|chose|at the cost|downside|alternative|accepted|giving up|if i did it again)\b/g) || []).length;
  const overlap = tx.overlapRatio(inp.answer, inp.question);
  const cues = COMPETENCY_CUES[inp.competency] || [];
  const onTopic = overlap >= 0.1 || cues.some((c) => low.includes(c));
  const story = Boolean(star.situation || star.action) && (m.i_count || 0) >= 2;
  const b = (x) => (x ? 1 : 0);
  let structure; let relevance; let specificity; let impact;
  if (technical) {
    structure = 2 + b(n > 80) + b(sents >= 4) + b(n > 150);
    relevance = 2 + b(onTopic || techSkills.length > 0) + b(techSkills.length >= 1) + b(n >= 80);
    specificity = 1 + b(nums > 0) + b(nums > 2) + b(techSkills.length >= 2) + b(n >= 120);
    impact = 1 + b(nums > 0) + b(tradeoffs >= 1) + b(tradeoffs >= 2) + b(star.result);
  } else if (inp.category === 'motivation') {
    structure = 2 + b(n > 60) + b(sents >= 4) + b(n > 100);
    relevance = 2 + b(/\b(?:role|team|company|product|your|you're)\b/.test(low))
      + b(/\b(?:i've|years|my current|at my|i led|i built)\b/.test(low))
      + b(/\b(?:want|grow|long term|next step|excited|goal)\b/.test(low));
    specificity = 1 + b(nums > 0) + b(proper >= 1) + b((m.i_count || 0) >= 3) + b(n >= 80);
    impact = 2 + b(nums > 0) + b(/\b(?:users|customers|impact|help|build)\b/.test(low));
  } else {
    structure = 1 + parts;
    relevance = 2 + b(story) + b(onTopic) + b(star.result && n >= 80);
    if (!story && !onTopic) relevance = 1;
    specificity = 1 + b(nums > 0) + b((m.i_count || 0) >= 3) + b(n >= 100) + b(proper >= 2);
    impact = 1 + 2 * b(star.result) + b(nums > 0) + b(nums > 2);
  }
  if (n < 20) { structure = Math.min(structure, 2); relevance = 1; specificity = 1; impact = 1; } else if (n < 40) structure = Math.min(structure, 2);
  const wpm = m.wpm;
  const communication = 5 - b((m.filler_rate || 0) > 4) - b((m.filler_rate || 0) > 8) - b((m.hedge_count || 0) >= 3)
    - b(n > 450) - b(wpm && (wpm > 185 || wpm < 90)) - b(n < 25);
  const technicalDepth = technical ? 1 + Math.min(4, b(n > 100) + b(nums > 0) + Math.min(2, techSkills.length) + b(tradeoffs >= 1)) : null;
  const c5 = (v) => tx.clampInt(v, 1, 5);
  const scores = {
    structure: c5(structure), relevance: c5(relevance), specificity: c5(specificity), impact: c5(impact),
    communication: c5(Math.max(1, communication)), technical_depth: technicalDepth === null ? null : c5(technicalDepth),
  };
  const dims = [scores.structure, scores.relevance, scores.specificity, scores.impact, scores.communication];
  const overall = sum(dims) / dims.length;
  const strengths = [];
  const improvements = [];
  const missing = [];
  if (behavioral) {
    for (const [part, label] of [['situation', 'context'], ['action', 'your specific actions'], ['result', 'a clear result']]) {
      if (star[part]) strengths.push(`Includes ${label}.`);
      else { missing.push(label); improvements.push(`Add ${label}.`); }
    }
  }
  if ((m.numbers_count || 0) > 0) strengths.push('Uses numbers to make it concrete.');
  else improvements.push('Quantify the outcome (time saved, revenue, users, quality).');
  if ((m.we_count || 0) > Math.max(3, 1.5 * (m.i_count || 0))) improvements.push("Use 'I' for what you personally did - the interviewer is assessing you.");
  if ((m.filler_rate || 0) > 4) improvements.push(`Cut filler words (${m.filler_count} detected) - pause instead.`);
  if (n < 60) improvements.push('Give more detail - aim for 1.5 to 2 minutes for a story.');
  else if (n > 450) improvements.push('Tighten it - aim for under 2.5 minutes.');
  if (technical) improvements.push('Name the trade-offs you considered and why you chose your approach.');
  const quotes = tx.sentences(inp.answer).filter((s) => tx.numbersCount(s) || /\bI (?:\w+ed|led|built|ran)\b/.test(s));
  let outline = ['Open with one sentence of context and why it mattered.'];
  outline = outline.concat(behavioral
    ? ['State your specific responsibility.', 'Walk through 2-3 actions you personally took.', 'Finish with the measurable result and what you learned.']
    : ['Answer the question directly first.', 'Support it with one concrete example from your work.', "Close with trade-offs or what you'd do differently."]);
  return {
    overall: tx.clampNum(tx.pyRound(overall, 1), 1, 5), scores,
    summary: 'Scored with built-in rules (no language model available): structure, detail and delivery were checked, not the substance of your answer.',
    strengths: strengths.length ? strengths.slice(0, 4) : ['You answered the question.'],
    improvements: improvements.length ? improvements.slice(0, 5) : ['Add one more concrete detail.'],
    missing_elements: missing, evidence_quotes: quotes.slice(0, 2).map((q) => tx.truncate(q, 160)),
    better_answer_outline: outline, competency_signal: tx.clampInt(Math.max(1, Math.min(5, tx.pyRound(overall))), 1, 5),
    calibration_notes: [],
  };
}

function evaluatorPostprocess(inp, out) {
  const m = inp.metrics;
  const notes = [];
  const s = out.scores;
  const n = m.word_count || 0;
  const behavioral = BEHAVIORAL_LIKE.has(inp.category);
  if (n < 25) {
    for (const dim of ['structure', 'relevance', 'specificity', 'impact']) s[dim] = Math.min(s[dim], 2);
    notes.push('Very short answer: scores capped at 2.');
  }
  if (behavioral && !(m.star || {}).result && (m.numbers_count || 0) === 0 && s.impact > 3) {
    s.impact = 3;
    notes.push('No clear result or number detected: impact capped at 3.');
  }
  if ((m.filler_rate || 0) > 8 && s.communication > 3) {
    s.communication = 3;
    notes.push('High filler-word rate measured: communication capped at 3.');
  }
  if (!TECHNICAL_LIKE.has(inp.category)) s.technical_depth = null;
  else if (s.technical_depth === null || s.technical_depth === undefined) s.technical_depth = s.specificity;
  const dims = [s.structure, s.relevance, s.specificity, s.impact, s.communication];
  let weights = [0.2, 0.25, 0.2, 0.2, 0.15];
  if (s.technical_depth !== null) { dims.push(s.technical_depth); weights = [0.15, 0.2, 0.15, 0.15, 0.1, 0.25]; }
  const weighted = sum(dims.map((d, i) => d * weights[i])) / sum(weights);
  let overall = 0.6 * out.overall + 0.4 * weighted;
  const bias = evaluationBias();
  if (bias) {
    overall += bias;
    notes.push(`Adjusted ${bias >= 0 ? '+' : ''}${bias.toFixed(2)} based on your feedback on past scores.`);
  }
  if (n < 25) overall = Math.min(overall, 2.0);
  out.overall = tx.pyRound(Math.max(1, Math.min(5, overall)), 1);
  out.competency_signal = Math.max(1, Math.min(5, tx.pyRound(out.competency_signal || out.overall)));
  out.evidence_quotes = out.evidence_quotes.filter((q) => quoteSupported(q, inp.answer)).slice(0, 4);
  out.strengths = out.strengths.slice(0, 5);
  out.improvements = out.improvements.slice(0, 5);
  out.better_answer_outline = out.better_answer_outline.slice(0, 6);
  out.calibration_notes = notes;
  return out;
}

export function evaluate(inp) {
  return evaluatorPostprocess(inp, evaluatorHeuristic(inp));
}

function interviewerAgent(inp) {
  const next = (reason) => ({ action: 'next', follow_up_question: '', reason });
  const follow = (reason, q) => ({ action: 'follow_up', follow_up_question: q, reason });
  if (inp.followups_so_far >= inp.max_followups) return next('Follow-up limit reached for this question.');
  const m = inp.metrics;
  const star = m.star || {};
  if ((m.word_count || 0) < 15) return next('Answer too short to probe further.');
  if (TECHNICAL_LIKE.has(inp.category)) {
    if ((m.numbers_count || 0) === 0) return follow('No scale or numbers given.', 'Roughly what scale were you dealing with, and how did that shape your design?');
    return follow('Probe trade-offs.', 'What alternatives did you consider, and why did you choose this approach?');
  }
  if (!star.result) return follow('No clear outcome.', 'What was the outcome, and how did you measure it?');
  if ((m.we_count || 0) > Math.max(3, 1.5 * (m.i_count || 0))) return follow('Unclear personal contribution.', "What was your specific contribution, as opposed to the team's?");
  if ((m.numbers_count || 0) === 0) return follow('Impact not quantified.', 'Can you put a number on the impact?');
  return next('The answer covered the key elements.');
}

function coachAgent(targetTitle, turns, compScores) {
  const evals = turns.filter((t) => t.evaluation).map((t) => t.evaluation);
  let out;
  if (!evals.length) {
    out = {
      headline: 'No answers recorded in this session.', overall_score: 1.0, competency_scores: compScores, strengths: [],
      improvements: [], drills: [], next_focus: [], encouragement: "Start a new session when you're ready.",
    };
  } else {
    const overall = tx.pyRound(sum(evals.map((e) => e.overall)) / evals.length, 1);
    const dims = ['structure', 'relevance', 'specificity', 'impact', 'communication'];
    const avg = {};
    for (const d of dims) avg[d] = sum(evals.map((e) => (e.scores || {})[d] || 0)) / evals.length;
    const tech = evals.map((e) => (e.scores || {}).technical_depth).filter(Boolean);
    if (tech.length) avg.technical_depth = sum(tech) / tech.length;
    const keys = Object.keys(avg);
    const weakest = [...keys].sort((a, b) => avg[a] - avg[b]).slice(0, 3);
    const strongest = [...keys].sort((a, b) => avg[b] - avg[a]).slice(0, 2);
    const nice = (k) => k.replaceAll('_', ' ');
    const imp = tx.mostCommon(evals.flatMap((e) => e.improvements || []), 4);
    const stg = tx.mostCommon(evals.flatMap((e) => e.strengths || []), 3);
    const weakComps = [...compScores].sort((a, b) => a.score - b.score).slice(0, 2);
    out = {
      headline: `Average ${tx.pyFloat(overall)}/5 across ${evals.length} answers - strongest on ${nice(strongest[0])}, weakest on ${nice(weakest[0])}.`,
      overall_score: overall, competency_scores: compScores,
      strengths: stg.length ? stg.map(([s]) => s) : [`Solid ${nice(strongest[0])}.`],
      improvements: imp.map(([s]) => s),
      drills: weakest.filter((d) => DRILL_LIBRARY[d]).map((d) => ({ ...DRILL_LIBRARY[d] })).slice(0, 3),
      next_focus: weakComps.length ? weakComps.map((c) => c.competency) : [nice(weakest[0])],
      encouragement: 'Consistency beats intensity: two short sessions this week will move these scores.',
    };
  }
  // postprocess
  const overalls = turns.filter((t) => t.evaluation).map((t) => t.evaluation.overall);
  if (overalls.length) out.overall_score = tx.pyRound(sum(overalls) / overalls.length, 1);
  out.overall_score = tx.clampNum(out.overall_score, 1, 5);
  out.competency_scores = compScores;
  out.drills = out.drills.slice(0, 4);
  out.strengths = out.strengths.slice(0, 5);
  out.improvements = out.improvements.slice(0, 5);
  return out;
}

// =============================================================================================
// Skill memory and question selection (coach/memory.py)
// =============================================================================================
const ALPHA = 0.4;
const MODE_CATEGORIES = { behavioral: ['behavioral', 'situational', 'culture', 'motivation'], technical: ['technical', 'system_design', 'role'] };
const skillKey = (targetId, comp) => `${targetId}::${comp}`;

export function skillsSnapshot(targetId) {
  const out = {};
  for (const r of rows('skills')) if (r.target_id === targetId) out[r.competency] = r.score;
  return out;
}

export function updateSkill(targetId, competency, score) {
  const comp = competency || 'General';
  const key = skillKey(targetId, comp);
  const row = db.skills[key];
  let ema; let n; let ease; let interval; let history;
  if (row) { ema = (1 - ALPHA) * row.score + ALPHA * score; n = row.n + 1; ease = row.ease; interval = row.interval_days; history = row.history || []; } else { ema = score; n = 1; ease = 2.5; interval = 0; history = []; }
  if (score >= 4) { interval = interval < 1 ? 1.0 : interval * ease; ease = Math.min(3, ease + 0.1); } else if (score >= 3) { interval = Math.max(1, interval); } else { interval = 0.5; ease = Math.max(1.3, ease - 0.2); }
  history = history.concat([{ at: nowIso(), score: tx.pyRound(score, 2) }]).slice(-50);
  db.skills[key] = {
    target_id: targetId, competency: comp, score: tx.pyRound(ema, 3), n, ease: tx.pyRound(ease, 3), interval_days: tx.pyRound(interval, 3),
    last_practiced: nowIso(), next_due: nowIso(new Date(Date.now() + interval * 86400000)), history,
  };
  save('skills');
}

export function selectQuestions(targetId, mode, n, focus = null, weights = {}) {
  let questions = rows('questions').filter((q) => q.target_id === targetId);
  const allowed = MODE_CATEGORIES[mode];
  if (allowed) {
    const pool = questions.filter((q) => allowed.includes(q.category));
    questions = pool.length ? pool : questions;
  }
  if (!questions.length) return [];
  const skills = {};
  for (const r of rows('skills')) if (r.target_id === targetId) skills[r.competency] = r;
  const now = Date.now();
  const focusLow = focus ? focus.toLowerCase() : null;
  const priority = (q) => {
    const skill = skills[q.competency];
    const weakness = skill ? (5 - skill.score) / 4 : 0.6;
    const due = skill && (Date.parse(skill.next_due) || now) <= now ? 1 : (skill ? 0 : 0.5);
    const importance = (weights[q.competency] ?? 3) / 5;
    const novelty = q.times_asked ? 0 : 1;
    const last = q.last_asked_at ? Date.parse(q.last_asked_at) : null;
    const recency = last && now - last < 20 * 3600 * 1000 ? 1 : 0;
    const focusBonus = focusLow && q.competency.toLowerCase() === focusLow ? 1.5 : 0;
    return 1.2 * weakness + 0.8 * due + 0.8 * importance + 0.6 * novelty - 1.5 * recency + focusBonus + Math.random() * 0.35;
  };
  const ranked = questions.map((q) => [priority(q), q]).sort((a, b) => b[0] - a[0]).map(([, q]) => q);
  const picked = [];
  const perComp = {};
  const perCat = {};
  const capCat = mode === 'mixed' ? Math.max(2, Math.floor((n + 1) / 2)) : n;
  for (const q of ranked) {
    if (picked.length >= n) break;
    if ((perComp[q.competency] || 0) >= 2 && !(focusLow && q.competency.toLowerCase() === focusLow)) continue;
    if ((perCat[q.category] || 0) >= capCat) continue;
    picked.push(q);
    perComp[q.competency] = (perComp[q.competency] || 0) + 1;
    perCat[q.category] = (perCat[q.category] || 0) + 1;
  }
  for (const q of ranked) {
    if (picked.length >= n) break;
    if (!picked.includes(q)) picked.push(q);
  }
  const isWarm = (q) => q.difficulty === 1 || q.category === 'motivation';
  let warm = picked.find(isWarm) || null;
  if (!warm && n >= 4 && picked.length) {
    warm = ranked.find((q) => isWarm(q) && !picked.includes(q)) || null;
    if (warm) picked[picked.length - 1] = warm;
  }
  if (warm && picked.indexOf(warm) !== 0) {
    picked.splice(picked.indexOf(warm), 1);
    picked.unshift(warm);
  }
  return picked;
}

export function progress(targetId) {
  const now = Date.now();
  const comps = rows('skills').filter((r) => r.target_id === targetId).sort((a, b) => a.score - b.score).map((r) => ({
    competency: r.competency, score: tx.pyRound(r.score, 2), n: r.n, last_practiced: r.last_practiced, next_due: r.next_due,
    due: Boolean(r.next_due && Date.parse(r.next_due) <= now), history: r.history || [],
  }));
  const sessions = rows('sessions').filter((s) => s.target_id === targetId && s.overall_score !== null && s.overall_score !== undefined)
    .sort((a, b) => a.started_at.localeCompare(b.started_at) || (a._seq - b._seq))
    .map((s) => ({ id: s.id, started_at: s.started_at, overall_score: s.overall_score }));
  const sessionIds = new Set(rows('sessions').filter((s) => s.target_id === targetId).map((s) => s.id));
  const answers = rows('turns').filter((t) => sessionIds.has(t.session_id) && t.status === 'answered').length;
  const scores = sessions.map((s) => s.overall_score);
  return {
    competencies: comps, sessions, due_count: comps.filter((c) => c.due).length,
    totals: { sessions: sessions.length, answers, avg_score: scores.length ? tx.pyRound(sum(scores) / scores.length, 2) : null },
  };
}

// =============================================================================================
// Serializers and flows (coach/service.py)
// =============================================================================================
export const questionDict = ({ _seq, ...q }) => q;
export const storyDict = ({ _seq, created_at, ...s }) => s;
export const targetDict = ({ _seq, ...t }) => t;
const turnDict = ({ _seq, session_id, ...t }) => t;

export function loadTarget(id) {
  const t = db.targets[id];
  if (!t) throw new DemoError('Target not found', 404);
  return t;
}

export function listTargets() {
  return rows('targets').sort((a, b) => b.created_at.localeCompare(a.created_at) || (b._seq - a._seq)).map((t) => ({
    id: t.id, title: t.title, company: t.company, status: t.status, created_at: t.created_at,
    match_score: t.fit ? t.fit.match_score : null,
    question_count: rows('questions').filter((q) => q.target_id === t.id).length,
    story_count: rows('stories').filter((s) => s.target_id === t.id).length,
    session_count: rows('sessions').filter((s) => s.target_id === t.id).length,
  }));
}

export function deleteTarget(id) {
  loadTarget(id);
  delete db.targets[id];
  for (const table of ['questions', 'stories', 'sessions', 'skills']) {
    for (const [k, r] of Object.entries(db[table])) if (r.target_id === id) delete db[table][k];
  }
  const live = new Set(Object.keys(db.sessions));
  for (const [k, t] of Object.entries(db.turns)) if (!live.has(t.session_id)) delete db.turns[k];
  save('targets', 'questions', 'stories', 'sessions', 'skills', 'turns');
}

export function createTarget(title, company, resumeText, jdText) {
  if (String(resumeText || '').trim().length < 40) throw new DemoError('Please paste your resume (at least a few lines).');
  if (String(jdText || '').trim().length < 40) throw new DemoError('Please paste the job description (at least a few lines).');
  const id = newId('tgt');
  const now = nowIso();
  db.targets[id] = {
    id, _seq: nextInt('target'), title: String(title || '').trim(), company: String(company || '').trim(), status: 'preparing', job_id: null,
    resume_text: resumeText, jd_text: jdText, profile: null, job: null, fit: null, meta: {}, created_at: now, updated_at: now,
  };
  const jobId = submitJob('prep_target', { target_id: id });
  db.targets[id].job_id = jobId;
  save('targets');
  return { target: targetDict(db.targets[id]), job_id: jobId };
}

export function prepareAgain(id) {
  const t = loadTarget(id);
  const jobId = submitJob('prep_target', { target_id: id });
  Object.assign(t, { status: 'preparing', job_id: jobId, updated_at: nowIso() });
  save('targets');
  return jobId;
}

/** The five prep agents, run one at a time (shared by the job and the synchronous seed). */
const PREP_RUNNERS = {
  profile: (ctx) => runAgent('ProfileAgent', () => profileAgent(ctx.t.resume_text), ctx.runId),
  job: (ctx) => runAgent('JobAnalystAgent', () => jobAgent(ctx.t.jd_text), ctx.runId),
  fit: (ctx) => runAgent('FitAgent', () => fitAgent(ctx.profile, ctx.analysis, ctx.t.resume_text), ctx.runId),
  stories: (ctx) => runAgent('StoryMinerAgent', () => storyAgent(ctx.profile, ctx.analysis), ctx.runId),
  questions: (ctx) => runAgent('QuestionPlannerAgent', () => planAgent(ctx.profile, ctx.analysis, ctx.fit, ctx.keep, 20), ctx.runId),
};

function savePrep(ctx) {
  const { t } = ctx;
  if (!db.targets[t.id]) return { skipped: 'target deleted' };
  const now = nowIso();
  for (const [k, q] of Object.entries(db.questions)) if (q.target_id === t.id && q.source === 'generated' && !q.times_asked) delete db.questions[k];
  for (const q of ctx.plan.questions) {
    const id = newId('q');
    db.questions[id] = {
      id, _seq: nextInt('question'), target_id: t.id, text: q.text, category: q.category, competency: q.competency, difficulty: q.difficulty,
      why_asked: q.why_asked, good_answer_signals: q.good_answer_signals, source: 'generated', times_asked: 0, last_score: null,
      last_asked_at: null, created_at: now,
    };
  }
  for (const [k, s] of Object.entries(db.stories)) if (s.target_id === t.id && s.source === 'generated') delete db.stories[k];
  for (const st of ctx.stories.stories) {
    const id = newId('sty');
    db.stories[id] = { id, _seq: nextInt('story'), target_id: t.id, ...st, source: 'generated', created_at: now, updated_at: now };
  }
  Object.assign(t, { profile: ctx.profile, job: ctx.analysis, fit: ctx.fit, meta: ctx.meta, status: 'ready', updated_at: now });
  if (!t.title) t.title = ctx.analysis.title.slice(0, 120);
  if (!t.company && ctx.analysis.company) t.company = ctx.analysis.company.slice(0, 120);
  save('targets', 'questions', 'stories');
  return { questions: ctx.plan.questions.length, stories: ctx.stories.stories.length };
}

function prepContext(t, runId) {
  const keep = rows('questions').filter((q) => q.target_id === t.id && (q.source !== 'generated' || q.times_asked > 0)).map((q) => q.text);
  return { t, runId, keep, meta: {} };
}
const KEY_FIELD = { profile: 'profile', job: 'analysis', fit: 'fit', stories: 'stories', questions: 'plan' };

export function prepareSync(t) {
  const ctx = prepContext(t, newId('run'));
  for (const key of ['profile', 'job', 'fit', 'stories', 'questions']) {
    const res = PREP_RUNNERS[key](ctx);
    ctx[KEY_FIELD[key]] = res.output;
    ctx.meta[key] = res.meta;
  }
  return savePrep(ctx);
}

async function runPrep(job, payload) {
  const t = db.targets[payload.target_id];
  if (!t) return { skipped: 'target deleted' };
  Object.assign(t, { status: 'preparing', job_id: job.job.id, updated_at: nowIso() });
  save('targets');
  job.plan(PREP_STEPS);
  const ctx = prepContext(t, job.job.id);
  const step = (key) => {
    const def = PREP_STEPS.find((s) => s.key === key);
    return job.step(key, def.label, def.agent, (st) => {
      const res = PREP_RUNNERS[key](ctx);
      JobHandle.record(st, res.meta);
      ctx[KEY_FIELD[key]] = res.output;
      ctx.meta[key] = res.meta;
    });
  };
  await Promise.all([step('profile'), step('job')]);
  await step('fit');
  await Promise.all([step('stories'), step('questions')]);
  const saved = await job.step('save', 'Saving your prep pack', null, (st) => {
    const out = savePrep(ctx);
    if (!out.skipped) st.detail = `${out.questions} questions, ${out.stories} stories`;
    return out;
  });
  if (saved.skipped) return saved;
  return { ...saved, degraded: Object.keys(ctx.meta) };
}

// --- practice ------------------------------------------------------------------------------------------
function buildPrep(targetId, q) {
  const scored = [];
  for (const st of rows('stories').filter((s) => s.target_id === targetId)) {
    const comps = (st.competencies || []).map((c) => c.toLowerCase());
    const body = [st.title, st.situation, st.action, st.result].join(' ');
    const score = (comps.includes(q.competency.toLowerCase()) ? 2 : 0) + tx.overlapRatio(body, q.text);
    if (score > 0.15) scored.push([score, st]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return {
    why_asked: q.why_asked || '',
    good_answer_signals: q.good_answer_signals || [],
    stories: scored.slice(0, 2).map(([, st]) => ({ id: st.id, title: st.title, result: tx.truncate(st.result, 120) })),
    tips: CATEGORY_TIPS[q.category] || CATEGORY_TIPS.behavioral,
  };
}

function insertTurn(sessionId, idx, kind, text, competency, category, questionId = null, parentTurnId = null, prep = null) {
  const id = newId('trn');
  db.turns[id] = {
    id, _seq: nextInt('turn'), session_id: sessionId, idx, kind, parent_turn_id: parentTurnId, question_id: questionId, question_text: text,
    competency, category, prep, answer_text: null, duration_sec: null, self_rating: null, metrics: null, evaluation: null,
    decision: null, status: 'asked', created_at: nowIso(), answered_at: null,
  };
  save('turns');
  return turnDict(db.turns[id]);
}

export function sessionDict(id) {
  const s = db.sessions[id];
  if (!s) throw new DemoError('Session not found', 404);
  const target = db.targets[s.target_id];
  const turns = rows('turns').filter((t) => t.session_id === id).sort((a, b) => a.idx - b.idx).map(turnDict);
  const current = [...turns].reverse().find((t) => t.status === 'asked');
  const { skills_before, ...config } = s.config;
  return {
    id: s.id, target_id: s.target_id, target_title: target ? target.title : '', status: s.status, config, plan: s.plan,
    turns, current_turn_id: current ? current.id : null, report: s.report, overall_score: s.overall_score, job_id: s.job_id,
    started_at: s.started_at, ended_at: s.ended_at,
  };
}

export function listSessions(targetId = null) {
  return rows('sessions').filter((s) => !targetId || s.target_id === targetId)
    .sort((a, b) => b.started_at.localeCompare(a.started_at) || (b._seq - a._seq))
    .map((s) => ({
      id: s.id, target_id: s.target_id, target_title: (db.targets[s.target_id] || {}).title || '', status: s.status,
      started_at: s.started_at, ended_at: s.ended_at, overall_score: s.overall_score,
      answered: rows('turns').filter((t) => t.session_id === s.id && t.status === 'answered').length,
      mode: (s.config || {}).mode || 'mixed',
    }));
}

const jobWeights = (t) => Object.fromEntries(((t.job || {}).competencies || []).map((c) => [c.name, parseInt(c.weight ?? 3, 10)]));

export function startSession(settings, body) {
  const t = loadTarget(body.target_id);
  if (t.status === 'preparing') throw new DemoError('This target is still being prepared - give it a few seconds.', 409);
  const cfg = settings.coach;
  const mode = ['mixed', 'behavioral', 'technical'].includes(body.mode) ? body.mode : 'mixed';
  const n = Math.max(1, Math.min(12, parseInt(body.num_questions ?? 5, 10) || 5));
  const picked = selectQuestions(t.id, mode, n, body.focus_competency || null, jobWeights(t));
  if (!picked.length) throw new DemoError('No questions in the bank yet. Re-run prep or add your own questions.', 409);
  const id = newId('ses');
  const config = {
    mode, num_questions: picked.length, persona: body.persona || cfg.persona,
    answer_time_limit_sec: body.answer_time_limit_sec || cfg.answer_time_limit_sec,
    hints: body.hints === null || body.hints === undefined ? cfg.hints_enabled : body.hints,
    focus_competency: body.focus_competency || null, max_followups: cfg.max_followups, skills_before: skillsSnapshot(t.id),
  };
  db.sessions[id] = {
    id, _seq: nextInt('session'), target_id: t.id, status: 'active', config, plan: picked.map((q) => q.id), report: null,
    overall_score: null, job_id: null, started_at: nowIso(), ended_at: null,
  };
  save('sessions');
  const first = picked[0];
  insertTurn(id, 0, 'main', first.text, first.competency, first.category, first.id, null, buildPrep(t.id, first));
  return sessionDict(id);
}

function sessionRow(id) {
  const s = db.sessions[id];
  if (!s) throw new DemoError('Session not found', 404);
  return s;
}
function turnRow(sessionId, turnId) {
  const t = db.turns[turnId];
  if (!t || t.session_id !== sessionId) throw new DemoError('Turn not found in this session', 404);
  return t;
}

function nextMainTurn(session, nextIdx) {
  const asked = new Set(rows('turns').filter((t) => t.session_id === session.id && t.kind === 'main').map((t) => t.question_id));
  for (const qid of session.plan) {
    if (asked.has(qid)) continue;
    const q = db.questions[qid];
    if (!q) continue;
    return insertTurn(session.id, nextIdx, 'main', q.text, q.competency, q.category, q.id, null, buildPrep(session.target_id, q));
  }
  return null;
}

export function finalMetrics(answer, durationSec, job) {
  const m = answerMetrics(answer, durationSec);
  const low = String(answer || '').toLowerCase();
  const terms = [];
  if (job) {
    for (const term of [...(job.must_have_skills || []), ...(job.nice_to_have_skills || []), ...(job.keywords || [])]) {
      const t = String(term).trim();
      if (t && !terms.some((x) => x.toLowerCase() === t.toLowerCase())
        && new RegExp(`(?:^|[^a-z0-9])${tx.escRe(t.toLowerCase())}(?![a-z0-9])`).test(low)) terms.push(t);
    }
  }
  const counts = tx.mostCommon(tx.words(answer).filter((w) => w.length > 3 && !tx.STOPWORDS.has(w.toLowerCase())).map((w) => w.toLowerCase()), 8);
  m.jd_terms = terms.slice(0, 12);
  m.top_words = counts.filter(([, c]) => c >= 3).map(([word, count]) => ({ word, count }));
  return m;
}

export function hireSignal(ev) {
  const s = ev.scores;
  const dims = [s.structure, s.relevance, s.specificity, s.impact, s.communication];
  if (s.technical_depth !== null && s.technical_depth !== undefined) dims.push(s.technical_depth);
  if (ev.overall >= 4.5 && Math.min(...dims) >= 4) return 'strong';
  if (ev.overall >= 3.5) return 'lean_hire';
  if (ev.overall >= 2.5) return 'lean_no';
  return 'no';
}

export function submitAnswer(sessionId, body) {
  const session = sessionRow(sessionId);
  if (session.status !== 'active') throw new DemoError('This session has ended.', 409);
  const turn = turnRow(sessionId, body.turn_id);
  if (turn.status !== 'asked') throw new DemoError('This question was already answered or skipped.', 409);
  const answer = String(body.answer_text || '').trim();
  if (!answer) throw new DemoError('The answer is empty. Speak or type your answer first.');
  const target = loadTarget(session.target_id);
  const job = target.job || {};
  const duration = body.duration_sec === null || body.duration_sec === undefined ? null : Number(body.duration_sec);
  const metrics = finalMetrics(answer, duration, job);
  const q = turn.question_id ? db.questions[turn.question_id] : null;
  const rootId = turn.parent_turn_id || turn.id;
  const followups = rows('turns').filter((t) => t.parent_turn_id === rootId).length;
  const maxFollowups = parseInt(session.config.max_followups ?? 1, 10);
  const runId = sessionId;
  const evIn = {
    question: turn.question_text, category: turn.category, competency: turn.competency, answer, metrics,
    job_title: target.title, seniority: job.seniority || 'unknown', signals: q ? q.good_answer_signals : [],
  };
  const ev = runAgent('EvaluatorAgent', () => evaluate(evIn), runId);
  const dec = runAgent('InterviewerAgent', () => interviewerAgent({
    question: turn.question_text, category: turn.category, competency: turn.competency, answer, metrics,
    persona: session.config.persona || 'neutral', followups_so_far: followups, max_followups: maxFollowups,
  }), runId);
  const rating = body.self_rating ? parseInt(body.self_rating, 10) : null;
  const evaluation = {
    ...ev.output, hire_signal: hireSignal(ev.output),
    self_rating_gap: rating ? tx.pyRound(ev.output.overall - rating, 1) : null, meta: ev.meta,
  };
  const decision = { ...dec.output, meta: dec.meta };
  const now = nowIso();
  Object.assign(turn, {
    answer_text: answer, duration_sec: duration, self_rating: rating, metrics, evaluation, decision, status: 'answered', answered_at: now,
  });
  if (turn.kind === 'main' && q) Object.assign(q, { times_asked: (q.times_asked || 0) + 1, last_score: ev.output.overall, last_asked_at: now });
  updateSkill(session.target_id, turn.competency, ev.output.overall);
  save('turns', 'questions');
  const nextIdx = turn.idx + 1;
  let next = null;
  if (decision.action === 'follow_up' && decision.follow_up_question && followups < maxFollowups) {
    next = insertTurn(sessionId, nextIdx, 'followup', decision.follow_up_question, turn.competency, turn.category, turn.question_id, rootId);
  } else {
    next = nextMainTurn(session, nextIdx);
  }
  return { turn: turnDict(turn), next_turn: next, done: next === null };
}

export function skipTurn(sessionId, turnId) {
  const session = sessionRow(sessionId);
  if (session.status !== 'active') throw new DemoError('This session has ended.', 409);
  const turn = turnRow(sessionId, turnId);
  if (turn.status !== 'asked') throw new DemoError('This question was already answered or skipped.', 409);
  Object.assign(turn, { status: 'skipped', answered_at: nowIso() });
  save('turns');
  const next = nextMainTurn(session, turn.idx + 1);
  return { next_turn: next, done: next === null };
}

const hintCache = {};
export function liveHints(settings, sessionId, body) {
  const session = sessionRow(sessionId);
  const turn = turnRow(sessionId, body.turn_id);
  const elapsed = Math.max(0, Number(body.elapsed_sec) || 0);
  const transcript = String(body.transcript || '');
  const metrics = answerMetrics(transcript, elapsed);
  const out = { hints: [], star: metrics.star, metrics };
  if (session.config.hints === false || session.status !== 'active') return out;
  let hints = ruleHints(metrics, elapsed, parseInt(session.config.answer_time_limit_sec ?? 150, 10), turn.category);
  if (settings.coach.llm_hints && elapsed >= 20 && metrics.word_count >= 30) {
    const cached = hintCache[turn.id];
    if (!cached || Date.now() - cached >= 15000) {
      runAgent('HintAgent', () => ({ hints: [] }), sessionId); // no model in the browser: rule hints only
      hintCache[turn.id] = Date.now();
    }
  }
  hints = hints.slice(0, 4);
  out.hints = hints;
  return out;
}

export function endSession(sessionId) {
  const s = sessionRow(sessionId);
  if ((s.status === 'finishing' || s.status === 'done') && s.job_id) return s.job_id;
  const jobId = submitJob('finalize_session', { session_id: sessionId });
  Object.assign(s, { status: 'finishing', job_id: jobId });
  for (const t of rows('turns')) if (t.session_id === sessionId && t.status === 'asked') t.status = 'skipped';
  save('sessions', 'turns');
  return jobId;
}

function finalizeSessionCore(s, runId) {
  const target = db.targets[s.target_id];
  const turns = rows('turns').filter((t) => t.session_id === s.id && t.status === 'answered').sort((a, b) => a.idx - b.idx).map(turnDict);
  const before = s.config.skills_before || {};
  const after = skillsSnapshot(s.target_id);
  const comps = [...new Set(turns.map((t) => t.competency).filter(Boolean))].sort();
  const compScores = comps.map((c) => ({
    competency: c, score: tx.clampNum(after[c] ?? 3.0, 1, 5), delta: c in before ? tx.pyRound((after[c] || 0) - before[c], 2) : 0,
  }));
  const res = runAgent('CoachAgent', () => coachAgent(target ? target.title : '', turns, compScores), runId);
  return { res, turns };
}

async function runFinalizeSession(job, payload) {
  const s = db.sessions[payload.session_id];
  if (!s) return { skipped: 'session deleted' };
  job.plan([{ key: 'report', label: 'Writing your session report', agent: 'CoachAgent' }, { key: 'save', label: 'Saving the report' }]);
  let out;
  await job.step('report', 'Writing your session report', 'CoachAgent', (st) => {
    out = finalizeSessionCore(s, job.job.id);
    JobHandle.record(st, out.res.meta);
  });
  await job.step('save', 'Saving the report', null, () => {
    const report = { ...out.res.output, meta: out.res.meta };
    Object.assign(s, { report, overall_score: out.turns.length ? report.overall_score : null, status: 'done', ended_at: nowIso() });
    save('sessions');
  });
  return { overall_score: s.report.overall_score, answers: out.turns.length };
}

registerJob('prep_target', runPrep);
registerJob('prep_target:failed', async (job, p) => { if (db.targets[p.target_id]) { db.targets[p.target_id].status = 'failed'; save('targets'); } });
registerJob('finalize_session', runFinalizeSession);
registerJob('finalize_session:failed', async (job, p) => { if (db.sessions[p.session_id]) { Object.assign(db.sessions[p.session_id], { status: 'failed', ended_at: nowIso() }); save('sessions'); } });

// --- question & story CRUD (routes/coach.py) ------------------------------------------------------------
export function listQuestions(targetId) {
  loadTarget(targetId);
  return rows('questions').filter((q) => q.target_id === targetId)
    .sort((a, b) => a.category.localeCompare(b.category) || a.competency.localeCompare(b.competency) || a.created_at.localeCompare(b.created_at) || (a._seq - b._seq))
    .map(questionDict);
}

export function addQuestion(targetId, body) {
  loadTarget(targetId);
  const text = String(body.text || '').trim();
  if (text.length < 5) throw new DemoError('text: String should have at least 5 characters', 422);
  const category = CATEGORIES.includes(body.category) ? body.category : 'behavioral';
  const d = CATEGORY_DEFAULTS[category] || CATEGORY_DEFAULTS.behavioral;
  const id = newId('q');
  db.questions[id] = {
    id, _seq: nextInt('question'), target_id: targetId, text, category, competency: String(body.competency || '').trim() || 'General',
    difficulty: Math.max(1, Math.min(3, parseInt(body.difficulty || 2, 10) || 2)), why_asked: d.why, good_answer_signals: [...d.signals],
    source: 'user', times_asked: 0, last_score: null, last_asked_at: null, created_at: nowIso(),
  };
  save('questions');
  return questionDict(db.questions[id]);
}

export function deleteQuestion(id) {
  delete db.questions[id];
  save('questions');
}

export function listStories(targetId) {
  loadTarget(targetId);
  return rows('stories').filter((s) => s.target_id === targetId).sort((a, b) => a.created_at.localeCompare(b.created_at) || (a._seq - b._seq)).map(storyDict);
}

export function addStory(targetId, body) {
  loadTarget(targetId);
  const title = String(body.title || '').trim();
  if (!title) throw new DemoError('title: String should have at least 1 character', 422);
  const id = newId('sty');
  const now = nowIso();
  db.stories[id] = {
    id, _seq: nextInt('story'), target_id: targetId, title, situation: body.situation || '', task: body.task || '', action: body.action || '',
    result: body.result || '', competencies: tx.strList(body.competencies), metrics: tx.strList(body.metrics), source: 'user', created_at: now, updated_at: now,
  };
  save('stories');
  return storyDict(db.stories[id]);
}

export function updateStory(id, body) {
  const s = db.stories[id];
  if (!s) throw new DemoError('Story not found', 404);
  for (const k of ['title', 'situation', 'task', 'action', 'result']) if (body[k] !== null && body[k] !== undefined) s[k] = body[k];
  if (body.competencies !== null && body.competencies !== undefined) s.competencies = tx.strList(body.competencies);
  if (body.metrics !== null && body.metrics !== undefined) s.metrics = tx.strList(body.metrics);
  Object.assign(s, { source: 'user', updated_at: nowIso() });
  save('stories');
  return storyDict(s);
}

export function deleteStory(id) {
  delete db.stories[id];
  save('stories');
}

/** Synchronous session for seeding is not needed; exported helpers for evals. */
export { evaluatorHeuristic as _evaluatorHeuristic };

// Exposed for the parity tests (Node) only.
export const _agents = { profileAgent, jobAgent, fitAgent, storyAgent, planAgent, evaluate, interviewerAgent, coachAgent };
