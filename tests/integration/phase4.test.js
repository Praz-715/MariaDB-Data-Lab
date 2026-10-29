// Integration tests for the Performance Lab and SQL diagnostics ("datalab_test").
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_NAME = process.env.DATALAB_TEST_DB_NAME || 'datalab_test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const db = await import('../../server/db.js');
const schema = await import('../../server/services/schemaService.js');
const jobs = await import('../../server/jobs/jobManager.js');
const diagnostics = await import('../../server/services/diagnosticsService.js');
const { getJob } = await import('../../server/jobs/jobStore.js');

const DB = process.env.DB_NAME;
const probe = await db.testConnection();
const skip = probe.ok ? false : `MariaDB not reachable: ${probe.error?.message}`;
const counts = async () => Object.fromEntries(await Promise.all(['orders', 'order_items', 'customers', 'inventory_movements'].map(async (t) => [t, Number((await db.query(`SELECT COUNT(*) AS n FROM ${t}`))[0].n)])));

async function bench(body) {
  const { jobId, done } = await jobs.startBenchmark({ warmupSec: 0, ...body });
  await done;
  return getJob(jobId);
}

before(async () => {
  if (skip) return;
  await schema.applySchema({ confirm: DB, createDatabase: true });
  await jobs.cleanupGeneratedData({ confirm: DB });
  const { done } = await jobs.startGeneration({ config: { preset: 'custom', seed: 5, customers: 1200, sellers: 30, products: 300, categories: 15, promotions: 5, orders: 1000, carts: 100, inventoryMovements: 100, batchSize: 100, commitInterval: 500, workers: 2 } });
  await done;
});

after(async () => {
  jobs.setTestHooks({});
  if (!skip) await jobs.cleanupGeneratedData({ confirm: DB }).catch(() => {});
  await db.closePool();
});

test('a read benchmark reports consistent throughput, percentiles and environment', { skip }, async () => {
  const job = await bench({ scenario: 'concurrent-read', concurrency: 3, durationSec: 2, label: 'test' });
  assert.equal(job.status, 'completed');
  const r = job.result;
  assert.ok(r.ops > 50 && r.opsPerSec > 0);
  assert.equal(r.errors, 0);
  const l = r.latency;
  assert.ok(l.min <= l.p50 && l.p50 <= l.p95 && l.p95 <= l.p99 && l.p99 <= l.max);
  assert.ok(Math.abs(r.opsPerSec - r.ops / (r.elapsedMs / 1000)) < 1);
  assert.deepEqual(Object.keys(r.variants).sort(), ['indexed-filter', 'join', 'pk-select']);
  assert.equal(Object.values(r.variants).reduce((s, v) => s + v.count, 0), r.ops);
  assert.ok(r.environment.server.version && r.environment.client.cpus > 0 && r.environment.dataset.tables.orders);
  assert.ok(r.bufferPool.readRequests > 0);
  assert.ok(r.timeline.length >= 1);
  // The live view shows the statements actually executed, with their bound values.
  const { SQL } = await import('../../server/benchmarks/scenarios.js');
  const live = Object.fromEntries(job.progress.statements.map((x) => [x.variant, x]));
  assert.deepEqual(Object.keys(live).sort(), ['indexed-filter', 'join', 'pk-select']);
  assert.equal(live['pk-select'].sql, SQL.pkSelect);
  assert.ok(Number.isInteger(live['pk-select'].values[0]) && live['pk-select'].values[0] >= 1);
  assert.equal(live.join.values[1] - live.join.values[0], 49);
  assert.equal(Object.values(live).reduce((n, x) => n + x.measured, 0), r.ops);
});

test('pagination binds LIMIT and OFFSET as parameters and returns full pages', { skip }, async () => {
  const job = await bench({ scenario: 'pagination', concurrency: 1, mode: 'iterations', iterations: 40, params: { pageSize: 20, maxPage: 10 } });
  assert.equal(job.status, 'completed');
  assert.equal(job.result.errors, 0);
  assert.equal(job.result.rows, 40 * 20, 'every page within the data is full');
});

test('write benchmarks touch only the scratch table and leave it empty', { skip }, async () => {
  const before = await counts();
  for (const scenario of ['bulk-insert', 'commit-throughput', 'mixed']) {
    const job = await bench({ scenario, concurrency: 2, durationSec: 1, params: scenario === 'bulk-insert' ? { batchSize: 100 } : undefined });
    assert.equal(job.status, 'completed', scenario);
    assert.ok(job.result.rowsWritten > 0, `${scenario} wrote rows`);
  }
  assert.deepEqual(await counts(), before, 'business tables unchanged');
  const [{ n }] = await db.query('SELECT COUNT(*) AS n FROM bench_events');
  assert.equal(Number(n), 0);
});

test('iteration mode runs exactly the requested number of operations', { skip }, async () => {
  const job = await bench({ scenario: 'pk-select', concurrency: 4, mode: 'iterations', iterations: 777 });
  assert.equal(job.result.ops, 777);
  assert.equal(job.result.attempted, 777);
});

test('heavy runs need confirmation and only one job runs at a time', { skip }, async () => {
  await assert.rejects(jobs.startBenchmark({ scenario: 'pk-select', concurrency: 16, durationSec: 1 }), (e) => e.status === 428);
  const first = await jobs.startBenchmark({ scenario: 'pk-select', concurrency: 1, durationSec: 2, warmupSec: 0 });
  await assert.rejects(jobs.startBenchmark({ scenario: 'pk-select', concurrency: 1, durationSec: 1 }), (e) => e.status === 409);
  await assert.rejects(jobs.startValidation(), (e) => e.status === 409);
  await first.done;
});

test('cancellation keeps partial results', { skip }, async () => {
  const { jobId, done } = await jobs.startBenchmark({ scenario: 'pk-select', concurrency: 2, durationSec: 60, warmupSec: 0, confirmHeavy: true });
  await new Promise((r) => setTimeout(r, 1200));
  jobs.cancelJob(jobId);
  await done;
  const job = await getJob(jobId);
  assert.equal(job.status, 'canceled');
  assert.ok(job.result.ops > 0 && job.result.elapsedMs < 10_000);
  assert.equal(job.result.stoppedEarly, 'canceled');
});

test('errors and statement timeouts are counted separately', { skip }, async () => {
  let n = 0;
  jobs.setTestHooks({
    beforeOp: () => {
      n++;
      if (n % 10 === 0) throw Object.assign(new Error('Query execution was interrupted (max_statement_time exceeded)'), { code: 'ER_STATEMENT_TIMEOUT', errno: 1969 });
      if (n % 10 === 5) throw Object.assign(new Error('injected failure'), { code: 'ER_INJECTED', errno: 9999 });
    },
  });
  const job = await bench({ scenario: 'pk-select', concurrency: 1, mode: 'iterations', iterations: 200 });
  jobs.setTestHooks({});
  assert.equal(job.status, 'completed');
  assert.equal(job.result.timeouts, 20);
  assert.equal(job.result.errors, 20);
  assert.equal(job.result.ops, 160);
  assert.ok(job.errors.some((e) => e.timeout) && job.errors.some((e) => !e.timeout));
});

test('diagnostics are read-only snapshots with rates and graceful sections', { skip }, async () => {
  const a = await diagnostics.snapshot();
  await db.query('SELECT COUNT(*) FROM orders');
  await new Promise((r) => setTimeout(r, 1100));
  const b = await diagnostics.snapshot();
  assert.ok(b.server.version && b.counters.Questions >= a.counters.Questions);
  const rates = diagnostics.rates(a, b);
  assert.ok(rates.intervalSec > 1 && rates.questions > 0);
  assert.ok(rates.rowsRead !== undefined && rates.rowsWritten !== undefined);
  for (const section of ['transactions', 'processlist', 'performanceSchema', 'indexUsage']) {
    const s = b[section];
    assert.ok(s.available === true || (s.available === false && typeof s.help === 'string' && s.help.length > 20), `${section} is available or explains itself`);
  }
  assert.ok(b.tables.some((t) => t.name === 'orders'));
  assert.equal(diagnostics.rates(null, b), null);
});

test('the server assessment inventories the server read-only and never leaks credentials', { skip }, async () => {
  const { collectAssessment } = await import('../../server/services/assessmentService.js');
  const a = await collectAssessment();
  assert.ok(a.variables.rows.length > 300, 'every global parameter');
  assert.ok(a.variables.rows.some((v) => v.name === 'innodb_buffer_pool_size'));
  assert.ok(a.status.rows.length > 300, 'every status counter');
  assert.match(a.server.version, /MariaDB/);
  assert.ok(a.cluster.topology.length > 0);
  for (const s of ['replicas', 'binlog', 'replicaHosts']) assert.ok(a.cluster[s].available || a.cluster[s].help, `${s} is available or explains why not`);
  const lab = a.schemas.rows.find((s) => s.name === DB);
  assert.ok(lab && lab.tables >= 30 && !lab.system);
  const orders = a.tables.rows.find((t) => t.schema === DB && t.name === 'orders');
  assert.equal(orders.engine, 'InnoDB');
  assert.equal(orders.hasPrimaryKey, true);
  assert.ok(orders.foreignKeys >= 1 && orders.indexes >= 2);
  assert.ok(Array.isArray(a.findings) && a.findings.every((f) => ['critical', 'warning', 'info'].includes(f.severity)));
  const json = JSON.stringify(a);
  const { password, adminPassword } = db.getProfile();
  for (const secret of [password, adminPassword].filter((p) => p && p.length >= 4)) assert.ok(!json.includes(secret), 'no password in the assessment');
});
