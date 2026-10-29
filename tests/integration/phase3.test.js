// Integration tests for the database object generator, Table Explorer,
// Visual Analytics queries and the partitioning experiment ("datalab_test").
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_NAME = process.env.DATALAB_TEST_DB_NAME || 'datalab_test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const db = await import('../../server/db.js');
const schema = await import('../../server/services/schemaService.js');
const jobs = await import('../../server/jobs/jobManager.js');
const objects = await import('../../server/services/objectsService.js');
const explorer = await import('../../server/services/explorerService.js');
const analytics = await import('../../server/services/analyticsService.js');
const partitions = await import('../../server/services/partitionService.js');
const { getJob } = await import('../../server/jobs/jobStore.js');

const DB = process.env.DB_NAME;
const probe = await db.testConnection();
const skip = probe.ok ? false : `MariaDB not reachable: ${probe.error?.message}`;
const CONFIG = { preset: 'custom', seed: 99, customers: 1500, sellers: 40, products: 400, categories: 20, promotions: 10, orders: 1200, carts: 200, inventoryMovements: 200, batchSize: 100, commitInterval: 300, workers: 2 };
const qs = (o = {}) => new URLSearchParams(o);

async function removeAllObjects() {
  const catalog = objects.loadCatalog();
  for (const o of [...catalog].reverse()) await objects.removeObject({ name: o.name, confirm: DB }).catch(() => {});
  await partitions.dropExperimentTable({ confirm: DB }).catch(() => {});
}

before(async () => {
  if (skip) return;
  await schema.applySchema({ confirm: DB, createDatabase: true });
  await removeAllObjects();
  await jobs.cleanupGeneratedData({ confirm: DB });
});

after(async () => {
  if (!skip) {
    // Leave the test schema without triggers or experiment tables for other suites.
    await removeAllObjects();
    await jobs.cleanupGeneratedData({ confirm: DB }).catch(() => {});
  }
  await db.closePool();
});

test('every catalog object applies, is detected, and is recorded as a job', { skip }, async () => {
  const r = await jobs.runObjectsJob({ action: 'apply' }, () => objects.applyObjects({ confirm: DB }));
  assert.deepEqual(r.results.filter((x) => !x.ok).map((x) => `${x.name}: ${x.error.message}`), []);
  assert.equal((await getJob(r.jobId)).status, 'completed');
  const s = await objects.objectsStatus();
  assert.deepEqual(s.objects.filter((o) => !o.exists).map((o) => o.name), []);
  await assert.rejects(objects.applyObjects({ confirm: 'nope' }), (e) => e.status === 400);
  await assert.rejects(objects.removeObject({ name: 'fn_order_balance', confirm: DB }), (e) => e.status === 409, 'dependants block removal');
});

test('generation still passes every business rule with the triggers installed', { skip }, async () => {
  const { jobId, done } = await jobs.startGeneration({ config: CONFIG });
  await done;
  assert.equal((await getJob(jobId)).status, 'completed');
  const v = await jobs.startValidation();
  await v.done;
  assert.equal((await getJob(v.jobId)).result.passed, true);
});

test('functions agree with the data and procedures are idempotent', { skip }, async () => {
  const [bal] = await db.query('SELECT SUM(ABS(fn_order_balance(order_id))) AS off FROM orders');
  assert.equal(Number(bal.off), 0, 'every order reconciles');
  const [stock] = await db.query('SELECT COUNT(*) AS n FROM inventory WHERE fn_stock_balance(product_id, warehouse_id) <> quantity_on_hand');
  assert.equal(Number(stock.n), 0);
  const snapshot = () => db.query('SELECT sales_date, orders_count, net_revenue FROM daily_sales_summary ORDER BY sales_date');
  const before = await snapshot();
  const ex = await objects.runExample('sp_refresh_sales_summaries', { confirmModify: true });
  assert.ok(ex.rows.length === 1);
  assert.deepEqual(await snapshot(), before);
  await assert.rejects(objects.runExample('sp_recalculate_inventory'), (e) => e.status === 428, 'modifying examples need confirmation');
  const orders = await objects.runExample('sp_customer_orders');
  assert.ok(orders.rows.length > 0);
});

test('triggers enforce lifecycle, review and return rules', { skip }, async () => {
  await assert.rejects(db.query("UPDATE orders SET status = 'created' WHERE status = 'delivered' LIMIT 1"), /Invalid order status transition/);
  const [shipped] = await db.query("SELECT order_id FROM orders WHERE status = 'approved' ORDER BY order_id LIMIT 1");
  if (shipped) {
    await db.query("UPDATE orders SET status = 'canceled', canceled_at = approved_at + INTERVAL 1 HOUR WHERE order_id = ?", [shipped.order_id]);
    const [h] = await db.query('SELECT old_status, new_status FROM order_status_history WHERE order_id = ?', [shipped.order_id]);
    assert.deepEqual([h.old_status, h.new_status], ['approved', 'canceled']);
  }
  const [undelivered] = await db.query("SELECT i.order_id, i.item_seq FROM order_items i JOIN orders o ON o.order_id = i.order_id WHERE o.status <> 'delivered' LIMIT 1");
  await assert.rejects(db.query("INSERT INTO product_reviews (order_id, item_seq, rating, title, created_at) VALUES (?, ?, 5, 'x', '2026-01-01 00:00:00')", [undelivered.order_id, undelivered.item_seq]), /Reviews require a delivered order/);
  const [line] = await db.query("SELECT i.order_id, i.item_seq, i.quantity FROM order_items i JOIN orders o ON o.order_id = i.order_id WHERE o.status = 'delivered' AND NOT EXISTS (SELECT 1 FROM order_returns r WHERE r.order_id = i.order_id) LIMIT 1");
  await db.query("INSERT INTO order_returns (order_id, return_seq, status, reason, requested_at, refund_amount) SELECT ?, 9, 'requested', 'changed_mind', delivered_at + INTERVAL 1 DAY, 0 FROM orders WHERE order_id = ?", [line.order_id, line.order_id]);
  await assert.rejects(db.query("INSERT INTO return_items (order_id, return_seq, item_seq, quantity, item_condition) VALUES (?, 9, ?, ?, 'resellable')", [line.order_id, line.item_seq, line.quantity + 1]), /exceeds purchased quantity/);
  await db.query('DELETE FROM order_returns WHERE order_id = ? AND return_seq = 9', [line.order_id]);
});

async function traverse(table, opts) {
  const seen = [];
  let cursor = null;
  for (let i = 0; i < 2000; i++) {
    const page = await explorer.browse(table, { ...opts, cursor });
    seen.push(...page.rows);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return seen;
}

test('keyset pagination visits every row exactly once in order, including NULL sort keys', { skip }, async () => {
  const items = await traverse('order_items', { limit: 97 });
  assert.equal(items.length, (await explorer.exactCount('order_items')).count);
  for (let i = 1; i < items.length; i++) {
    const a = items[i - 1];
    const b = items[i];
    assert.ok(a.order_id < b.order_id || (a.order_id === b.order_id && a.item_seq < b.item_seq));
  }
  const total = (await explorer.exactCount('orders')).count;
  for (const dir of ['asc', 'desc']) {
    const rows = await traverse('orders', { sort: 'delivered_at', dir, limit: 113 });
    assert.equal(rows.length, total, `delivered_at ${dir}`);
    assert.equal(new Set(rows.map((r) => r.order_id)).size, total, `no duplicates (${dir})`);
    const nulls = rows.map((r) => r.delivered_at === null);
    const firstNonNull = nulls.indexOf(false);
    if (dir === 'asc') assert.ok(nulls.slice(0, firstNonNull).every(Boolean) && !nulls.slice(firstNonNull).some(Boolean), 'NULLs first');
    else assert.ok(!nulls.slice(0, nulls.indexOf(true)).some(Boolean) && nulls.slice(nulls.indexOf(true)).every(Boolean), 'NULLs last');
  }
  const filtered = await traverse('orders', { filters: [{ column: 'status', op: 'eq', value: 'delivered' }, { column: 'total_amount', op: 'gte', value: '100' }], sort: 'purchased_at', dir: 'desc', limit: 50 });
  const [{ n }] = await db.query("SELECT COUNT(*) AS n FROM orders WHERE status = 'delivered' AND total_amount >= 100");
  assert.equal(filtered.length, Number(n));
  assert.equal((await explorer.countMatching('orders', [{ column: 'status', op: 'eq', value: 'delivered' }, { column: 'total_amount', op: 'gte', value: '100' }])).count, Number(n));
  await assert.rejects(explorer.browse('mysql.user', {}), (e) => e.status === 404);
  await assert.rejects(explorer.browse('orders', { cursor: 'not-a-cursor' }), (e) => e.status === 400);
});

test('relationships resolve parents and bounded child counts', { skip }, async () => {
  const [o] = await db.query('SELECT order_id FROM orders ORDER BY order_id LIMIT 1');
  const r = await explorer.related('orders', [o.order_id]);
  assert.ok(r.parents.some((p) => p.table === 'customers'));
  const items = r.children.find((c) => c.table === 'order_items');
  const [{ n }] = await db.query('SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?', [o.order_id]);
  assert.equal(items.count, Number(n));
});

test('analytics summary and fact paths agree, and filters are reported', { skip }, async () => {
  // Earlier tests changed order statuses; refresh the summaries with the catalog procedure first.
  await db.query("CALL sp_refresh_sales_summaries('2000-01-01', '2100-01-01')");
  const k = await analytics.chart('kpis', qs());
  assert.equal(k.source, 'daily_sales_summary');
  const [fact] = await db.query("SELECT COUNT(*) AS orders, SUM(IF(status NOT IN ('canceled', 'unavailable'), total_amount, 0)) AS revenue FROM orders");
  assert.equal(k.data.orders, Number(fact.orders));
  assert.ok(Math.abs(k.data.revenue - Number(fact.revenue)) < 0.01);
  const monthly = await analytics.chart('sales-monthly', qs());
  const [items] = await db.query("SELECT SUM(i.quantity * i.unit_price) AS rev FROM order_items i JOIN orders o ON o.order_id = i.order_id WHERE o.status NOT IN ('canceled', 'unavailable')");
  assert.ok(Math.abs(monthly.data.reduce((s, m) => s + m.revenue, 0) - Number(items.rev)) < 0.01);
  for (const name of analytics.CHART_NAMES) {
    const r = await analytics.chart(name, qs({ region: 'Southeast', status: 'delivered' }));
    assert.ok(r.ms >= 0 && r.source, name);
  }
  const s = await analytics.chart('orders-by-status', qs({ status: 'delivered' }));
  assert.deepEqual(s.filters.ignored, ['status']);
  const top = await analytics.chart('top-products', qs({ region: 'Southeast' }));
  assert.ok(top.data.length <= 10 && top.data.every((p, i) => i === 0 || top.data[i - 1].value >= p.value));
  await assert.rejects(analytics.chart('kpis', qs({ from: "2025-01-01' OR 1=1" })), (e) => e.status === 400);
  await assert.rejects(analytics.chart('nope', qs()), (e) => e.status === 404);
});

test('partition experiment copies every order and prunes date-range queries', { skip }, async () => {
  const plan = await partitions.partitionPlan({ granularity: 'quarter' });
  assert.ok(plan.checks.every((c) => c.ok));
  const { jobId, done } = await jobs.startPartitionExperiment({ granularity: 'quarter', confirm: DB, config: { commitInterval: 400 } });
  await done;
  assert.equal((await getJob(jobId)).status, 'completed');
  const [[a], [b]] = await Promise.all([db.query('SELECT COUNT(*) AS n, SUM(total_amount) AS s FROM orders'), db.query('SELECT COUNT(*) AS n, SUM(total_amount) AS s FROM exp_orders_partitioned')]);
  assert.deepEqual([b.n, b.s], [a.n, a.s]);
  const cmp = await partitions.compareQueries({ runs: 2 });
  const range = cmp.cases.find((c) => c.key === 'range');
  const point = cmp.cases.find((c) => c.key === 'point');
  assert.ok(range.identical && point.identical);
  const scanned = (c) => (c.partitioned.plan[0].partitions || '').split(',').length;
  assert.ok(scanned(range) < plan.partitions, 'date range is pruned');
  assert.equal(scanned(point), plan.partitions, 'id lookup probes every partition');
  await assert.rejects(partitions.createExperimentTable({ granularity: 'month', confirm: DB }), (e) => e.status === 409);
});
