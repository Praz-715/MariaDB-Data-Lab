// Performance Lab: configure and run a benchmark scenario, watch it live, read
// the result with its environment snapshot, and compare runs.
import { api, watchJob } from '../api.js';
import { h, clear, card, kpi, field, fmt, badge, errorBox, stateBox, dataTable, confirmDialog, toast, definitionList } from '../ui.js';
import { lineChart, columnChart, barChart, compact } from '../charts.js';

const ms = (v) => (v == null ? '—' : v < 10 ? `${v.toFixed(2)} ms` : `${fmt.num(v)} ms`);
const S1 = 'var(--series-1)';

// Display only: the statement with its bound values inlined, the way a client
// would show it. The server always sends values separately (parameterized).
function inlineValues(sql, values) {
  if (!Array.isArray(values)) return sql;
  let i = 0;
  return sql.replace(/\?/g, () => {
    const v = values[i++];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    const text = String(v);
    const shown = text.length > 40 ? `${text.slice(0, 12)}…(${text.length} chars)` : text;
    return `'${shown.replace(/'/g, "''")}'`;
  });
}

function statementList(statements) {
  return h('div', { class: 'stack' }, statements.map((st) => h('div', {},
    h('div', { class: 'row' }, statements.length > 1 ? badge('queued', st.variant) : null, st.note ? h('span', { class: 'small muted' }, st.note) : null),
    h('pre', { class: 'code wrap' }, st.sql))));
}

export async function render(root, { params }) {
  let meta;
  try {
    meta = await api.get('/api/benchmarks/scenarios');
  } catch (err) {
    root.append(errorBox(err));
    return;
  }
  const L = meta.limits;
  let selected = meta.scenarios[0].key;
  let stopWatch = null;

  const pickBox = h('div', { class: 'grid grid-3' });
  const formBox = h('div', { class: 'stack' });
  const liveBox = h('div', { class: 'stack' });
  const resultBox = h('div', { class: 'stack' });
  const historyBox = h('div', { class: 'stack' });
  const compareBox = h('div', { class: 'stack' });

  root.append(
    h('div', { class: 'note' },
      h('strong', {}, 'Results describe this environment only. '),
      'Hardware, storage, buffer pool size and cache state, indexes, data volume, server configuration (for example innodb_flush_log_at_trx_commit) and the client running inside the Data Lab process all shape the numbers. Every run stores an environment snapshot; compare runs only when it matches. Write scenarios touch only the bench_events scratch table, which is emptied before and after the run.'),
    card('1 · Scenario', pickBox),
    h('div', { class: 'grid grid-2' }, card('2 · Configuration', formBox), card('Live run', liveBox)),
    resultBox,
    card('History', historyBox),
    compareBox,
  );

  function drawPicker() {
    clear(pickBox, meta.scenarios.map((s) => h('button', {
      type: 'button', class: 'card', 'aria-pressed': String(s.key === selected),
      style: { textAlign: 'left', cursor: 'pointer', borderColor: s.key === selected ? 'var(--accent)' : null, boxShadow: s.key === selected ? '0 0 0 2px var(--accent-soft)' : null, font: 'inherit', color: 'inherit' },
      on: { click: () => ((selected = s.key), drawPicker(), drawForm()) },
    }, h('div', { class: 'row' }, h('strong', {}, s.label), badge(s.kind === 'write' ? 'interrupted' : s.kind === 'mixed' ? 'run' : 'queued', s.kind)), h('div', { class: 'small muted', style: { marginTop: '6px' } }, s.description))));
  }

  function drawForm() {
    const s = meta.scenarios.find((x) => x.key === selected);
    const num = (value, attrs = {}) => h('input', { class: 'input', type: 'number', value, ...attrs });
    const concurrency = num(s.defaults.concurrency, { min: 1, max: L.maxConcurrency });
    const mode = h('select', {}, h('option', { value: 'duration' }, 'Duration'), h('option', { value: 'iterations' }, 'Iterations'));
    const duration = num(s.defaults.durationSec, { min: 1, max: L.maxDurationSec });
    const iterations = num(1000, { min: 1 });
    const warmup = num(3, { min: 0, max: 120 });
    const timeout = num(10000, { min: 100, max: 600000, step: 100 });
    const seed = num(1, { min: 0 });
    const label = h('input', { class: 'input', maxlength: 80, placeholder: 'e.g. baseline, after adding index' });
    const paramInputs = Object.fromEntries(Object.entries(s.params).map(([k, p]) => [k, num(p.default, { min: p.min, max: p.max, step: p.step ?? 1 })]));
    const warn = h('div', { class: 'note note-warn', style: { display: 'none' } });
    const syncMode = () => {
      duration.parentElement.style.display = mode.value === 'duration' ? '' : 'none';
      iterations.parentElement.style.display = mode.value === 'iterations' ? '' : 'none';
    };
    const isHeavy = () => Number(concurrency.value) > L.heavyConcurrency || (mode.value === 'duration' && Number(duration.value) > L.heavyDurationSec) || (selected === 'full-scan' && Number(concurrency.value) > 2);
    const syncWarn = () => {
      warn.style.display = isHeavy() ? '' : 'none';
      warn.textContent = `Heavy run: above ${L.heavyConcurrency} connections or ${L.heavyDurationSec} s (or concurrent full scans). Expect sustained CPU, memory and I/O load on the database server; you will be asked to confirm.`;
    };
    [concurrency, duration, mode].forEach((el) => el.addEventListener('input', syncWarn));
    mode.addEventListener('change', syncMode);
    const run = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Run benchmark');
    const form = h('form', { class: 'stack' },
      h('div', { class: 'form-grid' },
        field(`Concurrency (max ${L.maxConcurrency})`, concurrency, 'Connections in a pool dedicated to this run'),
        field('Stop after', mode), field('Duration (s)', duration), field('Iterations (total)', iterations),
        field('Warm-up (s)', warmup, 'Same operations, not measured'), field('Per-statement timeout (ms)', timeout),
        field('Seed', seed, 'Fixes the parameter sequence'), field('Label', label)),
      Object.keys(paramInputs).length ? h('fieldset', {}, h('legend', {}, 'Scenario parameters'), h('div', { class: 'form-grid' }, Object.entries(paramInputs).map(([k, el]) => field(s.params[k].label, el)))) : null,
      warn,
      h('details', {}, h('summary', {}, `SQL executed by this scenario (${s.statements.length} statement${s.statements.length > 1 ? 's' : ''})`),
        h('p', { class: 'small muted' }, 'Each ? is bound to a value drawn from the seeded generator for every operation; values are sent separately from the statement text.'),
        statementList(s.statements)),
      h('div', { class: 'row' }, run));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = {
        scenario: selected, concurrency: Number(concurrency.value), mode: mode.value, durationSec: Number(duration.value), iterations: Number(iterations.value),
        warmupSec: Number(warmup.value), opTimeoutMs: Number(timeout.value), seed: Number(seed.value), label: label.value,
        params: Object.fromEntries(Object.entries(paramInputs).map(([k, el]) => [k, Number(el.value)])),
      };
      if (isHeavy()) {
        const ok = await confirmDialog({
          title: 'Run a heavy benchmark?', danger: true, requireText: 'RUN', confirmLabel: 'Run',
          body: [h('p', {}, `${body.concurrency} concurrent connections${body.mode === 'duration' ? ` for ${body.durationSec} s` : ''} against the configured server.`), h('p', {}, 'Do not run this against a production server.')],
        });
        if (!ok) return;
        body.confirmHeavy = true;
      }
      run.disabled = true;
      try {
        const r = await api.post('/api/benchmarks/runs', body);
        toast('Benchmark started', 'success');
        follow(r.jobId);
      } catch (err) {
        toast(err.message, 'error', 8000);
        clear(liveBox, errorBox(err));
      } finally {
        run.disabled = false;
      }
    });
    clear(formBox, form);
    syncMode();
    syncWarn();
  }

  function follow(id) {
    stopWatch?.();
    stopWatch = watchJob(id, (job) => {
      const p = job.progress || {};
      const tl = (p.timeline || []).filter((x) => !x.partial);
      clear(liveBox,
        h('div', { class: 'row' }, badge(job.status), h('span', { class: 'small muted' }, `${job.config.scenario} · ${p.phase ?? ''}`), job.live ? h('button', { class: 'btn btn-sm btn-danger', on: { click: () => api.post(`/api/jobs/${id}/cancel`).then(() => toast('Stopping after in-flight operations')) } }, 'Cancel') : null),
        h('div', { class: 'kpis' }, kpi('Ops (measured)', fmt.num(p.ops)), kpi('Current ops/s', job.live ? fmt.num(p.opsPerSec) : '—'), kpi('Elapsed', fmt.duration(p.elapsedMs)), kpi('Errors / timeouts', `${fmt.num(p.errors)} / ${fmt.num(p.timeouts)}`)),
        tl.length > 1 ? lineChart({ series: [{ label: 'Ops per second', color: S1, values: tl.map((x) => ({ x: new Date(x.t * 1000), y: x.ops })) }], xFormat: (d) => `${Math.round(d.getTime() / 1000)} s`, height: 180 }) : h('p', { class: 'small muted' }, p.phase === 'warmup' ? 'Warming up (not measured)…' : 'Collecting samples…'),
        liveStatements(job, p.statements || []));
      if (!job.live) {
        stopWatch?.();
        if (job.status === 'completed' || job.status === 'canceled') showResult(job);
        else clear(resultBox, card('Run failed', errorBox({ message: job.errors?.[0]?.message || 'Benchmark failed', details: job.errors?.[0] })));
        loadHistory();
      }
    });
  }

  // The statements the workers are running, each with the last executed values.
  function liveStatements(job, live) {
    const scenario = meta.scenarios.find((x) => x.key === job.config.scenario);
    const byVariant = new Map(live.map((x) => [x.variant, x]));
    const list = scenario?.statements || live.map((x) => ({ variant: x.variant, sql: x.sql }));
    return h('div', { class: 'stack' },
      h('strong', {}, job.live ? 'Statements running now' : 'Statements executed'),
      list.map((st) => {
        const last = byVariant.get(st.variant);
        return h('div', {},
          h('div', { class: 'row' }, badge(last ? 'running' : 'queued', st.variant),
            last ? h('span', { class: 'small muted' }, `last took ${ms(last.ms)}${last.batchRows ? ` for ${fmt.num(last.batchRows)} rows` : ''} · ${fmt.num(last.measured)} measured`) : h('span', { class: 'small muted' }, 'not executed yet')),
          h('pre', { class: 'code wrap' }, last ? inlineValues(last.sql, last.values) : st.sql));
      }),
      h('p', { class: 'small muted' }, 'Last executed statement per variant with its values inlined for display (refreshed every second). The server sends them as bound parameters.'));
  }

  function showResult(job) {
    const r = job.result;
    if (!r) return clear(resultBox);
    const c = job.config;
    const env = r.environment;
    const writes = c.kind !== 'read';
    const hit = r.bufferPool?.hitRatio;
    clear(resultBox, card(`Result · ${c.scenario}${c.label ? ` · ${c.label}` : ''}`,
      h('p', { class: 'small muted' }, `${c.concurrency} connections · ${c.mode === 'duration' ? `${c.durationSec} s` : `${fmt.num(c.iterations)} iterations`} · warm-up ${c.warmupSec} s · seed ${c.seed}${r.stoppedEarly ? ` · stopped early: ${r.stoppedEarly}` : ''}`),
      h('div', { class: 'kpis' },
        kpi('Operations / s', fmt.num(r.opsPerSec), `${fmt.num(r.ops)} ops in ${fmt.duration(r.elapsedMs)}`),
        kpi(writes ? 'Rows written / s' : 'Rows returned / s', fmt.num(writes ? r.rowsWrittenPerSec : r.rowsPerSec)),
        kpi('Mean latency', ms(r.latency.mean)), kpi('Median (p50)', ms(r.latency.p50)), kpi('p95', ms(r.latency.p95)), kpi('p99', ms(r.latency.p99)),
        kpi('Errors', fmt.num(r.errors), `${fmt.num(r.timeouts)} timeouts`),
        kpi('Buffer pool hit ratio', hit == null ? '—' : fmt.pct(hit, 2), hit == null ? 'no reads' : hit > 0.99 ? 'warm: working set cached' : 'cold: reads from disk')),
      Object.keys(r.variants).length > 1 ? [h('strong', {}, 'Per variant'), dataTable({
        columns: [
          { key: 'name', label: 'Variant' }, { key: 'count', label: 'Ops', align: 'right', render: (v) => fmt.num(v.count) }, { key: 'opsPerSec', label: 'Ops/s', align: 'right', render: (v) => fmt.num(v.opsPerSec) },
          { key: 'p50', label: 'p50', align: 'right', render: (v) => ms(v.p50) }, { key: 'p95', label: 'p95', align: 'right', render: (v) => ms(v.p95) }, { key: 'p99', label: 'p99', align: 'right', render: (v) => ms(v.p99) },
        ],
        rows: Object.entries(r.variants).map(([name, v]) => ({ name, ...v })),
      })] : null,
      h('div', { class: 'grid grid-2' },
        h('div', { class: 'stack' }, h('strong', {}, 'Throughput over time (ops/s)'), r.timeline.length > 1 ? lineChart({ series: [{ label: 'Ops per second', color: S1, values: r.timeline.filter((x) => !x.partial).map((x) => ({ x: new Date(x.t * 1000), y: x.ops })) }], xFormat: (d) => `${Math.round(d.getTime() / 1000)} s`, height: 200 }) : h('p', { class: 'muted small' }, 'Run too short for a timeline.')),
        h('div', { class: 'stack' }, h('strong', {}, 'Latency distribution (ops per latency bucket)'), columnChart({ data: r.distribution.map((d) => ({ label: d.ms < 10 ? d.ms.toFixed(1) : String(Math.round(d.ms)), title: `≤ ${d.ms} ms`, value: d.count })), height: 200, yFormat: compact, valueFormat: (v) => `${fmt.num(v)} ops` }))),
      h('details', {}, h('summary', {}, 'Environment snapshot'),
        definitionList([
          ['Server', `${env.server.version} (${env.server.version_comment})`],
          ['Buffer pool', `${fmt.bytes(env.server.innodb_buffer_pool_size)} · ${fmt.pct(env.bufferPool.fillRatio)} filled before the run`],
          ['innodb_flush_log_at_trx_commit', String(env.server.innodb_flush_log_at_trx_commit)],
          ['innodb_flush_method', String(env.server.innodb_flush_method)],
          ['Binary log / sync_binlog', `${env.server.log_bin ? 'on' : 'off'} / ${env.server.sync_binlog}`],
          ['Isolation', String(env.server.transaction_isolation)],
          ['Dataset', `${env.dataset.database} · ${fmt.bytes(env.dataset.totalBytes)} · orders ~${fmt.num(env.dataset.tables.orders?.estRows)}`],
          ['Client', `${env.client.platform} · ${env.client.cpus} CPUs (${env.client.cpuModel}) · Node ${env.client.node}`],
          ['During the run', `${fmt.num(r.bufferPool.readRequests)} page reads, ${fmt.num(r.bufferPool.diskReads)} from disk; ${fmt.bytes(r.bufferPool.logWrittenBytes)} redo log written`],
        ]),
        h('p', { class: 'small muted' }, env.client.note)),
      r.errors || r.timeouts ? h('details', {}, h('summary', {}, 'Error samples'), h('pre', { class: 'code' }, JSON.stringify(job.errors, null, 2))) : null));
  }

  const chosen = new Set();
  async function loadHistory() {
    let runs;
    try {
      ({ runs } = await api.get('/api/benchmarks/runs'));
    } catch (err) {
      clear(historyBox, errorBox(err));
      return;
    }
    const compareBtn = h('button', { class: 'btn btn-sm btn-primary', disabled: chosen.size < 2 }, `Compare selected (${chosen.size})`);
    compareBtn.addEventListener('click', () => compare([...chosen]));
    clear(historyBox,
      h('div', { class: 'row' }, compareBtn, h('span', { class: 'small muted' }, 'Pick 2–8 runs, ideally of the same scenario. The first selected run is the baseline.')),
      dataTable({
        searchable: true,
        columns: [
          { key: 'pick', label: '', sortable: false, render: (x) => h('input', { type: 'checkbox', checked: chosen.has(x.id), 'aria-label': 'Select run', on: { click: (e) => e.stopPropagation(), change: (e) => { if (e.target.checked && chosen.size < 8) chosen.add(x.id); else chosen.delete(x.id); loadHistory(); } } }) },
          { key: 'createdAt', label: 'Started', render: (x) => fmt.time(x.createdAt) },
          { key: 'scenario', label: 'Scenario' },
          { key: 'label', label: 'Label' },
          { key: 'concurrency', label: 'Conn.', align: 'right' },
          { key: 'status', label: 'Status', render: (x) => badge(x.status) },
          { key: 'opsPerSec', label: 'Ops/s', align: 'right', render: (x) => fmt.num(x.opsPerSec) },
          { key: 'p95', label: 'p95', align: 'right', render: (x) => ms(x.p95) },
          { key: 'p99', label: 'p99', align: 'right', render: (x) => ms(x.p99) },
          { key: 'errors', label: 'Errors', align: 'right', render: (x) => fmt.num(x.errors) },
        ],
        rows: runs,
        empty: 'No benchmark runs yet',
        onRowClick: async (x) => showResult(await api.get(`/api/jobs/${x.id}`)),
      }));
  }

  async function compare(ids) {
    let runs;
    try {
      ({ runs } = await api.get(`/api/benchmarks/compare?ids=${ids.join(',')}`));
    } catch (err) {
      clear(compareBox, errorBox(err));
      return;
    }
    runs = runs.filter((x) => x.result);
    if (runs.length < 2) return clear(compareBox, stateBox('empty', 'Pick at least two runs with results'));
    const base = runs[0];
    const name = (x, i) => `${i + 1}. ${x.config.label || x.config.scenario} (${x.config.concurrency}c)`;
    const delta = (v, b, lowerIsBetter) => {
      if (v == null || b == null || b === 0) return '';
      const d = ((v - b) / b) * 100;
      if (Math.abs(d) < 0.05) return ' (±0%)';
      const better = lowerIsBetter ? d < 0 : d > 0;
      return ` (${d > 0 ? '+' : ''}${d.toFixed(1)}% ${better ? 'better' : 'worse'})`;
    };
    const metrics = [
      ['Ops/s', (x) => x.result.opsPerSec, false, (v) => fmt.num(v)],
      ['Rows written/s', (x) => x.result.rowsWrittenPerSec, false, (v) => fmt.num(v)],
      ['p50', (x) => x.result.latency.p50, true, ms], ['p95', (x) => x.result.latency.p95, true, ms], ['p99', (x) => x.result.latency.p99, true, ms],
      ['Errors', (x) => x.result.errors, true, (v) => fmt.num(v)], ['Hit ratio', (x) => x.result.bufferPool?.hitRatio, false, (v) => (v == null ? '—' : fmt.pct(v, 2))],
    ];
    const diffKeys = ['scenario', 'concurrency', 'mode', 'durationSec', 'iterations', 'warmupSec', 'seed'].filter((k) => new Set(runs.map((x) => String(x.config[k]))).size > 1);
    const envKeys = ['innodb_buffer_pool_size', 'innodb_flush_log_at_trx_commit', 'innodb_flush_method', 'sync_binlog', 'version'].filter((k) => new Set(runs.map((x) => String(x.result.environment.server[k]))).size > 1);
    clear(compareBox, card('Comparison',
      new Set(runs.map((x) => x.config.scenario)).size > 1 ? h('div', { class: 'note note-warn' }, 'These runs use different scenarios; differences reflect the workload, not a change in the server.') : null,
      envKeys.length ? h('div', { class: 'note note-warn' }, `Server settings differ between runs: ${envKeys.join(', ')}.`) : null,
      diffKeys.length ? h('p', { class: 'small muted' }, `Configuration differences: ${diffKeys.join(', ')}.`) : null,
      dataTable({
        columns: [{ key: 'metric', label: 'Metric' }, ...runs.map((x, i) => ({ key: `r${i}`, label: name(x, i), align: 'right', sortable: false }))],
        rows: metrics.map(([label, get, lower, f]) => Object.fromEntries([['metric', label], ...runs.map((x, i) => [`r${i}`, `${f(get(x))}${i ? delta(get(x), get(base), lower) : ''}`])])),
      }),
      h('div', { class: 'grid grid-2' },
        h('div', { class: 'stack' }, h('strong', {}, 'Operations per second'), barChart({ data: runs.map((x, i) => ({ label: name(x, i), value: x.result.opsPerSec })), valueFormat: compact })),
        h('div', { class: 'stack' }, h('strong', {}, 'p95 latency (ms)'), barChart({ data: runs.map((x, i) => ({ label: name(x, i), value: x.result.latency.p95 ?? 0 })), valueFormat: (v) => ms(v) })))));
    compareBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  drawPicker();
  drawForm();
  clear(liveBox, stateBox('info', 'No run in progress', 'Pick a scenario and start a run.'));
  await loadHistory();
  const running = (await api.get('/api/jobs?type=benchmark&limit=1')).jobs.find((j) => j.live);
  if (running) follow(running.id);
  else if (params[0]) showResult(await api.get(`/api/jobs/${encodeURIComponent(params[0])}`));
  return () => stopWatch?.();
}
