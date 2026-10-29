// Import Manager: CSV -> staging (with licence confirmation and live progress),
// cross-file integrity report, staging -> lab tables transform with a repair
// report, and a calibration profile for scaling with synthetic data.
import { api, watchJob, setCalibration } from '../api.js';
import { h, clear, card, field, fmt, badge, errorBox, stateBox, dataTable, toast, confirmDialog, kpi, barList } from '../ui.js';
import { jobPanel } from '../jobPanel.js';

export async function render(root, { navigate }) {
  const stops = new Set();
  const stageBox = h('div', { class: 'stack' }, stateBox('loading', 'Loading…'));
  const stageJobBox = h('div', { class: 'stack' });
  const reportBox = h('div', { class: 'stack' });
  const transformBox = h('div', { class: 'stack' });
  const transformJobBox = h('div', { class: 'stack' });
  const calibrationBox = h('div', { class: 'stack' });
  root.append(
    h(
      'div',
      { class: 'grid grid-2' },
      card('1 · Stage CSV files', stageBox, stageJobBox),
      card('2 · Staging integrity', reportBox),
      card('3 · Transform into lab tables', transformBox, transformJobBox),
      card('4 · Scale with synthetic data', calibrationBox),
    ),
  );
  let schemaName = '';
  let report = null;

  function follow(id, box, after) {
    const stop = watchJob(id, (job) => {
      clear(box, jobPanel(job, { onChange: () => follow(id, box, after) }));
      if (!job.live) {
        stop();
        stops.delete(stop);
        after?.(job);
      }
    });
    stops.add(stop);
  }

  async function latest(stage) {
    const { jobs } = await api.get('/api/jobs?type=import&limit=50');
    return jobs.find((j) => j.config?.stage === stage) || null;
  }

  // ---------------------------------------------------------------- 1. staging
  async function loadStage() {
    let ds;
    try {
      [ds, report] = await Promise.all([api.get('/api/datasets'), api.get('/api/import/staging')]);
      schemaName = (await api.get('/api/connection')).profile.database;
    } catch (err) {
      clear(stageBox, errorBox(err));
      return;
    }
    const present = ds.files.filter((f) => f.present);
    const missingRequired = ds.files.filter((f) => f.required && !f.present);
    const stagedAny = Object.values(report.tables).some((n) => n > 0);
    const licence = h('input', { type: 'checkbox' });
    const replace = h('input', { type: 'checkbox' });
    const confirmInput = h('input', { class: 'input', autocomplete: 'off', placeholder: schemaName });
    const commit = h('input', { class: 'input', type: 'number', value: 5000, min: 100, max: 100000 });
    const batch = h('input', { class: 'input', type: 'number', value: 1000, min: 50, max: 10000 });
    const start = h('button', { class: 'btn btn-primary', disabled: true }, 'Start staging import');
    const sync = () => (start.disabled = !licence.checked || missingRequired.length > 0 || (stagedAny && (!replace.checked || confirmInput.value !== schemaName)));
    [licence, replace, confirmInput].forEach((el) => el.addEventListener('input', sync));
    start.addEventListener('click', async () => {
      start.disabled = true;
      try {
        const r = await api.post('/api/import/jobs', {
          licenseAccepted: true, files: present.map((f) => f.key), replaceStaging: replace.checked, confirm: confirmInput.value,
          config: { commitInterval: Number(commit.value), batchSize: Number(batch.value) },
        });
        toast('Staging import started', 'success');
        follow(r.jobId, stageJobBox, () => loadReport());
      } catch (err) {
        toast(err.message, 'error', 8000);
        clear(stageJobBox, errorBox(err));
        sync();
      }
    });
    clear(
      stageBox,
      h('p', { class: 'muted' }, `${present.length} of ${ds.files.length} Olist files present`, missingRequired.length ? ` · missing required: ${missingRequired.map((f) => f.file).join(', ')}` : '', '. ', h('a', { href: '#/sources' }, 'Manage files')),
      dataTable({
        columns: [
          { key: 'file', label: 'File', render: (f) => h('code', {}, f.file) },
          { key: 'records', label: 'Records', align: 'right', render: (f) => (f.scan ? fmt.num(f.scan.records) : f.present ? 'scanned at start' : '—') },
          { key: 'staged', label: 'Staged rows', align: 'right', render: (f) => fmt.num(report.tables[f.table]) },
        ],
        rows: ds.files,
      }),
      h('label', { class: 'check' }, licence, `I obtained this dataset myself and accept its licence (${ds.source.licence}).`),
      h('div', { class: 'form-grid' }, field('Records per transaction', commit, 'Also the resume granularity'), field('Batch size', batch)),
      stagedAny
        ? h('div', { class: 'stack note note-warn' }, h('label', { class: 'check' }, replace, 'Replace data already in the staging tables of these files'), field(`Type "${schemaName}" to confirm`, confirmInput))
        : null,
      h('div', { class: 'row' }, start),
    );
    sync();
    const job = await latest('staging');
    if (job) follow(job.id, stageJobBox, () => loadReport());
  }

  // ---------------------------------------------------------------- 2. report
  async function loadReport() {
    try {
      report = await api.get('/api/import/staging');
    } catch (err) {
      clear(reportBox, errorBox(err));
      return;
    }
    const clearBtn = h('button', { class: 'btn btn-sm btn-danger', disabled: !Object.values(report.tables).some((n) => n > 0) }, 'Clear staging…');
    clearBtn.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Clear all staging tables?', body: 'Staged CSV rows and rejected-row samples are deleted. Lab tables are not touched. Staging imports can no longer be resumed.', confirmLabel: 'Clear staging', danger: true, requireText: schemaName });
      if (!ok) return;
      try {
        await api.post('/api/import/staging/clear', { confirm: schemaName });
        toast('Staging cleared', 'success');
        await Promise.all([loadStage(), loadReport()]);
      } catch (err) {
        toast(err.message, 'error', 8000);
      }
    });
    clear(
      reportBox,
      h('div', { class: 'card-head' }, h('span', { class: 'muted' }, report.readyForTransform ? 'Required files are staged.' : `Not ready: ${report.missingRequired.join(', ')} empty.`), clearBtn),
      h('div', { class: 'kpis' }, Object.entries(report.tables).map(([t, n]) => kpi(t.replace('stg_olist_', '').replace(/_/g, ' '), fmt.num(n)))),
      report.checks.length
        ? dataTable({
            caption: 'Cross-file checks',
            columns: [
              { key: 'count', label: 'Records', align: 'right', render: (c) => (c.count ? badge(c.severity === 'warn' ? 'interrupted' : 'queued', fmt.num(c.count)) : badge('pass', '0')) },
              { key: 'title', label: 'Check', render: (c) => h('div', {}, c.title, h('div', { class: 'small muted' }, c.consequence)) },
            ],
            rows: report.checks,
          })
        : stateBox('empty', 'Nothing staged yet'),
    );
    drawTransform();
    drawCalibration();
  }

  // ---------------------------------------------------------------- 3. transform
  function drawTransform() {
    const workers = h('input', { class: 'input', type: 'number', value: 2, min: 1, max: 8 });
    const commit = h('input', { class: 'input', type: 'number', value: 2000, min: 100, max: 100000 });
    const seed = h('input', { class: 'input', type: 'number', value: 20180101, min: 0 });
    const start = h('button', { class: 'btn btn-primary', disabled: !report?.readyForTransform }, 'Transform into lab tables');
    start.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Load the staged Olist data into the lab tables?',
        body: [h('p', {}, 'The lab tables must be empty (delete generated data first). Olist records become customers, sellers, product listings, orders, shipments, payments and reviews; missing attributes are synthesized and inconsistencies are repaired and counted.')],
        confirmLabel: 'Start transform',
      });
      if (!ok) return;
      try {
        const r = await api.post('/api/import/transform', { config: { workers: Number(workers.value), commitInterval: Number(commit.value), seed: Number(seed.value) } });
        toast('Transform started', 'success');
        follow(r.jobId, transformJobBox);
      } catch (err) {
        toast(err.message, 'error', 8000);
        clear(transformJobBox, errorBox(err));
      }
    });
    clear(
      transformBox,
      h('p', { class: 'muted' }, 'Runs in foreign-key order with the same exactly-once ledger as the generator, then refreshes inventory balances and the sales summary tables. Afterwards, run validation from the Data Generator page.'),
      h('div', { class: 'form-grid' }, field('Workers', workers), field('Orders per transaction', commit), field('Seed for synthesized attributes', seed)),
      h('div', { class: 'row' }, start, h('button', { class: 'btn btn-sm', on: { click: () => navigate('generator') } }, 'Validation & cleanup')),
    );
  }

  // ---------------------------------------------------------------- 4. calibration
  function drawCalibration() {
    const btn = h('button', { class: 'btn btn-primary btn-sm', disabled: !report?.tables.stg_olist_orders }, 'Compute calibration profile');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const cal = await api.get('/api/import/calibration');
        showCalibration(cal);
      } catch (err) {
        clear(calibrationBox, errorBox(err));
      }
    });
    clear(
      calibrationBox,
      h('p', { class: 'muted' }, 'Derives category mix and median prices, payment mix, customer and seller geography, and basket size from the staged data. The Data Generator then produces datasets of any size with the same distributions. The synthetic dataset replaces lab data; it is not appended to imported rows.'),
      h('div', {}, btn),
    );
  }

  function showCalibration(cal) {
    const factor = h('input', { class: 'input', type: 'number', value: 10, min: 1, max: 500, step: 1 });
    const use = h('button', { class: 'btn btn-primary' }, 'Open in Data Generator');
    use.addEventListener('click', () => {
      setCalibration({ ...cal, scaleFactor: Number(factor.value) });
      navigate('generator');
    });
    const b = cal.basis;
    clear(
      calibrationBox,
      h('div', { class: 'kpis' }, kpi('Orders', fmt.num(b.orders)), kpi('Customers', fmt.num(b.customers)), kpi('Sellers', fmt.num(b.sellers)), kpi('Items / order', fmt.dec(cal.avgItemsPerOrder, 3))),
      h('strong', {}, 'Top categories by items (median price)'),
      barList(cal.categories.slice(0, 10).map((c) => ({ key: `${c.code} · R$${c.medianPrice}`, count: Math.round(c.weight * b.items) }))),
      h('strong', {}, 'Payment methods'),
      barList(Object.entries(cal.paymentMix).filter(([, v]) => v > 0).map(([k, v]) => ({ key: k, count: Math.round(v * 10000) })), { format: () => '' }),
      h('div', { class: 'form-grid' }, field('Scale factor vs. source', factor, 'Orders, customers, sellers and products × factor')),
      h('div', {}, use),
    );
  }

  await loadStage();
  await loadReport();
  const tjob = await latest('transform');
  if (tjob) follow(tjob.id, transformJobBox);
  return () => stops.forEach((s) => s());
}
