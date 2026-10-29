// Schema Designer tabs: the database object generator and the partitioning lab.
import { api, watchJob } from '../api.js';
import { h, clear, card, kpi, fmt, badge, errorBox, stateBox, dataTable, confirmDialog, toast, field } from '../ui.js';
import { jobPanel } from '../jobPanel.js';

const TYPE_LABELS = { table: 'Tables', function: 'Functions', view: 'Views', procedure: 'Procedures', trigger: 'Triggers', event: 'Events', index: 'Indexes' };

async function schemaName() {
  return (await api.get('/api/connection')).profile.database;
}

// ---------------------------------------------------------------- objects

export async function objectsTab(root) {
  const summary = h('div', { class: 'stack' }, stateBox('loading', 'Reading information_schema…'));
  const list = h('div', { class: 'stack' });
  const output = h('div', { class: 'stack' });
  root.append(summary, list, output);
  const db = await schemaName();

  async function apply(names) {
    const ok = await confirmDialog({
      title: names ? `Apply ${names.join(', ')}?` : 'Apply all catalog objects?',
      body: [h('p', {}, `CREATE OR REPLACE / IF NOT EXISTS statements run in "${db}" with the admin account. Triggers take effect immediately, also for generation and import jobs.`)],
      confirmLabel: 'Apply', requireText: db,
    });
    if (!ok) return;
    try {
      const r = await api.post('/api/objects/apply', { names: names ?? [], confirm: db });
      const failed = r.results.filter((x) => !x.ok);
      toast(failed.length ? `${failed.length} objects failed` : `${r.results.length} objects applied`, failed.length ? 'error' : 'success');
      clear(output, card('Apply result', dataTable({
        columns: [
          { key: 'name', label: 'Object', render: (x) => h('code', {}, x.name) },
          { key: 'type', label: 'Type' },
          { key: 'ok', label: 'Result', render: (x) => (x.ok ? badge('pass', 'ok') : badge('fail', 'failed')) },
          { key: 'ms', label: 'Time', align: 'right', render: (x) => `${fmt.num(x.ms)} ms` },
          { key: 'error', label: 'Error', render: (x) => x.error?.message ?? '' },
        ],
        rows: r.results,
      })));
      await load();
    } catch (err) {
      clear(output, errorBox(err));
    }
  }

  async function remove(o) {
    const ok = await confirmDialog({ title: `Remove ${o.name}?`, body: `DROP ${o.type.toUpperCase()} IF EXISTS ${o.name}${o.table ? ` ON ${o.table}` : ''}. Only catalog objects can be removed.`, confirmLabel: 'Remove', danger: true, requireText: db });
    if (!ok) return;
    try {
      await api.post(`/api/objects/${o.name}/remove`, { confirm: db });
      toast(`${o.name} removed`, 'success');
      await load();
    } catch (err) {
      toast(err.message, 'error', 8000);
      if (err.details) clear(output, errorBox(err));
    }
  }

  async function showDefinition(o) {
    try {
      const d = await api.get(`/api/objects/${o.name}/definition`);
      clear(output, card(`${o.name} · ${d.file}`, h('p', { class: 'muted' }, o.purpose), o.note ? h('div', { class: 'note' }, o.note) : null, h('pre', { class: 'code' }, d.sql)));
      output.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      clear(output, errorBox(err));
    }
  }

  async function runExample(o, confirmModify = false) {
    if (o.modifiesData && !confirmModify) {
      const ok = await confirmDialog({ title: `Run ${o.name}?`, body: `${o.name} modifies data (idempotent: it recomputes derived values). Example: ${o.example}`, confirmLabel: 'Run' });
      if (!ok) return;
      return runExample(o, true);
    }
    try {
      const r = await api.post(`/api/objects/${o.name}/example`, { confirmModify });
      clear(output, card(`Example: ${o.name}`, h('pre', { class: 'code' }, r.example), h('p', { class: 'small muted' }, `${r.rows.length} rows in ${r.ms} ms (runtime account, max 50 rows shown)`),
        dataTable({ columns: r.columns.map((c) => ({ key: c, label: c })), rows: r.rows, empty: 'No rows' })));
      output.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      clear(output, errorBox(err));
    }
  }

  async function explain(o) {
    try {
      const r = await api.get(`/api/objects/${o.name}/explain`);
      clear(output, card(`EXPLAIN for ${o.name}`, h('p', { class: 'muted' }, o.purpose), h('pre', { class: 'code' }, r.query),
        h('div', { class: r.usesIndex ? 'note' : 'note note-warn' }, r.indexInstalled ? (r.usesIndex ? `The optimizer uses ${o.name} for this query.` : `${o.name} is installed but the optimizer chose another plan.`) : `${o.name} is not installed: this is the plan without it. Apply it and explain again to compare.`),
        dataTable({ columns: [{ key: 'table', label: 'Table' }, { key: 'type', label: 'Access' }, { key: 'key', label: 'Key' }, { key: 'rows', label: 'Rows (est.)', align: 'right', render: (p) => fmt.num(p.rows) }, { key: 'extra', label: 'Extra' }], rows: r.plan })));
      output.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      clear(output, errorBox(err));
    }
  }

  async function load() {
    let s;
    try {
      s = await api.get('/api/objects');
    } catch (err) {
      clear(summary, errorBox(err));
      return;
    }
    clear(summary,
      h('div', { class: 'kpis' }, Object.entries(s.counts).map(([t, c]) => kpi(TYPE_LABELS[t], `${c.installed} / ${c.catalog}`, 'installed / in catalog'))),
      h('div', { class: s.eventScheduler === 'ON' ? 'note' : 'note note-warn' }, h('strong', {}, `event_scheduler = ${s.eventScheduler}. `), s.eventSchedulerHelp),
      h('div', { class: 'row' }, h('button', { class: 'btn btn-primary', on: { click: () => apply(null) } }, 'Apply all objects…'), h('span', { class: 'small muted' }, 'Definitions live in sql/objects/<type>/*.sql; preview any of them before applying.')));
    clear(list, Object.keys(TYPE_LABELS).map((type) => {
      const objs = s.objects.filter((o) => o.type === type);
      if (!objs.length) return null;
      return card(TYPE_LABELS[type], dataTable({
        columns: [
          { key: 'name', label: 'Name', render: (o) => h('code', {}, o.name) },
          { key: 'exists', label: 'Status', value: (o) => (o.exists ? 1 : 0), render: (o) => (o.exists ? badge('completed', type === 'event' && o.details?.status ? `installed · ${o.details.status.toLowerCase()}` : 'installed') : badge('queued', 'not installed')) },
          { key: 'purpose', label: 'Purpose', sortable: false, render: (o) => h('span', { class: 'small', style: { whiteSpace: 'normal', display: 'block', minWidth: '260px' } }, o.purpose) },
          {
            key: 'actions', label: '', sortable: false,
            render: (o) => h('div', { class: 'row' },
              h('button', { class: 'btn btn-sm', on: { click: () => showDefinition(o) } }, 'DDL'),
              o.example ? h('button', { class: 'btn btn-sm', disabled: !o.exists, on: { click: () => runExample(o) } }, 'Run example') : null,
              o.type === 'index' ? h('button', { class: 'btn btn-sm', on: { click: () => explain(o) } }, 'EXPLAIN') : null,
              o.exists ? h('button', { class: 'btn btn-sm', on: { click: () => remove(o) } }, 'Remove') : h('button', { class: 'btn btn-sm btn-primary', on: { click: () => apply([o.name]) } }, 'Apply')),
          },
        ],
        rows: objs,
      }));
    }));
  }
  await load();
}

// ---------------------------------------------------------------- partitioning

export async function partitionTab(root) {
  const planBox = h('div', { class: 'stack' });
  const statusBox = h('div', { class: 'stack' });
  const jobBox = h('div', { class: 'stack' });
  const compareBox = h('div', { class: 'stack' });
  root.append(
    h('div', { class: 'note' }, 'The experiment builds a separate copy of orders partitioned by purchase date. The transactional tables are never partitioned: InnoDB does not allow foreign keys on partitioned tables, and every unique key would have to include the partitioning column.'),
    h('div', { class: 'grid grid-2' }, card('Plan', planBox), card('Experiment table', statusBox, jobBox)),
    card('Pruning comparison', compareBox),
  );
  const db = await schemaName();
  const granularity = h('select', {}, [['month', 'Monthly'], ['quarter', 'Quarterly'], ['year', 'Yearly']].map(([v, l]) => h('option', { value: v }, l)));
  let stopWatch = null;

  async function loadPlan() {
    try {
      const p = await api.get(`/api/partitioning/plan?granularity=${granularity.value}`);
      clear(planBox,
        h('div', { class: 'row' }, field('Partition by purchase', granularity), h('span', { class: 'small muted' }, `${p.partitions} partitions for ${fmt.num(p.sourceRows)} orders (${p.dataRange.from.slice(0, 10)} – ${p.dataRange.to.slice(0, 10)})`)),
        h('ul', { class: 'rule-list' }, p.checks.map((c) => h('li', {}, badge(c.ok ? 'pass' : 'fail', c.ok ? 'ok' : 'check'), h('div', {}, h('div', { class: 'rule-title' }, c.rule), h('div', { class: 'rule-desc' }, c.detail)), h('span', {})))),
        h('details', {}, h('summary', {}, 'Generated DDL'), h('pre', { class: 'code' }, p.ddl)));
    } catch (err) {
      clear(planBox, errorBox(err));
    }
  }
  granularity.addEventListener('change', loadPlan);

  async function loadStatus() {
    let s;
    try {
      s = await api.get('/api/partitioning/status');
    } catch (err) {
      clear(statusBox, errorBox(err));
      return;
    }
    const create = h('button', { class: 'btn btn-primary', disabled: s.exists }, 'Create and copy…');
    create.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Create exp_orders_partitioned?', body: `Creates the partitioned table (${granularity.value}ly) in "${db}" and copies every order into it in resumable units.`, confirmLabel: 'Create', requireText: db });
      if (!ok) return;
      try {
        const r = await api.post('/api/partitioning/create', { granularity: granularity.value, confirm: db });
        follow(r.jobId);
        loadStatus();
      } catch (err) {
        toast(err.message, 'error', 8000);
      }
    });
    const drop = h('button', { class: 'btn btn-danger btn-sm', disabled: !s.exists }, 'Drop experiment…');
    drop.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Drop exp_orders_partitioned?', body: 'Only the experiment table is dropped. The orders table is not touched.', confirmLabel: 'Drop', danger: true, requireText: db });
      if (!ok) return;
      try {
        await api.post('/api/partitioning/drop', { confirm: db });
        toast('Experiment table dropped', 'success');
        loadStatus();
      } catch (err) {
        toast(err.message, 'error', 8000);
      }
    });
    clear(statusBox,
      h('div', { class: 'row' }, create, drop),
      s.exists
        ? [h('p', { class: 'small muted' }, `${s.partitions.length} partitions · ${fmt.bytes(s.bytes)} (InnoDB statistics; may lag right after the copy)`),
          dataTable({ columns: [{ key: 'name', label: 'Partition' }, { key: 'bound', label: 'Less than' }, { key: 'estRows', label: 'Rows (est.)', align: 'right', render: (p) => fmt.num(p.estRows) }, { key: 'bytes', label: 'Size', align: 'right', render: (p) => fmt.bytes(p.bytes) }], rows: s.partitions })]
        : stateBox('empty', 'Not created', 'Pick a granularity in the plan and create the experiment.'));
  }

  function follow(id) {
    stopWatch?.();
    stopWatch = watchJob(id, (job) => {
      clear(jobBox, jobPanel(job, { onChange: () => follow(id) }));
      if (!job.live) {
        stopWatch?.();
        loadStatus();
      }
    });
  }

  function drawCompare() {
    const btn = h('button', { class: 'btn btn-primary btn-sm' }, 'Run comparison');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const r = await api.post('/api/partitioning/compare', { runs: 5 });
        const planText = (p) => p.map((x) => `${x.partitions ? `partitions: ${x.partitions}; ` : ''}${x.type}${x.key ? ` via ${x.key}` : ''}, ~${fmt.num(x.rows)} rows`).join(' | ');
        clear(compareBox, btn, h('p', { class: 'small muted' }, r.note),
          r.cases.map((c) => card(c.label,
            c.identical ? badge('pass', 'identical results') : badge('fail', 'results differ'),
            dataTable({
              columns: [{ key: 'table', label: 'Table' }, { key: 'ms', label: 'Median time', align: 'right' }, { key: 'plan', label: 'Plan (EXPLAIN PARTITIONS)', sortable: false, render: (x) => h('span', { class: 'small' }, x.plan) }],
              rows: [
                { table: 'orders', ms: `${c.regular.medianMs} ms`, plan: planText(c.regular.plan) },
                { table: 'exp_orders_partitioned', ms: `${c.partitioned.medianMs} ms`, plan: planText(c.partitioned.plan) },
              ],
            }))));
      } catch (err) {
        clear(compareBox, btn, errorBox(err));
      } finally {
        btn.disabled = false;
      }
    });
    clear(compareBox, h('p', { class: 'muted' }, 'Runs a date-range aggregate (benefits from pruning) and a lookup by order_id alone (cannot be pruned) on both tables, with EXPLAIN PARTITIONS and median timings.'), btn);
  }

  await Promise.all([loadPlan(), loadStatus()]);
  drawCompare();
  const { jobs } = await api.get('/api/jobs?type=objects&limit=20');
  const copy = jobs.find((j) => j.config?.stage === 'partition-copy');
  if (copy) follow(copy.id);
  return () => stopWatch?.();
}
