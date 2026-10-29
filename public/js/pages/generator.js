// Data Generator: configuration with a live estimate, job control with real
// backend progress, the business-rule validation report, and safe cleanup.
import { api, watchJob, getCalibration, setCalibration } from '../api.js';
import { h, clear, card, kpi, field, fmt, badge, errorBox, stateBox, progressBar, confirmDialog, toast, barList, dataTable } from '../ui.js';
import { jobPanel } from '../jobPanel.js';

const VOLUME = [
  ['customers', 'Customers'], ['sellers', 'Sellers'], ['products', 'Products'], ['categories', 'Leaf categories'],
  ['orders', 'Orders'], ['avgItemsPerOrder', 'Avg items per order', 0.1], ['carts', 'Shopping carts'],
  ['promotions', 'Promotions'], ['inventoryMovements', 'Extra stock movements'],
];
const BEHAVIOUR = [
  ['reviewRate', 'Review rate', 0.01, 'Share of delivered items that get a review'],
  ['returnRate', 'Return rate', 0.01, 'Share of delivered orders returned (doubles when late)'],
  ['splitPaymentRate', 'Split payment rate', 0.01, 'Orders paid with voucher + main method'],
  ['promotionRate', 'Promotion attempt rate', 0.01, 'Orders that try a live promotion code'],
];
const LOADING = [
  ['batchSize', 'Batch size', 1, 'Entities per bulk INSERT batch'],
  ['commitInterval', 'Commit interval', 1, 'Entities per transaction (resume granularity)'],
  ['workers', 'Concurrent workers', 1, 'Parallel transactions; uses pooled connections'],
];

export async function render(root, { navigate }) {
  const timers = new Set();
  const later = (fn, ms) => {
    const t = setTimeout(() => (timers.delete(t), fn()), ms);
    timers.add(t);
  };

  const meta = await api.get('/api/generator/presets');
  const inputs = {};
  const num = (key, step = 1) => (inputs[key] = h('input', { class: 'input', type: 'number', name: key, step, min: 0 }));
  const preset = h('select', { name: 'preset' }, [...meta.presets.map((p) => h('option', { value: p.key }, `${p.label} — ≈${fmt.compact(p.totalRows)} rows`)), h('option', { value: 'custom' }, 'Custom')]);
  inputs.seed = h('input', { class: 'input', type: 'number', name: 'seed', min: 0, max: 4294967295 });
  inputs.startDate = h('input', { class: 'input', type: 'date', name: 'startDate' });
  inputs.endDate = h('input', { class: 'input', type: 'date', name: 'endDate' });

  function fill(cfg) {
    for (const [k, el] of Object.entries(inputs)) if (cfg[k] !== undefined) el.value = cfg[k];
  }
  let calibration = getCalibration();
  function readConfig() {
    const cfg = { preset: preset.value };
    for (const [k, el] of Object.entries(inputs)) cfg[k] = el.type === 'number' ? Number(el.value) : el.value;
    if (calibration) {
      const { scaleFactor, basis, computedAt, avgItemsPerOrder, reviewRate, ...profile } = calibration;
      cfg.calibration = profile;
    }
    return cfg;
  }

  const calibrationBox = h('div', { class: 'stack' });
  function drawCalibration() {
    if (!calibration) {
      clear(calibrationBox, h('p', { class: 'muted' }, 'Using built-in distributions. To match an imported dataset, compute a calibration profile in the ', h('a', { href: '#/import' }, 'Import Manager'), '.'));
      return;
    }
    const b = calibration.basis;
    const factor = h('input', { class: 'input', type: 'number', min: 1, max: 500, value: calibration.scaleFactor || 10 });
    const apply = h('button', { class: 'btn btn-sm btn-primary' }, 'Apply scale');
    apply.addEventListener('click', () => {
      const f = Number(factor.value);
      fill({
        orders: Math.round(b.orders * f), customers: Math.round(b.customers * f * 1.05), sellers: Math.max(1, Math.round(b.sellers * f)),
        products: Math.max(1, Math.round(b.products * f)), carts: Math.round(b.orders * f * 0.3), avgItemsPerOrder: Math.min(6, Math.max(1, calibration.avgItemsPerOrder)),
        reviewRate: Math.min(1, calibration.reviewRate), categories: 38,
      });
      preset.value = 'custom';
      updateEstimate();
    });
    const remove = h('button', { class: 'btn btn-sm' }, 'Remove calibration');
    remove.addEventListener('click', () => {
      calibration = null;
      setCalibration(null);
      drawCalibration();
      updateEstimate();
    });
    clear(
      calibrationBox,
      h('div', { class: 'row' }, badge('completed', 'calibrated'), h('span', { class: 'small muted' }, `from ${calibration.source} · ${fmt.num(b.orders)} source orders (${b.firstPurchase?.slice(0, 10)} – ${b.lastPurchase?.slice(0, 10)})`)),
      h('p', { class: 'small muted' }, 'Category mix and prices, payment mix, and customer/seller geography follow the source. Counts below are yours to choose; "Apply scale" sets them to a multiple of the source size.'),
      h('div', { class: 'row' }, field('Scale factor', factor), apply, remove),
    );
  }

  const estimateBox = h('div', { class: 'stack' });
  const startBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Start generation');
  const jobBox = h('div', { class: 'stack' });
  const validationBox = h('div', { class: 'stack' });
  const dangerBox = h('div', { class: 'stack' });
  let lastEstimate = null;
  let estimateSeq = 0;

  async function updateEstimate() {
    const seq = ++estimateSeq;
    try {
      const e = await api.post('/api/generator/estimate', { config: readConfig() });
      if (seq !== estimateSeq) return;
      lastEstimate = e;
      const rows = Object.entries(e.rows).map(([table, n]) => ({ table, n })).sort((a, b) => b.n - a.n);
      clear(
        estimateBox,
        h('div', { class: 'kpis' }, kpi('Estimated rows', fmt.num(e.totalRows), `${rows.filter((r) => r.n > 0).length} tables`), kpi('Estimated storage', fmt.bytes(e.estimatedBytes), 'data + indexes, approximate'), kpi('History', `${fmt.num(e.days)} days`, `${e.leafCategories} leaf categories`)),
        e.exceedsLimit ? h('div', { class: 'note note-bad' }, `Exceeds the server limit GEN_MAX_TOTAL_ROWS (${fmt.num(meta.limits.maxTotalRows)}).`) : null,
        e.requiresConfirmation && !e.exceedsLimit ? h('div', { class: 'note note-warn' }, `Above ${fmt.num(meta.limits.confirmRowsThreshold)} rows: substantial disk, CPU and I/O load. You will be asked to confirm.`) : null,
        h('details', {}, h('summary', {}, 'Rows per table'), dataTable({ columns: [{ key: 'table', label: 'Table', render: (r) => h('code', {}, r.table) }, { key: 'n', label: 'Rows', align: 'right', render: (r) => fmt.num(r.n) }], rows })),
        h('p', { class: 'small muted' }, 'Estimated by running the generator on sampled ids. Payments, shipments, reviews and returns are derived from orders by the business rules, so they are controlled through the rates above.'),
      );
      startBtn.disabled = e.exceedsLimit;
    } catch (err) {
      if (seq !== estimateSeq) return;
      lastEstimate = null;
      startBtn.disabled = true;
      clear(estimateBox, errorBox(err));
    }
  }
  let debounce = null;
  const scheduleEstimate = () => {
    clearTimeout(debounce);
    debounce = setTimeout(updateEstimate, 300);
  };

  preset.addEventListener('change', () => {
    const p = meta.presets.find((x) => x.key === preset.value);
    if (p) fill(p.config);
    updateEstimate();
  });
  for (const el of Object.values(inputs)) {
    el.addEventListener('input', () => {
      preset.value = 'custom';
      scheduleEstimate();
    });
  }

  const form = h(
    'form',
    { class: 'stack', novalidate: true },
    h('div', { class: 'form-grid' }, field('Preset', preset, 'Presets are approximate starting points')),
    h('fieldset', {}, h('legend', {}, 'Volume'), h('div', { class: 'form-grid' }, VOLUME.map(([k, label, step]) => field(label, num(k, step))))),
    h('fieldset', {}, h('legend', {}, 'Business behaviour'), h('div', { class: 'form-grid' }, BEHAVIOUR.map(([k, label, step, help]) => field(label, num(k, step), help)))),
    h('fieldset', {}, h('legend', {}, 'History & reproducibility'), h('div', { class: 'form-grid' }, field('Start date', inputs.startDate), field('End date', inputs.endDate, 'Also the "as-of" date for open orders'), field('Seed', inputs.seed, 'Same seed + config = same dataset'))),
    h('fieldset', {}, h('legend', {}, 'Bulk loading'), h('div', { class: 'form-grid' }, LOADING.map(([k, label, step, help]) => field(label, num(k, step), help)))),
    h('div', { class: 'row' }, startBtn, h('span', { class: 'small muted' }, 'Requires an installed schema with empty data tables.')),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!lastEstimate) return;
    let confirmLargeRun = false;
    if (lastEstimate.requiresConfirmation) {
      confirmLargeRun = await confirmDialog({
        title: 'Start a large generation run?',
        body: [h('p', {}, `About ${fmt.num(lastEstimate.totalRows)} rows and ${fmt.bytes(lastEstimate.estimatedBytes)} will be written to MariaDB with ${inputs.workers.value} concurrent workers.`), h('p', {}, 'This causes sustained disk, CPU and I/O load on the database server.')],
        confirmLabel: 'Start',
        requireText: 'GENERATE',
      });
      if (!confirmLargeRun) return;
    }
    startBtn.disabled = true;
    try {
      const r = await api.post('/api/generator/jobs', { config: readConfig(), confirmLargeRun });
      toast(`Generation job ${fmt.shortId(r.jobId)} started`, 'success');
      await loadJob(r.jobId);
    } catch (err) {
      toast(err.message, 'error', 8000);
      clear(jobBox, errorBox(err));
    } finally {
      startBtn.disabled = false;
    }
  });

  // ---------------------------------------------------------------- job panel
  let stopWatch = null;
  async function loadJob(id) {
    stopWatch?.();
    if (!id) {
      try {
        const list = await api.get('/api/jobs?type=generation&limit=1');
        if (!list.jobs.length) {
          clear(jobBox, stateBox('empty', 'No generation job yet', 'Configure a run on the left and start it.'));
          return;
        }
        id = list.jobs[0].id;
      } catch (err) {
        clear(jobBox, errorBox(err));
        return;
      }
    }
    stopWatch = watchJob(id, (job) => {
      clear(jobBox, jobPanel(job, { onChange: () => loadJob(job.id) }));
      if (!job.live) {
        stopWatch?.();
        if (job.status === 'completed') loadDanger();
      }
    });
  }

  // ---------------------------------------------------------------- validation panel
  async function loadValidation(id) {
    let job;
    try {
      if (!id) {
        const list = await api.get('/api/jobs?type=validation&limit=1');
        if (!list.jobs.length) {
          drawValidation(null);
          return;
        }
        id = list.jobs[0].id;
      }
      job = await api.get(`/api/jobs/${id}`);
    } catch (err) {
      clear(validationBox, errorBox(err));
      return;
    }
    drawValidation(job);
    if (job.live) later(() => loadValidation(job.id), 700);
  }

  function drawValidation(job) {
    const runBtn = h('button', { class: 'btn btn-primary btn-sm', disabled: job?.live }, 'Run validation');
    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      try {
        const r = await api.post('/api/validation/jobs');
        loadValidation(r.jobId);
      } catch (err) {
        toast(err.message, 'error', 8000);
        runBtn.disabled = false;
      }
    });
    const head = h('div', { class: 'card-head' }, h('div', { class: 'row' }, job ? badge(job.status) : null, job ? h('span', { class: 'small muted' }, `${fmt.time(job.createdAt)}`) : null), runBtn);
    if (!job) {
      clear(validationBox, head, stateBox('empty', 'No validation report yet', 'Run validation after generating data to check every business rule against MariaDB.'));
      return;
    }
    if (job.live || !job.result) {
      clear(validationBox, head, progressBar((job.progress?.done || 0) / (job.progress?.total || 1), 'Validation progress'), stateBox('loading', `Checking rule ${job.progress?.done ?? 0} of ${job.progress?.total ?? '…'}`, job.progress?.current));
      return;
    }
    const r = job.result;
    const m = r.profile.metrics || {};
    clear(
      validationBox,
      head,
      r.passed
        ? stateBox('success', `All ${r.counts.pass} business rules pass`, `Checked in ${fmt.duration(r.elapsedMs)}.`)
        : stateBox('error', `${r.counts.fail} rules failed, ${r.counts.error} could not run`, `${r.counts.pass} passed. See violations and sample keys below.`),
      h(
        'ul',
        { class: 'rule-list' },
        r.results.map((x) =>
          h(
            'li',
            {},
            badge(x.status),
            h('div', {}, h('div', { class: 'rule-title' }, `${x.category} · ${x.title}`), h('div', { class: 'rule-desc' }, x.description), x.error ? h('div', { class: 'small' }, `${x.error.code}: ${x.error.message}`) : null, x.sample?.length ? h('div', { class: 'chips' }, x.sample.map((s) => h('span', { class: 'chip' }, s))) : null),
            h('span', { class: 'small muted' }, x.status === 'error' ? `${x.ms} ms` : `${fmt.num(x.violations)} · ${x.ms} ms`),
          ),
        ),
      ),
      h('h3', { class: 'card-title' }, 'Dataset profile'),
      h(
        'div',
        { class: 'kpis' },
        kpi('Avg items / order', fmt.dec(m.avgItemsPerOrder)),
        kpi('Avg order value', fmt.brl(m.avgOrderValue)),
        kpi('Repeat customers', fmt.pct(m.repeatCustomerRate)),
        kpi('Late deliveries', fmt.pct(m.lateDeliveryRate)),
        kpi('Avg delivery', `${fmt.dec(m.avgDeliveryDays, 1)} days`),
        kpi('Return rate', fmt.pct(m.returnRate)),
        kpi('Avg rating', fmt.dec(m.avgRating)),
      ),
      h(
        'div',
        { class: 'grid grid-2' },
        profileBars('Order status', r.profile.orderStatus),
        profileBars('Payment methods', r.profile.paymentMethods),
        profileBars('Review ratings', r.profile.ratings),
        profileBars('Top destination states', r.profile.topStates),
      ),
    );
  }

  function profileBars(title, items) {
    return h('div', { class: 'stack' }, h('strong', {}, title), Array.isArray(items) && items.length ? barList(items) : h('span', { class: 'muted small' }, items?.error || 'no data'));
  }

  // ---------------------------------------------------------------- cleanup
  async function loadDanger() {
    const schema = await api.get('/api/schema/status').catch(() => null);
    if (!schema) return;
    const btn = h('button', { class: 'btn btn-danger', disabled: !schema.installed }, 'Delete generated data…');
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: `Delete all generated data in "${schema.database}"?`,
        body: [h('p', {}, `TRUNCATE runs on ${schema.tables.filter((t) => !['metadata'].includes(t.group) && t.name !== 'data_generation_audit').length} generated tables in this schema only. Job history and data_generation_audit are kept. The schema itself is never dropped.`), h('p', {}, 'This cannot be undone.')],
        confirmLabel: 'Delete data',
        danger: true,
        requireText: schema.database,
      });
      if (!ok) return;
      try {
        const r = await api.post('/api/generator/cleanup', { confirm: schema.database });
        toast(`Truncated ${r.truncated.length} tables`, 'success');
        loadJob();
      } catch (err) {
        toast(err.message, 'error', 8000);
      }
    });
    clear(dangerBox, h('p', { class: 'muted' }, 'Required before starting a new run: generation refuses to write into non-empty tables, which guarantees no duplicate or mixed datasets.'), h('div', {}, btn));
  }

  fill(meta.presets[0].config);
  preset.value = meta.presets[0].key;
  drawCalibration();
  root.append(
    h(
      'div',
      { class: 'grid grid-2' },
      h('div', { class: 'stack' }, card('Configuration', form), card('Calibration', calibrationBox), card('Estimate', estimateBox)),
      h('div', { class: 'stack' }, card('Generation job', jobBox), card('Validation report', validationBox), card('Danger zone', dangerBox)),
    ),
  );
  await Promise.all([updateEstimate(), loadJob(), loadValidation(), loadDanger()]);
  return () => {
    for (const t of timers) clearTimeout(t);
    stopWatch?.();
    clearTimeout(debounce);
  };
}
