// Integration tests against a real MariaDB server. They use a dedicated schema
// (DATALAB_TEST_DB_NAME, default "datalab_test") and are skipped when the server
// configured in .env is not reachable.
//   npm run test:integration
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_NAME = process.env.DATALAB_TEST_DB_NAME || 'datalab_test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const db = await import('../../server/db.js');
const schema = await import('../../server/services/schemaService.js');
const jobs = await import('../../server/jobs/jobManager.js');
const { getJob, ledgerSummary } = await import('../../server/jobs/jobStore.js');

const DB = process.env.DB_NAME;
const probe = await db.testConnection();
const skip = probe.ok ? false : `MariaDB not reachable: ${probe.error?.message}`;

const TINY = {
  preset: 'custom', seed: 4242, customers: 600, sellers: 20, products: 200, categories: 12, promotions: 8, orders: 800,
  carts: 150, inventoryMovements: 100, batchSize: 50, commitInterval: 100, workers: 1,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let baseline = null;

after(async () => {
  jobs.setTestHooks({});
  await db.closePool();
});

// Order-independent content hash of every generated table, ignoring surrogate
// auto-increment ids and refresh timestamps.
async function contentHash() {
  const out = {};
  for (const t of schema.GENERATED_TABLES) {
    const cols = (await db.query('SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', [DB, t]))
      .map((r) => r.c)
      .filter((c) => c !== 'movement_id' && c !== 'refreshed_at');
    const expr = cols.map((c) => `IFNULL(\`${c}\`, '<null>')`).join(', ');
    const [r] = await db.query(`SELECT COUNT(*) AS n, SUM(CRC32(CONCAT_WS('|', ${expr}))) AS h FROM \`${t}\``);
    out[t] = `${r.n}:${r.h}`;
  }
  return out;
}

async function clean() {
  await jobs.cleanupGeneratedData({ confirm: DB });
}

async function validationPasses() {
  const { jobId, done } = await jobs.startValidation();
  await done;
  const v = await getJob(jobId);
  const failed = v.result.results.filter((r) => r.status !== 'pass');
  assert.deepEqual(failed, [], 'all business rules pass');
}

test('connection validation reports success and actionable failures', { skip }, async () => {
  assert.equal(probe.ok, true);
  assert.ok(probe.server.isMariaDB);
  const p = db.getProfile();
  const badPassword = await db.testConnection({ ...p, password: 'definitely-wrong' });
  assert.equal(badPassword.ok, false);
  assert.equal(badPassword.error.code, 'ER_ACCESS_DENIED_ERROR');
  assert.ok(badPassword.error.hint);
  const badPort = await db.testConnection({ ...p, port: 1, connectTimeoutMs: 1000 });
  assert.equal(badPort.ok, false);
  assert.ok(!JSON.stringify(badPort).includes(p.password || '\u0000'), 'password never echoed');
});

test('schema creation is authorized, idempotent and refuses foreign schemas', { skip }, async () => {
  await assert.rejects(schema.applySchema({ confirm: 'wrong' }), (e) => e.status === 400);
  const r = await schema.applySchema({ confirm: DB, createDatabase: true });
  assert.ok(r.statementsExecuted >= 33);
  await schema.applySchema({ confirm: DB });
  const s = await schema.schemaStatus();
  assert.equal(s.installed, true);
  assert.equal(s.managed, true);
  assert.ok(s.objects.foreignKeys >= 40 && s.objects.checkConstraints >= 40);

  const admin = await db.adminConnection();
  try {
    // Unrelated tables block installation until sharing the schema is confirmed.
    await admin.query('CREATE TABLE IF NOT EXISTS zz_foreign_table (id INT PRIMARY KEY)');
    await assert.rejects(schema.applySchema({ confirm: DB }), (e) => e.status === 409 && e.details.includes('zz_foreign_table'));
    await schema.applySchema({ confirm: DB, allowUnrelatedTables: true });
    const shared = await schema.schemaStatus();
    assert.equal(shared.sharedSchema, true);
    assert.deepEqual(shared.foreignTables, ['zz_foreign_table']);

    // A foreign key from outside the lab blocks cleanup (TRUNCATE would orphan its rows).
    await admin.query('CREATE TABLE zz_foreign_ref (code CHAR(3) PRIMARY KEY, FOREIGN KEY (code) REFERENCES currencies (currency_code))');
    await assert.rejects(clean(), (e) => e.status === 409 && e.details.some((d) => d.includes('zz_foreign_ref')));
    await admin.query('DROP TABLE zz_foreign_ref');

    // Without the ownership marker, existing objects with lab names are never claimed.
    await admin.query("DELETE FROM lab_schema_info WHERE info_key = 'app'");
    const unmarked = await schema.schemaStatus();
    assert.equal(unmarked.managed, false);
    assert.ok(unmarked.conflicts.includes('table orders'));
    await assert.rejects(
      schema.applySchema({ confirm: DB, allowUnrelatedTables: true }),
      (e) => e.status === 409 && e.details.includes('table lab_schema_info'),
    );
    await assert.rejects(clean(), (e) => e.status === 409);
    await admin.query("INSERT INTO lab_schema_info (info_key, info_value, updated_at) VALUES ('app', ?, NOW())", [schema.APP_MARKER]);
  } finally {
    await admin.query('DROP TABLE IF EXISTS zz_foreign_ref');
    await admin.query('DROP TABLE IF EXISTS zz_foreign_table');
    await admin.end();
  }
  await schema.applySchema({ confirm: DB });
  assert.equal((await schema.schemaStatus()).sharedSchema, false);
  await clean();
});

test('generation completes, satisfies every business rule and records an audit', { skip }, async () => {
  await clean();
  const { jobId, done } = await jobs.startGeneration({ config: TINY });
  assert.equal(await done, undefined);
  const job = await getJob(jobId);
  assert.equal(job.status, 'completed', JSON.stringify(job.errors));
  assert.equal(job.errors.length, 0);
  const [{ n }] = await db.query('SELECT COUNT(*) AS n FROM orders');
  assert.equal(n, TINY.orders);
  const audit = await db.query('SELECT table_name, rows_inserted FROM data_generation_audit WHERE job_id = ?', [jobId]);
  assert.ok(audit.length >= 25);
  assert.ok(Math.abs(job.rowsProcessed / job.rowsEstimated - 1) < 0.1, 'estimate within 10%');
  await validationPasses();
  baseline = await contentHash();
});

test('rules rewritten for large datasets still detect violations', { skip }, async () => {
  const { RULES } = await import('../../server/validators/businessRules.js');
  const rule = (id) => RULES.find((r) => r.id === id);
  await db.withConnection(async (conn) => {
    const [ship] = await conn.query(`SELECT s.order_id, s.shipment_seq, o.customer_id, o.shipping_address_seq FROM shipments s
      JOIN orders o ON o.order_id = s.order_id JOIN shipment_tracking_events e ON e.order_id = s.order_id AND e.shipment_seq = s.shipment_seq AND e.event_seq = 2
      ORDER BY s.order_id LIMIT 1`);
    const shipRef = `${ship.order_id}/${ship.shipment_seq}`;
    const cases = [
      ['tracking_sequence', `${shipRef}/2`, 'UPDATE shipment_tracking_events SET event_at = event_at - INTERVAL 400 DAY WHERE order_id = ? AND shipment_seq = ? AND event_seq = 2', [ship.order_id, ship.shipment_seq]],
      ['shipment_cost', shipRef, 'UPDATE shipments SET shipping_cost = shipping_cost + 1 WHERE order_id = ? AND shipment_seq = ?', [ship.order_id, ship.shipment_seq]],
      ['payment_total', String(ship.order_id), 'UPDATE payments SET amount = amount + 1 WHERE order_id = ? ORDER BY payment_seq LIMIT 1', [ship.order_id]],
      ['zip_consistency', `customer:${ship.customer_id}/${ship.shipping_address_seq}`,
        'UPDATE customer_addresses SET location_id = (SELECT MIN(g.location_id) FROM geographic_locations g WHERE g.location_id <> customer_addresses.location_id) WHERE customer_id = ? AND address_seq = ?',
        [ship.customer_id, ship.shipping_address_seq]],
      ['shipment_destination', shipRef, null, null], // the address change above also moves the destination
    ];
    await conn.beginTransaction();
    try {
      for (const [, , sql, params] of cases) if (sql) await conn.query(sql, params);
      for (const [id, ref] of cases) {
        const refs = (await conn.query(rule(id).sql)).map((r) => String(r.ref));
        assert.ok(refs.includes(ref), `${id} found ${JSON.stringify(refs.slice(0, 5))}, expected ${ref}`);
      }
    } finally {
      await conn.rollback();
    }
  });
});

test('starting over non-empty tables is refused and invalid input is rejected', { skip }, async () => {
  await assert.rejects(jobs.startGeneration({ config: TINY }), (e) => e.status === 409);
  await assert.rejects(jobs.startGeneration({ config: { ...TINY, seed: "1 OR 1=1" } }), (e) => e.status === 400);
  await assert.rejects(jobs.cleanupGeneratedData({ confirm: 'nope' }), (e) => e.status === 400);
});

test('same seed reproduces the same dataset with different concurrency', { skip }, async () => {
  assert.ok(baseline);
  await clean();
  const { jobId, done } = await jobs.startGeneration({ config: { ...TINY, workers: 4 } });
  await done;
  const job = await getJob(jobId);
  assert.equal(job.status, 'completed', JSON.stringify(job.errors));
  assert.deepEqual(await contentHash(), baseline);
});

test('a failed batch is recorded, rolled back, and recovered without duplicates', { skip }, async () => {
  await clean();
  let thrown = false;
  jobs.setTestHooks({
    beforeCommit: ({ phase, unit }) => {
      if (phase === 'orders' && unit === 3 && !thrown) {
        thrown = true;
        throw Object.assign(new Error('injected constraint failure'), { code: 'ER_INJECTED', errno: 9999 });
      }
    },
  });
  const { jobId, done } = await jobs.startGeneration({ config: TINY });
  await done;
  let job = await getJob(jobId);
  assert.equal(job.status, 'failed');
  const failed = (await ledgerSummary(jobId)).filter((l) => l.status === 'failed');
  assert.deepEqual(failed.map((f) => [f.phase, f.unit]), [['orders', 3]]);
  const [{ n }] = await db.query('SELECT COUNT(*) AS n FROM orders WHERE order_id BETWEEN 301 AND 400');
  assert.equal(n, 0, 'the failed unit left no rows behind');

  const resumed = await jobs.resumeGeneration(jobId);
  await resumed.done;
  job = await getJob(jobId);
  assert.equal(job.status, 'completed');
  assert.deepEqual(await contentHash(), baseline);
  jobs.setTestHooks({});
});

test('transient errors are retried with bounded attempts', { skip }, async () => {
  await clean();
  let attempts = 0;
  jobs.setTestHooks({
    beforeCommit: ({ phase, unit }) => {
      if (phase === 'customers' && unit === 0 && attempts++ < 2) throw Object.assign(new Error('Deadlock found'), { code: 'ER_LOCK_DEADLOCK', errno: 1213 });
    },
  });
  const { jobId, done } = await jobs.startGeneration({ config: TINY });
  await done;
  const job = await getJob(jobId);
  assert.equal(job.status, 'completed');
  assert.equal(job.errors.filter((e) => e.code === 'ER_LOCK_DEADLOCK').length, 2);
  assert.deepEqual(await contentHash(), baseline);
  jobs.setTestHooks({});
});

test('pause holds workers and continue completes the job', { skip }, async () => {
  await clean();
  jobs.setTestHooks({ beforeCommit: () => sleep(40) });
  const { jobId, done } = await jobs.startGeneration({ config: TINY });
  while ((await jobs.jobDetail(jobId)).committedUnits < 3) await sleep(20);
  jobs.pauseJob(jobId);
  await sleep(150);
  const a = (await jobs.jobDetail(jobId)).committedUnits;
  await sleep(300);
  const paused = await jobs.jobDetail(jobId);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.committedUnits, a, 'no progress while paused');
  jobs.unpauseJob(jobId);
  await done;
  assert.equal((await getJob(jobId)).status, 'completed');
  jobs.setTestHooks({});
});

test('cancellation stops cleanly and the job resumes to an identical dataset', { skip }, async () => {
  await clean();
  jobs.setTestHooks({ beforeCommit: () => sleep(30) });
  const { jobId, done } = await jobs.startGeneration({ config: TINY });
  while ((await jobs.jobDetail(jobId)).committedUnits < 4) await sleep(20);
  jobs.cancelJob(jobId);
  await done;
  const job = await getJob(jobId);
  assert.equal(job.status, 'canceled');
  assert.ok(job.rowsProcessed > 0 && job.rowsProcessed < job.rowsEstimated);
  await assert.rejects(jobs.startGeneration({ config: TINY }), (e) => e.status === 409, 'partial data blocks a fresh start');
  jobs.setTestHooks({});
  const resumed = await jobs.resumeGeneration(jobId);
  await resumed.done;
  assert.equal((await getJob(jobId)).status, 'completed');
  assert.deepEqual(await contentHash(), baseline);
  await validationPasses();
});

test('jobs cannot be resumed after their data was deleted', { skip }, async () => {
  const [{ job_id: last }] = await db.query("SELECT job_id FROM lab_jobs WHERE job_type = 'generation' ORDER BY created_at DESC LIMIT 1");
  await clean();
  await db.query("UPDATE lab_jobs SET status = 'interrupted' WHERE job_id = ?", [last]);
  await assert.rejects(jobs.resumeGeneration(last), (e) => e.status === 409);
});
