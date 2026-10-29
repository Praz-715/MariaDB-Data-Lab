// Integration tests for the Olist import pipeline, using the synthetic
// Olist-format fixture (scripts/make-olist-fixture.js) in a temporary directory
// and the "datalab_test" schema.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), 'olist-fixture-'));
execFileSync(process.execPath, [path.join(ROOT, 'scripts/make-olist-fixture.js'), FIXTURE, '1500', '11'], { stdio: 'ignore' });

process.env.DB_NAME = process.env.DATALAB_TEST_DB_NAME || 'datalab_test';
process.env.DATASET_DIR = FIXTURE;
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const db = await import('../../server/db.js');
const schema = await import('../../server/services/schemaService.js');
const jobs = await import('../../server/jobs/jobManager.js');
const files = await import('../../server/importers/datasetFiles.js');
const { stagingReport } = await import('../../server/importers/stagingImport.js');
const { computeCalibration } = await import('../../server/importers/calibration.js');
const { getJob, ledgerSummary } = await import('../../server/jobs/jobStore.js');

const DB = process.env.DB_NAME;
const probe = await db.testConnection();
const skip = probe.ok ? false : `MariaDB not reachable: ${probe.error?.message}`;
const CFG = { commitInterval: 300, batchSize: 100, workers: 2 };
let stagedCounts = null;
let transformHash = null;

after(async () => {
  jobs.setTestHooks({});
  await db.closePool();
  fs.rmSync(FIXTURE, { recursive: true, force: true });
});

async function contentHash(tables) {
  const out = {};
  for (const t of tables) {
    const cols = (await db.query('SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', [DB, t]))
      .map((r) => r.c)
      .filter((c) => c !== 'movement_id' && c !== 'refreshed_at');
    const [r] = await db.query(`SELECT COUNT(*) AS n, SUM(CRC32(CONCAT_WS('|', ${cols.map((c) => `IFNULL(\`${c}\`, '<null>')`).join(', ')}))) AS h FROM \`${t}\``);
    out[t] = `${r.n}:${r.h}`;
  }
  return out;
}

const STAGING = ['stg_olist_category_translation', 'stg_olist_geolocation', 'stg_olist_customers', 'stg_olist_sellers', 'stg_olist_products', 'stg_olist_orders', 'stg_olist_order_items', 'stg_olist_payments', 'stg_olist_reviews'];

async function validationResult() {
  const { jobId, done } = await jobs.startValidation();
  await done;
  return (await getJob(jobId)).result;
}

test('the current schema version installs staging tables', { skip }, async () => {
  await schema.applySchema({ confirm: DB, createDatabase: true });
  const s = await schema.schemaStatus();
  assert.equal(s.installed, true);
  assert.equal(s.schemaVersion, schema.SCHEMA_VERSION);
  assert.ok(s.tables.filter((t) => t.group === 'staging').every((t) => t.exists));
  await jobs.cleanupGeneratedData({ confirm: DB });
  await jobs.clearStaging({ confirm: DB });
});

test('scan validates every file and finds the malformed rows', { skip }, async () => {
  const results = await files.scanAll();
  assert.equal(Object.keys(results).length, 9);
  for (const r of Object.values(results)) {
    assert.equal(r.header.ok, true);
    assert.match(r.sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(results.customers.rejected, 1);
  assert.equal(results.orders.rejected, 1);
  assert.equal(results.order_items.rejected, 1);
  const preview = await files.previewFile(files.definition('reviews'), 5);
  assert.equal(preview.rows.length, 5);
});

test('import requires licence acknowledgement', { skip }, async () => {
  await assert.rejects(jobs.startImport({}), (e) => e.status === 400);
});

test('a failed import unit is recovered exactly once on resume', { skip }, async () => {
  let thrown = false;
  jobs.setTestHooks({
    beforeCommit: ({ phase, unit }) => {
      if (phase === 'stage:orders' && unit === 2 && !thrown) {
        thrown = true;
        throw Object.assign(new Error('injected failure'), { code: 'ER_INJECTED' });
      }
    },
  });
  const { jobId, done } = await jobs.startImport({ licenseAccepted: true, config: CFG });
  await done;
  assert.equal((await getJob(jobId)).status, 'failed');
  jobs.setTestHooks({});
  const resumed = await jobs.resumeGeneration(jobId);
  await resumed.done;
  const job = await getJob(jobId);
  assert.equal(job.status, 'completed', JSON.stringify(job.errors));
  assert.equal(job.progress.stats._rejected, 3);
  assert.ok((await ledgerSummary(jobId)).every((l) => l.status === 'done'));

  const scans = Object.fromEntries((await files.listFiles()).files.map((f) => [f.table, f.scan.valid]));
  stagedCounts = {};
  for (const t of STAGING) {
    const [{ n }] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
    stagedCounts[t] = n;
    assert.equal(n, scans[t], `${t}: staged rows equal valid records`);
  }
  const [{ n: rejects }] = await db.query('SELECT COUNT(*) AS n FROM stg_import_rejects WHERE job_id = ?', [jobId]);
  assert.equal(rejects, 3);
});

test('importing again into non-empty staging needs replace confirmation', { skip }, async () => {
  await assert.rejects(jobs.startImport({ licenseAccepted: true, files: ['sellers'] }), (e) => e.status === 409);
  const { done } = await jobs.startImport({ licenseAccepted: true, files: ['sellers'], replaceStaging: true, confirm: DB, config: CFG });
  await done;
  const [{ n }] = await db.query('SELECT COUNT(*) AS n FROM stg_olist_sellers');
  assert.equal(n, stagedCounts.stg_olist_sellers);
});

test('staging report finds the cross-file problems built into the fixture', { skip }, async () => {
  const report = await stagingReport();
  assert.equal(report.readyForTransform, true);
  const c = Object.fromEntries(report.checks.map((x) => [x.id, x.count]));
  assert.ok(c.orders_without_items > 0);
  assert.equal(c.items_unknown_product, 1);
  assert.equal(c.zips_without_geolocation, 1);
  assert.ok(c.multi_seller_products > 0 && c.reviews_before_delivery > 0 && c.delivery_before_shipping > 0);
});

test('transform loads the lab tables, reports repairs, and passes every business rule', { skip }, async () => {
  const { jobId, done } = await jobs.startTransform({ config: CFG });
  await done;
  const job = await getJob(jobId);
  assert.equal(job.status, 'completed', JSON.stringify(job.errors));
  const stats = job.progress.stats;
  for (const k of ['_fix|delivery_before_pickup', '_fix|review_moved_after_delivery', '_fix|payment_adjusted_to_total', '_fix|item_dropped_unknown_listing', '_fix|payment_synthesized']) {
    assert.ok(stats[k] > 0, `${k} recorded`);
  }
  const [{ n: orders }] = await db.query('SELECT COUNT(*) AS n FROM orders');
  assert.equal(orders, stagedCounts.stg_olist_orders - stats['_skip|orders_without_customer_or_items']);
  const v = await validationResult();
  assert.deepEqual(v.results.filter((r) => r.status !== 'pass').map((r) => r.id), []);
  assert.ok(Math.abs(job.rowsProcessed / job.rowsEstimated - 1) < 0.2, 'estimate within 20%');
  transformHash = await contentHash(schema.GENERATED_TABLES);
});

test('transform is deterministic across worker counts', { skip }, async () => {
  await jobs.cleanupGeneratedData({ confirm: DB });
  const { done } = await jobs.startTransform({ config: { ...CFG, workers: 4 } });
  await done;
  assert.deepEqual(await contentHash(schema.GENERATED_TABLES), transformHash);
});

test('calibration from staging drives a scaled synthetic dataset', { skip }, async () => {
  const cal = await computeCalibration();
  assert.ok(cal.categories.length > 5);
  assert.ok(cal.paymentMix.credit_card > 0.5 && cal.paymentMix.pix === 0);
  await jobs.cleanupGeneratedData({ confirm: DB });
  const config = {
    preset: 'custom', customers: 4000, sellers: 60, products: 900, categories: 38, orders: 3000, carts: 200, promotions: 10, inventoryMovements: 100,
    avgItemsPerOrder: cal.avgItemsPerOrder, calibration: cal, commitInterval: 500, batchSize: 250, workers: 2,
  };
  const { jobId, done } = await jobs.startGeneration({ config });
  await done;
  assert.equal((await getJob(jobId)).status, 'completed');
  const v = await validationResult();
  assert.deepEqual(v.results.filter((r) => r.status !== 'pass').map((r) => r.id), []);
  const mix = Object.fromEntries(v.profile.paymentMethods.map((p) => [p.key, p.count]));
  assert.equal(mix.pix ?? 0, 0, 'no Pix payments, like the 2016-2018 source');
  await jobs.cleanupGeneratedData({ confirm: DB });
});
