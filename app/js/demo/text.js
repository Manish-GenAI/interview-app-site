// Port of backend/app/coach/text.py: deterministic text tools used by the rule-based agents.
// Lookbehinds are rewritten as "(?:^|[^…])" prefixes so the demo also runs on older Safari.
import { SKILL_VOCAB, STOPWORDS as STOP_LIST, FILLERS, HEDGES } from './data.js';

export const STOPWORDS = new Set(STOP_LIST);
export { FILLERS, HEDGES };

export const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Python's round(): half-to-even on exact ties. */
export function pyRound(x, nd = 0) {
  const m = 10 ** nd;
  const v = x * m;
  const f = Math.floor(v);
  const diff = v - f;
  const r = Math.abs(diff - 0.5) < 1e-9 ? (f % 2 === 0 ? f : f + 1) : Math.round(v);
  return nd ? r / m : r;
}

/** Python str.strip(chars). */
export function pyStrip(s, chars) {
  const set = new Set(chars);
  let a = 0;
  let b = s.length;
  while (a < b && set.has(s[a])) a += 1;
  while (b > a && set.has(s[b - 1])) b -= 1;
  return s.slice(a, b);
}

const LINE_SPLIT = new RegExp('\\r\\n|[\\n\\r\\v\\f\\x1c-\\x1e\\x85\\u2028\\u2029]');
export const splitLines = (text) => String(text || '').split(LINE_SPLIT);

export const BULLET_RE = /^\s*(?:[-*•▪◦·–]|\d+[.)])\s+/;
const WORD_RE = /[A-Za-z][A-Za-z'+#.-]*/g;

export function words(text) {
  return String(text || '').match(WORD_RE) || [];
}

export function sentences(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  return t.replace(/([.!?])\s+(?=[A-Z0-9"'])/g, '$1\u0000').split('\u0000').map((s) => s.trim()).filter(Boolean);
}

export function lines(text) {
  return splitLines(text).map((ln) => ln.trim()).filter(Boolean);
}

export function bulletLines(text) {
  return splitLines(text).filter((ln) => BULLET_RE.test(ln)).map((ln) => ln.replace(BULLET_RE, '').trim());
}

const SKILL_PATTERNS = SKILL_VOCAB.map((s) => [s, new RegExp(`(?:^|[^A-Za-z0-9+#])${escRe(s)}(?![A-Za-z0-9+#])`, 'i')]);
const CASE_SENSITIVE = new Set(['C', 'R', 'Go']);
const CANON = { Golang: 'Go', LLMs: 'LLM', 'Google Cloud': 'GCP' };

export function findSkills(text) {
  const t = String(text || '');
  const found = [];
  for (const [skill, pattern] of SKILL_PATTERNS) {
    if (CASE_SENSITIVE.has(skill)) {
      if (skill !== 'Go' && new RegExp(`(?:^|[^A-Za-z0-9+#])${escRe(skill)}(?![A-Za-z0-9+#/])`).test(t)) found.push(skill);
      else if (skill === 'Go' && /\bGo(?:lang)?\b(?! to| ahead| back| through| over| live)/.test(t)) found.push(skill);
      continue;
    }
    if (pattern.test(t)) found.push(skill);
  }
  const out = [];
  for (let s of found) {
    s = CANON[s] || s;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function cmpStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

export function keywords(text, k = 15) {
  let toks = words(text).map((w) => pyStrip(w.toLowerCase(), ".-'"));
  toks = toks.filter((t) => t.length > 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
  const counts = new Map();
  for (const t of toks) counts.set(t, (counts.get(t) || 0) + 1);
  const bigrams = new Map();
  for (let i = 0; i + 1 < toks.length; i += 1) {
    const a = toks[i];
    const b = toks[i + 1];
    if (!STOPWORDS.has(a) && !STOPWORDS.has(b)) bigrams.set(`${a} ${b}`, (bigrams.get(`${a} ${b}`) || 0) + 1);
  }
  const scored = [...counts.entries()].concat([...bigrams.entries()].filter(([, c]) => c > 1).map(([w, c]) => [w, c * 1.5]));
  scored.sort((x, y) => (y[1] - x[1]) || cmpStr(x[0], y[0]));
  const out = [];
  for (const [term] of scored) {
    if (out.some((e) => term.includes(e) || e.includes(term))) continue;
    out.push(term);
    if (out.length >= k) break;
  }
  return out;
}

const LIKE_RE = /(?:,\s*like\b|\blike,|\bwas like\b|\bit's like\b|\bjust like\b(?! a| the))/g;

export function countPhrases(text, phrases) {
  const low = ` ${String(text || '').toLowerCase()} `;
  const out = {};
  for (const phrase of phrases) {
    const re = phrase === 'like' ? LIKE_RE : new RegExp(`(?:^|[^a-z'])${escRe(phrase)}(?![a-z'])`, 'g');
    const n = (low.match(re) || []).length;
    if (n) out[phrase] = n;
  }
  return out;
}

const STAR = {
  situation: [/\bwhen i\b/i, /\bat (?:my|our|the) (?:previous|last|current)?\s*(?:job|company|team|role)\b/i,
    /\bthe situation\b/i, /\bcontext\b/i, /\bback in\b/i, /\bwe were\b/i, /\bour team (?:was|had)\b/i,
    /\bthere was\b/i, /\bin (?:19|20)\d\d\b/i, /\bat [A-Z][a-z]+/i, /\bwhile (?:i|we) (?:was|were)\b/i,
    /\bproblem was\b/i, /\bchallenge was\b/i],
  task: [/\bmy (?:goal|task|job|responsibility|role) was\b/i, /\bi was (?:responsible|asked|tasked|in charge)\b/i,
    /\bi needed to\b/i, /\bwe needed to\b/i, /\bthe goal was\b/i, /\bobjective\b/i, /\bhad to\b/i,
    /\bi owned\b/i, /\bmy part\b/i],
  action: [new RegExp('\\bi (?:built|led|created|designed|implemented|wrote|decided|proposed|organized|started|set up|'
    + 'analy[sz]ed|reached out|talked|negotiated|introduced|refactored|automated|migrated|launched|'
    + 'prioriti[sz]ed|ran|drove|coordinated|mentored|investigated|debugged|fixed|presented|convinced|'
    + 'worked with|partnered|reduced|improved|redesigned|shipped|delivered)\\b', 'i'),
  /\bfirst,? i\b/i, /\bthen i\b/i, /\bso i\b/i, /\bmy approach\b/i, /\bi made sure\b/i,
  new RegExp('\\bi (?:\\w+ed|took|made|set|ran|wrote|built|led|drove|chose|found|sent|gave|brought|taught|kept|held|'
    + 'spoke|told|began|put|got)\\b(?! (?:to|that it|like))', 'i')],
  result: [/\bas a result\b/i, /\bresult(?:ed|s)?\b/i, /\bwhich led to\b/i, /\bin the end\b/i, /\boutcome\b/i,
    /\bimpact\b/i, /\b(?:reduced|increased|improved|saved|grew|boosted|decreased|doubled|tripled|dropped|halved)\b/i,
    /\bcut\b[^.]{0,40}\b(?:by|from|in half)\b/i,
    /\d+\s?%/i, /\$\s?\d/i, /\b\d+x\b/i, /\bi learned\b/i, /\blesson\b/i, /\bdelivered\b/i,
    /\blaunched\b/i, /\bon time\b/i, /\bcustomers?\b.*\b(?:happy|satisf)/i, /\bpromoted\b/i],
};

export function starPresence(text) {
  const t = String(text || '');
  const out = {};
  for (const [part, pats] of Object.entries(STAR)) out[part] = pats.some((p) => p.test(t));
  return out;
}

export const NUMBER_RE = new RegExp(
  '(?:\\b\\d+(?:[.,]\\d+)?\\s?(?:%|percent|x|k|m|million|billion|hours?|days?|weeks?|months?|users?|customers?|people|ms|'
  + 'seconds?|minutes?)?\\b|\\$\\s?\\d+|\\b(?:two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|'
  + 'hundred|thousand|million|billion|half|double|triple)\\b)', 'gi',
);

export function numberMatches(text) {
  return String(text || '').match(NUMBER_RE) || [];
}
export function numbersCount(text) {
  return numberMatches(text).length;
}

function contentWords(s) {
  return new Set(words(s).filter((w) => !STOPWORDS.has(w.toLowerCase()) && w.length > 2).map((w) => w.toLowerCase()));
}
export function overlapRatio(a, b) {
  const aw = contentWords(a);
  const bw = contentWords(b);
  if (!bw.size) return 0;
  let n = 0;
  for (const w of bw) if (aw.has(w)) n += 1;
  return n / bw.size;
}

export function truncate(text, limit) {
  const t = String(text || '');
  if (t.length <= limit) return t;
  const head = t.slice(0, limit - 1);
  const cut = head.lastIndexOf(' ');
  return (cut >= 0 ? head.slice(0, cut) : head) + '…';
}

export function firstWords(text, n) {
  const ws = String(text || '').split(/\s+/).filter(Boolean);
  return ws.slice(0, n).join(' ') + (ws.length > n ? '…' : '');
}

/** Python re.sub(r"\W+", " ", s.lower()).strip() - used for dedupe keys. */
export function normKey(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, ' ').trim();
}

export function dedupe(items, limit = null) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const key = normKey(item);
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(String(item).trim());
    }
  }
  return limit ? out.slice(0, limit) : out;
}

/** Pydantic StrList: coerce to a list of trimmed non-empty strings. */
export function strList(v) {
  if (v === null || v === undefined) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((x) => String(x).trim()).filter(Boolean);
}

export const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, pyRound(Number(v))));
export const clampNum = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v)));

/** Python's str() of a float in f-strings: 4 -> "4.0", 3.25 -> "3.25". */
export function pyFloat(x) {
  return Number.isInteger(x) ? x.toFixed(1) : String(x);
}

/** Counter.most_common: count desc, ties keep first-seen order. */
export function mostCommon(items, k = Infinity) {
  const counts = new Map();
  for (const it of items) counts.set(it, (counts.get(it) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
}
