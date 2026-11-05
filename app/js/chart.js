// Single-series line chart (inline SVG) with crosshair tooltip and keyboard support.
// Follows the dataviz guidance: 2px line, >=8px markers with a 2px surface ring, hairline solid grid,
// one y-axis, end-value label, no legend for a single series, tooltip enhances (the table view is the twin).
import { fmtDay, fmtScore } from './ui.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, parent = null) {
  const node = document.createElementNS(SVG_NS, name);
  Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, String(v)));
  if (parent) parent.appendChild(node);
  return node;
}

/**
 * points: [{x: ISO date string, y: number, label?: string}]
 * opts: {yMin, yMax, yTicks: [..], height, valueLabel, describe}
 * Returns a cleanup function.
 */
export function lineChart(container, points, opts = {}) {
  const { yMin = 1, yMax = 5, yTicks = [1, 2, 3, 4, 5], height = 220, valueLabel = 'Score', describe = '' } = opts;
  const data = points.filter((p) => p && p.y !== null && p.y !== undefined && !Number.isNaN(Number(p.y)));
  container.innerHTML = '';
  container.classList.add('chart');
  container.tabIndex = 0;
  container.setAttribute('role', 'img');
  const latest = data.length ? data[data.length - 1] : null;
  container.setAttribute('aria-label', describe || `${valueLabel} over ${data.length} sessions${latest ? `, latest ${fmtScore(latest.y)} of ${yMax}` : ''}. Full values in the table below.`);

  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  tip.setAttribute('aria-hidden', 'true');
  const svgHolder = document.createElement('div');
  container.append(svgHolder, tip);

  let active = -1;
  let geom = null;

  function draw() {
    const width = Math.max(280, container.clientWidth || 600);
    const m = { top: 14, right: 44, bottom: 30, left: 34 };
    const w = width - m.left - m.right;
    const h = height - m.top - m.bottom;
    const n = data.length;
    const xAt = (i) => m.left + (n <= 1 ? w / 2 : (i / (n - 1)) * w);
    const yAt = (v) => m.top + h - ((Math.max(yMin, Math.min(yMax, v)) - yMin) / (yMax - yMin)) * h;
    geom = { xAt, yAt, m, w, h, width };

    svgHolder.innerHTML = '';
    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, 'aria-hidden': 'true', focusable: 'false' }, svgHolder);

    // Grid + y ticks
    yTicks.forEach((t) => {
      const y = Math.round(yAt(t)) + 0.5;
      el('line', { class: t === yMin ? 'axis-line' : 'grid-line', x1: m.left, x2: m.left + w, y1: y, y2: y }, svg);
      const label = el('text', { class: 'tick', x: m.left - 8, y: y + 4, 'text-anchor': 'end' }, svg);
      label.textContent = String(t);
    });

    // X labels: first, last and a few in between
    if (n) {
      const maxLabels = Math.max(2, Math.floor(w / 90));
      const step = Math.max(1, Math.ceil(n / maxLabels));
      data.forEach((p, i) => {
        if (i % step !== 0 && i !== n - 1) return;
        if (i !== n - 1 && n - 1 - i < step / 2 && i !== 0) return;
        const t = el('text', { class: 'tick', x: xAt(i), y: m.top + h + 18, 'text-anchor': n === 1 ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle' }, svg);
        t.textContent = p.label || fmtDay(p.x);
      });
    }

    if (n >= 2) {
      const line = data.map((p, i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)},${yAt(p.y).toFixed(1)}`).join(' ');
      const area = `${line} L${xAt(n - 1).toFixed(1)},${(m.top + h).toFixed(1)} L${xAt(0).toFixed(1)},${(m.top + h).toFixed(1)} Z`;
      el('path', { class: 'series-area', d: area }, svg);
      el('path', { class: 'series-line', d: line }, svg);
    }
    const cross = el('line', { class: 'crosshair', x1: 0, x2: 0, y1: m.top, y2: m.top + h, visibility: 'hidden' }, svg);
    data.forEach((p, i) => {
      el('circle', { class: `marker${i === active ? ' active' : ''}`, cx: xAt(i), cy: yAt(p.y), r: i === active ? 6 : 4, 'data-i': i }, svg);
    });
    if (latest) {
      const end = el('text', { class: 'end-label', x: xAt(n - 1) + 10, y: yAt(latest.y) + 4 }, svg);
      end.textContent = fmtScore(latest.y);
    }
    // Hit layer: the whole plot is the target; the crosshair snaps to the nearest session.
    const hit = el('rect', { x: m.left - 12, y: m.top, width: w + 24, height: h, fill: 'transparent' }, svg);
    hit.addEventListener('pointermove', (e) => {
      const rect = svg.getBoundingClientRect();
      const scale = width / rect.width;
      const px = (e.clientX - rect.left) * scale;
      let best = 0;
      let bestD = Infinity;
      data.forEach((_, i) => { const d = Math.abs(xAt(i) - px); if (d < bestD) { bestD = d; best = i; } });
      setActive(best, cross);
    });
    hit.addEventListener('pointerleave', () => setActive(-1, cross));
    if (active >= 0) setActive(active, cross);
  }

  function setActive(i, cross) {
    active = i;
    const svg = svgHolder.querySelector('svg');
    if (!svg || !geom) return;
    svg.querySelectorAll('.marker').forEach((c) => {
      const on = Number(c.getAttribute('data-i')) === i;
      c.classList.toggle('active', on);
      c.setAttribute('r', on ? '6' : '4');
    });
    const crossLine = cross || svg.querySelector('.crosshair');
    if (i < 0 || !data[i]) {
      tip.hidden = true;
      if (crossLine) crossLine.setAttribute('visibility', 'hidden');
      return;
    }
    const p = data[i];
    const x = geom.xAt(i);
    if (crossLine) {
      crossLine.setAttribute('x1', String(Math.round(x) + 0.5));
      crossLine.setAttribute('x2', String(Math.round(x) + 0.5));
      crossLine.setAttribute('visibility', 'visible');
    }
    tip.replaceChildren();
    const v = document.createElement('div');
    v.className = 'v';
    const key = document.createElement('i');
    v.append(key, document.createTextNode(`${fmtScore(p.y)} / ${yMax}`));
    const l = document.createElement('div');
    l.className = 'l';
    l.textContent = `${valueLabel} · ${p.label || fmtDay(p.x)}`;
    tip.append(v, l);
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / geom.width;
    tip.style.left = `${Math.min(Math.max(x * scale, 70), rect.width - 70)}px`;
    tip.style.top = `${geom.yAt(p.y) * scale}px`;
    tip.hidden = false;
  }

  container.addEventListener('keydown', (e) => {
    if (!data.length) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); setActive(Math.min(data.length - 1, active + 1)); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); setActive(Math.max(0, active < 0 ? data.length - 1 : active - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(data.length - 1); }
    else if (e.key === 'Escape') setActive(-1);
  });
  container.addEventListener('blur', () => setActive(-1));

  draw();
  let ro = null;
  if ('ResizeObserver' in window) {
    let lastW = container.clientWidth;
    ro = new ResizeObserver(() => {
      if (Math.abs(container.clientWidth - lastW) > 4) { lastW = container.clientWidth; draw(); }
    });
    ro.observe(container);
  }
  return () => { if (ro) ro.disconnect(); };
}
