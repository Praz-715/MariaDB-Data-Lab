// Visual Analytics: every chart is drawn from a live MariaDB aggregate query.
// One filter row scopes all charts; each card shows its source table and query time.
import { api } from '../api.js';
import { h, clear, field, fmt, errorBox, stateBox, kpi } from '../ui.js';
import { lineChart, columnChart, barChart, heatmap, chartCard, legend, compact, brlCompact, pct } from '../charts.js';

const S1 = 'var(--series-1)';
const S2 = 'var(--series-2)';
const toDate = (s) => new Date(`${String(s).slice(0, 10)}T00:00:00Z`);
const monthLabel = (s) => toDate(s).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
const dayLabel = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit', timeZone: 'UTC' });
const brl = (v) => fmt.brl(v);

function addDays(date, n) {
  const d = toDate(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export async function render(root, { navigate }) {
  let options;
  try {
    options = await api.get('/api/analytics/options');
  } catch (err) {
    root.append(errorBox(err));
    return;
  }
  if (!options.range.from) {
    root.append(stateBox('empty', 'No sales data yet', 'Generate or import data first; charts read the lab tables and summary tables.', h('button', { class: 'btn btn-primary', on: { click: () => navigate('generator') } }, 'Open Data Generator')));
    return;
  }
  const { from: minDate, to: maxDate } = options.range;

  // ---- filter row (one row above everything it scopes)
  const preset = h('select', {}, [['all', 'All data'], ['365', 'Last 365 days'], ['90', 'Last 90 days'], ['30', 'Last 30 days'], ['custom', 'Custom range']].map(([v, l]) => h('option', { value: v }, l)));
  const from = h('input', { class: 'input', type: 'date', value: minDate, min: minDate, max: maxDate });
  const to = h('input', { class: 'input', type: 'date', value: maxDate, min: minDate, max: maxDate });
  const category = h('select', {}, h('option', { value: '' }, 'All categories'), options.categories.map((c) => h('option', { value: c.id }, c.depth === 0 ? `${c.name} (all)` : `   ${c.name}`)));
  const seller = h('select', {}, h('option', { value: '' }, 'All sellers'), options.sellers.map((s) => h('option', { value: s.id }, `${s.name} #${s.id}`)));
  const status = h('select', {}, h('option', { value: '' }, 'All statuses'), options.statuses.map((s) => h('option', { value: s }, s)));
  const region = h('select', {}, h('option', { value: '' }, 'All regions'), options.regions.map((r) => h('option', { value: r }, r)));
  const note = h('p', { class: 'small muted' }, `Data covers ${minDate} to ${maxDate} (the "as-of" date of the dataset). Without category, seller, status or region filters, charts read the summary tables.`);
  preset.addEventListener('change', () => {
    if (preset.value === 'all') {
      from.value = minDate;
      to.value = maxDate;
    } else if (preset.value !== 'custom') {
      to.value = maxDate;
      from.value = addDays(maxDate, -Number(preset.value) + 1) < minDate ? minDate : addDays(maxDate, -Number(preset.value) + 1);
    }
    refresh();
  });
  for (const el of [from, to]) el.addEventListener('change', () => ((preset.value = 'custom'), refresh()));
  for (const el of [category, seller, status, region]) el.addEventListener('change', refresh);

  const kpiRow = h('div', { class: 'kpis' });
  const cards = {
    daily: chartCard({ title: 'Daily sales', subtitle: 'Net revenue per purchase day' }),
    monthly: chartCard({ title: 'Monthly item revenue' }),
    category: chartCard({ title: 'Revenue by product category' }),
    products: chartCard({ title: 'Top 10 products by revenue' }),
    status: chartCard({ title: 'Orders by status' }),
    payments: chartCard({ title: 'Payment methods', subtitle: 'Amount paid' }),
    geography: chartCard({ title: 'Customer geography', subtitle: 'Orders by customer state' }),
    heat: chartCard({ title: 'Order volume by hour and weekday', subtitle: 'Purchase time in UTC' }),
    delivery: chartCard({ title: 'Delivery duration', subtitle: 'Delivered orders by days from purchase' }),
    rates: chartCard({ title: 'Cancellation and return rates' }),
    repeat: chartCard({ title: 'Repeat-purchase trend', subtitle: 'Share of orders from returning customers' }),
    inventory: chartCard({ title: 'Inventory movements', subtitle: 'Units in and out of stock per month' }),
    throughput: chartCard({ title: 'Database insertion throughput', subtitle: 'Latest generation or import job' }),
  };

  root.append(
    h('section', { class: 'card stack' },
      h('div', { class: 'filter-row' }, field('Date range', preset), field('From', from), field('To', to), field('Category', category), field('Seller', seller), field('Status', status), field('Region', region)),
      note),
    kpiRow,
    h('div', { class: 'grid grid-2' }, Object.values(cards).map((c) => c.el)),
  );

  let seq = 0;
  async function load(name, card, draw) {
    const mySeq = seq;
    card.loading();
    const qs = new URLSearchParams({ from: from.value, to: to.value });
    for (const [k, el] of [['category', category], ['seller', seller], ['status', status], ['region', region]]) if (el.value) qs.set(k, el.value);
    try {
      const res = await api.get(`/api/analytics/charts/${name}?${name === 'throughput' ? '' : qs}`);
      if (mySeq === seq) draw(res);
    } catch (err) {
      if (mySeq === seq) card.error(err.message);
    }
  }

  function refresh() {
    seq++;
    const mySeq = seq;
    api.get(`/api/analytics/charts/kpis?${new URLSearchParams(Object.fromEntries([['from', from.value], ['to', to.value], ...[['category', category], ['seller', seller], ['status', status], ['region', region]].filter(([, el]) => el.value).map(([k, el]) => [k, el.value])]))}`)
      .then((r) => {
        if (mySeq !== seq) return;
        const d = r.data;
        clear(kpiRow,
          kpi('Orders', fmt.num(d.orders), `${r.source} · ${r.ms} ms`),
          kpi('Revenue', d.revenue == null ? '—' : `R$ ${fmt.compact(d.revenue)}`, `${fmt.brl(d.revenue)} · excludes canceled`),
          kpi('Average order value', fmt.brl(d.averageOrderValue)),
          kpi('Cancellation rate', fmt.pct(d.cancelRate)),
          kpi('Delivered share', fmt.pct(d.deliveredShare)));
      })
      .catch((err) => clear(kpiRow, errorBox(err)));

    load('sales-daily', cards.daily, (r) => {
      const values = r.data.map((d) => ({ x: toDate(d.date), y: d.revenue }));
      cards.daily.set({
        response: r, subtitle: r.metric,
        chart: lineChart({ series: [{ label: 'Revenue', color: S1, values }], yFormat: brlCompact, xFormat: dayLabel }),
        table: { columns: [{ key: 'date', label: 'Date' }, { key: 'revenue', label: 'Revenue', align: 'right', render: (d) => brl(d.revenue) }, { key: 'orders', label: 'Orders', align: 'right', render: (d) => fmt.num(d.orders) }], rows: r.data },
      });
    });
    load('sales-monthly', cards.monthly, (r) => cards.monthly.set({
      response: r, subtitle: r.metric,
      chart: columnChart({ data: r.data.map((d) => ({ label: monthLabel(d.month), value: d.revenue })), yFormat: brlCompact, valueFormat: brl }),
      table: { columns: [{ key: 'month', label: 'Month' }, { key: 'revenue', label: 'Revenue', align: 'right', render: (d) => brl(d.revenue) }, { key: 'items', label: 'Items', align: 'right', render: (d) => fmt.num(d.items) }], rows: r.data },
    }));
    load('revenue-by-category', cards.category, (r) => cards.category.set({
      response: r, subtitle: r.metric,
      chart: barChart({ data: r.data, valueFormat: brlCompact }),
      table: { columns: [{ key: 'label', label: 'Category' }, { key: 'value', label: 'Revenue', align: 'right', render: (d) => brl(d.value) }], rows: r.data },
    }));
    load('top-products', cards.products, (r) => cards.products.set({
      response: r, subtitle: r.metric,
      chart: barChart({ data: r.data.map((d) => ({ ...d, note: `${fmt.num(d.units)} units` })), valueFormat: brlCompact }),
      table: { columns: [{ key: 'id', label: 'Product', align: 'right' }, { key: 'label', label: 'Name' }, { key: 'units', label: 'Units', align: 'right', render: (d) => fmt.num(d.units) }, { key: 'value', label: 'Revenue', align: 'right', render: (d) => brl(d.value) }], rows: r.data },
    }));
    load('orders-by-status', cards.status, (r) => {
      const total = r.data.reduce((s, d) => s + d.value, 0);
      cards.status.set({
        response: r,
        chart: barChart({ data: r.data.map((d) => ({ ...d, note: pct(total ? d.value / total : 0) })), valueFormat: compact }),
        table: { columns: [{ key: 'label', label: 'Status' }, { key: 'value', label: 'Orders', align: 'right', render: (d) => fmt.num(d.value) }, { key: 'share', label: 'Share', align: 'right', value: (d) => d.value, render: (d) => fmt.pct(total ? d.value / total : 0) }], rows: r.data },
      });
    });
    load('payment-methods', cards.payments, (r) => cards.payments.set({
      response: r,
      chart: barChart({ data: r.data.map((d) => ({ ...d, label: d.label.replace('_', ' '), note: `${fmt.num(d.payments)} payments` })), valueFormat: brlCompact }),
      table: { columns: [{ key: 'label', label: 'Method' }, { key: 'payments', label: 'Payments', align: 'right', render: (d) => fmt.num(d.payments) }, { key: 'value', label: 'Amount', align: 'right', render: (d) => brl(d.value) }], rows: r.data },
    }));
    load('geography', cards.geography, (r) => {
      const top = r.data.slice(0, 12);
      const rest = r.data.slice(12).reduce((s, d) => s + d.value, 0);
      const data = rest ? [...top, { label: `Other (${r.data.length - 12} states)`, value: rest }] : top;
      cards.geography.set({
        response: r,
        chart: barChart({ data: data.map((d) => ({ ...d, note: d.region })), valueFormat: compact, rowHeight: 26 }),
        table: { columns: [{ key: 'label', label: 'State' }, { key: 'region', label: 'Region' }, { key: 'value', label: 'Orders', align: 'right', render: (d) => fmt.num(d.value) }, { key: 'revenue', label: 'Revenue', align: 'right', render: (d) => brl(d.revenue) }], rows: r.data },
      });
    });
    load('hour-weekday', cards.heat, (r) => {
      const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
      cards.heat.set({
        response: r,
        chart: heatmap({ grid: r.data.grid, rows: r.data.weekdays, cols: hours }),
        table: { columns: [{ key: 'day', label: 'Weekday' }, ...hours.map((hr, i) => ({ key: `h${i}`, label: hr, align: 'right' }))], rows: r.data.weekdays.map((day, wi) => Object.fromEntries([['day', day], ...hours.map((_, i) => [`h${i}`, r.data.grid[wi][i]])])) },
      });
    });
    load('delivery-duration', cards.delivery, (r) => {
      const sm = r.summary;
      cards.delivery.set({
        response: r,
        subtitle: sm.delivered ? `Median ${sm.medianDays} days · 90% within ${sm.p90Days} days · ${fmt.pct(sm.late / sm.delivered)} later than estimated` : 'No delivered orders in this selection',
        chart: columnChart({ data: r.data.map((d) => ({ label: d.days === 40 ? '40+' : String(d.days), title: `${d.days === 40 ? '40 or more' : d.days} days`, value: d.value })), yFormat: compact, valueFormat: (v) => `${fmt.num(v)} orders`, labelEvery: 5 }),
        table: { columns: [{ key: 'days', label: 'Days', align: 'right' }, { key: 'value', label: 'Orders', align: 'right', render: (d) => fmt.num(d.value) }, { key: 'late', label: 'Late', align: 'right', render: (d) => fmt.num(d.late) }], rows: r.data },
      });
    });
    load('cancel-return-rates', cards.rates, (r) => cards.rates.set({
      response: r, subtitle: r.metric,
      legend: legend([{ label: 'Cancellation rate', color: S1 }, { label: 'Return rate', color: S2 }]),
      chart: lineChart({ series: [{ label: 'Cancellation rate', color: S1, values: r.data.map((d) => ({ x: toDate(d.month), y: d.cancelRate })) }, { label: 'Return rate', color: S2, values: r.data.map((d) => ({ x: toDate(d.month), y: d.returnRate })) }], yFormat: pct, xFormat: (d) => monthLabel(d.toISOString()) }),
      table: { columns: [{ key: 'month', label: 'Month' }, { key: 'orders', label: 'Orders', align: 'right', render: (d) => fmt.num(d.orders) }, { key: 'cancelRate', label: 'Cancellation', align: 'right', render: (d) => fmt.pct(d.cancelRate) }, { key: 'returnRate', label: 'Returns', align: 'right', render: (d) => fmt.pct(d.returnRate) }], rows: r.data },
    }));
    load('repeat-purchase', cards.repeat, (r) => cards.repeat.set({
      response: r,
      chart: lineChart({ series: [{ label: 'Returning-customer share', color: S1, values: r.data.map((d) => ({ x: toDate(d.month), y: d.share })) }], yFormat: pct, xFormat: (d) => monthLabel(d.toISOString()) }),
      table: { columns: [{ key: 'month', label: 'Month' }, { key: 'orders', label: 'Orders', align: 'right', render: (d) => fmt.num(d.orders) }, { key: 'share', label: 'Returning share', align: 'right', render: (d) => fmt.pct(d.share) }], rows: r.data },
    }));
    load('inventory-movements', cards.inventory, (r) => cards.inventory.set({
      response: r,
      legend: legend([{ label: 'Inbound units', color: S1 }, { label: 'Outbound units', color: S2 }]),
      chart: lineChart({ series: [{ label: 'Inbound units', color: S1, values: r.data.map((d) => ({ x: toDate(d.month), y: d.inbound })) }, { label: 'Outbound units', color: S2, values: r.data.map((d) => ({ x: toDate(d.month), y: d.outbound })) }], xFormat: (d) => monthLabel(d.toISOString()) }),
      table: { columns: [{ key: 'month', label: 'Month' }, { key: 'inbound', label: 'Inbound', align: 'right', render: (d) => fmt.num(d.inbound) }, { key: 'outbound', label: 'Outbound', align: 'right', render: (d) => fmt.num(d.outbound) }], rows: r.data },
    }));
    load('throughput', cards.throughput, (r) => {
      if (!r.data) return cards.throughput.set({ response: r, chart: h('p', { class: 'muted small' }, 'No job with throughput samples yet.'), table: { columns: [], rows: [] } });
      const d = r.data;
      const base = new Date(0);
      cards.throughput.set({
        response: r,
        subtitle: `${d.type} job ${d.jobId.slice(0, 8)} · ${d.status} · ${fmt.num(d.rows)} rows · average ${fmt.num(d.avgRowsPerSec)} rows/s`,
        chart: lineChart({ series: [{ label: 'Rows per second', color: S1, values: d.points.map((p) => ({ x: new Date(base.getTime() + p.t * 1000), y: p.value })) }], xFormat: (x) => `${Math.round(x.getTime() / 1000)} s` }),
        table: { columns: [{ key: 't', label: 'Seconds since first sample', align: 'right' }, { key: 'value', label: 'Rows/s', align: 'right', render: (p) => fmt.num(p.value) }], rows: d.points },
      });
    });
  }

  refresh();
}
