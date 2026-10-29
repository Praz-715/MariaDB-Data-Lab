// Table Explorer: navigation, structure (columns, keys, indexes, constraints,
// triggers, DDL), bounded browsing with keyset pagination, filters and sorting,
// counts that say whether they are exact, and row relationships.
import { api } from '../api.js';
import { h, clear, card, fmt, badge, errorBox, stateBox, dataTable, definitionList, field, toast } from '../ui.js';

const OPS = [['eq', '='], ['ne', '≠'], ['lt', '<'], ['lte', '≤'], ['gt', '>'], ['gte', '≥'], ['starts', 'starts with'], ['contains', 'contains'], ['between', 'between'], ['isnull', 'is null'], ['notnull', 'is not null']];
const GROUP_ORDER = ['reference', 'master', 'transaction', 'analytics', 'objects', 'staging', 'metadata'];

export async function render(root, { params, navigate }) {
  const nav = h('ul', { class: 'table-nav', 'aria-label': 'Tables' });
  const navFilter = h('input', { class: 'input input-sm', type: 'search', placeholder: 'Find table…', 'aria-label': 'Find table' });
  const main = h('div', { class: 'stack' });
  root.append(h('div', { class: 'explorer' }, h('section', { class: 'card stack' }, navFilter, nav), main));

  let tables = [];
  try {
    ({ tables } = await api.get('/api/explorer/tables'));
  } catch (err) {
    clear(main, errorBox(err));
    return;
  }
  const current = params[0] || null;
  function drawNav() {
    const q = navFilter.value.toLowerCase();
    const items = [];
    for (const g of GROUP_ORDER) {
      const ts = tables.filter((t) => t.group === g && t.name.includes(q));
      if (!ts.length) continue;
      items.push(h('li', { class: 'group' }, g));
      for (const t of ts) {
        items.push(h('li', {}, h('button', { type: 'button', 'aria-current': t.name === current ? 'true' : 'false', on: { click: () => navigate(`explorer/${t.name}`) } }, h('span', {}, t.name), h('span', { class: 'small muted' }, fmt.compact(t.estRows)))));
      }
    }
    clear(nav, items);
  }
  navFilter.addEventListener('input', drawNav);
  drawNav();

  if (!current) {
    clear(main, await home(tables, navigate));
    return;
  }
  let initialFilters = [];
  try {
    initialFilters = params[1] ? JSON.parse(decodeURIComponent(params[1])) : [];
  } catch {
    initialFilters = [];
  }
  await tableView(main, current, initialFilters, navigate);
}

async function home(tables, navigate) {
  const biggest = [...tables].filter((t) => t.group !== 'metadata').sort((a, b) => b.estRows - a.estRows).slice(0, 8);
  let jobs = [];
  try {
    ({ jobs } = await api.get('/api/jobs?limit=8'));
  } catch {
    /* shown as empty */
  }
  const validation = jobs.find((j) => j.type === 'validation' && j.result);
  return [
    card('Largest tables', dataTable({
      columns: [
        { key: 'name', label: 'Table', render: (t) => h('button', { class: 'cell-link', on: { click: () => navigate(`explorer/${t.name}`) } }, t.name) },
        { key: 'estRows', label: 'Rows (estimated)', align: 'right', render: (t) => fmt.num(t.estRows) },
        { key: 'dataBytes', label: 'Data', align: 'right', render: (t) => fmt.bytes(t.dataBytes) },
        { key: 'indexBytes', label: 'Indexes', align: 'right', render: (t) => fmt.bytes(t.indexBytes) },
      ],
      rows: biggest,
    }), h('p', { class: 'small muted' }, 'Row counts here are InnoDB estimates. Open a table for an exact count.')),
    card('Recent jobs', dataTable({
      columns: [
        { key: 'type', label: 'Type' },
        { key: 'status', label: 'Status', render: (j) => badge(j.status) },
        { key: 'createdAt', label: 'Created', render: (j) => fmt.time(j.createdAt) },
        { key: 'rowsProcessed', label: 'Processed', align: 'right', render: (j) => fmt.num(j.rowsProcessed) },
      ],
      rows: jobs,
      onRowClick: (j) => navigate(`jobs/${j.id}`),
      empty: 'No jobs yet',
    })),
    card('Latest validation report', validation
      ? h('div', { class: 'stack' }, h('div', {}, validation.result.passed ? badge('pass', 'all rules pass') : badge('fail', `${validation.result.counts.fail} rules failed`), ` ${fmt.time(validation.createdAt)}`),
        h('p', { class: 'small muted' }, `${validation.result.counts.pass} passed · ${validation.result.counts.fail} failed · ${validation.result.counts.error} errors. Details on the Data Generator page.`))
      : stateBox('empty', 'No validation report yet')),
  ];
}

async function tableView(main, table, initialFilters, navigate) {
  let meta;
  try {
    meta = await api.get(`/api/explorer/tables/${encodeURIComponent(table)}`);
  } catch (err) {
    clear(main, errorBox(err));
    return;
  }
  const head = card(null,
    h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, table), h('div', { class: 'row' }, badge('queued', meta.engine), meta.triggers.length ? badge('interrupted', `${meta.triggers.length} triggers`) : null)),
    countLine(table, meta));
  const tabsEl = h('div', { class: 'tabs', role: 'tablist' });
  const panel = h('div', { class: 'stack' });
  const tabs = [['data', 'Data'], ['structure', 'Structure'], ['ddl', 'DDL']];
  let active = 'data';
  function drawTabs() {
    clear(tabsEl, tabs.map(([k, l]) => h('button', { role: 'tab', 'aria-selected': String(active === k), on: { click: () => ((active = k), drawTabs(), drawPanel()) } }, l)));
  }
  function drawPanel() {
    if (active === 'data') dataPanel(panel, table, meta, initialFilters, navigate);
    else if (active === 'structure') clear(panel, structure(meta, navigate));
    else ddlPanel(panel, table);
  }
  clear(main, head, card(null, tabsEl, panel));
  drawTabs();
  drawPanel();
}

function countLine(table, meta) {
  const out = h('div', { class: 'row small' });
  const exactBtn = h('button', { class: 'btn btn-sm', type: 'button' }, 'Exact count');
  exactBtn.addEventListener('click', async () => {
    exactBtn.disabled = true;
    exactBtn.textContent = 'Counting…';
    try {
      const r = await api.get(`/api/explorer/tables/${encodeURIComponent(table)}/exact-count`);
      clear(out, h('span', {}, h('strong', {}, fmt.num(r.count)), ` rows · exact COUNT(*) in ${fmt.num(r.ms)} ms`));
    } catch (err) {
      toast(err.message, 'error');
      exactBtn.disabled = false;
      exactBtn.textContent = 'Exact count';
    }
  });
  clear(out, h('span', {}, `~${fmt.num(meta.estRows)} rows (InnoDB estimate) · data ${fmt.bytes(meta.dataBytes)} · indexes ${fmt.bytes(meta.indexBytes)}`), exactBtn);
  return out;
}

function dataPanel(panel, table, meta, initialFilters, navigate) {
  const filters = initialFilters.map((f) => ({ ...f }));
  const filterBox = h('div', { class: 'stack' });
  const sortSel = h('select', {}, h('option', { value: '' }, `Primary key (${meta.primaryKey.join(', ')})`), meta.columns.filter((c) => !meta.primaryKey.includes(c.name) || meta.primaryKey[0] !== c.name).map((c) => h('option', { value: c.name }, `${c.name}${meta.sortable.includes(c.name) ? ' (indexed)' : ''}`)));
  const dirSel = h('select', {}, h('option', { value: 'asc' }, 'Ascending'), h('option', { value: 'desc' }, 'Descending'));
  const limitSel = h('select', {}, [25, 50, 100, 200].map((n) => h('option', { value: n, selected: n === 50 }, `${n} rows`)));
  const resultBox = h('div', { class: 'stack' });
  const detailBox = h('div', { class: 'stack' });
  let cursors = [null];
  let page = 0;

  function drawFilters() {
    clear(filterBox,
      filters.map((f, i) => {
        const col = h('select', { 'aria-label': 'Column' }, meta.columns.map((c) => h('option', { value: c.name, selected: c.name === f.column }, c.name)));
        const op = h('select', { 'aria-label': 'Operator' }, OPS.map(([v, l]) => h('option', { value: v, selected: v === f.op }, l)));
        const val = h('input', { class: 'input input-sm', value: f.value ?? '', 'aria-label': 'Value', placeholder: 'value' });
        const val2 = h('input', { class: 'input input-sm', value: f.value2 ?? '', 'aria-label': 'Second value', placeholder: 'and' });
        const sync = () => {
          Object.assign(f, { column: col.value, op: op.value, value: val.value, value2: val2.value });
          val.style.display = ['isnull', 'notnull'].includes(op.value) ? 'none' : '';
          val2.style.display = op.value === 'between' ? '' : 'none';
        };
        [col, op, val, val2].forEach((el) => el.addEventListener('input', sync));
        sync();
        return h('div', { class: 'row' }, col, op, val, val2, h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': 'Remove filter', on: { click: () => (filters.splice(i, 1), drawFilters()) } }, '✕'));
      }),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-sm', type: 'button', disabled: filters.length >= 5, on: { click: () => (filters.push({ column: meta.primaryKey[0], op: 'eq', value: '' }), drawFilters()) } }, '+ Filter'),
        field('Sort by', sortSel), field('Direction', dirSel), field('Page size', limitSel),
        h('button', { class: 'btn btn-primary btn-sm', type: 'button', on: { click: () => ((cursors = [null]), (page = 0), load()) } }, 'Apply'),
        h('button', { class: 'btn btn-sm', type: 'button', on: { click: countFiltered } }, 'Count matching rows')));
  }

  const qs = (cursor) => {
    const p = new URLSearchParams({ limit: limitSel.value, dir: dirSel.value });
    if (sortSel.value) p.set('sort', sortSel.value);
    if (filters.length) p.set('filters', JSON.stringify(filters.map(({ column, op, value, value2 }) => ({ column, op, value, value2 }))));
    if (cursor) p.set('cursor', cursor);
    return p;
  };

  async function countFiltered() {
    try {
      const r = await api.get(`/api/explorer/tables/${encodeURIComponent(table)}/count?${qs(null)}`);
      toast(`${r.capped ? 'More than ' : ''}${fmt.num(r.count)} matching rows (${r.ms} ms)`, 'info', 6000);
    } catch (err) {
      toast(err.message, 'error', 8000);
    }
  }

  async function load() {
    resultBox.style.opacity = '0.5';
    let r;
    try {
      r = await api.get(`/api/explorer/tables/${encodeURIComponent(table)}/rows?${qs(cursors[page])}`);
    } catch (err) {
      resultBox.style.opacity = '';
      clear(resultBox, errorBox(err));
      return;
    }
    resultBox.style.opacity = '';
    cursors[page + 1] = r.nextCursor;
    const fkCols = new Map();
    for (const fk of meta.foreignKeys) if (fk.columns.length === 1) fkCols.set(fk.columns[0], fk);
    const columns = r.columns.map((c) => ({
      key: c, label: c, sortable: false,
      render: (row) => {
        const v = row[c];
        if (v === null) return h('span', { class: 'muted' }, 'NULL');
        const fk = fkCols.get(c);
        if (fk) return h('button', { class: 'cell-link mono-cell', title: `Open ${fk.refTable}`, on: { click: (e) => (e.stopPropagation(), navigate(`explorer/${fk.refTable}/${encodeURIComponent(JSON.stringify([{ column: fk.refColumns[0], op: 'eq', value: String(v) }]))}`)) } }, String(v));
        return String(v).length > 80 ? h('span', { title: String(v) }, `${String(v).slice(0, 80)}…`) : String(v);
      },
    }));
    const plan = r.plan.map((p) => `${p.table}: ${p.type}${p.key ? ` via ${p.key}` : ''}, ~${fmt.num(p.rows)} rows examined${p.extra ? ` (${p.extra})` : ''}`).join('; ');
    clear(resultBox,
      dataTable({ columns, rows: r.rows, empty: 'No rows match', onRowClick: (row) => showRelated(row) }),
      h('div', { class: 'row small' },
        h('button', { class: 'btn btn-sm', disabled: page === 0, on: { click: () => (page--, load()) } }, '← Previous'),
        h('span', { class: 'muted' }, `Page ${page + 1} · ${r.rows.length} rows · ${r.ms} ms`),
        h('button', { class: 'btn btn-sm', disabled: !r.hasMore, on: { click: () => (page++, load()) } }, 'Next →')),
      h('p', { class: 'small muted' }, `Keyset pagination on (${r.sort.keys.join(', ')}) ${r.sort.dir}; no OFFSET scans. Plan: ${plan}`),
      r.notes.map((n) => h('div', { class: 'note note-warn' }, n)));
  }

  async function showRelated(row) {
    const key = meta.primaryKey.map((k) => row[k]);
    clear(detailBox, h('p', { class: 'muted small' }, 'Loading relationships…'));
    try {
      const r = await api.get(`/api/explorer/tables/${encodeURIComponent(table)}/related?key=${encodeURIComponent(JSON.stringify(key))}`);
      const link = (t, f, label) => h('button', { class: 'cell-link', on: { click: () => navigate(`explorer/${t}/${encodeURIComponent(JSON.stringify(f.map((x) => ({ ...x, value: String(x.value) }))))}`) } }, label);
      clear(detailBox, card(`Row ${meta.primaryKey.map((k, i) => `${k}=${key[i]}`).join(', ')}`,
        definitionList(Object.entries(r.row).map(([k, v]) => [k, v === null ? 'NULL' : String(v)])),
        h('strong', {}, 'References'),
        r.parents.length ? h('ul', {}, r.parents.map((p) => h('li', {}, link(p.table, p.filters, p.table), h('span', { class: 'small muted' }, ` via ${p.constraint}`)))) : h('p', { class: 'small muted' }, 'None'),
        h('strong', {}, 'Referenced by'),
        h('ul', {}, r.children.map((c) => h('li', {}, c.count ? link(c.table, c.filters, c.table) : h('span', { class: 'muted' }, c.table), ` · ${c.capped ? '1,000+' : fmt.num(c.count)} rows`, h('span', { class: 'small muted' }, ` via ${c.constraint}`))))));
      detailBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      clear(detailBox, errorBox(err));
    }
  }

  clear(panel, filterBox, resultBox, detailBox);
  drawFilters();
  load();
}

function structure(meta, navigate) {
  const linkTable = (t) => h('button', { class: 'cell-link', on: { click: () => navigate(`explorer/${t}`) } }, t);
  return [
    h('strong', {}, 'Columns'),
    dataTable({
      columns: [
        { key: 'name', label: 'Column', render: (c) => h('code', {}, c.name) },
        { key: 'type', label: 'Type', render: (c) => h('code', {}, c.type) },
        { key: 'nullable', label: 'Null', render: (c) => (c.nullable ? 'yes' : 'no') },
        { key: 'columnKey', label: 'Key', render: (c) => (meta.primaryKey.includes(c.name) ? 'PK' : c.columnKey || '') },
        { key: 'defaultValue', label: 'Default', render: (c) => c.defaultValue ?? '' },
        { key: 'extra', label: 'Extra' },
      ],
      rows: meta.columns,
    }),
    h('strong', {}, `Indexes (${meta.indexes.length})`),
    dataTable({
      columns: [
        { key: 'name', label: 'Index', render: (i) => h('code', {}, i.name) },
        { key: 'columns', label: 'Columns', render: (i) => i.columns.join(', ') },
        { key: 'unique', label: 'Unique', render: (i) => (i.unique ? 'yes' : 'no') },
        { key: 'cardinality', label: 'Cardinality (est.)', align: 'right', render: (i) => fmt.num(i.cardinality) },
      ],
      rows: meta.indexes,
    }),
    h('strong', {}, `Foreign keys (${meta.foreignKeys.length})`),
    dataTable({
      columns: [
        { key: 'name', label: 'Constraint', render: (f) => h('code', {}, f.name) },
        { key: 'columns', label: 'Columns', render: (f) => f.columns.join(', ') },
        { key: 'refTable', label: 'References', render: (f) => h('span', {}, linkTable(f.refTable), ` (${f.refColumns.join(', ')})`) },
        { key: 'onDelete', label: 'On delete' },
      ],
      rows: meta.foreignKeys,
      empty: 'None',
    }),
    h('strong', {}, `Referenced by (${meta.referencedBy.length})`),
    dataTable({
      columns: [
        { key: 'table', label: 'Table', render: (f) => linkTable(f.table) },
        { key: 'columns', label: 'Columns', render: (f) => f.columns.join(', ') },
        { key: 'name', label: 'Constraint', render: (f) => h('code', {}, f.name) },
      ],
      rows: meta.referencedBy,
      empty: 'None',
    }),
    h('strong', {}, `CHECK constraints (${meta.checks.length})`),
    dataTable({ columns: [{ key: 'name', label: 'Constraint', render: (c) => h('code', {}, c.name) }, { key: 'clause', label: 'Clause', render: (c) => h('code', {}, c.clause) }], rows: meta.checks, empty: 'None' }),
    meta.triggers.length ? [h('strong', {}, 'Triggers'), dataTable({ columns: [{ key: 'name', label: 'Trigger' }, { key: 'timing', label: 'Timing' }, { key: 'event', label: 'Event' }], rows: meta.triggers })] : null,
  ];
}

async function ddlPanel(panel, table) {
  clear(panel, h('p', { class: 'muted small' }, 'Loading…'));
  try {
    const r = await api.get(`/api/explorer/tables/${encodeURIComponent(table)}/ddl`);
    clear(panel, h('pre', { class: 'code' }, r.ddl));
  } catch (err) {
    clear(panel, errorBox(err));
  }
}
