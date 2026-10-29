// DOM helpers and shared components. All dynamic text is inserted with
// textContent (never innerHTML), so server data cannot inject markup.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

// ---------------------------------------------------------------- formatting

const nf = new Intl.NumberFormat('en-US');
export const fmt = {
  num: (n) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '—' : nf.format(Math.round(Number(n)))),
  dec: (n, d = 2) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })),
  pct: (n, d = 1) => (n === null || n === undefined ? '—' : `${(Number(n) * 100).toFixed(d)}%`),
  brl: (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })),
  compact: (n) => (n === null || n === undefined ? '—' : Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(n))),
  bytes(n) {
    if (n === null || n === undefined) return '—';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let v = Number(n);
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
  },
  duration(ms) {
    if (ms === null || ms === undefined) return '—';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  },
  time(v) {
    if (!v) return '—';
    const d = new Date(String(v).replace(' ', 'T') + (String(v).includes('Z') ? '' : 'Z'));
    return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
  },
  shortId: (id) => (id ? String(id).slice(0, 8) : '—'),
};

export function elapsedBetween(start, end) {
  if (!start) return null;
  const s = new Date(String(start).replace(' ', 'T') + 'Z').getTime();
  const e = end ? new Date(String(end).replace(' ', 'T') + 'Z').getTime() : Date.now();
  return e - s;
}

// ---------------------------------------------------------------- feedback

export function toast(message, kind = 'info', timeout = 4500) {
  const box = document.getElementById('toasts');
  const el = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  box.append(el);
  setTimeout(() => el.remove(), timeout);
}

// Modal confirmation. With requireText, the confirm button stays disabled until
// the user types that exact text.
export function confirmDialog({ title, body, confirmLabel = 'Confirm', danger = false, requireText = null }) {
  return new Promise((resolve) => {
    const input = requireText
      ? h('input', { type: 'text', class: 'input', autocomplete: 'off', spellcheck: 'false', 'aria-label': `Type ${requireText} to confirm` })
      : null;
    const ok = h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'submit', value: 'ok', disabled: Boolean(requireText) }, confirmLabel);
    const cancel = h('button', { class: 'btn', type: 'button' }, 'Cancel');
    const dlg = h(
      'dialog',
      { class: 'dialog', 'aria-labelledby': 'dlg-title' },
      h(
        'form',
        { method: 'dialog' },
        h('h2', { id: 'dlg-title' }, title),
        h('div', { class: 'dialog-body' }, body),
        requireText ? h('label', { class: 'field' }, h('span', {}, 'Type ', h('code', {}, requireText), ' to confirm'), input) : null,
        h('div', { class: 'dialog-actions' }, cancel, ok),
      ),
    );
    if (input) input.addEventListener('input', () => (ok.disabled = input.value !== requireText));
    cancel.addEventListener('click', () => dlg.close('cancel'));
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue === 'ok' && (!requireText || input.value === requireText));
      dlg.remove();
    });
    document.body.append(dlg);
    dlg.showModal();
    (input || ok).focus();
  });
}

export function stateBox(kind, title, detail, ...actions) {
  const icons = { loading: '', empty: '○', error: '!', success: '✓', info: 'i' };
  return h(
    'div',
    { class: `state state-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    kind === 'loading' ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : h('span', { class: 'state-icon', 'aria-hidden': 'true' }, icons[kind]),
    h('div', {}, h('div', { class: 'state-title' }, title), detail ? h('div', { class: 'state-detail' }, detail) : null, actions.length ? h('div', { class: 'state-actions' }, actions) : null),
  );
}

export function errorBox(err, ...actions) {
  const d = err?.details;
  const lines = [];
  if (Array.isArray(d)) lines.push(h('ul', { class: 'error-list' }, d.map((x) => h('li', {}, String(x)))));
  else if (d && typeof d === 'object') {
    if (d.code) lines.push(h('div', { class: 'mono small' }, `${d.code}${d.errno ? ` (${d.errno})` : ''}${d.sqlState ? ` SQLSTATE ${d.sqlState}` : ''}`));
    if (d.message && d.message !== err.message) lines.push(h('div', {}, d.message));
    if (d.hint) lines.push(h('div', { class: 'hint' }, d.hint));
  }
  return stateBox('error', err?.message || 'Something went wrong', lines.length ? lines : null, ...actions);
}

// ---------------------------------------------------------------- components

const STATUS_KIND = {
  completed: 'ok', pass: 'ok', running: 'run', paused: 'warn', queued: 'muted', failed: 'bad', fail: 'bad', error: 'bad',
  canceled: 'muted', interrupted: 'warn', delivered: 'ok',
};
export function badge(status, label = status) {
  return h('span', { class: `badge badge-${STATUS_KIND[status] || 'muted'}` }, label);
}

export function card(title, ...children) {
  return h('section', { class: 'card' }, title ? h('h2', { class: 'card-title' }, title) : null, children);
}

export function kpi(label, value, sub, opts = {}) {
  return h('div', { class: 'kpi' }, h('div', { class: 'kpi-label' }, label), h('div', { class: `kpi-value ${opts.muted ? 'muted' : ''}` }, value), sub ? h('div', { class: 'kpi-sub' }, sub) : null);
}

export function progressBar(fraction, label) {
  const pct = Math.max(0, Math.min(1, fraction || 0)) * 100;
  return h(
    'div',
    { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': pct.toFixed(0), 'aria-label': label || 'Progress' },
    h('div', { class: 'progress-fill', style: { width: `${pct}%` } }),
  );
}

// Searchable, sortable table over an in-memory row set (already bounded by the API).
// Cells do not wrap; a column with `wrap: true` wraps long values (e.g. settings strings),
// and `shrink: true` keeps a column as narrow as its content (name/value lists).
const cellClass = (c) => [c.align === 'right' ? 'num' : '', c.wrap ? 'wrap' : '', c.shrink ? 'shrink' : ''].filter(Boolean).join(' ');
export function dataTable({ columns, rows, empty = 'No rows', searchable = false, onRowClick = null, caption = null }) {
  let sortKey = null;
  let sortDir = 1;
  let filter = '';
  const tbody = h('tbody');
  const search = searchable ? h('input', { type: 'search', class: 'input input-sm', placeholder: 'Filter rows…', 'aria-label': 'Filter rows' }) : null;
  const heads = columns.map((c) => {
    const th = h('th', { scope: 'col', class: cellClass(c) }, c.label);
    if (c.sortable !== false) {
      th.tabIndex = 0;
      th.classList.add('sortable');
      const sort = () => {
        sortDir = sortKey === c.key ? -sortDir : 1;
        sortKey = c.key;
        heads.forEach((x) => x.removeAttribute('aria-sort'));
        th.setAttribute('aria-sort', sortDir === 1 ? 'ascending' : 'descending');
        draw();
      };
      th.addEventListener('click', sort);
      th.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), sort()));
    }
    return th;
  });
  function draw() {
    let view = rows;
    if (filter) {
      const f = filter.toLowerCase();
      view = view.filter((r) => columns.some((c) => String(c.value ? c.value(r) : r[c.key] ?? '').toLowerCase().includes(f)));
    }
    if (sortKey) {
      const col = columns.find((c) => c.key === sortKey);
      const get = (r) => (col.value ? col.value(r) : r[sortKey]);
      view = [...view].sort((a, b) => {
        const x = get(a);
        const y = get(b);
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * sortDir;
        return String(x ?? '').localeCompare(String(y ?? '')) * sortDir;
      });
    }
    clear(
      tbody,
      view.length
        ? view.map((r) => {
            const tr = h('tr', {}, columns.map((c) => h('td', { class: cellClass(c) }, c.render ? c.render(r) : String(r[c.key] ?? '—'))));
            if (onRowClick) {
              tr.classList.add('clickable');
              tr.tabIndex = 0;
              tr.addEventListener('click', () => onRowClick(r));
              tr.addEventListener('keydown', (e) => e.key === 'Enter' && onRowClick(r));
            }
            return tr;
          })
        : h('tr', {}, h('td', { colspan: columns.length, class: 'empty-cell' }, empty)),
    );
  }
  if (search) search.addEventListener('input', () => ((filter = search.value), draw()));
  draw();
  return h('div', { class: 'table-wrap' }, search, h('div', { class: 'table-scroll' }, h('table', { class: 'table' }, caption ? h('caption', { class: 'sr-only' }, caption) : null, h('thead', {}, h('tr', {}, heads)), tbody)));
}

// Horizontal bar list for categorical distributions from real query results.
export function barList(items, { format = fmt.num, total = null } = {}) {
  const max = Math.max(1, ...items.map((i) => i.count));
  const sum = total ?? items.reduce((s, i) => s + i.count, 0);
  return h(
    'ul',
    { class: 'bars' },
    items.map((i) =>
      h(
        'li',
        {},
        h('span', { class: 'bar-label' }, i.key),
        h('span', { class: 'bar-track' }, h('span', { class: 'bar-fill', style: { width: `${(i.count / max) * 100}%` } })),
        h('span', { class: 'bar-value' }, `${format(i.count)} · ${fmt.pct(sum ? i.count / sum : 0)}`),
      ),
    ),
  );
}

export function field(label, input, help) {
  const id = input.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  const helpId = help ? `${id}-help` : null;
  if (helpId) input.setAttribute('aria-describedby', helpId);
  return h('div', { class: 'field' }, h('label', { for: id }, label), input, help ? h('div', { class: 'help', id: helpId }, help) : null);
}

export function definitionList(pairs) {
  return h('dl', { class: 'deflist' }, pairs.filter(Boolean).map(([k, v]) => [h('dt', {}, k), h('dd', {}, v ?? '—')]));
}
