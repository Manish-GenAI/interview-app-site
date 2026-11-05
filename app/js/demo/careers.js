// Demo stand-in for the Jobs backend (backend/app/careers). Same routes, shapes and rules as the installed app,
// running in the browser. Ports the deterministic parts: careers/text.py (skills, titles, seniority, places),
// match.py (gate + explainable score + rubric), the writer's built-in draft and truth.py (rule-based claim check),
// plus the approval gate. No network: searches use the bundled sample openings in careers-data.js.
// Regexes avoid lookbehind so the demo also runs on older Safari.
import { SAMPLE_RESUME, SKILL_VOCAB } from './data.js';
import { db, save, nowIso, newId, rows, DemoError, registerJob, submitJob, JobHandle } from './store.js';
import { runAgent } from './common.js';
import { sentences, bulletLines, lines, escRe } from './text.js';
import * as coach from './coach.js';
import { SAMPLE_BOARDS, SAMPLE_POSTINGS, SUGGESTIONS, DAILY_LIMIT } from './careers-data.js';

const BOARD_KINDS = ['greenhouse', 'lever', 'ashby', 'smartrecruiters'];
const LABELS = { greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', smartrecruiters: 'SmartRecruiters', remotive: 'Remotive', arbeitnow: 'Arbeitnow', manual: 'Added by you' };
const APP_STATUSES = ['preparing', 'needs_review', 'approved', 'filling', 'filled', 'submitted', 'interviewing', 'offer', 'rejected', 'withdrawn', 'failed'];
const DEMO_BOARD_NOTE = 'Demo: only the bundled sample jobs are searched. The installed app reads this board live.';
const FORM_ONLY = new Set(['consent', 'demographic']);

// =================================================================================================
// text.py (subset)
// =================================================================================================
const SKILL_ALIASES = {
  ml: 'Machine Learning', k8s: 'Kubernetes', postgres: 'PostgreSQL', golang: 'Go', llms: 'LLM', 'large language models': 'LLM',
  'large language model': 'LLM', genai: 'Generative AI', 'gen ai': 'Generative AI', nodejs: 'Node.js', node: 'Node.js', reactjs: 'React',
  'react.js': 'React', 'vue.js': 'Vue', 'google cloud': 'GCP', 'amazon web services': 'AWS', 'ci / cd': 'CI/CD', sklearn: 'scikit-learn',
  huggingface: 'Hugging Face', 'natural language processing': 'NLP', 'deep-learning': 'Deep Learning', torch: 'PyTorch', tf: 'TensorFlow',
  js: 'JavaScript', ts: 'TypeScript', gke: 'Kubernetes', eks: 'Kubernetes', aks: 'Kubernetes', ec2: 'AWS', s3: 'AWS', sagemaker: 'AWS',
};
const SKILL_CANON = { Golang: 'Go', LLMs: 'LLM', 'Google Cloud': 'GCP' };
const SKILL_CASE = new Set(['C', 'R', 'Go']);
const SKILL_LOOKUP = new Map();
for (const s of SKILL_VOCAB) if (!SKILL_CASE.has(s)) SKILL_LOOKUP.set(s.toLowerCase(), SKILL_CANON[s] || s);
for (const [alias, s] of Object.entries(SKILL_ALIASES)) if (!SKILL_LOOKUP.has(alias)) SKILL_LOOKUP.set(alias, s);
const AMBIGUOUS = new Set(['tf', 'js', 'ts', 'node', 'ml', 's3', 'ec2']);
const SKILL_RE = new RegExp(`(^|[^A-Za-z0-9+#])(${[...SKILL_LOOKUP.keys()].sort((a, b) => b.length - a.length).map(escRe).join('|')})(?![A-Za-z0-9+#])`, 'gi');
const GO_RE = /\bGo(?:lang)?\b(?! to| ahead| back| through| over| live| beyond| above| deep| further)/;

export function extractSkills(text) {
  const found = new Set();
  const t = String(text || '');
  if (!t) return found;
  SKILL_RE.lastIndex = 0;
  let m;
  while ((m = SKILL_RE.exec(t))) {
    const raw = m[2];
    const key = raw.toLowerCase();
    const shouty = raw === raw.toUpperCase() && /[A-Z]/.test(raw);
    if (!AMBIGUOUS.has(key) || shouty || raw === 'Node') {
      const skill = SKILL_LOOKUP.get(key);
      if (skill) found.add(skill);
    }
    SKILL_RE.lastIndex = m.index + m[1].length + raw.length; // the next skill may start right after this one
  }
  if (GO_RE.test(t)) found.add('Go');
  return found;
}

export const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim();
const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

const TITLE_ABBREV = {
  sr: 'senior', snr: 'senior', jr: 'junior', swe: 'software engineer', sde: 'software engineer', ml: 'machine learning',
  mle: 'machine learning engineer', ai: 'ai', eng: 'engineer', dev: 'developer', mgr: 'manager', pm: 'product manager',
  tpm: 'technical program manager', fe: 'frontend', be: 'backend', sre: 'site reliability engineer', sdet: 'test engineer', nlp: 'nlp',
  llm: 'llm', genai: 'generative ai', ds: 'data scientist', de: 'data engineer', qa: 'qa', ux: 'ux', ui: 'ui', vp: 'vice president',
  cto: 'chief technology officer', em: 'engineering manager', ic: '', ii: '', iii: '', iv: '', i: '', 1: '', 2: '', 3: '',
};
const TITLE_PHRASES = [['front end', 'frontend'], ['front-end', 'frontend'], ['back end', 'backend'], ['back-end', 'backend'],
  ['full-stack', 'fullstack'], ['full stack', 'fullstack'], ['dev ops', 'devops'], ['site reliability', 'sre'],
  ['machine-learning', 'machine learning'], ['artificial intelligence', 'ai'], ['deep learning', 'machine learning'],
  ['member of technical staff', 'engineer'], ['software development engineer', 'software engineer'],
  ['applied scientist', 'applied scientist machine learning'], ['research engineer', 'research engineer'], ['data science', 'data scientist']];
const SENIORITY_WORDS = {
  intern: 'intern', internship: 'intern', trainee: 'intern', apprentice: 'intern', graduate: 'junior', junior: 'junior', entry: 'junior',
  associate: 'junior', 'new grad': 'junior', mid: 'mid', intermediate: 'mid', senior: 'senior', lead: 'senior', staff: 'staff',
  principal: 'principal', distinguished: 'principal', fellow: 'principal', manager: 'manager', head: 'director', director: 'director',
  'vice president': 'executive', chief: 'executive', president: 'executive',
};
const SENIORITY_RANK = { intern: 0, junior: 1, mid: 2, senior: 3, staff: 4, principal: 5, manager: 4, director: 6, executive: 7 };
const ROLE_HEADS = {
  engineer: 'engineering', developer: 'engineering', programmer: 'engineering', architect: 'engineering', sre: 'engineering',
  scientist: 'science', researcher: 'science', analyst: 'analysis', manager: 'management', director: 'management', head: 'management',
  designer: 'design', recruiter: 'people', consultant: 'consulting', specialist: 'specialist', representative: 'sales', executive: 'sales',
  writer: 'writing', accountant: 'finance', counsel: 'legal', attorney: 'legal', lawyer: 'legal',
};
const FILLER_TITLE = new Set(['of', 'and', 'the', 'for', 'a', 'an', 'to', 'in', 'at', 'with', '&', '-', '/', 'team', 'remote', 'hybrid',
  'contract', 'temporary', 'fulltime', 'full', 'time', 'part', 'f', 'm', 'd', 'w', 'x', 'h', 'new', 'role', 'position', 'opening']);
const ROLE_LEVEL = new Set(['manager', 'director', 'head', 'chief', 'president', 'vice president']);
const LEVEL_WORDS = new Set([...Object.keys(SENIORITY_WORDS).filter((w) => !ROLE_LEVEL.has(w)), 'lead', 'levels', 'level', 'l3', 'l4',
  'l5', 'l6', 'l7', 'e3', 'e4', 'e5', 'e6', 'e7', 'ic3', 'ic4', 'ic5', 'ic6']);

const tokenCache = new Map();
export function titleTokens(title) {
  const k = String(title || '');
  if (tokenCache.has(k)) return tokenCache.get(k);
  let low = ` ${k.toLowerCase()} `.replace(/\([^)]*\)/g, ' ');
  for (const [phrase, repl] of TITLE_PHRASES) low = low.split(phrase).join(repl);
  const toks = [];
  for (const tok of low.match(/[a-z0-9+#]+/g) || []) toks.push(...String(has(TITLE_ABBREV, tok) ? TITLE_ABBREV[tok] : tok).split(/\s+/));
  const out = new Set(toks.filter((t) => t && !FILLER_TITLE.has(t) && !LEVEL_WORDS.has(t)));
  if (tokenCache.size > 5000) tokenCache.clear();
  tokenCache.set(k, out);
  return out;
}
function roleHead(tokens) {
  for (const [word, family] of Object.entries(ROLE_HEADS)) if (tokens.has(word)) return family;
  return null;
}
export function titleSimilarity(a, b) {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (!ta.size || !tb.size) return 0;
  const weight = (toks) => [...toks].reduce((s, t) => s + (has(ROLE_HEADS, t) ? 2 : 1), 0);
  const inter = [...ta].filter((t) => tb.has(t));
  const wa = weight(ta);
  const wb = weight(tb);
  let score = weight(inter) / Math.max(1, Math.min(wa, wb) * 0.5 + Math.max(wa, wb) * 0.5);
  const ha = roleHead(ta);
  const hb = roleHead(tb);
  if (ha && hb && ha !== hb) score = Math.min(score, 0.35);
  return Math.round(Math.min(1, score) * 1000) / 1000;
}
export function seniorityOf(title) {
  let low = ` ${String(title || '').toLowerCase()} `.split('sr.').join('senior').split('jr.').join('junior');
  low = low.replace(/\bsr\b/g, 'senior').replace(/\bjr\b/g, 'junior');
  if (/\b(?:vp|vice president|chief|cto|ceo|cfo|coo)\b/.test(low)) return 'executive';
  let best = null;
  for (const [word, level] of Object.entries(SENIORITY_WORDS)) {
    if (new RegExp(`\\b${escRe(word)}\\b`).test(low) && (best === null || SENIORITY_RANK[level] > SENIORITY_RANK[best])) best = level;
  }
  if (best === null && /\b(?:iii|iv|l5|l6|e5|e6|ic5|ic6)\b/.test(low)) best = 'senior';
  if (best === null && /\b(?:i|l3|e3|ic3)\b/.test(low)) best = 'junior';
  return best;
}
function seniorityForYears(years) {
  if (years === null || years === undefined) return null;
  if (years < 1) return 'junior';
  if (years < 4) return 'mid';
  if (years < 8) return 'senior';
  if (years < 12) return 'staff';
  return 'principal';
}
const YEARS_RE = /(\d{1,2})\s*(?:\+|plus)?\s*(?:(?:-|–|to)\s*(\d{1,2})\s*)?(?:\+\s*)?years?(?:'|’)?\s+(?:of\s+)?(?:[a-z/-]+\s+){0,6}?(?:experience|exp\b|industry|professional|work)/gi;
export function requiredYears(text) {
  const found = [];
  for (const m of String(text || '').matchAll(YEARS_RE)) {
    const n = parseInt(m[1], 10);
    if (n > 0 && n <= 25) found.push(n);
  }
  return found.length ? Math.min(...found) : null;
}
const RESUME_RANGE = /\b((?:19|20)\d\d)\s*(?:-|–|—|to)\s*((?:19|20)\d\d|present|current|now|today)\b/gi;
export function yearsFromResume(text, nowYear = new Date().getFullYear()) {
  const spans = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/\b(?:b\.?s|b\.?tech|m\.?s|m\.?tech|bachelor|master|phd|university|college|school)\b/i.test(line)) continue;
    for (const m of line.matchAll(RESUME_RANGE)) {
      const start = parseInt(m[1], 10);
      const end = /^\d/.test(m[2]) ? parseInt(m[2], 10) : nowYear;
      if (start >= 1970 && start <= end && end <= nowYear + 1) spans.push([start, end]);
    }
  }
  if (!spans.length) return null;
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let total = 0;
  let [cs, ce] = spans[0];
  for (const [s, e] of spans.slice(1)) {
    if (s <= ce) ce = Math.max(ce, e);
    else { total += ce - cs; cs = s; ce = e; }
  }
  total += ce - cs;
  return Math.max(0, Math.min(total, 50));
}

const COUNTRY_WORDS = {
  IN: ['india', 'bengaluru', 'bangalore', 'mumbai', 'pune', 'hyderabad', 'chennai', 'new delhi', 'delhi', 'ncr', 'gurgaon', 'gurugram',
    'noida', 'kolkata', 'ahmedabad', 'jaipur', 'kochi', 'karnataka', 'maharashtra', 'telangana', 'tamil nadu', 'haryana', 'kerala'],
  US: ['united states', 'usa', 'u.s.', 'america', 'san francisco', 'new york', 'nyc', 'seattle', 'austin', 'boston', 'chicago',
    'los angeles', 'bay area', 'california', 'texas'],
  GB: ['united kingdom', 'uk', 'u.k.', 'england', 'scotland', 'london', 'manchester', 'edinburgh'],
  CA: ['canada', 'toronto', 'vancouver', 'montreal'],
  DE: ['germany', 'deutschland', 'berlin', 'munich', 'münchen', 'hamburg', 'frankfurt', 'cologne', 'stuttgart', 'saarbrücken'],
  IE: ['ireland', 'dublin'], NL: ['netherlands', 'amsterdam', 'rotterdam'], FR: ['france', 'paris'], ES: ['spain', 'madrid', 'barcelona'],
  PL: ['poland', 'warsaw', 'krakow'], PT: ['portugal', 'lisbon'], IT: ['italy', 'milan'], SE: ['sweden', 'stockholm'],
  DK: ['denmark', 'copenhagen'], CH: ['switzerland', 'zurich', 'zürich'], AT: ['austria', 'vienna'], BE: ['belgium', 'brussels'],
  SG: ['singapore'], AU: ['australia', 'sydney', 'melbourne'], JP: ['japan', 'tokyo'], AE: ['uae', 'united arab emirates', 'dubai'],
};
export const REGIONS = {
  europe: ['GB', 'DE', 'IE', 'NL', 'FR', 'ES', 'PL', 'PT', 'IT', 'SE', 'DK', 'CH', 'AT', 'BE'],
  eu: ['DE', 'IE', 'NL', 'FR', 'ES', 'PL', 'PT', 'IT', 'SE', 'DK', 'AT', 'BE'],
  emea: ['GB', 'DE', 'IE', 'NL', 'FR', 'ES', 'PL', 'PT', 'IT', 'SE', 'DK', 'CH', 'AT', 'BE', 'AE'],
  'north america': ['US', 'CA'], americas: ['US', 'CA'],
  apac: ['IN', 'SG', 'AU', 'JP'], asia: ['IN', 'SG', 'JP', 'AE'],
};
const COUNTRY_NAMES = { IN: 'India', US: 'United States', GB: 'United Kingdom', CA: 'Canada', DE: 'Germany', IE: 'Ireland', NL: 'Netherlands',
  FR: 'France', ES: 'Spain', PL: 'Poland', SG: 'Singapore', AU: 'Australia', AE: 'United Arab Emirates' };
const WORLDWIDE = ['worldwide', 'anywhere', 'global', 'globally', 'any location', 'remote - anywhere', 'international'];
const COUNTRY_RES = Object.entries(COUNTRY_WORDS).flatMap(([code, ws]) => [...ws].sort((a, b) => b.length - a.length)
  .map((w) => [code, new RegExp(`(?:^|[^a-z])${escRe(w)}(?![a-z])`)]));

export function countriesIn(location) {
  const found = new Set();
  if (!location) return found;
  if (/(?:^|[^A-Za-z])US(?![A-Za-z])/.test(location)) found.add('US');
  const low = String(location).toLowerCase();
  for (const [code, rx] of COUNTRY_RES) if (!found.has(code) && rx.test(low)) found.add(code);
  return found;
}
function regionsIn(location) {
  const low = String(location || '').toLowerCase();
  return Object.keys(REGIONS).filter((name) => new RegExp(`(?:^|[^a-z])${escRe(name)}(?![a-z])`).test(low));
}
const isWorldwide = (loc) => WORLDWIDE.some((w) => String(loc || '').toLowerCase().includes(w));
function toCountryCodes(values) {
  const out = new Set();
  for (const value of values || []) {
    const v = String(value || '').trim();
    if (v.length === 2 && /^[A-Za-z]{2}$/.test(v)) { out.add(v.toUpperCase()); continue; }
    countriesIn(v).forEach((c) => out.add(c));
  }
  return out;
}
function cityTokens(location) {
  const low = String(location || '').toLowerCase().replace(/bangalore/g, 'bengaluru').replace(/gurgaon/g, 'gurugram');
  return new Set(low.split(/[,;/|()\-–]+/).map((p) => p.trim()).filter((p) => p && !['remote', 'hybrid', 'on-site', 'onsite'].includes(p)));
}

const STOP = new Set(`the and for with from that this have has had was were are you your our their they them his her its
into onto over under about than then also just very more most less such each other some any all can could would should
will shall may might must not but nor yet both either neither who whom whose which what when where why how`.split(/\s+/));
const contentWords = (text) => (String(text || '').toLowerCase().match(/[a-z0-9+#]+/g) || []).filter((w) => w.length > 2 && !STOP.has(w));
export function evidenceIn(evidence, corpus, threshold = 0.8) {
  const ev = contentWords(evidence);
  if (!ev.length) return false;
  const tokens = (s) => (String(s || '').toLowerCase().match(/[a-z0-9+#]+/g) || []).join(' ');
  if (` ${tokens(corpus)} `.includes(` ${tokens(evidence)} `)) return true;
  const words = new Set(contentWords(corpus));
  return ev.filter((w) => words.has(w)).length / ev.length >= threshold;
}
function snippet(text, limit = 280) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  const head = flat.slice(0, limit - 1);
  return `${head.slice(0, Math.max(0, head.lastIndexOf(' ')))}…`;
}

// =================================================================================================
// SearchPlannerAgent (built-in rules) and match.py
// =================================================================================================
const FAMILY_VARIANTS = {
  'machine learning': ['Machine Learning Engineer', 'ML Engineer', 'AI Engineer', 'Applied Scientist', 'MLOps Engineer'],
  'data scien': ['Data Scientist', 'Machine Learning Scientist', 'Applied Scientist', 'Data Analyst'],
  'data engineer': ['Data Engineer', 'Analytics Engineer', 'Big Data Engineer', 'Data Platform Engineer'],
  backend: ['Backend Engineer', 'Software Engineer', 'Platform Engineer', 'API Engineer'],
  frontend: ['Frontend Engineer', 'Software Engineer', 'UI Engineer', 'Web Developer'],
  full: ['Full Stack Engineer', 'Software Engineer', 'Web Developer'],
  software: ['Software Engineer', 'Software Developer', 'Backend Engineer'],
  devops: ['DevOps Engineer', 'Site Reliability Engineer', 'Platform Engineer', 'Cloud Engineer'],
  'product manager': ['Product Manager', 'Technical Product Manager', 'Product Owner'],
  analyst: ['Data Analyst', 'Business Analyst', 'Product Analyst'],
  designer: ['Product Designer', 'UX Designer', 'UI Designer'],
};
function dedupe(items, limit) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const k = String(item || '').trim().toLowerCase();
    if (k && !seen.has(k)) { seen.add(k); out.push(String(item).trim()); }
  }
  return out.slice(0, limit);
}
function planSearch(profile, prefs) {
  const cv = profile.resume_text || '';
  const titles = [...(prefs.titles || [])];
  if (profile.current_title) titles.push(profile.current_title);
  for (const ln of lines(cv).slice(0, 40)) {
    if (/\b(engineer|developer|scientist|analyst|manager|designer|architect|consultant|lead)\b/i.test(ln) && ln.length <= 80 && !ln.startsWith('-')) {
      titles.push(ln.split(/\s+(?:at|@|,|\||–|-)\s+|\s*\(/)[0].trim());
      if (titles.length >= 4) break;
    }
  }
  const joined = titles.join(' ').toLowerCase();
  const low = `${joined} ${cv.slice(0, 3000)}`.toLowerCase();
  for (const [key, variants] of Object.entries(FAMILY_VARIANTS)) {
    if (joined.includes(key) || (!titles.length && low.includes(key))) titles.push(...variants);
  }
  const finalTitles = dedupe((titles.length ? titles : ['Software Engineer'])
    .map((t) => t.replace(/^(?:senior|sr\.?|junior|jr\.?|lead|staff|principal)\s+/i, '') || t), 10);
  const skills = extractSkills(cv);
  const lowCv = cv.toLowerCase();
  const ranked = [...skills].map((s) => [s, lowCv.split(s.toLowerCase()).length - 1 || 1]).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([s]) => s);
  let seniority = seniorityForYears(profile.years_experience ?? yearsFromResume(cv)) || 'mid';
  if (profile.current_title && seniorityOf(profile.current_title)) seniority = seniorityOf(profile.current_title);
  const family = finalTitles.length ? roleHead(titleTokens(finalTitles[0])) : null;
  const exclude = { engineering: ['sales', 'recruiter', 'account executive'], science: ['sales', 'recruiter'] }[family] || [];
  return {
    summary: `Roles like ${finalTitles.slice(0, 3).join(', ')}, using ${ranked.slice(0, 4).join(', ') || 'your experience'}.`,
    titles: finalTitles, skills: ranked, keywords: [...(prefs.keywords || [])], exclude: [...(prefs.exclude_keywords || []), ...exclude], seniority,
  };
}

const WEIGHTS = { title: 35, skills: 30, location: 15, seniority: 10, keywords: 5, recency: 5 };
const APPLY_AT = 70;
const MAYBE_AT = 50;
const NO_SPONSOR_RE = /(?:unable|not able|cannot|can't|can not|won't|will not|do not|don't|does not|doesn't)\s+(?:to\s+)?(?:offer\s+|provide\s+)?(?:visa\s+)?sponsor|no (?:visa )?sponsorship|without (?:the need for )?(?:visa )?sponsorship|sponsorship (?:is )?not (?:available|offered|provided)/i;
const CLEARANCE_RE = /security clearance|ts\/sci|top secret|must be a u\.?s\.? citizen|us citizenship (?:is )?required|itar|u\.?s\.? person/i;

function buildContext(profile, prefs, plan) {
  let titles = (prefs.titles || []).filter((t) => t.trim());
  if (!titles.length) titles = [...(plan.titles || [])];
  if (!titles.length && profile.current_title) titles = [profile.current_title];
  const resume = profile.resume_text || '';
  const cvSkills = extractSkills(`${resume}\n${profile.extra_facts || ''}`);
  let core = extractSkills((plan.skills || []).join(', '));
  if (!core.size) core = new Set(cvSkills);
  let years = profile.years_experience;
  if (years === null || years === undefined) years = yearsFromResume(resume);
  const senPref = (prefs.seniority || []).filter(Boolean);
  const seniority = senPref.length ? senPref[0] : (plan.seniority || seniorityForYears(years));
  const locations = (prefs.locations || []).length ? prefs.locations : [profile.location || ''];
  let home = toCountryCodes([...(profile.work_authorized_countries || []), profile.country || '']);
  if (!home.size) home = toCountryCodes(locations);
  const cities = new Set();
  locations.forEach((l) => cityTokens(l).forEach((c) => cities.add(c)));
  const lowList = (arr) => arr.filter((k) => String(k).trim()).map((k) => String(k).toLowerCase()).slice(0, 20);
  return {
    titles, cvSkills, coreSkills: core, years, seniority, home, cities, now: Date.now(),
    keywords: lowList([...(prefs.keywords || []), ...(plan.keywords || [])]),
    exclude: lowList([...(prefs.exclude_keywords || []), ...(plan.exclude || [])]),
    remotePref: prefs.remote || 'onsite_ok', needsSponsorship: profile.needs_sponsorship,
  };
}
const wordRe = (w) => new RegExp(`(?:^|[^a-z0-9])${escRe(w)}(?![a-z0-9])`);
const excludedByTitle = (title, ctx) => ctx.exclude.find((w) => wordRe(w).test(` ${title.toLowerCase()} `)) || null;
function bestTitle(title, ctx) {
  let best = 0;
  let which = '';
  for (const target of ctx.titles) {
    const sim = titleSimilarity(title, target);
    if (sim > best) { best = sim; which = target; }
  }
  return [best, which];
}
function gate(p, ctx) {
  const title = p.title || '';
  if (!title || excludedByTitle(title, ctx)) return false;
  if (ctx.remotePref === 'remote_only' && p.remote === false && p.workplace !== 'hybrid') return false;
  if (!ctx.titles.length) return true;
  if (bestTitle(title, ctx)[0] >= 0.3) return true;
  const low = title.toLowerCase();
  return ctx.keywords.some((k) => low.includes(k)) || [...ctx.coreSkills].some((s) => s.length > 2 && low.includes(s.toLowerCase()));
}
const names = (codes) => [...codes].map((c) => COUNTRY_NAMES[c] || c).sort().join(', ');
function locationFit(p, ctx) {
  const loc = p.location || '';
  const countries = countriesIn(loc);
  regionsIn(loc).forEach((r) => REGIONS[r].forEach((c) => countries.add(c)));
  const remote = !!p.remote;
  const hybrid = (p.workplace || '') === 'hybrid';
  const home = ctx.home;
  const overlap = new Set([...countries].filter((c) => home.has(c)));
  if (remote && !hybrid) {
    if (isWorldwide(loc) || !countries.size || !home.size) return [1, 'Remote', null, null];
    if (overlap.size) return [1, `Remote, open to ${names(overlap)}`, null, null];
    const where = loc.replace('Remote', '').replace(/^[\s()\-–,;]+|[\s()\-–,;]+$/g, '') || 'another country';
    return [0.1, null, null, `Remote only for candidates in ${where}`];
  }
  if (ctx.remotePref === 'remote_only') return [0, null, null, 'Not remote'];
  const place = cityTokens(loc);
  if (ctx.cities.size && [...place].some((c) => ctx.cities.has(c))) return [1, `In ${loc}`, null, null];
  if (home.size && overlap.size) return [0.7, `In ${loc}`, ctx.cities.size ? 'Different city from your preferred locations' : null, null];
  if (!countries.size) return [0.5, null, null, null];
  if (!home.size) return [0.6, null, null, null];
  const where = names(countries).slice(0, 60);
  if (ctx.needsSponsorship) return [0.05, null, null, `Based in ${where} - you'd need a work visa`];
  return [ctx.remotePref === 'any' ? 0.25 : 0.1, null, `Based in ${where} (outside your work countries)`, null];
}
function seniorityFit(p, ctx) {
  const level = seniorityOf(p.title || '');
  const req = requiredYears(String(p.description_text || '').slice(0, 6000));
  let gap = null;
  let score = 0.7;
  if (level && ctx.seniority) {
    const diff = (SENIORITY_RANK[level] ?? 2) - (SENIORITY_RANK[ctx.seniority] ?? 2);
    score = { 0: 1, 1: 0.65, '-1': 0.75 }[diff] ?? (diff > 1 ? 0 : 0.35);
    if (diff > 1) gap = `Asks for a ${level} level; your experience reads as ${ctx.seniority}`;
  }
  if (req !== null && ctx.years !== null && ctx.years !== undefined) {
    if (ctx.years + 0.5 >= req) score = score >= 0.35 ? Math.max(score, 0.8) : score;
    else {
      score = Math.min(score, Math.max(0, 1 - 0.3 * (req - ctx.years)));
      gap = gap || `Asks for ${req}+ years; you have about ${ctx.years}`;
    }
  }
  return [score, gap];
}
function recency(p, now) {
  if (!p.posted_at) return [0.4, null];
  const t = Date.parse(p.posted_at);
  if (Number.isNaN(t)) return [0.4, null];
  const days = Math.max(0, Math.floor((now - t) / 86400000));
  return [days <= 7 ? 1 : days <= 30 ? 0.7 : days <= 90 ? 0.35 : 0, days];
}
function recommend(score, flags) {
  if (flags.length && score < APPLY_AT + 10) return score >= MAYBE_AT + 10 ? 'maybe' : 'skip';
  return score >= APPLY_AT ? 'apply' : score >= MAYBE_AT ? 'maybe' : 'skip';
}
function scorePosting(p, ctx) {
  const title = p.title || '';
  const desc = p.description_text || '';
  const reasons = []; const gaps = []; const red = []; const comp = {};
  const excluded = excludedByTitle(title, ctx);
  if (excluded) {
    return { score: 0, components: {}, reasons: [], gaps: [], red_flags: [`Title contains '${excluded}'`], recommendation: 'skip', skills_matched: [], skills_missing: [] };
  }
  const [sim, which] = ctx.titles.length ? bestTitle(title, ctx) : [0.6, ''];
  comp.title = WEIGHTS.title * sim;
  if (sim >= 0.6 && which) reasons.push(`Title fits your target '${which}'`);
  const postingSkills = extractSkills(`${title}\n${desc}`);
  const matched = [...postingSkills].filter((s) => ctx.cvSkills.has(s)).sort();
  const missing = [...postingSkills].filter((s) => !ctx.cvSkills.has(s)).sort();
  if (postingSkills.size) {
    const coverage = matched.length / postingSkills.size;
    const depth = Math.min(1, matched.length / 6);
    const coreBonus = [...postingSkills].some((s) => ctx.coreSkills.has(s)) ? 0.1 : 0;
    comp.skills = WEIGHTS.skills * Math.min(1, 0.55 * coverage + 0.35 * depth + coreBonus);
    if (matched.length) reasons.push(`Uses ${matched.length} of the ${postingSkills.size} skills it lists from your CV: ${matched.slice(0, 5).join(', ')}`);
    if (missing.length) gaps.push(`Not in your CV: ${missing.slice(0, 5).join(', ')}`);
  } else comp.skills = WEIGHTS.skills * 0.4;
  if (ctx.keywords.length) {
    const low = `${title}\n${desc}`.toLowerCase();
    const hits = ctx.keywords.filter((k) => low.includes(k));
    comp.keywords = WEIGHTS.keywords * Math.min(1, hits.length / Math.max(1, Math.min(3, ctx.keywords.length)));
  } else comp.keywords = WEIGHTS.keywords * 0.5;
  const [locScore, locReason, locGap, locFlag] = locationFit(p, ctx);
  comp.location = WEIGHTS.location * locScore;
  if (locReason) reasons.push(locReason);
  if (locGap) gaps.push(locGap);
  if (locFlag) red.push(locFlag);
  const foreign = ctx.home.size > 0 && ![...countriesIn(p.location || '')].some((c) => ctx.home.has(c));
  if (ctx.needsSponsorship && foreign && NO_SPONSOR_RE.test(desc)) red.push("Says it can't sponsor visas");
  if (CLEARANCE_RE.test(desc) && !ctx.home.has('US')) red.push('Needs a security clearance or US citizenship');
  const [senScore, senGap] = seniorityFit(p, ctx);
  comp.seniority = WEIGHTS.seniority * senScore;
  if (senGap) gaps.push(senGap);
  const [recScore, days] = recency(p, ctx.now);
  comp.recency = WEIGHTS.recency * recScore;
  if (days !== null && days <= 7) reasons.push(days > 1 ? 'Posted this week' : 'Posted in the last day');
  const lowDesc = desc.toLowerCase();
  const softHits = ctx.exclude.filter((w) => wordRe(w).test(lowDesc));
  const penalty = Math.min(20, 6 * softHits.length);
  if (softHits.length) gaps.push(`Mentions ${softHits.slice(0, 3).join(', ')}`);
  let total = Object.values(comp).reduce((a, b) => a + b, 0) - penalty;
  if (red.length) total -= 10 * red.length;
  const score = Math.round(Math.max(0, Math.min(100, total)));
  return {
    score, components: Object.fromEntries(Object.entries(comp).map(([k, v]) => [k, Math.round(v * 10) / 10])),
    reasons: reasons.slice(0, 4), gaps: gaps.slice(0, 4), red_flags: red.slice(0, 3), recommendation: recommend(score, red),
    skills_matched: matched.slice(0, 12), skills_missing: missing.slice(0, 12),
  };
}

// The rerank step without a model: the deterministic requirement rubric (agents.heuristic_rubric).
const REQ_SPLIT = /^\s*(?:what you(?:'ll)? (?:need|bring)|requirements|qualifications|must[- ]haves?|you (?:have|bring|are)|about you|minimum qualifications|basic qualifications|who you are)\b/im;
const NICE_SPLIT = /^\s*(?:nice[- ]to[- ]haves?|preferred|bonus|plus|it'?s a plus|ideally|preferred qualifications)\b/im;
function heuristicRubric(desc, cv, cvSkills) {
  const reqM = REQ_SPLIT.exec(desc);
  const niceM = NICE_SPLIT.exec(desc);
  const reqText = reqM ? desc.slice(reqM.index, niceM && niceM.index > reqM.index ? niceM.index : undefined) : desc;
  const niceSkills = extractSkills(niceM ? desc.slice(niceM.index) : '');
  let must = [...extractSkills(reqText)].sort().filter((s) => !niceSkills.has(s)).slice(0, 6);
  if (!must.length) must = [...extractSkills(desc)].sort().slice(0, 5);
  const nice = [...niceSkills].sort().filter((s) => !must.includes(s)).slice(0, 4);
  const cvLines = lines(cv).filter((ln) => ln.length > 3);
  const item = (skill) => {
    if (!cvSkills.has(skill)) return { requirement: skill, status: 'missing', evidence: '', note: '' };
    const re = new RegExp(`(?:^|[^A-Za-z])${escRe(skill)}(?![A-Za-z])`, 'i');
    const line = cvLines.find((ln) => re.test(ln)) || '';
    return { requirement: skill, status: 'met', evidence: line.replace(/^[-•*\s]+/, '').split(/\s+/).filter(Boolean).slice(0, 15).join(' '), note: '' };
  };
  const mustItems = must.map(item);
  const req = requiredYears(desc);
  if (req) mustItems.push({ requirement: `${req}+ years of experience`, status: 'partial', evidence: '', note: '' });
  return {
    must_haves: mustItems.length ? mustItems : [{ requirement: 'Role fit', status: 'partial', evidence: '', note: '' }],
    nice_to_haves: nice.map(item),
  };
}

// =================================================================================================
// Store: profile, preferences, sources, postings, applications
// =================================================================================================
function defaultProfile() {
  return {
    full_name: '', first_name: '', last_name: '', email: '', phone: '', location: '', country: '', linkedin_url: '', github_url: '',
    portfolio_url: '', current_company: '', current_title: '', years_experience: null, notice_period: '', earliest_start: '',
    work_authorized_countries: [], needs_sponsorship: null, salary_expectation: '', willing_to_relocate: null, extra_facts: '',
    resume_text: '', resume_file: null, saved_answers: {}, updated_at: null,
  };
}
function defaultPrefs() {
  return {
    titles: [], keywords: [], exclude_keywords: [], locations: [], remote: 'onsite_ok', seniority: [], min_score: 45, max_results: 150,
    aggregators: { remotive: true, arbeitnow: false },
  };
}
export function ensureCareersSeeded() {
  if (db.careers.seeded) return;
  const now = nowIso();
  db.careers = {
    seeded: now,
    last_search_at: null,
    profile: {
      ...defaultProfile(), full_name: 'Jane Doe', first_name: 'Jane', last_name: 'Doe', email: 'jane.doe@example.com', phone: '+91 00000 00000', location: 'Bengaluru',
      country: 'India', current_company: 'Acme Corp', current_title: 'Senior Software Engineer', notice_period: '30 days',
      work_authorized_countries: ['India'], resume_text: SAMPLE_RESUME,
      resume_file: { name: 'jane-doe-cv.txt', size: SAMPLE_RESUME.length, uploaded_at: now }, updated_at: now,
    },
    prefs: defaultPrefs(),
  };
  for (const b of SAMPLE_BOARDS) {
    const id = newId('src');
    db.cr_sources[id] = { id, ...b, enabled: true, last_fetched: null, last_error: null, job_count: null, sample: true, created_at: now };
  }
  save('careers', 'cr_sources');
}

const profile = () => ({ ...defaultProfile(), ...(db.careers.profile || {}) });
const prefs = () => ({ ...defaultPrefs(), ...(db.careers.prefs || {}), aggregators: { ...defaultPrefs().aggregators, ...((db.careers.prefs || {}).aggregators || {}) } });
function profileView() {
  const { sensitive_answers: _ignored, ...p } = profile();
  return p;
}

const STR_FIELDS = ['full_name', 'first_name', 'last_name', 'email', 'phone', 'location', 'country', 'linkedin_url', 'github_url', 'portfolio_url',
  'current_company', 'current_title', 'notice_period', 'earliest_start', 'salary_expectation', 'extra_facts', 'resume_text'];
function putProfile(body) {
  const p = profile();
  for (const k of STR_FIELDS) if (k in body) p[k] = String(body[k] ?? '').slice(0, k === 'resume_text' ? 60000 : 4000);
  if ('years_experience' in body) {
    const v = body.years_experience;
    if (v === null || v === '') p.years_experience = null;
    else if (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 60) p.years_experience = Number(v);
    else throw new DemoError('years_experience: Input should be a valid number', 422);
  }
  for (const k of ['needs_sponsorship', 'willing_to_relocate']) {
    if (k in body) {
      if (body[k] !== null && typeof body[k] !== 'boolean') throw new DemoError(`${k}: Input should be a valid boolean`, 422);
      p[k] = body[k];
    }
  }
  if ('work_authorized_countries' in body) p.work_authorized_countries = (body.work_authorized_countries || []).map((x) => String(x).trim()).filter(Boolean);
  if ('saved_answers' in body) {
    const sa = body.saved_answers || {};
    if (typeof sa !== 'object' || Array.isArray(sa)) throw new DemoError('saved_answers: Input should be a valid dictionary', 422);
    p.saved_answers = Object.fromEntries(Object.entries(sa).map(([q, a]) => [String(q).trim(), String(a ?? '').trim()]).filter(([q, a]) => q && a));
  }
  p.updated_at = nowIso();
  db.careers.profile = p;
  save('careers');
  return profileView();
}

/** Fill only empty contact fields from the CV text (never overwrites what the user typed). */
function fillFromCv(p, text) {
  const first = lines(text)[0] || '';
  if (!p.full_name && /^[A-Z][a-zA-Z'.-]+(?:\s+[A-Z][a-zA-Z'.-]+){1,3}$/.test(first.trim())) {
    p.full_name = first.trim();
    const parts = p.full_name.split(/\s+/);
    if (!p.first_name) p.first_name = parts[0];
    if (!p.last_name) p.last_name = parts.slice(1).join(' ');
  }
  const email = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  if (!p.email && email) p.email = email[0];
  const linkedin = text.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[\w-]+\/?/i);
  if (!p.linkedin_url && linkedin) p.linkedin_url = linkedin[0].startsWith('http') ? linkedin[0] : `https://${linkedin[0]}`;
  const github = text.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[\w-]+\/?/i);
  if (!p.github_url && github) p.github_url = github[0].startsWith('http') ? github[0] : `https://${github[0]}`;
}
async function uploadResume(form) {
  const file = form && form.get('file');
  if (!file) throw new DemoError('file: Field required', 422);
  const name = String(file.name || '').toLowerCase();
  if (/\.(pdf|docx)$/.test(name)) throw new DemoError('The demo can only read .txt and .md files. The installed app reads PDF and DOCX too. You can also paste the text below.', 400);
  if (!/\.(txt|md|markdown|text)$/.test(name)) throw new DemoError('Unsupported file type. Use .txt or .md in the demo, or paste the text.', 400);
  const text = (await file.text()).replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 40) throw new DemoError('That file looks empty. Paste your CV text instead.', 400);
  const p = profile();
  p.resume_text = text.slice(0, 60000);
  p.resume_file = { name: file.name, size: file.size || text.length, uploaded_at: nowIso() };
  fillFromCv(p, text);
  p.updated_at = nowIso();
  db.careers.profile = p;
  save('careers');
  return profileView();
}
function importTarget(targetId) {
  const t = db.targets[targetId];
  if (!t) throw new DemoError('Target not found', 404);
  const p = profile();
  p.resume_text = t.resume_text || '';
  fillFromCv(p, p.resume_text);
  p.updated_at = nowIso();
  db.careers.profile = p;
  save('careers');
  return profileView();
}

function putPrefs(body) {
  const p = prefs();
  const list = (k) => { if (k in body) p[k] = (body[k] || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 30); };
  ['titles', 'keywords', 'exclude_keywords', 'locations', 'seniority'].forEach(list);
  if ('remote' in body) {
    if (!['any', 'remote_only', 'onsite_ok'].includes(body.remote)) throw new DemoError("remote: Input should be 'any', 'remote_only' or 'onsite_ok'", 422);
    p.remote = body.remote;
  }
  if ('min_score' in body) {
    const n = Number(body.min_score);
    if (!Number.isInteger(n) || n < 0 || n > 100) throw new DemoError('min_score: Input should be between 0 and 100', 422);
    p.min_score = n;
  }
  if ('max_results' in body) {
    const n = Number(body.max_results);
    if (!Number.isInteger(n) || n < 10 || n > 500) throw new DemoError('max_results: Input should be between 10 and 500', 422);
    p.max_results = n;
  }
  if (body.aggregators && typeof body.aggregators === 'object') {
    for (const k of ['remotive', 'arbeitnow']) if (k in body.aggregators) p.aggregators[k] = !!body.aggregators[k];
  }
  db.careers.prefs = p;
  save('careers');
  return p;
}

// --- sources ---------------------------------------------------------------------------------------
const sourceKey = (kind, token) => `${kind}:${String(token).toLowerCase()}`;
function sourceView(s) {
  const entry = SUGGESTIONS.find((b) => sourceKey(b.kind, b.token) === sourceKey(s.kind, s.token));
  const { sample: _s, created_at: _c, ...out } = s;
  return { ...out, tags: entry ? entry.tags : s.sample ? ['Sample'] : [] };
}
function listSources() {
  return rows('cr_sources')
    .sort((a, b) => (Number(!!b.enabled) - Number(!!a.enabled)) || String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase()))
    .map(sourceView);
}
function addSource(body) {
  const kind = String(body.kind || '').trim().toLowerCase();
  const token = String(body.token || '').trim().replace(/^\/+|\/+$/g, '');
  if (!BOARD_KINDS.includes(kind)) throw new DemoError(`Unknown board type '${kind}'. Use greenhouse, lever, ashby or smartrecruiters.`, 400);
  if (!/^[A-Za-z0-9_.%-]{1,80}$/.test(token)) throw new DemoError("That board name doesn't look right. Paste the company's careers link instead.", 400);
  const exists = rows('cr_sources').find((s) => sourceKey(s.kind, s.token) === sourceKey(kind, token));
  if (exists) {
    exists.enabled = true;
    save('cr_sources');
    return sourceView(exists);
  }
  const sample = SAMPLE_BOARDS.find((b) => sourceKey(b.kind, b.token) === sourceKey(kind, token));
  const id = newId('src');
  const name = String(body.name || '').trim() || (sample && sample.name)
    || (SUGGESTIONS.find((s) => sourceKey(s.kind, s.token) === sourceKey(kind, token)) || {}).name
    || token.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  db.cr_sources[id] = {
    id, kind, token, name, enabled: true, last_fetched: null, last_error: null,
    job_count: sample ? SAMPLE_POSTINGS.filter((p) => p.board === `${kind}:${sample.token}`).length : null, sample: !!sample, created_at: nowIso(),
  };
  save('cr_sources');
  return sourceView(db.cr_sources[id]);
}
function updateSource(id, body) {
  const s = db.cr_sources[id];
  if (!s) throw new DemoError('Source not found', 404);
  if ('enabled' in body) s.enabled = !!body.enabled;
  if ('name' in body && String(body.name || '').trim()) s.name = String(body.name).trim().slice(0, 120);
  save('cr_sources');
  return sourceView(s);
}
function deleteSource(id) {
  if (!db.cr_sources[id]) throw new DemoError('Source not found', 404);
  delete db.cr_sources[id];
  save('cr_sources');
}
function suggestions() {
  const mine = new Set(rows('cr_sources').map((s) => sourceKey(s.kind, s.token)));
  return SUGGESTIONS.map((s) => ({ ...s, added: mine.has(sourceKey(s.kind, s.token)) }));
}
const DETECT = [
  ['greenhouse', /boards-api\.greenhouse\.io\/v1\/boards\/([A-Za-z0-9_-]+)/i],
  ['greenhouse', /(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/(?!embed)([A-Za-z0-9_-]+)/i],
  ['lever', /api\.lever\.co\/v0\/postings\/([A-Za-z0-9_.-]+)/i],
  ['lever', /jobs(?:\.eu)?\.lever\.co\/([A-Za-z0-9_.-]+)/i],
  ['ashby', /api\.ashbyhq\.com\/posting-api\/job-board\/([A-Za-z0-9_.-]+)/i],
  ['ashby', /jobs\.ashbyhq\.com\/([A-Za-z0-9_.%-]+)/i],
  ['smartrecruiters', /api\.smartrecruiters\.com\/v1\/companies\/([A-Za-z0-9_-]+)/i],
  ['smartrecruiters', /(?:jobs|careers)\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/i],
];
function detect(url) {
  const raw = String(url || '').trim();
  let parsed = null;
  try { parsed = new URL(raw.includes('://') ? raw : `https://${raw}`); } catch { /* not a URL */ }
  let found = null;
  if (parsed && parsed.hostname.includes('greenhouse.io') && parsed.pathname.includes('/embed/')) {
    const token = parsed.searchParams.get('for');
    if (token) found = ['greenhouse', token];
  }
  if (!found) {
    for (const [kind, rx] of DETECT) {
      const m = raw.match(rx);
      if (m) { found = [kind, decodeURIComponent(m[1])]; break; }
    }
  }
  if (!found) {
    throw new DemoError("That link isn't a Greenhouse, Lever, Ashby or SmartRecruiters job board. Open one of the company's jobs and copy that link instead.", 400);
  }
  const [kind, token] = found;
  const known = [...SUGGESTIONS, ...SAMPLE_BOARDS].find((s) => sourceKey(s.kind, s.token) === sourceKey(kind, token));
  return { kind, token, name: known ? known.name : token.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) };
}

// --- postings and matches ----------------------------------------------------------------------------
function postingView(p) {
  return {
    id: p.id, source: p.source, source_label: p.source_label, company: p.company, title: p.title, location: p.location, remote: p.remote,
    workplace: p.workplace, department: p.department, employment_type: p.employment_type, posted_at: p.posted_at, url: p.url,
    apply_url: p.apply_url, salary: p.salary, description_snippet: snippet(p.description_text), attribution: p.attribution || null,
  };
}
function appForPosting(postingId) {
  return rows('cr_apps').find((a) => a.posting_id === postingId) || null;
}
function matchView(p) {
  const m = p.match || {};
  const app = appForPosting(p.id);
  return {
    posting: postingView(p), score: m.score ?? 0, det_score: m.det_score ?? 0, llm_score: m.llm_score ?? null,
    recommendation: m.recommendation || 'skip', reasons: m.reasons || [], gaps: m.gaps || [], red_flags: m.red_flags || [],
    application_id: app ? app.id : null, meta: m.meta || {},
  };
}
function applyScore(p, s) {
  p.match = {
    score: s.score, det_score: s.score, llm_score: null, recommendation: s.recommendation, reasons: s.reasons, gaps: s.gaps, red_flags: s.red_flags,
    meta: { components: s.components, skills_matched: s.skills_matched, skills_missing: s.skills_missing, reviewed_by: 'rules', rubric: null, also_in: [] },
  };
  return p;
}
function attachRubric(p, ctx, cvText) {
  p.match.meta.rubric = heuristicRubric(p.description_text || '', cvText, ctx.cvSkills);
  return p;
}
/** Settings → Jobs (saved by the Settings page; defaults until the user changes them). */
function careerSetting(key, fallback) {
  const c = (db.meta.settings && db.meta.settings.careers) || {};
  return c[key] === undefined || c[key] === null ? fallback : c[key];
}
const dailyLimit = () => Math.max(1, Number(careerSetting('daily_application_limit', DAILY_LIMIT)) || DAILY_LIMIT);
const rerankTop = () => Math.max(0, Number(careerSetting('rerank_top', 25)) || 0);
function samplePosting(sp, now) {
  const slug = sp.ref;
  const source = sp.board.includes(':') ? sp.board.split(':')[0] : sp.board;
  return {
    id: `pst_${slug.replace(/[^a-z0-9]/gi, '')}`, ref: sp.ref, board: sp.board, source, source_label: LABELS[source], company: sp.company,
    title: sp.title, location: sp.location, remote: sp.workplace === 'remote', workplace: sp.workplace, department: sp.department,
    employment_type: sp.employment_type, posted_at: nowIso(new Date(now - sp.days * 86400000)),
    url: `https://example.com/sample-jobs/${slug}`, apply_url: `https://example.com/sample-jobs/${slug}/apply`, salary: sp.salary || '',
    description_text: sp.description, questions: sp.questions || null, attribution: sp.attribution || null,
  };
}
function listMatches(q) {
  const pr = prefs();
  const minRaw = q.get('min_score');
  const min = minRaw !== null && minRaw !== '' ? Number(minRaw) : pr.min_score;
  const rec = q.get('recommendation') || '';
  const text = String(q.get('q') || '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(500, parseInt(q.get('limit') || '50', 10) || 50));
  return rows('cr_postings')
    .filter((p) => p.match && !p.dismissed)
    .filter((p) => (p.match.score ?? 0) >= min || p.source === 'manual')
    .filter((p) => !rec || p.match.recommendation === rec)
    .filter((p) => !text || `${p.title} ${p.company} ${p.location} ${p.description_text}`.toLowerCase().includes(text))
    .sort((a, b) => (b.match.score - a.match.score) || String(b.posted_at || '').localeCompare(String(a.posted_at || '')))
    .slice(0, limit)
    .map(matchView);
}
function getPosting(id) {
  const p = db.cr_postings[id];
  if (!p) throw new DemoError('Posting not found', 404);
  return { ...postingView(p), description_text: p.description_text, questions: questionsFor(p) };
}
function addManual(body) {
  const title = String(body.title || '').trim();
  const company = String(body.company || '').trim();
  const desc = String(body.description_text || '').trim();
  if (!title || !company) throw new DemoError('title and company: Field required', 422);
  if (desc.length < 80) throw new DemoError('Paste the full job description (at least a few lines).', 400);
  const id = newId('pst');
  const pr = profile();
  const p = {
    id, ref: null, board: 'manual', source: 'manual', source_label: LABELS.manual, company: company.slice(0, 160), title: title.slice(0, 200),
    location: String(body.location || '').trim(), remote: /\bremote\b/i.test(String(body.location || '')) || null, workplace: '',
    department: '', employment_type: '', posted_at: nowIso(), url: String(body.url || '').trim(),
    apply_url: String(body.apply_url || body.url || '').trim(), salary: '', description_text: desc.slice(0, 12000), questions: null,
    attribution: null, found_at: nowIso(), manual: true,
  };
  const ctx = buildContext(pr, prefs(), planSearch(pr, prefs()));
  db.cr_postings[id] = attachRubric(applyScore(p, scorePosting(p, ctx)), ctx, pr.resume_text || '');
  save('cr_postings');
  return matchView(db.cr_postings[id]);
}
function dismiss(id) {
  const p = db.cr_postings[id];
  if (!p) throw new DemoError('Posting not found', 404);
  p.dismissed = true;
  save('cr_postings');
}

registerJob('cr_search', async (job) => {
  job.plan([
    { key: 'plan', label: 'Plan the search from your CV', agent: 'SearchPlannerAgent' },
    { key: 'fetch', label: 'Fetch open jobs from company boards' },
    { key: 'score', label: 'Score every job against your CV' },
    { key: 'rerank', label: 'AI review of the best matches', agent: 'JobMatchAgent' },
    { key: 'save', label: 'Save your matches' },
  ]);
  const pr = profile();
  const pf = prefs();
  let plan;
  await job.step('plan', 'Plan the search from your CV', 'SearchPlannerAgent', (st) => {
    const res = runAgent('SearchPlannerAgent', () => planSearch(pr, pf));
    plan = res.output;
    JobHandle.record(st, res.meta);
    st.detail = `Looking for ${plan.titles.slice(0, 4).join(', ')}`;
  });
  let fetched = [];
  const now = Date.now();
  await job.step('fetch', 'Fetch open jobs from company boards', null, (st) => {
    const enabled = rows('cr_sources').filter((s) => s.enabled);
    const boards = new Set(enabled.map((s) => `${s.kind}:${s.token}`));
    const agg = pf.aggregators || {};
    fetched = SAMPLE_POSTINGS.filter((sp) => boards.has(sp.board) || (sp.board === 'remotive' && agg.remotive) || (sp.board === 'arbeitnow' && agg.arbeitnow))
      .map((sp) => samplePosting(sp, now));
    const stamp = nowIso();
    for (const s of enabled) {
      const n = SAMPLE_POSTINGS.filter((sp) => sp.board === `${s.kind}:${s.token}`).length;
      Object.assign(s, { last_fetched: stamp, job_count: n, last_error: s.sample ? null : DEMO_BOARD_NOTE });
    }
    save('cr_sources');
    const sites = ['remotive', 'arbeitnow'].filter((k) => agg[k]).map((k) => LABELS[k]);
    st.detail = `${fetched.length} sample openings from ${enabled.length} boards${sites.length ? ` and ${sites.join(', ')}` : ''}`;
  });
  const ctx = buildContext(pr, pf, plan);
  let kept = [];
  let relevant = 0;
  await job.step('score', 'Score every job against your CV', null, (st) => {
    kept = fetched.filter((p) => gate(p, ctx)).map((p) => applyScore(p, scorePosting(p, ctx)));
    relevant = kept.length;
    st.detail = `${kept.length} of ${fetched.length} passed the quick check`;
  });
  let reviewed = 0;
  await job.step('rerank', 'AI review of the best matches', 'JobMatchAgent', (st) => {
    kept.sort((a, b) => b.match.score - a.match.score);
    const res = runAgent('JobMatchAgent', () => kept.slice(0, rerankTop()).map((p) => attachRubric(p, ctx, pr.resume_text || '')));
    reviewed = res.output.length;
    JobHandle.record(st, res.meta);
  });
  let saved = 0;
  await job.step('save', 'Save your matches', null, (st) => {
    const stamp = nowIso();
    kept.sort((a, b) => b.match.score - a.match.score);
    for (const p of kept.slice(0, pf.max_results)) {
      const old = db.cr_postings[p.id];
      db.cr_postings[p.id] = { ...p, dismissed: old ? !!old.dismissed : false, found_at: old ? old.found_at : stamp, posted_at: old ? old.posted_at : p.posted_at };
      saved += 1;
    }
    const summary = {
      at: stamp, fetched: fetched.length, relevant, saved, reviewed, errors: [], titles: plan.titles.slice(0, 6),
      apply: kept.slice(0, pf.max_results).filter((p) => p.match.recommendation === 'apply').length,
    };
    db.careers.last_search = summary;
    db.careers.last_search_at = stamp;
    save('cr_postings', 'careers');
    st.detail = `${saved} matches saved`;
  });
  return db.careers.last_search;
});

// =================================================================================================
// Applications (careers/questions.py + the application half of careers/service.py)
// =================================================================================================
const Q_RULES = [
  ['consent', /\b(?:consent|i agree|agree to|acknowledge|acknowledgement|certify|certification that|attest|privacy (?:policy|notice)|terms (?:and|&) conditions|gdpr|data (?:processing|retention|protection)|arbitration|record(?:ing)? (?:of )?(?:the |our |this )?(?:interview|conversation|call)|brighthire|notetaker|ai policy|truthful|accurate and complete|opt[- ]in|marketing communications|whatsapp updates|sms updates)\b/i],
  ['demographic', /\b(?:gender|sex\b|race|racial|ethnic|ethnicity|hispanic|latino|latinx|veteran|disabilit|disabled|sexual orientation|transgender|lgbt|pronouns?|age range|date of birth|birth ?date|religio|marital|caste|self[- ]identif|eeo|voluntary self|neurodiver)/i],
  ['compensation', /\b(?:salary|compensation|pay (?:expectation|range|requirement)|expected (?:ctc|pay|salary|compensation)|current (?:ctc|salary|pay|compensation|package)|ctc\b|remuneration|wage|hourly rate|rate expectation|desired pay|package)\b/i],
  ['legal', /\b(?:authori[sz]ed to work|work authori[sz]ation|right to work|legally (?:eligible|authori[sz]ed|allowed|permitted)|eligib(?:le|ility) to work|sponsor|visa|work permit|immigration|citizenship|citizen\b|convicted|conviction|criminal|felony|background (?:check|verification)|non[- ]?compete|non[- ]?solicit|export control|itar|security clearance|clearance|relative|family member|related to (?:anyone|an employee)|previously (?:been )?(?:employed|worked)|ever (?:been )?employed|worked (?:for|at) .{0,40} before|former employee|government (?:official|employee)|conflict of interest|debarred|sanction)\b/i],
  ['availability', /\b(?:start date|when can you start|earliest (?:start|date)|notice period|available to start|availability|relocat|commute|on[- ]?site|in the office|in-office|hybrid|time ?zone|willing to travel|travel requirement|work (?:from|in) (?:the )?office|shift|weekends?)\b/i],
  ['profile', /^\s*(?:first name|last name|surname|family name|given name|full name|legal name|name|preferred (?:first )?name|e-?mail(?: address)?|phone(?: number)?|mobile(?: number)?|contact number|location|city|current (?:city|location)|where are you (?:currently )?(?:located|based)|(?:please select )?the country (?:where )?you (?:currently )?(?:reside|live)|country of residence|linkedin|github|website|portfolio|personal (?:website|site)|(?:who is your )?current (?:or previous )?(?:company|employer)|(?:what is your )?current (?:or previous )?(?:job )?title|current role|years of (?:professional )?experience|how many years)/i],
];
const OPEN_TEXT_START = /^\s*(?:why|what|tell|describe|how would|how do|how have|explain|share|please (?:describe|tell|share|explain)|give an example|walk us|in (?:a few|\d+) (?:sentences|words)|cover letter|additional information|anything else)/i;
const COVER_KEYS = ['cover_letter_text', 'comments'];

/** Category for a form question; the AI may only draft open_text. */
export function classify(q) {
  if (q.kind === 'file') return 'file';
  const label = `${q.label} ${q.description || ''}`.trim();
  if (/cover ?letter|additional information|anything else/i.test(q.label) && ['text', 'textarea'].includes(q.kind)) return 'open_text';
  for (const [category, rx] of Q_RULES) {
    if (category === 'profile') {
      if (rx.test(q.label)) return 'profile';
    } else if (rx.test(label)) return category;
  }
  if (q.kind === 'textarea' || (q.kind === 'text' && OPEN_TEXT_START.test(q.label) && q.label.length > 25)) return 'open_text';
  return 'other';
}

/** What every form asks (sources.standard_questions): boards without a public questions API. */
function standardQuestions(source) {
  const q = (key, label, kind = 'text', required = false) => ({ key, label, kind, required, options: [], description: '' });
  const base = [
    q('first_name', 'First name', 'text', true), q('last_name', 'Last name', 'text', true), q('email', 'Email', 'text', true),
    q('phone', 'Phone', 'text', source !== 'lever'), q('resume', 'Resume/CV', 'file', true), q('location', 'Current location'),
    q('linkedin', 'LinkedIn profile'), q('github', 'GitHub or portfolio'), q('current_company', 'Current company'),
    q('cover_letter_text', 'Cover letter', 'textarea'),
  ];
  if (source === 'lever') {
    base.splice(0, 2, q('name', 'Full name', 'text', true));
    base.push(q('comments', 'Additional information', 'textarea'));
  }
  return base;
}
function questionsOf(p) {
  const board = p.questions && p.questions.length;
  const qs = board ? p.questions : standardQuestions(p.source);
  return { origin: board ? 'board' : 'standard', questions: qs.map((q) => ({ description: '', options: [], required: false, kind: 'text', ...q })) };
}
function questionsFor(p) {
  return questionsOf(p).questions.map((q) => ({ key: q.key, label: q.label, kind: q.kind, required: !!q.required, options: q.options, category: classify(q) }));
}

function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s) => {
    const out = new Map();
    for (let i = 0; i < s.length - 1; i += 1) out.set(s.slice(i, i + 2), (out.get(s.slice(i, i + 2)) || 0) + 1);
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  let inter = 0;
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) || 0);
  return (2 * inter) / (a.length - 1 + b.length - 1);
}
function normLabel(label, company = '') {
  let low = String(label || '').toLowerCase();
  if (company) low = low.split(company.toLowerCase()).join('the company');
  return low.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function savedAnswer(label, saved, company = '') {
  const target = normLabel(label, company);
  if (!target) return null;
  let best = null;
  for (const [savedLabel, answer] of Object.entries(saved || {})) {
    const cand = normLabel(savedLabel, company);
    if (!cand || !String(answer).trim()) continue;
    const ratio = cand === target ? 1 : similarity(cand, target);
    if (ratio >= 0.86 && (!best || ratio > best[0])) best = [ratio, savedLabel, String(answer)];
  }
  return best ? [best[1], best[2]] : null;
}
/** Map a free value onto one of a select's options ('Yes' -> 'Yes, I am'), or null. */
function bestOption(value, options) {
  if (!options || !options.length) return value || null;
  const v = String(value || '').trim().toLowerCase();
  if (!v) return null;
  const exact = options.find((o) => o.trim().toLowerCase() === v);
  if (exact) return exact;
  if (['yes', 'no', 'true', 'false'].includes(v)) {
    const want = v === 'yes' || v === 'true';
    return options.find((o) => {
      const low = o.trim().toLowerCase();
      return want ? /^(?:yes|i am|i do|i will|true)\b/.test(low) : /^(?:no|i am not|i do not|i will not|false)\b/.test(low);
    }) || null;
  }
  const scored = options.map((o) => [similarity(v, o.toLowerCase()), o]).sort((a, b) => b[0] - a[0]);
  if (scored.length && scored[0][0] >= 0.75) return scored[0][1];
  const contains = options.filter((o) => o.toLowerCase().includes(v) || v.includes(o.toLowerCase()));
  return contains.length === 1 ? contains[0] : null;
}
const yesNo = (flag) => (flag === null || flag === undefined ? '' : flag ? 'Yes' : 'No');
function profileValue(key, label, p) {
  const low = `${key} ${label}`.toLowerCase();
  const first = p.first_name || String(p.full_name || '').split(' ')[0];
  const last = p.last_name || String(p.full_name || '').split(' ').slice(1).join(' ');
  const full = p.full_name || [first, last].filter(Boolean).join(' ');
  const checks = [
    [/first|given|preferred/, first], [/last|surname|family/, last], [/full name|legal name|^name\b|\bname$/, full],
    [/e-?mail/, p.email], [/phone|mobile|contact number/, p.phone], [/linkedin/, p.linkedin_url],
    [/github/, p.github_url || p.portfolio_url], [/website|portfolio|personal site/, p.portfolio_url || p.github_url],
    [/country/, p.country], [/location|city|located|based/, p.location], [/company|employer/, p.current_company],
    [/title|role/, p.current_title], [/years/, p.years_experience === null || p.years_experience === undefined ? '' : String(p.years_experience)],
  ];
  const hit = checks.find(([rx]) => rx.test(low));
  return hit ? String(hit[1] || '') : '';
}
function availabilityValue(label, p) {
  const low = String(label).toLowerCase();
  if (low.includes('notice')) return p.notice_period || '';
  if (/start|available|availability|earliest/.test(low)) return p.earliest_start || p.notice_period || '';
  if (low.includes('relocat')) return yesNo(p.willing_to_relocate);
  return '';
}
function compensationValue(label, p) {
  if (/current|present|last drawn|previous|history/.test(String(label).toLowerCase())) return ''; // salary history: only the user
  return p.salary_expectation || '';
}

/** Fill what policy allows; mark everything else for the user (questions.plan_answers). */
/** Several choices for a multi-select: "a; b" or "a, b" (options may contain commas). */
function multiOptions(value, options) {
  const whole = bestOption(value, options);
  if (whole && whole.toLowerCase() === String(value).trim().toLowerCase()) return [whole];
  for (const sep of [';', '\n', '|', ',']) {
    const parts = String(value).split(sep).map((x) => x.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const mapped = parts.map((x) => bestOption(x, options));
    if (mapped.every(Boolean)) return [...new Set(mapped)];
  }
  return whole ? [whole] : null;
}

// Legal answers: reused only per country (sponsorship / work authorisation) or for the identical question.
const INTENTS = [
  [/\bsponsor/i, 'Needs visa sponsorship in {country}'],
  [/authori[sz]ed to work|eligible to work|right to work|legally (?:able|allowed|permitted|eligible) to work|work authori[sz]ation/i, 'Authorized to work in {country}'],
];
const NEGATION = /\bnot\b|n't\b|\bwithout\b|\bno longer\b/i;
function intentKey(label, country) {
  if (!country || NEGATION.test(label || '')) return null;
  for (const [rx, template] of INTENTS) if (rx.test(label || '')) return template.replace('{country}', COUNTRY_NAMES[country] || country);
  return null;
}
function mentionsCompany(label, company) {
  const low = String(label || '').toLowerCase();
  return (!!company && low.includes(company.toLowerCase()))
    || /\b(?:this company|our company|previously (?:been )?(?:employed|worked)|ever (?:been )?employed|relative|family member|referred|referral)\b/.test(low);
}
function jobCountry(posting) {
  const codes = [...countriesIn(posting.location || '')];
  return codes.length === 1 ? codes[0] : null;
}

function planAnswers(questions, p, company, aiAnswers = {}, hasFile = false, country = null) {
  return questions.map((q) => {
    const category = classify(q);
    let value = '';
    let source = 'empty';
    let note = '';
    if (category === 'profile') {
      value = profileValue(q.key, q.label, p);
      source = value ? 'profile' : 'empty';
      if (q.key === 'location' || /\blocation\b/i.test(q.label)) note = "Pick the matching suggestion in the form's location box.";
    } else if (category === 'file') {
      if (/resume|cv/i.test(`${q.key} ${q.label}`)) {
        source = hasFile ? 'profile' : 'empty';
        value = hasFile ? 'Your uploaded CV' : '';
        if (!hasFile) note = 'Upload your CV in Profile so the browser can attach it.';
      } else note = q.key.includes('cover') ? 'Optional file. The cover letter is pasted as text instead.' : '';
    } else if (category === 'open_text') {
      value = aiAnswers[q.key] || '';
      source = value ? 'ai' : 'empty';
      note = value ? 'Drafted from your CV. Edit it so it sounds like you.' : '';
    } else if (category === 'availability') {
      value = availabilityValue(q.label, p);
      source = value ? 'profile' : 'empty';
    } else if (category === 'compensation') {
      value = compensationValue(q.label, p);
      source = value ? 'profile' : 'empty';
      note = value ? 'Your own salary expectation from Profile.' : 'Answer this yourself.';
    } else if (category === 'consent') {
      note = 'Read it and tick it yourself in the form. The app never agrees to anything for you.';
    } else if (category === 'demographic') {
      note = 'Voluntary. Answer it yourself in the form (or choose not to). The app never fills it.';
    }
    const saved = p.saved_answers || {};
    if (!value && category === 'legal') {
      const key = intentKey(q.label, country);
      if (key && String(saved[key] || '').trim()) {
        value = String(saved[key]);
        source = 'saved';
        note = `Your answer for jobs in this country (${key.toLowerCase()}). Check it still applies.`;
      } else if (!mentionsCompany(q.label, company)) {
        const exact = Object.entries(saved).find(([k, v]) => normLabel(k) === normLabel(q.label) && String(v).trim());
        if (exact && (countriesIn(q.label).size || !intentKey(q.label, 'XX'))) {
          value = String(exact[1]);
          source = 'saved';
          note = 'Your saved answer to this exact question. Check it still applies.';
        }
      }
    }
    if (!value && ['other', 'availability', 'compensation', 'profile'].includes(category)) {
      const hit = savedAnswer(q.label, saved, company);
      if (hit) {
        [, value] = hit;
        source = 'saved';
        note = 'Your saved answer to a similar question. Check it still applies.';
      }
    }
    if (category === 'legal' && !value) note = 'Answer this yourself. Legal questions are never guessed.';
    if (value && ['select', 'multiselect'].includes(q.kind) && q.options.length && category !== 'file') {
      let picked = null;
      if (q.kind === 'multiselect') picked = multiOptions(value, q.options);
      else {
        const m = bestOption(value, q.options);
        picked = m === null ? null : [m];
      }
      if (!picked) {
        note = `Your answer '${value.slice(0, 60)}' doesn't match the options. Pick one.`;
        value = '';
        source = 'empty';
      } else value = picked.join('; ');
    }
    let needsInput = !value && (q.required || category === 'legal') && category !== 'file';
    if (category === 'consent' || category === 'demographic') {
      value = '';
      source = 'empty';
      needsInput = false;
    }
    return {
      key: q.key, label: q.label, kind: q.kind, required: !!q.required, category, options: q.options, description: q.description || '',
      value, source, needs_input: needsInput, note,
    };
  });
}

// ApplicationWriterAgent with built-in rules (agents.ApplicationWriterAgent.heuristic): open-text answers stay empty.
function draftMaterials(p, pr, match) {
  const cv = pr.resume_text || '';
  const meta = (match && match.meta) || {};
  const matched = (meta.skills_matched || []).slice(0, 4);
  const missingSkills = meta.skills_missing || [];
  const bullets = bulletLines(cv).filter((b) => b.split(/\s+/).length >= 5);
  const withNumbers = bullets.filter((b) => /\d/.test(b));
  const relevant = bullets.filter((b) => matched.some((s) => b.toLowerCase().includes(s.toLowerCase())));
  const picks = dedupe([...relevant, ...withNumbers, ...bullets], 3);
  const role = pr.current_title || 'professional';
  const yrs = pr.years_experience ?? yearsFromResume(cv);
  const years = yrs ? ` with ${yrs} years of experience` : '';
  const skills = matched.length ? matched.join(', ') : 'the skills in my CV';
  const summary = `${role[0].toUpperCase()}${role.slice(1)}${years}, working with ${skills}.`;
  const evidence = picks.slice(0, 2).map((x) => `${x.replace(/\.+$/, '')}.`).join(' ');
  let cover = `Dear Hiring Team,\n\nI'd like to apply for the ${p.title} role at ${p.company}. The posting asks for ${skills}, which is the work I do day to day as a ${role}${years}.\n\n`
    + (evidence ? `A few examples from my CV: ${evidence}\n\n` : '')
    + (missingSkills.length ? `I haven't used ${missingSkills.slice(0, 2).join(', ')} in a job yet, and I'd pick it up quickly.\n\n` : '')
    + `I'd welcome the chance to talk about how I can help ${p.company}.`;
  const name = pr.full_name || [pr.first_name, pr.last_name].filter(Boolean).join(' ');
  if (name) cover = `${cover.trim()}\n\nBest regards,\n${name}`;
  const highlights = matched.map((s) => `${s}: ${bullets.find((b) => b.toLowerCase().includes(s.toLowerCase())) || 'listed in my CV'}`.slice(0, 200));
  return { summary, cover_letter: cover, highlights };
}
function coverAnswers(answers, letter) {
  const out = {};
  for (const a of answers) {
    if (['text', 'textarea'].includes(a.kind) && (COVER_KEYS.includes(a.key) || /cover ?letter/i.test(a.label))) out[a.key] = letter;
  }
  return out;
}

// --- truth.py: rule-based claim checker ----------------------------------------------------------------
const NUM_RE = /(^|[^\w.])((?:[$€£₹]\s?)?)(\d[\d,]*(?:\.\d+)?)\s?(%|x\b|k\b|m\b|mn\b|million|billion|bn\b|lakhs?|crores?|cr\b|\+)?/gi;
const YEARS_CLAIM_RE = /(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)\b(?:\s+of)?(?:\s+\w+){0,3}?\s+(?:experience|working|building|in|as|of)/gi;
const DATE_LIKE = /^(?:19|20)\d\d$/;
const DEGREES = {
  phd: /\bph\.?\s?d\b|\bdoctorate\b|\bdoctoral\b/i,
  master: /\bmaster'?s\b|\bm\.?\s?tech\b|\bm\.\s?s\.?(?:c\.?)?\b|\bmsc\b|\bm\.?\s?eng\b|\bmba\b|\bm\.?\s?e\.(?=\s)/i,
  bachelor: /\bbachelor'?s\b|\bb\.?\s?tech\b|\bb\.\s?s\.?(?:c\.?)?\b|\bbsc\b|\bb\.?\s?eng\b|\bb\.\s?e\.(?=\s)|\bb\.\s?a\./i,
};
const CERTS = ['PMP', 'CPA', 'CFA', 'CISSP', 'CKA', 'CKAD', 'ACCA', 'CSM', 'PSM', 'CCNA', 'CCNP', 'OSCP', 'CISA', 'CISM', 'ITIL', 'TOGAF', 'FRM', 'CEH'];
const CERT_PHRASE_RE = /(?:[A-Z][\w+.-]*\s+){0,5}(?:Certified|Certification|Certificate)(?:\s+[A-Z][\w+.-]*){0,5}/g;
const ORG_RE = /\b(worked at|work at|employed at|employed by|joined|my time at|while at|when I was at|at|with|for)\s+((?:[A-Z][\w&.'-]*)(?:\s+(?:[A-Z][\w&.'-]*|&|of|and)){0,3})/g;
const STRONG_ORG = new Set(['worked at', 'work at', 'employed at', 'employed by', 'joined', 'my time at', 'while at', 'when i was at']);
const NOT_ORGS = new Set(['i', 'the', 'we', 'this', 'our', 'my', 'your', 'it', 'hiring', 'team', 'dear', 'a', 'an', 'me', 'you', 'us', 'them',
  'that', 'these', 'those', 'both', 'each', 'every', 'my team', 'scale', 'speed']);
const CLAIM_MARKERS = /\b(?:i|i've|i'm|i'd|my|me|built|led|designed|shipped|implemented|delivered|developed|created|worked|used|using|experience)\b/i;
const LEARNING_MARKERS = /\b(?:learn|learning|eager|keen|excited to|looking forward|explore|pick (?:it )?up|grow into|interested in|curious|would love to)\b/i;

function hashId(s) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return ((h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')).slice(0, 10);
}
const issue = (field, text, problem, severity, kind) => ({
  id: hashId(`${field}|${norm(text)}|${kind}`), field, text: String(text).trim().slice(0, 240), problem, severity, acknowledged: false, source: 'rules',
});
function numbersIn(text) {
  const out = new Set();
  NUM_RE.lastIndex = 0;
  let m;
  while ((m = NUM_RE.exec(text))) {
    let core = m[3].replace(/,/g, '');
    if (core.endsWith('.0')) core = core.slice(0, -2);
    out.add(core.replace(/\.+$/, ''));
    NUM_RE.lastIndex = m.index + m[1].length + m[2].length + m[3].length;
  }
  return out;
}
function checkField(field, text, corpus, postingText, company, actualYears) {
  const issues = [];
  if (!String(text || '').trim()) return issues;
  const corpusLow = corpus.toLowerCase();
  const corpusNums = numbersIn(corpus);
  const postingNums = numbersIn(postingText);
  const postingLow = postingText.toLowerCase();
  const claimed = [];
  for (const m of text.matchAll(YEARS_CLAIM_RE)) {
    const n = parseFloat(m[1]);
    claimed.push([m.index, m.index + m[1].length]);
    if (actualYears !== null && actualYears !== undefined && n > actualYears + 0.5) {
      issues.push(issue(field, m[0], `Claims ${n} years; your CV/profile shows about ${actualYears}.`, 'block', 'years'));
    }
  }
  NUM_RE.lastIndex = 0;
  let m;
  while ((m = NUM_RE.exec(text))) {
    const start = m.index + m[1].length;
    const numStart = start + m[2].length;
    NUM_RE.lastIndex = numStart + m[3].length;
    if (claimed.some(([a, b]) => a <= numStart && numStart < b)) continue;
    let core = m[3].replace(/,/g, '').replace(/\.+$/, '');
    if (core.endsWith('.0')) core = core.slice(0, -2);
    if (!core || corpusNums.has(core) || postingNums.has(core)) continue;
    if (DATE_LIKE.test(core) && corpusLow.includes(core)) continue;
    const shown = text.slice(start, m.index + m[0].length).trim();
    const context = text.slice(Math.max(0, start - 50), m.index + m[0].length + 50).trim();
    issues.push(issue(field, context, `The number '${shown}' isn't in your CV or confirmed facts.`, 'block', `num:${core}`));
  }
  for (const [canon, rx] of Object.entries(DEGREES)) {
    const d = text.match(rx);
    if (d && !rx.test(corpus)) {
      issues.push(issue(field, d[0], canon === 'phd' ? "Mentions a PhD/doctorate that your CV doesn't list." : `Mentions a ${canon}'s-level degree that your CV doesn't list.`, 'block', `degree:${canon}`));
    }
  }
  for (const acro of CERTS) {
    const rx = new RegExp(`\\b${acro}\\b`);
    if (rx.test(text) && !rx.test(corpus)) issues.push(issue(field, acro, `Mentions the ${acro} certification, which your CV doesn't list.`, 'block', `cert:${acro}`));
  }
  for (const c of text.matchAll(CERT_PHRASE_RE)) {
    const phrase = c[0].trim();
    if (phrase.split(/\s+/).length >= 2 && !evidenceIn(phrase, corpus, 0.75)) issues.push(issue(field, phrase, "This certification isn't in your CV.", 'block', 'cert'));
  }
  const companyLow = String(company || '').toLowerCase();
  const skillsLow = new Set([...extractSkills(text)].map((s) => s.toLowerCase()));
  for (const o of text.matchAll(ORG_RE)) {
    const verb = o[1].toLowerCase();
    const org = o[2].trim().replace(/^[ .,']+|[ .,']+$/g, '');
    const orgLow = org.toLowerCase();
    if (NOT_ORGS.has(orgLow) || skillsLow.has(orgLow) || org.length < 2 || corpusLow.includes(orgLow)
      || (companyLow && (companyLow.includes(orgLow) || orgLow.includes(companyLow))) || postingLow.includes(orgLow)) continue;
    if (['at', 'with', 'for'].includes(verb) && !/[A-Z].*[A-Z]|[A-Z][a-z]+/.test(org)) continue;
    const strong = STRONG_ORG.has(verb);
    if (!strong && (verb === 'with' || verb === 'for')) continue;
    issues.push(issue(field, o[0], `'${org}' isn't in your CV.`, strong ? 'block' : 'warn', `org:${orgLow}`));
  }
  const cvSkills = extractSkills(corpus);
  for (const sent of sentences(text)) {
    const extra = [...extractSkills(sent)].filter((s) => !cvSkills.has(s)).sort();
    if (extra.length && CLAIM_MARKERS.test(sent) && !LEARNING_MARKERS.test(sent)) {
      issues.push(issue(field, sent, `Your CV doesn't mention ${extra.slice(0, 3).join(', ')}. Keep it only if you have real experience with it.`, 'warn', `skill:${extra.join(',')}`));
    }
  }
  const seen = new Set();
  return issues.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
}
function draftFields(materials, answers) {
  const fields = [['summary', materials.summary || ''], ['cover_letter', materials.cover_letter || '']];
  (materials.highlights || []).forEach((h, i) => fields.push([`highlights.${i}`, h]));
  for (const a of answers) {
    if (a.category === 'open_text' && ['ai', 'user'].includes(a.source) && a.value) fields.push([`answer:${a.key}`, String(a.value)]);
  }
  return fields;
}
const corpusOf = (pr) => [pr.resume_text || '', pr.extra_facts || '', pr.current_title ? `Current title: ${pr.current_title}` : '',
  pr.current_company ? `Current company: ${pr.current_company}` : ''].join('\n');
const yearsOf = (pr) => pr.years_experience ?? yearsFromResume(pr.resume_text || '');
function runTruth(app, pr) {
  const fields = draftFields(app.materials, app.answers);
  const all = [];
  for (const [name, value] of fields) all.push(...checkField(name, value, corpusOf(pr), app.posting.description_text || '', app.posting.company, yearsOf(pr)));
  const acked = new Set(app.acked || []);
  const merged = [];
  for (const i of all) {
    const dup = merged.find((x) => x.field === i.field && (norm(x.text).includes(norm(i.text)) || norm(i.text).includes(norm(x.text))));
    if (dup) { if (i.severity === 'block') dup.severity = 'block'; continue; }
    merged.push({ ...i, acknowledged: acked.has(i.id) });
  }
  merged.sort((a, b) => (a.severity !== 'block') - (b.severity !== 'block') || a.field.localeCompare(b.field));
  return { ok: !merged.some((i) => i.severity === 'block' && !i.acknowledged), issues: merged, meta: { checked_at: nowIso(), rules: merged.length, ai: 0 } };
}

function approvedToday(exclude = null) {
  const today = new Date().toDateString();
  return rows('cr_apps').filter((a) => a.id !== exclude && a.approved_at && new Date(a.approved_at).toDateString() === today).length;
}
function checklist(app, pr) {
  const items = [];
  const missing = app.answers.filter((a) => a.needs_input && !a.value).map((a) => a.label);
  items.push({ key: 'answers', label: 'Required questions answered', ok: !missing.length, blocking: true,
    detail: missing.length ? `Still needed: ${missing.slice(0, 4).map((m) => m.slice(0, 60)).join('; ')}${missing.length > 4 ? ' …' : ''}`
      : `${app.answers.filter((a) => a.value).length} answers ready` });
  const blocks = ((app.truth && app.truth.issues) || []).filter((i) => i.severity === 'block' && !i.acknowledged);
  items.push({ key: 'truth', label: 'Every claim is backed by your CV', ok: !blocks.length, blocking: true,
    detail: blocks.length ? `${blocks.length} claim(s) to fix or confirm` : 'No unsupported claims' });
  const gaps = [['full_name', 'name'], ['email', 'email'], ['phone', 'phone']].filter(([k]) => !pr[k]).map(([, l]) => l);
  items.push({ key: 'contact', label: 'Contact details in Profile', ok: !gaps.length, blocking: true,
    detail: gaps.length ? `Add your ${gaps.join(', ')}` : 'Name, email and phone set' });
  items.push({ key: 'cv_file', label: 'CV file uploaded', ok: !!pr.resume_file, blocking: false,
    detail: pr.resume_file ? 'The browser assistant attaches it' : 'Upload it in Profile to attach it automatically' });
  const used = approvedToday(app.id);
  items.push({ key: 'limit', label: "Within today's limit", ok: used < dailyLimit(), blocking: true,
    detail: `${used} of ${dailyLimit()} approved today. Fewer, better-matched applications get more replies.` });
  const self = app.answers.filter((a) => FORM_ONLY.has(a.category));
  if (self.length) {
    const nc = self.filter((a) => a.category === 'consent').length;
    const nd = self.length - nc;
    items.push({ key: 'in_form', label: 'Questions you answer yourself in the form', ok: true, blocking: false,
      detail: `${[nc ? `${nc} consent` : '', nd ? `${nd} voluntary` : ''].filter(Boolean).join(' and ')} question(s); the app never fills these` });
  }
  return items;
}

const AI_DIRECTIVE_RE = /[^.\n]{0,120}(?:ignore (?:all |any )?(?:previous|prior|above) instructions|if you(?:'re| are) an? (?:ai|llm|bot|language model|chat ?gpt|gpt|assistant|automated)|(?:ai|llm|language model|chat ?gpt)s? (?:reading|processing) this|note to (?:ai|llm|chatgpt)|as an ai language model|include the (?:word|phrase|code)|mention the (?:word|phrase)|(?:start|begin) your (?:application|answer|cover letter) with the (?:word|phrase))[^.\n]{0,160}/gi;
const AI_SCREENING_RE = /[^.\n]*\b(?:automated|AI|artificial intelligence|algorithmic)\b[^.\n]{0,80}\b(?:screen|assess|evaluat|rank|review)\w*[^.\n]{0,40}\b(?:applica|candidat|resume|CV)\w*[^\n]*/i;
function warningsFor(p, appId, origin) {
  const out = [];
  const desc = p.description_text || '';
  const seen = new Set();
  for (const m of desc.matchAll(AI_DIRECTIVE_RE)) {
    const t = m[0].replace(/\s+/g, ' ').trim().slice(0, 240);
    if (t && !seen.has(t) && seen.size < 3) {
      seen.add(t);
      out.push({ kind: 'ai_directive', text: `The posting contains text aimed at AI tools: “${t}”. The draft ignored it. Read the posting yourself and decide.` });
    }
  }
  const scr = desc.match(AI_SCREENING_RE);
  const url = scr ? (scr[0].match(/https?:\/\/[^\s)]+/) || [''])[0].replace(/[.,;]+$/, '') : '';
  if (url) out.push({ kind: 'ai_screening', url, text: 'This employer uses AI to help screen applications. You can ask for a human review instead.' });
  const cutoff = Date.now() - 120 * 86400000;
  rows('cr_apps').filter((a) => a.id !== appId && String(a.posting.company).toLowerCase() === String(p.company).toLowerCase()
    && Date.parse(a.created_at) >= cutoff && ['approved', 'filling', 'filled', 'submitted', 'interviewing', 'offer'].includes(a.status))
    .slice(0, 2)
    .forEach((o) => out.push({ kind: 'duplicate', text: `You also applied to ${p.company} for “${o.posting.title}” on ${o.created_at.slice(0, 10)}. Some employers limit applications per person.` }));
  if (origin === 'standard') {
    out.push({ kind: 'info', text: "This job board doesn't publish its form questions, so only the standard fields are listed. The browser assistant reports anything else the form asks." });
  }
  return out;
}

function appView(a) {
  const { acked: _a, posting_id: _p, approved_hash: _h, ...out } = a;
  const pr = profile();
  return { ...out, truth: a.truth || { ok: true, issues: [], meta: {} }, checklist: checklist(a, pr) };
}
function loadApp(id) {
  const a = db.cr_apps[id];
  if (!a) throw new DemoError('Application not found', 404);
  return a;
}
function touch(a, event, detail = '') {
  a.updated_at = nowIso();
  if (event) a.history = [...(a.history || []), { at: a.updated_at, event, detail }].slice(-100);
}
const contentHash = (a) => hashId(JSON.stringify({ m: a.materials, a: a.answers.map((x) => [x.key, x.value]) }));

function createApplication(postingId) {
  const p = db.cr_postings[postingId];
  if (!p) throw new DemoError('Posting not found', 404);
  const existing = appForPosting(postingId);
  if (existing) return { application: appView(existing), job_id: existing.job_id, created: false };
  const pr = profile();
  if (String(pr.resume_text || '').trim().length < 150) throw new DemoError('Add your CV in Profile first. Drafts are written only from it.', 400);
  const id = newId('app');
  const now = nowIso();
  const m = p.match || null;
  db.cr_apps[id] = {
    id, posting_id: p.id, status: 'preparing', mode: BOARD_KINDS.includes(p.source) ? 'fill' : 'assist', warnings: [], questions_origin: 'standard',
    posting: { ...postingView(p), description_text: p.description_text },
    match: m ? { score: m.score, det_score: m.det_score, llm_score: m.llm_score, recommendation: m.recommendation, reasons: m.reasons, gaps: m.gaps, red_flags: m.red_flags, meta: m.meta } : null,
    materials: { summary: '', cover_letter: '', highlights: [] }, answers: [], truth: { ok: true, issues: [], meta: {} }, fill_report: null,
    history: [{ at: now, event: 'created', detail: m ? `Match score ${m.score}` : 'Added by you' }], notes: '', follow_up_at: null,
    target_id: null, job_id: null, acked: [], created_at: now, updated_at: now, approved_at: null, submitted_at: null,
  };
  const jobId = submitJob('cr_draft', { app_id: id });
  db.cr_apps[id].job_id = jobId;
  save('cr_apps');
  return { application: appView(db.cr_apps[id]), job_id: jobId, created: true };
}

registerJob('cr_draft', async (job, payload) => {
  job.plan([
    { key: 'questions', label: 'Read the application form' },
    { key: 'write', label: 'Draft the cover letter and answers from your CV', agent: 'ApplicationWriterAgent' },
    { key: 'truth', label: 'Check every claim against your CV', agent: 'TruthCheckAgent' },
    { key: 'review', label: 'Ready for your review' },
  ]);
  const a = db.cr_apps[payload.app_id];
  if (!a) return { skipped: 'application deleted' };
  const p = db.cr_postings[a.posting_id] || { ...a.posting, questions: null };
  const pr = profile();
  const previous = new Map((a.answers || []).filter((x) => x.source === 'user').map((x) => [x.key, x]));
  const { origin, questions } = questionsOf(p);
  let answers = [];
  await job.step('questions', 'Read the application form', null, (st) => {
    answers = planAnswers(questions, pr, p.company, {}, !!pr.resume_file, jobCountry(p));
    st.detail = `${questions.length} questions (${origin === 'board' ? 'from the job board' : 'standard form'})`;
  });
  await job.step('write', 'Draft the cover letter and answers from your CV', 'ApplicationWriterAgent', (st) => {
    const res = runAgent('ApplicationWriterAgent', () => draftMaterials(p, pr, a.match));
    a.materials = res.output;
    answers = planAnswers(questions, pr, p.company, coverAnswers(answers, a.materials.cover_letter), !!pr.resume_file, jobCountry(p));
    for (const x of answers) {
      const old = previous.get(x.key);
      if (old && !FORM_ONLY.has(x.category)) Object.assign(x, { value: old.value, source: 'user', needs_input: false });
    }
    a.answers = answers;
    JobHandle.record(st, res.meta);
  });
  await job.step('truth', 'Check every claim against your CV', 'TruthCheckAgent', (st) => {
    a.truth = runTruth(a, pr);
    const res = runAgent('TruthCheckAgent', () => ({ issues: [] }));
    JobHandle.record(st, res.meta);
    const blocks = a.truth.issues.filter((i) => i.severity === 'block').length;
    st.detail = a.truth.issues.length ? `${blocks} to fix, ${a.truth.issues.length - blocks} to check` : 'All claims backed by your CV';
  });
  await job.step('review', 'Ready for your review', null, (st) => {
    if (!db.cr_apps[a.id]) return;
    a.warnings = warningsFor(p, a.id, origin);
    a.questions_origin = origin;
    a.status = 'needs_review';
    a.approved_at = null;
    touch(a, 'drafted', 'Ready for your review (built-in rules; no AI model was available)');
    save('cr_apps');
    st.detail = 'Waiting for you';
  });
  return { application_id: a.id, issues: a.truth.issues.length };
});
registerJob('cr_draft:failed', async (job, payload) => {
  const a = db.cr_apps[payload.app_id];
  if (!a) return;
  a.status = 'failed';
  touch(a, 'failed', 'Drafting failed; try Regenerate');
  save('cr_apps');
});

function listApplications(status) {
  return rows('cr_apps')
    .filter((a) => !status || a.status === status)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .map((a) => ({
      id: a.id, status: a.status, posting: { company: a.posting.company, title: a.posting.title, location: a.posting.location, url: a.posting.url },
      score: a.match ? Math.round(a.match.score) : null, created_at: a.created_at, updated_at: a.updated_at, approved_at: a.approved_at,
      submitted_at: a.submitted_at, follow_up_at: a.follow_up_at,
    }));
}

function updateApplication(id, patch) {
  const a = loadApp(id);
  if (['preparing', 'filling'].includes(a.status)) throw new DemoError('Wait until the current step finishes.', 409);
  let changed = false;
  if (patch.materials && typeof patch.materials === 'object') {
    for (const k of ['summary', 'cover_letter']) {
      if (k in patch.materials && patch.materials[k] !== null) {
        const v = String(patch.materials[k]).slice(0, 12000);
        if (v !== a.materials[k]) { a.materials[k] = v; changed = true; }
      }
    }
    if (Array.isArray(patch.materials.highlights)) {
      const hl = patch.materials.highlights.map((h) => String(h).trim().slice(0, 400)).filter(Boolean).slice(0, 8);
      if (JSON.stringify(hl) !== JSON.stringify(a.materials.highlights)) { a.materials.highlights = hl; changed = true; }
    }
  }
  if (Array.isArray(patch.answers)) {
    for (const item of patch.answers) {
      const ans = a.answers.find((x) => x.key === String(item.key));
      if (!ans || FORM_ONLY.has(ans.category)) continue; // never stored or filled by the app
      let value = (Array.isArray(item.value) ? item.value.join('; ') : String(item.value || '')).trim().slice(0, 6000);
      if (ans.kind === 'multiselect' && ans.options && ans.options.length && value) {
        const picked = multiOptions(value, ans.options);
        if (!picked) throw new DemoError(`“${value.slice(0, 60)}” doesn't match the options for “${ans.label.slice(0, 80)}”.`, 400);
        value = picked.join('; ');
      } else if (ans.kind === 'select' && ans.options && ans.options.length && value) {
        const mapped = bestOption(value, ans.options);
        if (mapped === null) throw new DemoError(`“${value.slice(0, 60)}” isn't one of the options for “${ans.label.slice(0, 80)}”.`, 400);
        value = mapped;
      }
      if (value !== ans.value) {
        Object.assign(ans, { value, source: value ? 'user' : 'empty', note: '', needs_input: !value && (ans.required || ans.category === 'legal') });
        changed = true;
      }
    }
  }
  if ('notes' in patch && patch.notes !== null) a.notes = String(patch.notes).slice(0, 4000);
  if ('follow_up_at' in patch) a.follow_up_at = patch.follow_up_at || null;
  if (changed) {
    a.truth = runTruth(a, profile());
    if (['approved', 'filled'].includes(a.status)) {
      a.status = 'needs_review';
      a.approved_at = null;
      touch(a, 'reopened', 'Edited after approval. Approve it again.');
    } else {
      if (a.status === 'failed') a.status = 'needs_review';
      touch(a, null);
    }
  } else touch(a, null);
  save('cr_apps');
  return appView(a);
}
function regenerate(id) {
  const a = loadApp(id);
  if (['preparing', 'filling'].includes(a.status)) throw new DemoError('Wait until the current step finishes.', 409);
  if (['submitted', 'interviewing', 'offer', 'rejected', 'withdrawn'].includes(a.status)) throw new DemoError('This application was already submitted.', 409);
  a.status = 'preparing';
  a.approved_at = null;
  const jobId = submitJob('cr_draft', { app_id: id, regenerate: true });
  a.job_id = jobId;
  touch(a, 'regenerated', 'Drafting again from your CV');
  save('cr_apps');
  return { job_id: jobId };
}
function ack(id, issueId) {
  const a = loadApp(id);
  const found = ((a.truth && a.truth.issues) || []).find((i) => i.id === issueId);
  if (!found) throw new DemoError('That claim is no longer flagged. The check ran again after your edit.', 404);
  a.acked = [...new Set([...(a.acked || []), issueId])];
  found.acknowledged = true;
  a.truth.ok = !a.truth.issues.some((i) => i.severity === 'block' && !i.acknowledged);
  touch(a, 'truth_ack', `You confirmed: “${found.text.slice(0, 120)}”`);
  save('cr_apps');
  return appView(a);
}
function approve(id) {
  const a = loadApp(id);
  if (a.status === 'approved') return appView(a);
  if (a.status !== 'needs_review') {
    throw new DemoError({ preparing: 'Still drafting. Wait a moment.', failed: 'Drafting failed. Regenerate it first.' }[a.status]
      || `Can't approve an application that is ${a.status}.`, 409);
  }
  const pr = profile();
  const blockers = checklist(a, pr).filter((i) => i.blocking && !i.ok).map((i) => `${i.label}: ${i.detail}`);
  if (blockers.length) return { conflict: { detail: 'Not ready to approve yet.', blockers } };
  let remembered = 0;
  const saved = { ...(pr.saved_answers || {}) };
  const country = jobCountry(db.cr_postings[a.posting_id] || a.posting || {});
  for (const x of a.answers) {
    if (x.source === 'user' && x.value && ['legal', 'other', 'availability', 'compensation'].includes(x.category)) {
      saved[x.label.trim().slice(0, 300)] = x.value;
      const key = x.category === 'legal' ? intentKey(x.label, country) : null;
      if (key) saved[key] = x.value;
      remembered += 1;
    }
  }
  if (remembered) putProfile({ saved_answers: saved });
  a.approved_hash = contentHash(a);
  a.status = 'approved';
  a.approved_at = nowIso();
  touch(a, 'approved', `Approved by you${remembered ? `; ${remembered} answer(s) saved for next time` : ''}`);
  save('cr_apps');
  return appView(a);
}
function fill(id) {
  const a = loadApp(id);
  if (a.mode !== 'fill') throw new DemoError("This site isn't supported by the browser assistant. Open the application page and copy your approved answers from here.", 400);
  if (!['approved', 'filled'].includes(a.status)) throw new DemoError('Approve the application first.', 409);
  if (a.approved_hash && a.approved_hash !== contentHash(a)) throw new DemoError('The application changed after approval. Approve it again.', 409);
  throw new DemoError('Needs the installed app (it drives a browser on your PC).', 501);
}
function markSubmitted(id, note) {
  const a = loadApp(id);
  if (a.status === 'submitted') return appView(a);
  if (!['approved', 'filled', 'filling', 'needs_review'].includes(a.status)) throw new DemoError(`Can't mark an application that is ${a.status} as submitted.`, 409);
  a.status = 'submitted';
  a.submitted_at = nowIso();
  if (!a.follow_up_at) a.follow_up_at = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  touch(a, 'submitted', String(note || '').slice(0, 500) || 'You submitted it');
  save('cr_apps');
  return appView(a);
}
function setStatus(id, status) {
  if (!['interviewing', 'offer', 'rejected', 'withdrawn'].includes(status)) throw new DemoError('Status must be one of interviewing, offer, rejected, withdrawn.', 400);
  const a = loadApp(id);
  a.status = status;
  touch(a, status, '');
  save('cr_apps');
  return appView(a);
}
function prepFor(id) {
  const a = loadApp(id);
  if (a.target_id && db.targets[a.target_id]) return { target_id: a.target_id, job_id: db.targets[a.target_id].job_id || null };
  const pr = profile();
  const p = a.posting;
  const jd = `${p.title} at ${p.company}\n${p.location || ''}\n\n${p.description_text || ''}`;
  const res = coach.createTarget(p.title, p.company, pr.resume_text || '', jd);
  a.target_id = res.target.id;
  touch(a, 'prep', 'Interview prep pack started in Prep');
  save('cr_apps');
  return { target_id: res.target.id, job_id: res.job_id };
}
function deleteApplication(id) {
  loadApp(id);
  delete db.cr_apps[id];
  save('cr_apps');
}

function stats() {
  const by = {};
  for (const a of rows('cr_apps')) by[a.status] = (by[a.status] || 0) + 1;
  const last = db.careers.last_search || null;
  return {
    approved_today: approvedToday(), daily_limit: dailyLimit(), by_status: by,
    sources_enabled: rows('cr_sources').filter((s) => s.enabled).length,
    postings: last ? last.saved : 0, last_search_at: last ? last.at : null, last_search: last,
    browser: { available: false, channel: null, busy: false, detail: 'Demo: filling forms needs the installed app, which opens a browser window on your PC.' },
  };
}

/** Register the /api/careers routes on the demo router. */
export function registerCareerRoutes(route, json) {
  route('GET', '/api/careers/profile', () => json(profileView()));
  route('PUT', '/api/careers/profile', ({ body }) => json(putProfile(body)));
  route('POST', '/api/careers/profile/resume', async ({ form }) => json(await uploadResume(form)));
  route('POST', '/api/careers/profile/import-target', ({ body }) => json(importTarget(body.target_id)));
  route('GET', '/api/careers/preferences', () => json(prefs()));
  route('PUT', '/api/careers/preferences', ({ body }) => json(putPrefs(body)));
  route('GET', '/api/careers/sources', () => json(listSources()));
  route('POST', '/api/careers/sources', ({ body }) => json(addSource(body), 201));
  route('GET', '/api/careers/sources/suggestions', () => json(suggestions()));
  route('POST', '/api/careers/sources/detect', ({ body }) => json(detect(body.url)));
  route('PUT', '/api/careers/sources/:id', ({ p, body }) => json(updateSource(p.id, body)));
  route('DELETE', '/api/careers/sources/:id', ({ p }) => { deleteSource(p.id); return json({ ok: true }); });
  route('POST', '/api/careers/search', ({ body }) => json({ job_id: submitJob('cr_search', { refresh: !!body.refresh }) }));
  route('GET', '/api/careers/matches', ({ q }) => json(listMatches(q)));
  route('POST', '/api/careers/postings/manual', ({ body }) => json(addManual(body), 201));
  route('GET', '/api/careers/postings/:id', ({ p }) => json(getPosting(p.id)));
  route('POST', '/api/careers/postings/:id/dismiss', ({ p }) => { dismiss(p.id); return json({ ok: true }); });
  route('POST', '/api/careers/applications', ({ body }) => {
    const res = createApplication(body.posting_id);
    return json({ application: res.application, job_id: res.job_id }, res.created ? 201 : 200);
  });
  route('GET', '/api/careers/applications', ({ q }) => json(listApplications(q.get('status') || '')));
  route('GET', '/api/careers/applications/:id', ({ p }) => json(appView(loadApp(p.id))));
  route('PUT', '/api/careers/applications/:id', ({ p, body }) => json(updateApplication(p.id, body)));
  route('DELETE', '/api/careers/applications/:id', ({ p }) => { deleteApplication(p.id); return json({ ok: true }); });
  route('POST', '/api/careers/applications/:id/regenerate', ({ p }) => json(regenerate(p.id)));
  route('POST', '/api/careers/applications/:id/truth/:issue/ack', ({ p }) => json(ack(p.id, p.issue)));
  route('POST', '/api/careers/applications/:id/approve', ({ p }) => {
    const res = approve(p.id);
    return res.conflict ? json(res.conflict, 409) : json(res);
  });
  route('POST', '/api/careers/applications/:id/fill', ({ p }) => json(fill(p.id)));
  route('POST', '/api/careers/applications/:id/submitted', ({ p, body }) => json(markSubmitted(p.id, body.note)));
  route('POST', '/api/careers/applications/:id/status', ({ p, body }) => json(setStatus(p.id, body.status)));
  route('POST', '/api/careers/applications/:id/prep', ({ p }) => json(prepFor(p.id)));
  route('GET', '/api/careers/stats', () => json(stats()));
}

export { APP_STATUSES };
