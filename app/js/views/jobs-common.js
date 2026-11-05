// Shared pieces for the Jobs pages: section nav, badges, safe external links and small helpers.
import { api } from '../api.js';
import { html, fmtRel, sentence, meter } from '../ui.js';

/** Question categories the AI never answers (only saved values, or the user). */
export const SENSITIVE = new Set(['legal', 'demographic', 'compensation', 'consent']);

export const APP_STATUS = {
  preparing: ['badge-accent', 'Drafting…'],
  needs_review: ['badge-warn', 'Needs your review'],
  approved: ['badge-ok', 'Approved'],
  filling: ['badge-accent', 'Filling form…'],
  filled: ['badge-warn', 'Filled: submit it'],
  submitted: ['badge-ok', 'Submitted'],
  interviewing: ['badge-accent', 'Interviewing'],
  offer: ['badge-ok', 'Offer'],
  rejected: ['', 'Rejected'],
  withdrawn: ['', 'Withdrawn'],
  failed: ['badge-danger', 'Failed'],
};

export function appStatusBadge(status) {
  const [cls, label] = APP_STATUS[status] || ['', sentence(status || 'unknown')];
  return html`<span class="badge ${cls}">${label}</span>`;
}

const REC = {
  apply: ['badge-ok', 'Apply', 'Strong match: worth applying'],
  maybe: ['badge-warn', 'Maybe', 'Partial match: check the gaps'],
  skip: ['', 'Skip', 'Weak match'],
};
export function recBadge(rec) {
  if (!rec) return '';
  const [cls, label, title] = REC[rec] || ['', sentence(rec), ''];
  return html`<span class="badge ${cls}" title="${title}">${label}</span>`;
}

export function scoreBand(score) {
  const s = Number(score) || 0;
  return s >= 70 ? 'hi' : s >= 50 ? 'mid' : 'lo';
}

export const SOURCE_KIND = {
  greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', smartrecruiters: 'SmartRecruiters',
  remotive: 'Remotive', arbeitnow: 'Arbeitnow', manual: 'Added by you',
};

/** Only http(s) links from job boards become clickable; anything else (javascript:, data:) is dropped. */
export function safeUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(String(url), location.href);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

export function extLink(url, label, { cls = '' } = {}) {
  const href = safeUrl(url);
  if (!href) return '';
  return html`<a class="${cls}" href="${href}" target="_blank" rel="noopener noreferrer">${label}<span aria-hidden="true"> ↗</span><span class="sr-only"> (opens in a new tab)</span></a>`;
}

/** "Source: Remotive" style credit, linked back to the original posting as the aggregator's terms ask. */
export function attributionHTML(posting) {
  if (!posting || !posting.attribution) return '';
  const href = safeUrl(posting.url);
  return html`<span class="attribution">${href
    ? html`<a href="${href}" target="_blank" rel="noopener noreferrer">${posting.attribution}<span class="sr-only"> (opens in a new tab)</span></a>`
    : posting.attribution}</span>`;
}

export function workplaceLabel(p) {
  if (!p) return '';
  if (p.workplace) return sentence(p.workplace);
  if (p.remote === true) return 'Remote';
  return '';
}

/** Company · location · workplace · type · posted. */
export function postingMeta(p, { source = true } = {}) {
  if (!p) return '';
  const wp = workplaceLabel(p);
  return html`<div class="item-meta">
    ${p.company ? html`<span class="strong">${p.company}</span>` : ''}
    ${p.location ? html`<span>${p.location}</span>` : ''}
    ${wp ? html`<span class="badge ${p.remote ? 'badge-accent' : ''}">${wp}</span>` : ''}
    ${p.employment_type ? html`<span>${sentence(p.employment_type)}</span>` : ''}
    ${p.salary ? html`<span>${p.salary}</span>` : ''}
    ${p.posted_at ? html`<span>Posted ${fmtRel(p.posted_at)}</span>` : ''}
    ${source && (p.source_label || SOURCE_KIND[p.source]) ? html`<span>via ${p.source_label || SOURCE_KIND[p.source]}</span>` : ''}
  </div>`;
}

export function jobsNav(active, { review = 0 } = {}) {
  const items = [
    ['search', '#/jobs', 'Find jobs'],
    ['applications', '#/jobs/applications', 'Applications'],
    ['sources', '#/jobs/sources', 'Sources'],
    ['profile', '#/jobs/profile', 'Profile'],
  ];
  return html`<nav class="subnav" aria-label="Jobs sections">${items.map(([key, href, label]) => html`<a href="${href}"
    ${key === active ? html`aria-current="page"` : ''}>${label}${key === 'applications' && review ? html`<span class="count" title="Waiting for your review">${review}<span class="sr-only"> to review</span></span>` : ''}</a>`)}</nav>`;
}

export function hitlNote() {
  return html`<p class="hitl"><span aria-hidden="true">🛡</span><span>You stay in control: the app finds jobs and drafts applications from your CV.
    You review and approve each one, and you click <strong>Submit</strong> yourself.</span></p>`;
}

export function loadStats(signal) {
  return api('/api/careers/stats', { signal }).catch((err) => {
    if (err && err.name === 'AbortError') throw err;
    return null;
  });
}

export function reviewCount(stats) {
  const by = (stats && stats.by_status) || {};
  return Number(by.needs_review || 0);
}

/** "3 of 15 approved today" */
export function limitText(stats) {
  if (!stats || stats.daily_limit === undefined || stats.daily_limit === null) return '';
  return `${stats.approved_today || 0} of ${stats.daily_limit} approved today`;
}

/** Split a comma/newline separated field into a clean list. */
export function splitList(text) {
  return String(text || '').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean)
    .filter((s, i, arr) => arr.findIndex((x) => x.toLowerCase() === s.toLowerCase()) === i);
}

export function isEmptyValue(v) {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'boolean') return false;
  return String(v).trim() === '';
}

export function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

/** Local YYYY-MM-DD for <input type=date>. */
export function isoDay(value) {
  if (!value) return '';
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayIso() {
  return isoDay(new Date().toISOString());
}

/** The body of an ApiError (e.g. 409 {detail, blockers}) whether the server nested it under detail or not. */
export function errorBody(err) {
  const body = (err && err.body) || {};
  const nested = body && typeof body.detail === 'object' && body.detail ? body.detail : null;
  const blockers = (Array.isArray(body.blockers) && body.blockers) || (nested && Array.isArray(nested.blockers) && nested.blockers) || [];
  return { blockers: blockers.map((b) => (typeof b === 'string' ? b : (b && (b.label || b.detail)) || JSON.stringify(b))) };
}

/** Questions the user always answers on the employer's form itself (the app never fills them). */
export const FORM_ONLY = new Set(['consent', 'demographic']);

const RUBRIC_STATUS = { met: ['In your CV', '✓'], partial: ['Partly in your CV', '◐'], missing: ['Not in your CV', '–'] };
const PARTS = [['title', 'Title', 35], ['skills', 'Skills', 30], ['location', 'Location', 15], ['seniority', 'Seniority', 10],
  ['keywords', 'Keywords', 5], ['recency', 'Recency', 5]];

function rubricList(items) {
  return html`<ul class="rubric-list">${items.map((it) => {
    const [label, icon] = RUBRIC_STATUS[it.status] || [sentence(it.status || ''), '·'];
    return html`<li class="rb rb-${it.status || 'missing'}"><span class="rb-icon" aria-hidden="true">${icon}</span>
      <div><span class="rb-req">${it.requirement}</span><span class="rb-status">${label}</span>
        ${it.evidence ? html`<q class="rb-ev">${it.evidence}</q>` : ''}${it.note ? html`<span class="subtle small"> (${it.note})</span>` : ''}</div></li>`;
  })}</ul>`;
}

/** Requirement-by-requirement rubric, the rule-based score breakdown and where else the job is listed. */
export function matchExplainHTML(m) {
  if (!m) return '';
  const meta = m.meta || {};
  const rubric = meta.rubric || null;
  const must = (rubric && rubric.must_haves) || [];
  const nice = (rubric && rubric.nice_to_haves) || [];
  const comp = meta.components || null;
  const also = meta.also_in || [];
  if (!must.length && !nice.length && !comp && !also.length) return '';
  const by = meta.reviewed_by === 'model' ? 'Checked requirement by requirement by the AI model; each quote was verified against your CV.'
    : meta.reviewed_by === 'rules' ? 'Checked with built-in rules (no AI model reviewed this one).' : '';
  return html`<div class="match-explain stack-sm">
    ${must.length || nice.length ? html`<div class="rubric">
      ${must.length ? html`<div><div class="section-title">Must-haves</div>${rubricList(must)}</div>` : ''}
      ${nice.length ? html`<div><div class="section-title">Nice to have</div>${rubricList(nice)}</div>` : ''}
    </div>` : ''}
    ${comp ? html`<div><div class="section-title">Rule-based score${m.det_score !== undefined && m.det_score !== null ? ` (${Math.round(m.det_score)})` : ''}</div>
      <div class="stack-sm">${PARTS.filter(([k]) => comp[k] !== undefined).map(([k, label, max]) => html`<div class="score-row">
        <span class="lbl">${label}</span>${meter(Number(comp[k]) || 0, max, { label })}<span class="val">${Math.round(Number(comp[k]) || 0)}<span class="subtle">/${max}</span></span></div>`)}
      ${comp.feedback ? html`<div class="small muted">${Number(comp.feedback) > 0 ? '+' : ''}${Math.round(Number(comp.feedback))} from roles you applied to or dismissed</div>` : ''}</div></div>` : ''}
    ${also.length ? html`<p class="small muted">Also listed in: ${also.join('; ')}</p>` : ''}
    ${by ? html`<p class="small subtle">${by}</p>` : ''}
  </div>`;
}

const WARNING_KIND = {
  ai_directive: ['banner-warn', '⚠', 'Text aimed at AI tools'],
  ai_screening: ['banner-info', 'ℹ', 'AI screening'],
  duplicate: ['banner-warn', '⚠', 'Applied there before'],
  info: ['banner-info', 'ℹ', ''],
};

/** Notes about the posting shown above the review (the server words them as full sentences). */
export function warningsHTML(warnings) {
  const list = (warnings || []).filter((w) => w && (w.text || w.url));
  if (!list.length) return '';
  return html`<div class="stack-sm">${list.map((w) => {
    const [cls, icon, title] = WARNING_KIND[w.kind] || WARNING_KIND.info;
    const href = safeUrl(w.url);
    return html`<div class="banner ${cls}" role="note"><span class="banner-icon" aria-hidden="true">${icon}</span>
      <div class="stack-sm">${title ? html`<strong>${title}</strong>` : ''}
        ${w.text ? html`<span class="small">${w.text}</span>` : ''}
        ${href ? html`<span class="small">${extLink(href, w.kind === 'ai_screening' ? 'Ask for a human review' : 'Open link')}</span>` : ''}</div></div>`;
  })}</div>`;
}
