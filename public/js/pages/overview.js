// Overview: KPIs from live MariaDB queries, latest jobs, and implementation status.
import { api } from '../api.js';
import { h, clear, card, kpi, fmt, badge, errorBox, stateBox, dataTable, elapsedBetween } from '../ui.js';

const ROADMAP = [
  [1, true, 'Connection manager, 30-table schema, deterministic small-to-XL generator, business-rule validation, job history'],
  [2, true, 'Olist CSV import (streaming, mapping preview, validation, staging, transform), Server-Sent Events progress, calibrated scaling, 10M-row run'],
  [3, true, 'Table Explorer (keyset pagination, filters, relationships), database object generator (views, functions, procedures, triggers, events, query-driven indexes), partitioning lab, analytics dashboard'],
  [4, true, 'Performance Lab (13 scenarios, latency percentiles, environment snapshots, run comparison), read-only SQL diagnostics'],
  [5, true, 'Security hardening and review, HTTP-level tests, XL-scale (50M rows) run and tuning'],
];

export async function render(root, { navigate }) {
  let timer = null;
  const body = h('div', { class: 'stack' }, stateBox('loading', 'Querying MariaDB…'));
  root.append(body);

  async function load() {
    let data;
    try {
      data = await api.get('/api/overview');
    } catch (err) {
      clear(body, errorBox(err, h('button', { class: 'btn', on: { click: () => navigate('connections') } }, 'Open Connections')));
      return;
    }
    if (!data.installed) {
      clear(
        body,
        stateBox('empty', `Schema "${data.schema.database}" is not installed`, 'Create the lab schema before generating data.', h('button', { class: 'btn btn-primary', on: { click: () => navigate('schema') } }, 'Open Schema Designer')),
        roadmap(),
      );
      return;
    }
    const k = data.kpis;
    const live = data.recentJobs.find((j) => j.live && j.type === 'generation');
    const latest = data.recentJobs.find((j) => j.type === 'generation');
    const count = (t) => kpi(t[0].toUpperCase() + t.slice(1), fmt.num(k.counts[t].value), k.counts[t].exact ? 'exact count' : 'estimated (InnoDB statistics)');
    clear(
      body,
      h(
        'div',
        { class: 'kpis' },
        count('customers'),
        count('products'),
        count('sellers'),
        count('orders'),
        kpi('Total revenue', fmt.brl(k.revenue.total), k.revenue.total == null ? 'summary not refreshed yet' : 'excl. canceled · from daily_sales_summary'),
        kpi('Avg order value', fmt.brl(k.revenue.averageOrderValue), `${fmt.num(k.revenue.validOrders)} valid orders`),
        kpi('Database size', fmt.bytes(k.storage.totalBytes), 'data + indexes'),
        kpi('Generated rows', fmt.compact(k.storage.estimatedRows), 'estimated (InnoDB statistics)'),
        kpi('Insert throughput', live ? `${fmt.num(live.progress?.rowsPerSec)}/s` : '—', live ? 'current job, 30 s window' : 'no job running', { muted: !live }),
        kpi('Latest job', latest ? badge(latest.status) : '—', latest ? fmt.time(latest.createdAt) : 'no generation job yet', { muted: !latest }),
      ),
      h(
        'div',
        { class: 'grid grid-2' },
        card(
          'Recent jobs',
          dataTable({
            columns: [
              { key: 'type', label: 'Type' },
              { key: 'status', label: 'Status', render: (j) => badge(j.status) },
              { key: 'createdAt', label: 'Created', render: (j) => fmt.time(j.createdAt) },
              { key: 'rowsProcessed', label: 'Rows', align: 'right', render: (j) => fmt.num(j.rowsProcessed) },
              { key: 'dur', label: 'Duration', align: 'right', value: (j) => elapsedBetween(j.startedAt, j.finishedAt) ?? 0, render: (j) => fmt.duration(elapsedBetween(j.startedAt, j.finishedAt)) },
            ],
            rows: data.recentJobs,
            empty: 'No jobs yet. Start one from the Data Generator.',
            onRowClick: (j) => navigate(`jobs/${j.id}`),
          }),
        ),
        card(
          `Schema objects in ${data.schema.database}`,
          h(
            'div',
            { class: 'kpis' },
            Object.entries(data.schema.objects).map(([name, n]) => kpi(name.replace(/([A-Z])/g, ' $1'), fmt.num(n))),
          ),
        ),
      ),
      roadmap(),
    );
    clearTimeout(timer);
    if (data.activeJobs.length) timer = setTimeout(load, 3000);
  }

  await load();
  return () => clearTimeout(timer);
}

function roadmap() {
  return card(
    'Implementation status',
    h('ul', { class: 'roadmap' }, ROADMAP.map(([n, done, text]) => h('li', {}, badge(done ? 'completed' : 'queued', done ? `Phase ${n} · done` : `Phase ${n} · planned`), h('span', {}, text)))),
  );
}
