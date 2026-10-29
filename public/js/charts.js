// Native SVG charts (no library). Marks follow the data-viz spec: 2px lines,
// <=24px bars with 4px rounded data ends, hairline solid grid, recessive axes,
// a hover/focus tooltip on every mark, a legend for two or more series, and a
// table view for every chart. Text uses text tokens, never series colors.
import { h, clear, fmt, dataTable } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== false) el.setAttribute(k, String(v));
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

// Clean axis ticks (1, 2, 2.5, 5 × 10^n).
export function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw);
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

export const compact = (v) => (Math.abs(v) >= 1000 ? Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v) : fmt.num(v));
export const brlCompact = (v) => `R$${compact(v)}`;
export const pct = (v) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;

// Re-renders the SVG whenever the container width changes.
function responsive(render) {
  const host = h('div', { class: 'chart-body' });
  let last = 0;
  const draw = () => {
    const w = Math.max(260, Math.floor(host.clientWidth || 600));
    if (w === last) return;
    last = w;
    const tooltip = h('div', { class: 'chart-tooltip', role: 'status' });
    clear(host, render(w, tooltip), tooltip);
  };
  const ro = new ResizeObserver(() => draw());
  ro.observe(host);
  queueMicrotask(draw);
  return host;
}

function showTip(tip, host, x, y, head, rows) {
  clear(
    tip,
    h('div', { class: 'tt-head' }, head),
    rows.map((r) => h('div', { class: 'tt-row' }, r.color ? h('span', { class: 'tt-key', style: { background: r.color } }) : null, h('span', { class: 'tt-val' }, r.value), r.name ? h('span', { class: 'tt-name' }, r.name) : null)),
  );
  tip.style.display = 'block';
  const box = host.getBoundingClientRect();
  const tw = tip.offsetWidth;
  tip.style.left = `${Math.min(Math.max(0, x + 12), box.width - tw - 4)}px`;
  tip.style.top = `${Math.max(0, y - 10)}px`;
}
const hideTip = (tip) => (tip.style.display = 'none');

// A rect with 4px rounded data end and a square baseline end.
function barPath(x, y, w, hgt, orientation) {
  const r = Math.min(4, (orientation === 'h' ? hgt : w) / 2, orientation === 'h' ? w : hgt);
  if (orientation === 'v') return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt - r}Q${x + w},${y + hgt} ${x + w - r},${y + hgt}H${x}Z`;
}

export function legend(items) {
  return h('div', { class: 'chart-legend' }, items.map((i) => h('span', {}, h('i', { class: i.kind === 'rect' ? 'legend-rect' : 'legend-line', style: { background: i.color } }), i.label)));
}

// ---------------------------------------------------------------- line chart

// series: [{ label, color, values: [{ x: Date, y }] }]; one shared y-axis.
export function lineChart({ series, yFormat = compact, xFormat = (d) => d.toISOString().slice(0, 10), height = 240, area = true }) {
  return responsive((width, tip) => {
    const m = { t: 12, r: 14, b: 26, l: 48 };
    const iw = width - m.l - m.r;
    const ih = height - m.t - m.b;
    const xs = series[0]?.values.map((v) => v.x) ?? [];
    if (!xs.length) return h('p', { class: 'muted small' }, 'No data for this selection.');
    const x0 = xs[0].getTime();
    const x1 = xs[xs.length - 1].getTime();
    const max = Math.max(...series.flatMap((se) => se.values.map((v) => v.y)), 0);
    const ticks = niceTicks(max);
    const yMax = ticks[ticks.length - 1] || 1;
    const X = (d) => m.l + (x1 === x0 ? iw / 2 : ((d.getTime() - x0) / (x1 - x0)) * iw);
    const Y = (v) => m.t + ih - (v / yMax) * ih;
    const svg = s('svg', { class: 'chart-svg', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': series.map((x) => x.label).join(', ') });
    for (const t of ticks) {
      svg.append(s('line', { class: t === 0 ? 'axis' : 'grid', x1: m.l, x2: m.l + iw, y1: Y(t), y2: Y(t) }));
      svg.append(s('text', { class: 'tick', x: m.l - 6, y: Y(t) + 4, 'text-anchor': 'end' }, yFormat(t)));
    }
    // Roughly one date label per 90px so labels never collide on narrow screens.
    const xTicks = Math.max(2, Math.min(6, xs.length, Math.floor(iw / 90)));
    for (let i = 0; i < xTicks; i++) {
      const d = xs[Math.round((i * (xs.length - 1)) / Math.max(1, xTicks - 1))];
      svg.append(s('text', { class: 'tick', x: X(d), y: height - 8, 'text-anchor': i === 0 ? 'start' : i === xTicks - 1 ? 'end' : 'middle' }, xFormat(d)));
    }
    for (const se of series) {
      const pts = se.values.map((v) => `${X(v.x).toFixed(1)},${Y(v.y).toFixed(1)}`);
      if (area && series.length === 1) svg.append(s('path', { d: `M${X(se.values[0].x)},${Y(0)}L${pts.join('L')}L${X(se.values[se.values.length - 1].x)},${Y(0)}Z`, fill: se.color, 'fill-opacity': 0.1 }));
      svg.append(s('path', { d: `M${pts.join('L')}`, fill: 'none', stroke: se.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      const lastV = se.values[se.values.length - 1];
      svg.append(s('circle', { cx: X(lastV.x), cy: Y(lastV.y), r: 4, fill: se.color, stroke: 'var(--surface)', 'stroke-width': 2 }));
    }
    // Crosshair + one tooltip listing every series at the nearest x.
    const cross = s('line', { class: 'crosshair', y1: m.t, y2: m.t + ih, visibility: 'hidden' });
    const dots = series.map((se) => s('circle', { r: 4, fill: se.color, stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' }));
    svg.append(cross, ...dots);
    const overlay = s('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent', tabindex: 0, 'aria-label': 'Chart values; use left and right arrow keys' });
    let idx = xs.length - 1;
    const showAt = (i, px, py) => {
      idx = Math.max(0, Math.min(xs.length - 1, i));
      const cx = X(xs[idx]);
      cross.setAttribute('x1', cx);
      cross.setAttribute('x2', cx);
      cross.setAttribute('visibility', 'visible');
      series.forEach((se, k) => {
        dots[k].setAttribute('cx', cx);
        dots[k].setAttribute('cy', Y(se.values[idx].y));
        dots[k].setAttribute('visibility', 'visible');
      });
      showTip(tip, svg, px ?? cx, py ?? m.t, xFormat(xs[idx]), series.map((se) => ({ color: se.color, value: yFormat(se.values[idx].y), name: series.length > 1 ? se.label : null })));
    };
    const nearest = (px) => {
      const t = x0 + ((px - m.l) / iw) * (x1 - x0);
      let lo = 0;
      let hi = xs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (xs[mid].getTime() < t) lo = mid + 1;
        else hi = mid;
      }
      return lo > 0 && Math.abs(xs[lo - 1].getTime() - t) < Math.abs(xs[lo].getTime() - t) ? lo - 1 : lo;
    };
    overlay.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect();
      showAt(nearest(e.clientX - r.left), e.clientX - r.left, e.clientY - r.top);
    });
    const hide = () => {
      cross.setAttribute('visibility', 'hidden');
      dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
      hideTip(tip);
    };
    overlay.addEventListener('pointerleave', hide);
    overlay.addEventListener('blur', hide);
    overlay.addEventListener('focus', () => showAt(idx));
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        showAt(idx + (e.key === 'ArrowRight' ? 1 : -1));
      }
    });
    svg.append(overlay);
    return svg;
  });
}

// ---------------------------------------------------------------- column chart (vertical)

// data: [{ label, value, title? }]; one series, slot 1.
export function columnChart({ data, yFormat = compact, valueFormat = yFormat, height = 220, color = 'var(--series-1)', labelEvery = null }) {
  return responsive((width, tip) => {
    if (!data.length) return h('p', { class: 'muted small' }, 'No data for this selection.');
    const m = { t: 12, r: 8, b: 26, l: 48 };
    const iw = width - m.l - m.r;
    const ih = height - m.t - m.b;
    const ticks = niceTicks(Math.max(...data.map((d) => d.value), 0));
    const yMax = ticks[ticks.length - 1] || 1;
    const Y = (v) => m.t + ih - (v / yMax) * ih;
    const band = iw / data.length;
    const bw = Math.max(2, Math.min(24, band - 2));
    const svg = s('svg', { class: 'chart-svg', width, height, viewBox: `0 0 ${width} ${height}` });
    for (const t of ticks) {
      svg.append(s('line', { class: t === 0 ? 'axis' : 'grid', x1: m.l, x2: m.l + iw, y1: Y(t), y2: Y(t) }));
      svg.append(s('text', { class: 'tick', x: m.l - 6, y: Y(t) + 4, 'text-anchor': 'end' }, yFormat(t)));
    }
    const every = labelEvery ?? Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(iw / 56))));
    data.forEach((d, i) => {
      const x = m.l + i * band + (band - bw) / 2;
      const y = Y(d.value);
      const hgt = Math.max(0, m.t + ih - y);
      const mark = s('path', { class: 'mark', d: barPath(x, y, bw, hgt, 'v'), fill: color, tabindex: 0, 'aria-label': `${d.label}: ${valueFormat(d.value)}` });
      const show = () => showTip(tip, svg, x + bw / 2, y, d.title ?? d.label, [{ value: valueFormat(d.value) }]);
      mark.addEventListener('pointerenter', show);
      mark.addEventListener('focus', show);
      mark.addEventListener('pointerleave', () => hideTip(tip));
      mark.addEventListener('blur', () => hideTip(tip));
      // Hit target spans the whole band so thin columns are easy to hover.
      const hit = s('rect', { x: m.l + i * band, y: m.t, width: band, height: ih, fill: 'transparent' });
      hit.addEventListener('pointerenter', show);
      hit.addEventListener('pointerleave', () => hideTip(tip));
      svg.append(hit, mark);
      if (i % every === 0) svg.append(s('text', { class: 'tick', x: x + bw / 2, y: height - 8, 'text-anchor': 'middle' }, d.label));
    });
    return svg;
  });
}

// ---------------------------------------------------------------- bar chart (horizontal)

// data: [{ label, value, note? }]; value labelled at the bar tip.
export function barChart({ data, valueFormat = compact, color = 'var(--series-1)', rowHeight = 30, labelWidth = null }) {
  return responsive((width, tip) => {
    if (!data.length) return h('p', { class: 'muted small' }, 'No data for this selection.');
    const lw = labelWidth ?? Math.min(220, Math.max(70, Math.floor(width * 0.32)));
    const valueRoom = 72;
    const iw = Math.max(40, width - lw - valueRoom - 8);
    const height = data.length * rowHeight + 4;
    const max = Math.max(...data.map((d) => d.value), 0) || 1;
    const svg = s('svg', { class: 'chart-svg', width, height, viewBox: `0 0 ${width} ${height}` });
    svg.append(s('line', { class: 'axis', x1: lw, x2: lw, y1: 0, y2: height }));
    const maxChars = Math.floor((lw - 8) / 6.4);
    data.forEach((d, i) => {
      const y = i * rowHeight + (rowHeight - 18) / 2;
      const w = (d.value / max) * iw;
      const label = d.label.length > maxChars ? `${d.label.slice(0, maxChars - 1)}…` : d.label;
      svg.append(s('text', { x: lw - 8, y: y + 13, 'text-anchor': 'end' }, s('title', {}, d.label), label));
      const mark = s('path', { class: 'mark', d: barPath(lw, y, Math.max(1, w), 18, 'h'), fill: d.color ?? color, tabindex: 0, 'aria-label': `${d.label}: ${valueFormat(d.value)}` });
      const show = () => showTip(tip, svg, lw + w, y, d.label, [{ value: valueFormat(d.value), name: d.note ?? null }]);
      const hit = s('rect', { x: 0, y: i * rowHeight, width, height: rowHeight, fill: 'transparent' });
      for (const el of [mark, hit]) {
        el.addEventListener('pointerenter', show);
        el.addEventListener('pointerleave', () => hideTip(tip));
      }
      mark.addEventListener('focus', show);
      mark.addEventListener('blur', () => hideTip(tip));
      svg.append(hit, mark, s('text', { x: lw + w + 6, y: y + 13 }, valueFormat(d.value)));
    });
    return svg;
  });
}

// ---------------------------------------------------------------- heatmap

// grid[row][col] counts; 7-class sequential ramp with a scale legend.
export function heatmap({ grid, rows, cols, valueFormat = fmt.num, colLabelEvery = 3 }) {
  const max = Math.max(...grid.flat(), 0);
  const cls = (v) => (max === 0 ? 1 : Math.min(7, 1 + Math.floor((v / max) * 6.999)));
  const body = responsive((width, tip) => {
    const m = { t: 4, r: 4, b: 20, l: 36 };
    const cw = (width - m.l - m.r) / cols.length;
    const ch = Math.min(26, Math.max(16, cw));
    const height = m.t + rows.length * ch + m.b;
    const svg = s('svg', { class: 'chart-svg', width, height, viewBox: `0 0 ${width} ${height}` });
    rows.forEach((r, ri) => {
      svg.append(s('text', { x: m.l - 6, y: m.t + ri * ch + ch / 2 + 4, 'text-anchor': 'end' }, r));
      cols.forEach((c, ci) => {
        const v = grid[ri][ci];
        const cell = s('rect', {
          class: 'mark', x: m.l + ci * cw + 1, y: m.t + ri * ch + 1, width: Math.max(1, cw - 2), height: ch - 2, rx: 2,
          fill: `var(--seq-${cls(v)})`, tabindex: ci === 0 ? 0 : -1, 'aria-label': `${r} ${c}: ${valueFormat(v)}`,
        });
        const show = () => showTip(tip, svg, m.l + ci * cw + cw / 2, m.t + ri * ch, `${r} · ${c}`, [{ value: valueFormat(v) }]);
        cell.addEventListener('pointerenter', show);
        cell.addEventListener('focus', show);
        cell.addEventListener('pointerleave', () => hideTip(tip));
        cell.addEventListener('blur', () => hideTip(tip));
        svg.append(cell);
      });
    });
    cols.forEach((c, ci) => {
      if (ci % colLabelEvery === 0) svg.append(s('text', { class: 'tick', x: m.l + ci * cw + cw / 2, y: height - 6, 'text-anchor': 'middle' }, c));
    });
    return svg;
  });
  const scale = h('div', { class: 'chart-legend' }, h('span', {}, '0'), h('span', { class: 'legend-ramp' }, [1, 2, 3, 4, 5, 6, 7].map((i) => h('i', { style: { background: `var(--seq-${i})` } }))), h('span', {}, valueFormat(max)));
  return h('div', { class: 'stack' }, body, scale);
}

// ---------------------------------------------------------------- card

// A chart card with title, provenance (source table + query time), optional
// legend, and a toggle between the chart and its table view.
export function chartCard({ title, subtitle = null }) {
  const body = h('div', { class: 'chart-body' }, h('p', { class: 'muted small' }, 'Loading…'));
  const meta = h('div', { class: 'chart-meta' });
  const toggle = h('button', { class: 'btn btn-sm', type: 'button', 'aria-pressed': 'false' }, 'Table');
  const sub = h('div', { class: 'chart-sub' }, subtitle);
  let tableView = false;
  let current = null;
  const draw = () => {
    if (!current) return;
    clear(body, tableView ? dataTable({ columns: current.table.columns, rows: current.table.rows }) : [current.legend ?? null, current.chart]);
  };
  toggle.addEventListener('click', () => {
    tableView = !tableView;
    toggle.setAttribute('aria-pressed', String(tableView));
    toggle.textContent = tableView ? 'Chart' : 'Table';
    draw();
  });
  const el = h('section', { class: 'card chart-card' }, h('div', { class: 'chart-head' }, h('div', {}, h('h2', { class: 'chart-title' }, title), sub), toggle), body, meta);
  return {
    el,
    loading() {
      body.classList.add('loading');
    },
    error(message) {
      body.classList.remove('loading');
      current = null;
      clear(body, h('div', { class: 'state state-error' }, h('div', {}, h('div', { class: 'state-title' }, 'Chart query failed'), h('div', { class: 'state-detail' }, message))));
    },
    set({ chart, table, legend: lg = null, subtitle: st = null, response }) {
      body.classList.remove('loading');
      current = { chart, table, legend: lg };
      if (st) sub.textContent = st;
      const f = response?.filters;
      clear(
        meta,
        response ? `Source: ${response.source} · ${response.ms} ms` : '',
        f?.ignored?.length ? ` · not applicable here: ${f.ignored.join(', ')}` : '',
      );
      draw();
    },
  };
}
