// Visual Analytics data. Each chart is one bounded aggregate query against
// MariaDB. When the active filters allow it, charts read the pre-aggregated
// summary tables (daily_sales_summary, monthly_sales_summary); otherwise they
// aggregate the fact tables over the indexed purchase-date range. Every
// response says which source it used, which filters applied, and how long the
// query took.
import { query, describeDbError } from '../db.js';
import { HttpError } from '../http.js';

const TIMEOUT = 30;
const STATUSES = ['created', 'approved', 'shipped', 'delivered', 'canceled', 'unavailable'];
const REGIONS = ['North', 'Northeast', 'Central-West', 'Southeast', 'South'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID = "o.status NOT IN ('canceled', 'unavailable')";

function nextDay(d) {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + 1);
  return x.toISOString().slice(0, 10);
}

export async function parseFilters(qs) {
  const get = (k) => {
    const v = qs.get(k);
    return v === null || v === '' ? null : v;
  };
  const f = { from: get('from'), to: get('to'), category: get('category'), seller: get('seller'), status: get('status'), region: get('region') };
  for (const k of ['from', 'to']) if (f[k] && (!DATE_RE.test(f[k]) || Number.isNaN(Date.parse(f[k])))) throw new HttpError(400, `${k} must be YYYY-MM-DD`);
  if (f.status && !STATUSES.includes(f.status)) throw new HttpError(400, 'Unknown status');
  if (f.region && !REGIONS.includes(f.region)) throw new HttpError(400, 'Unknown region');
  for (const k of ['category', 'seller']) if (f[k] && !/^\d{1,10}$/.test(f[k])) throw new HttpError(400, `${k} must be a numeric id`);
  if (!f.from || !f.to) {
    const [r] = await query('SELECT MIN(sales_date) AS lo, MAX(sales_date) AS hi FROM daily_sales_summary');
    f.from ??= r.lo ?? '2000-01-01';
    f.to ??= r.hi ?? new Date().toISOString().slice(0, 10);
  }
  if (f.to < f.from) throw new HttpError(400, 'to must not precede from');
  // A top-level category stands for all of its leaves.
  f.categoryIds = f.category ? (await query('SELECT category_id AS id FROM product_categories WHERE category_id = ? OR parent_category_id = ?', [f.category, f.category])).map((r) => r.id) : null;
  if (f.category && !f.categoryIds.length) throw new HttpError(400, 'Unknown category');
  f.itemLevel = Boolean(f.categoryIds || f.seller);
  return f;
}

// Order-level scope: purchase-date range plus status, region and item filters.
function orderScope(f, { ignoreStatus = false } = {}) {
  const joins = [];
  const where = ['o.purchased_at >= ?', 'o.purchased_at < ?'];
  const params = [f.from, nextDay(f.to)];
  const applied = ['date'];
  if (f.status && !ignoreStatus) {
    where.push('o.status = ?');
    params.push(f.status);
    applied.push('status');
  }
  if (f.region) {
    joins.push('JOIN customer_addresses fa ON fa.customer_id = o.customer_id AND fa.address_seq = o.shipping_address_seq JOIN geographic_locations fg ON fg.location_id = fa.location_id');
    where.push('fg.region = ?');
    params.push(f.region);
    applied.push('region');
  }
  if (f.itemLevel) {
    const cond = [];
    if (f.categoryIds) {
      cond.push(`fp.category_id IN (${f.categoryIds.map(() => '?').join(',')})`);
      params.push(...f.categoryIds);
      applied.push('category');
    }
    if (f.seller) {
      cond.push('fp.seller_id = ?');
      params.push(f.seller);
      applied.push('seller');
    }
    where.push(`EXISTS (SELECT 1 FROM order_items fi JOIN products fp ON fp.product_id = fi.product_id WHERE fi.order_id = o.order_id AND ${cond.join(' AND ')})`);
  }
  return { joins: joins.join(' '), where: where.join(' AND '), params, applied };
}

// Item-level product condition (for charts that aggregate order lines).
function productScope(f) {
  const where = [];
  const params = [];
  if (f.categoryIds) {
    where.push(`p.category_id IN (${f.categoryIds.map(() => '?').join(',')})`);
    params.push(...f.categoryIds);
  }
  if (f.seller) {
    where.push('p.seller_id = ?');
    params.push(f.seller);
  }
  return { where, params };
}

async function run(sql, params) {
  const t0 = Date.now();
  try {
    const rows = await query(`SET STATEMENT max_statement_time = ${TIMEOUT} FOR ${sql}`, params);
    return { rows, ms: Date.now() - t0 };
  } catch (err) {
    const d = describeDbError(err);
    throw new HttpError(d.code === 'ER_STATEMENT_TIMEOUT' ? 504 : 502, `Chart query failed: ${d.message}`, d);
  }
}

const n = (v) => (v == null ? 0 : Number(v));
const ALL = ['date', 'category', 'seller', 'status', 'region'];
function envelope(f, source, applied, ms, data, extra = {}) {
  const requested = ALL.filter((k) => (k === 'date' ? true : k === 'category' ? f.category : f[k]));
  return { source, ms, filters: { applied, ignored: requested.filter((k) => !applied.includes(k)) }, data, ...extra };
}

const CHARTS = {
  async kpis(f) {
    if (!f.itemLevel && !f.status && !f.region) {
      const { rows: [r], ms } = await run(
        `SELECT SUM(orders_count) AS orders, SUM(canceled_orders) AS canceled, SUM(delivered_orders) AS delivered, SUM(net_revenue) AS revenue,
                SUM(items_sold) AS items FROM daily_sales_summary WHERE sales_date BETWEEN ? AND ?`,
        [f.from, f.to],
      );
      const valid = n(r.orders) - n(r.canceled);
      return envelope(f, 'daily_sales_summary', ['date'], ms, {
        orders: n(r.orders), revenue: n(r.revenue), averageOrderValue: valid ? n(r.revenue) / valid : null,
        cancelRate: n(r.orders) ? n(r.canceled) / n(r.orders) : null, deliveredShare: n(r.orders) ? n(r.delivered) / n(r.orders) : null, items: n(r.items),
      });
    }
    const s = orderScope(f);
    const { rows: [r], ms } = await run(
      `SELECT COUNT(*) AS orders, SUM(o.status IN ('canceled', 'unavailable')) AS canceled, SUM(o.status = 'delivered') AS delivered,
              SUM(IF(${VALID}, o.total_amount, 0)) AS revenue FROM orders o ${s.joins} WHERE ${s.where}`,
      s.params,
    );
    const valid = n(r.orders) - n(r.canceled);
    return envelope(f, 'orders', s.applied, ms, {
      orders: n(r.orders), revenue: n(r.revenue), averageOrderValue: valid ? n(r.revenue) / valid : null,
      cancelRate: n(r.orders) ? n(r.canceled) / n(r.orders) : null, deliveredShare: n(r.orders) ? n(r.delivered) / n(r.orders) : null, items: null,
    }, { metric: 'Order totals of orders matching the filters' });
  },

  async 'sales-daily'(f) {
    if (!f.itemLevel && !f.status && !f.region) {
      const { rows, ms } = await run('SELECT sales_date AS d, net_revenue AS revenue, orders_count AS orders FROM daily_sales_summary WHERE sales_date BETWEEN ? AND ? ORDER BY sales_date', [f.from, f.to]);
      return envelope(f, 'daily_sales_summary', ['date'], ms, rows.map((r) => ({ date: r.d, revenue: n(r.revenue), orders: n(r.orders) })), { metric: 'Net revenue (excludes canceled and unavailable orders)' });
    }
    const s = orderScope(f);
    const { rows, ms } = await run(
      `SELECT DATE(o.purchased_at) AS d, SUM(IF(${VALID}, o.total_amount, 0)) AS revenue, COUNT(*) AS orders FROM orders o ${s.joins} WHERE ${s.where} GROUP BY d ORDER BY d`,
      s.params,
    );
    return envelope(f, 'orders', s.applied, ms, rows.map((r) => ({ date: r.d, revenue: n(r.revenue), orders: n(r.orders) })), { metric: 'Order totals of matching orders (excludes canceled and unavailable)' });
  },

  async 'sales-monthly'(f) {
    if (!f.seller && !f.status && !f.region) {
      const cat = f.categoryIds ? ` AND category_id IN (${f.categoryIds.map(() => '?').join(',')})` : '';
      const { rows, ms } = await run(
        `SELECT month_start AS m, SUM(revenue) AS revenue, SUM(items_sold) AS items FROM monthly_sales_summary
          WHERE month_start BETWEEN ? AND ?${cat} GROUP BY month_start ORDER BY month_start`,
        [`${f.from.slice(0, 7)}-01`, f.to, ...(f.categoryIds || [])],
      );
      return envelope(f, 'monthly_sales_summary', f.categoryIds ? ['date', 'category'] : ['date'], ms, rows.map((r) => ({ month: r.m, revenue: n(r.revenue), items: n(r.items) })), { metric: 'Item revenue by purchase month (whole months)' });
    }
    const s = orderScope({ ...f, categoryIds: null, seller: null, itemLevel: false });
    const p = productScope(f);
    const { rows, ms } = await run(
      `SELECT DATE_FORMAT(o.purchased_at, '%Y-%m-01') AS m, SUM(i.quantity * i.unit_price) AS revenue, SUM(i.quantity) AS items
         FROM orders o ${s.joins} JOIN order_items i ON i.order_id = o.order_id JOIN products p ON p.product_id = i.product_id
        WHERE ${s.where} AND ${VALID}${p.where.length ? ` AND ${p.where.join(' AND ')}` : ''} GROUP BY m ORDER BY m`,
      [...s.params, ...p.params],
    );
    return envelope(f, 'order_items', [...s.applied, ...(f.categoryIds ? ['category'] : []), ...(f.seller ? ['seller'] : [])], ms, rows.map((r) => ({ month: r.m, revenue: n(r.revenue), items: n(r.items) })), { metric: 'Item revenue by purchase month' });
  },

  async 'revenue-by-category'(f) {
    const group = (rows, ms, source, applied) => {
      const sorted = rows.map((r) => ({ id: r.id, label: r.label, value: n(r.revenue) })).sort((a, b) => b.value - a.value);
      const top = sorted.slice(0, 12);
      const rest = sorted.slice(12).reduce((s, r) => s + r.value, 0);
      if (rest > 0) top.push({ id: null, label: `Other (${sorted.length - 12} categories)`, value: rest });
      return envelope(f, source, applied, ms, top, { metric: 'Item revenue' });
    };
    if (!f.seller && !f.status && !f.region) {
      const cat = f.categoryIds ? ` AND m.category_id IN (${f.categoryIds.map(() => '?').join(',')})` : '';
      const { rows, ms } = await run(
        `SELECT c.category_id AS id, c.category_name AS label, SUM(m.revenue) AS revenue FROM monthly_sales_summary m JOIN product_categories c ON c.category_id = m.category_id
          WHERE m.month_start BETWEEN ? AND ?${cat} GROUP BY c.category_id, c.category_name`,
        [`${f.from.slice(0, 7)}-01`, f.to, ...(f.categoryIds || [])],
      );
      return group(rows, ms, 'monthly_sales_summary', f.categoryIds ? ['date', 'category'] : ['date']);
    }
    const s = orderScope({ ...f, categoryIds: null, seller: null, itemLevel: false });
    const p = productScope(f);
    const { rows, ms } = await run(
      `SELECT c.category_id AS id, c.category_name AS label, SUM(i.quantity * i.unit_price) AS revenue
         FROM orders o ${s.joins} JOIN order_items i ON i.order_id = o.order_id JOIN products p ON p.product_id = i.product_id JOIN product_categories c ON c.category_id = p.category_id
        WHERE ${s.where} AND ${VALID}${p.where.length ? ` AND ${p.where.join(' AND ')}` : ''} GROUP BY c.category_id, c.category_name`,
      [...s.params, ...p.params],
    );
    return group(rows, ms, 'order_items', [...s.applied, ...(f.categoryIds ? ['category'] : []), ...(f.seller ? ['seller'] : [])]);
  },

  async 'top-products'(f) {
    const s = orderScope({ ...f, categoryIds: null, seller: null, itemLevel: false });
    const p = productScope(f);
    // Aggregate by product_id first and join names for the top 10 only: grouping
    // by the wide product_name over every order line was 3-4x slower at 10M rows.
    const { rows, ms } = await run(
      `SELECT t.id, pp.product_name AS label, t.revenue, t.units
         FROM (SELECT i.product_id AS id, SUM(i.quantity * i.unit_price) AS revenue, SUM(i.quantity) AS units
                 FROM orders o ${s.joins} JOIN order_items i ON i.order_id = o.order_id${p.where.length ? ' JOIN products p ON p.product_id = i.product_id' : ''}
                WHERE ${s.where} AND ${VALID}${p.where.length ? ` AND ${p.where.join(' AND ')}` : ''}
                GROUP BY i.product_id ORDER BY revenue DESC LIMIT 10) t
         JOIN products pp ON pp.product_id = t.id
        ORDER BY t.revenue DESC`,
      [...s.params, ...p.params],
    );
    return envelope(f, 'order_items', [...s.applied, ...(f.categoryIds ? ['category'] : []), ...(f.seller ? ['seller'] : [])], ms, rows.map((r) => ({ id: r.id, label: r.label, value: n(r.revenue), units: n(r.units) })), { metric: 'Item revenue' });
  },

  async 'orders-by-status'(f) {
    const s = orderScope(f, { ignoreStatus: true });
    const { rows, ms } = await run(`SELECT o.status AS label, COUNT(*) AS value FROM orders o ${s.joins} WHERE ${s.where} GROUP BY o.status ORDER BY value DESC`, s.params);
    return envelope(f, 'orders', s.applied, ms, rows.map((r) => ({ label: r.label, value: n(r.value) })), { metric: 'Orders' });
  },

  async 'payment-methods'(f) {
    const s = orderScope(f);
    const { rows, ms } = await run(
      `SELECT y.payment_method AS label, COUNT(*) AS payments, SUM(y.amount) AS amount FROM orders o ${s.joins} JOIN payments y ON y.order_id = o.order_id
        WHERE ${s.where} GROUP BY y.payment_method ORDER BY amount DESC`,
      s.params,
    );
    return envelope(f, 'payments', s.applied, ms, rows.map((r) => ({ label: r.label, value: n(r.amount), payments: n(r.payments) })), { metric: 'Amount paid' });
  },

  async geography(f) {
    const s = orderScope(f);
    const join = f.region ? '' : 'JOIN customer_addresses fa ON fa.customer_id = o.customer_id AND fa.address_seq = o.shipping_address_seq JOIN geographic_locations fg ON fg.location_id = fa.location_id';
    const { rows, ms } = await run(
      `SELECT fg.state_code AS label, fg.region AS region, COUNT(*) AS orders, SUM(IF(${VALID}, o.total_amount, 0)) AS revenue
         FROM orders o ${s.joins} ${join} WHERE ${s.where} GROUP BY fg.state_code, fg.region ORDER BY orders DESC`,
      s.params,
    );
    return envelope(f, 'orders', s.applied, ms, rows.map((r) => ({ label: r.label, region: r.region, value: n(r.orders), revenue: n(r.revenue) })), { metric: 'Orders by customer state' });
  },

  async 'hour-weekday'(f) {
    const s = orderScope(f);
    const { rows, ms } = await run(
      `SELECT WEEKDAY(o.purchased_at) AS wd, HOUR(o.purchased_at) AS h, COUNT(*) AS value FROM orders o ${s.joins} WHERE ${s.where} GROUP BY wd, h`,
      s.params,
    );
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const r of rows) grid[n(r.wd)][n(r.h)] = n(r.value);
    return envelope(f, 'orders', s.applied, ms, { grid, weekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] }, { metric: 'Orders by purchase hour (UTC) and weekday' });
  },

  async 'delivery-duration'(f) {
    const s = orderScope({ ...f, status: null });
    const { rows, ms } = await run(
      `SELECT LEAST(FLOOR(TIMESTAMPDIFF(HOUR, o.purchased_at, o.delivered_at) / 24), 40) AS days, COUNT(*) AS value,
              SUM(o.delivered_at > o.estimated_delivery_at) AS late
         FROM orders o ${s.joins} WHERE ${s.where} AND o.status = 'delivered' GROUP BY days ORDER BY days`,
      s.params,
    );
    const data = rows.map((r) => ({ days: n(r.days), value: n(r.value), late: n(r.late) }));
    const total = data.reduce((a, r) => a + r.value, 0);
    let acc = 0;
    const pct = (p) => {
      acc = 0;
      for (const r of data) if ((acc += r.value) >= total * p) return r.days;
      return null;
    };
    return envelope(f, 'orders', s.applied, ms, data, {
      metric: 'Delivered orders by whole days from purchase to delivery (40 = 40 or more)',
      summary: { delivered: total, late: data.reduce((a, r) => a + r.late, 0), medianDays: total ? pct(0.5) : null, p90Days: total ? pct(0.9) : null },
    });
  },

  async 'cancel-return-rates'(f) {
    const s = orderScope({ ...f, status: null });
    const { rows, ms } = await run(
      `SELECT DATE_FORMAT(o.purchased_at, '%Y-%m-01') AS m, COUNT(*) AS orders, SUM(o.status IN ('canceled', 'unavailable')) AS canceled,
              SUM(o.status = 'delivered') AS delivered, SUM(EXISTS (SELECT 1 FROM order_returns r WHERE r.order_id = o.order_id)) AS returned
         FROM orders o ${s.joins} WHERE ${s.where} GROUP BY m ORDER BY m`,
      s.params,
    );
    return envelope(f, 'orders', s.applied, ms, rows.map((r) => ({
      month: r.m, cancelRate: n(r.orders) ? n(r.canceled) / n(r.orders) : 0, returnRate: n(r.delivered) ? n(r.returned) / n(r.delivered) : 0, orders: n(r.orders),
    })), { metric: 'Cancellation rate = canceled or unavailable / orders; return rate = returned / delivered orders' });
  },

  async 'repeat-purchase'(f) {
    const s = orderScope(f);
    // The rank is computed over each customer's full history, so a repeat
    // purchase in the range counts even if the first order was before it.
    const { rows, ms } = await run(
      `SELECT DATE_FORMAT(o.purchased_at, '%Y-%m-01') AS m, COUNT(*) AS orders, SUM(r.seq > 1) AS repeat_orders
         FROM orders o ${s.joins}
         JOIN (SELECT order_id, ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY purchased_at, order_id) AS seq FROM orders) r ON r.order_id = o.order_id
        WHERE ${s.where} GROUP BY m ORDER BY m`,
      s.params,
    );
    return envelope(f, 'orders', s.applied, ms, rows.map((r) => ({ month: r.m, share: n(r.orders) ? n(r.repeat_orders) / n(r.orders) : 0, orders: n(r.orders) })), { metric: 'Share of orders placed by customers who had ordered before' });
  },

  async 'inventory-movements'(f) {
    const p = productScope(f);
    const join = p.where.length ? ' JOIN products p ON p.product_id = m.product_id' : '';
    const { rows, ms } = await run(
      `SELECT DATE_FORMAT(m.moved_at, '%Y-%m-01') AS mo, SUM(IF(m.quantity > 0, m.quantity, 0)) AS inbound, SUM(IF(m.quantity < 0, -m.quantity, 0)) AS outbound
         FROM inventory_movements m${join} WHERE m.moved_at >= ? AND m.moved_at < ?${p.where.length ? ` AND ${p.where.join(' AND ')}` : ''} GROUP BY mo ORDER BY mo`,
      [f.from, nextDay(f.to), ...p.params],
    );
    return envelope(f, 'inventory_movements', ['date', ...(f.categoryIds ? ['category'] : []), ...(f.seller ? ['seller'] : [])], ms, rows.map((r) => ({ month: r.mo, inbound: n(r.inbound), outbound: n(r.outbound) })), { metric: 'Units moved into and out of stock per month' });
  },

  async throughput() {
    const t0 = Date.now();
    const [job] = await query(
      `SELECT job_id, job_type, status, JSON_EXTRACT(progress, '$.throughput') AS tp, JSON_EXTRACT(progress, '$.avgRowsPerSec') AS avg, rows_processed, created_at
         FROM lab_jobs WHERE job_type IN ('generation', 'import') AND JSON_LENGTH(JSON_EXTRACT(progress, '$.throughput')) > 0 ORDER BY created_at DESC LIMIT 1`,
    );
    if (!job) return { source: 'lab_jobs', ms: Date.now() - t0, filters: { applied: [], ignored: [] }, data: null };
    const tp = (typeof job.tp === 'string' ? JSON.parse(job.tp) : job.tp) || [];
    const start = tp[0]?.ts ?? 0;
    return {
      source: 'lab_jobs', ms: Date.now() - t0, filters: { applied: [], ignored: [] },
      data: { jobId: job.job_id, type: job.job_type, status: job.status, rows: Number(job.rows_processed), avgRowsPerSec: Number(job.avg), createdAt: job.created_at, points: tp.map((p) => ({ t: Math.round((p.ts - start) / 1000), value: p.rowsPerSec })) },
      metric: 'Rows written per second (30-second window) during the latest generation or import job',
    };
  },
};

export const CHART_NAMES = Object.keys(CHARTS);

export async function chart(name, qs) {
  const fn = Object.hasOwn(CHARTS, name) ? CHARTS[name] : null;
  if (!fn) throw new HttpError(404, 'Unknown chart');
  const f = name === 'throughput' ? null : await parseFilters(qs);
  return { chart: name, range: f ? { from: f.from, to: f.to } : null, ...(await fn(f)) };
}

export async function options() {
  const [range] = await query('SELECT MIN(sales_date) AS lo, MAX(sales_date) AS hi FROM daily_sales_summary');
  const categories = await query(
    `SELECT c.category_id AS id, c.category_name AS name, c.depth, p.category_name AS parent FROM product_categories c
       LEFT JOIN product_categories p ON p.category_id = c.parent_category_id ORDER BY COALESCE(p.category_name, c.category_name), c.depth, c.category_name`,
  );
  const sellers = await query(
    'SET STATEMENT max_statement_time = 10 FOR SELECT s.seller_id AS id, s.display_name AS name, COUNT(*) AS shipments FROM shipments sh JOIN sellers s ON s.seller_id = sh.seller_id GROUP BY s.seller_id, s.display_name ORDER BY shipments DESC LIMIT 100',
  ).catch(() => []);
  return { range: { from: range.lo, to: range.hi }, categories, sellers: sellers.map((s) => ({ id: s.id, name: s.name, shipments: Number(s.shipments) })), statuses: STATUSES, regions: REGIONS };
}
